import crypto from 'node:crypto';
import { isValidUsername, normalizeUsername, passwordProblem, RESERVED_USERNAMES } from '@elian/shared';
import { get, run, tx } from '../db/index.js';
import { env } from '../config/env.js';
import { audit } from '../lib/audit.js';
import { errors, AppError } from '../lib/errors.js';
import { dummyVerify, hashPassword, needsRehash, verifyPassword } from '../lib/password.js';
import { now } from '../lib/time.js';
import { verifyTotp } from '../lib/tokens.js';
import { DEFAULT_SETTINGS } from '../services/settings.js';
import { getUserByUsername, getUserById, type UserRow } from '../services/users.js';
import { createPendingRequest, type PendingMetadata, type CreatedPending } from './pending.js';
import { createSession, type CreatedSession } from './sessions.js';

export interface RequestContext {
  ipMasked: string | null;
  userAgent: string | null;
  device: string | null;
  requestId: string;
}

function pendingMeta(ctx: RequestContext): PendingMetadata {
  return { device: ctx.device, userAgent: ctx.userAgent, ipMasked: ctx.ipMasked, requestId: ctx.requestId };
}

export function validateRegistrationInput(input: { username: string; displayName: string; password: string }): { username: string; displayName: string; password: string } {
  const username = normalizeUsername(input.username);
  if (!isValidUsername(username)) {
    throw errors.badRequest('Логин должен начинаться с буквы и содержать 4–32 символа: a-z, 0-9, _');
  }
  if (RESERVED_USERNAMES.has(username)) throw errors.badRequest('Этот логин зарезервирован');
  const displayName = String(input.displayName ?? '').trim();
  if (displayName.length < 1 || displayName.length > 64) throw errors.badRequest('Имя должно быть от 1 до 64 символов');
  if (/[\u0000-\u001f\u007f]/.test(displayName)) throw errors.badRequest('Имя содержит недопустимые символы');
  const problem = passwordProblem(input.password);
  if (problem) throw errors.badRequest(problem);
  if (getUserByUsername(username)) throw errors.conflict('Логин уже занят');
  const pending = get<{ id: string }>(
    `SELECT id FROM pending_auth_requests WHERE username = ? COLLATE NOCASE AND type = 'REGISTRATION' AND status = 'pending' AND expires_at > ?`,
    [username, now()],
  );
  if (pending) throw errors.conflict('Заявка на этот логин уже ожидает подтверждения');
  return { username, displayName, password: input.password };
}

/** Шаг 1 регистрации: валидация + хэш пароля во временной заявке. Пользователь НЕ создаётся. */
export async function startRegistration(
  input: { username: string; displayName: string; password: string },
  ctx: RequestContext,
): Promise<CreatedPending> {
  if (!env.registrationEnabled) throw errors.forbidden('Регистрация временно закрыта владельцем сервера');
  const valid = validateRegistrationInput(input);
  const passwordHash = await hashPassword(valid.password);
  const pending = await createPendingRequest({
    type: 'REGISTRATION',
    username: valid.username,
    displayName: valid.displayName,
    passwordHash,
    metadata: pendingMeta(ctx),
  });
  audit({ action: 'auth.registration_requested', targetType: 'pending', targetId: pending.requestId, metadata: { username: valid.username }, ipMasked: ctx.ipMasked });
  return pending;
}

export type LoginResult =
  | { kind: 'pending'; pending: CreatedPending }
  | { kind: 'tfa_required' };

/**
 * Шаг 1 входа: проверка пароля Argon2id. Запрос владельцу создаётся ТОЛЬКО при успехе.
 * Неверный логин/пароль не создаёт ни запроса, ни кода, ни уведомления.
 */
export async function startLogin(
  input: { username: string; password: string; totp?: string },
  ctx: RequestContext,
): Promise<LoginResult> {
  const username = normalizeUsername(input.username);
  const user = username ? getUserByUsername(username) : null;
  const credential = user
    ? get<{ password_hash: string; algo: string }>('SELECT password_hash, algo FROM credentials WHERE user_id = ?', [user.id])
    : null;
  if (!user || !credential) {
    await dummyVerify(input.password ?? '');
    audit({ action: 'auth.login_failed', metadata: { reason: 'unknown_user' }, ipMasked: ctx.ipMasked });
    throw errors.unauthorized('Неверный логин или пароль');
  }
  const ok = await verifyPassword(credential.password_hash, input.password ?? '');
  if (!ok) {
    audit({ actorId: user.id, action: 'auth.login_failed', metadata: { reason: 'bad_password' }, ipMasked: ctx.ipMasked });
    throw errors.unauthorized('Неверный логин или пароль');
  }
  if (user.tfa_enabled && user.tfa_secret) {
    if (!input.totp) return { kind: 'tfa_required' };
    if (!verifyTotp(user.tfa_secret, input.totp)) throw errors.unauthorized('Неверный код двухфакторной аутентификации');
  }
  if (needsRehash(credential.password_hash)) {
    const rehashed = await hashPassword(input.password);
    run('UPDATE credentials SET password_hash = ? WHERE user_id = ?', [rehashed, user.id]);
  }
  const pending = await createPendingRequest({
    type: 'LOGIN',
    username: user.username,
    userId: user.id,
    metadata: pendingMeta(ctx),
  });
  audit({ actorId: user.id, action: 'auth.login_pending', targetType: 'pending', targetId: pending.requestId, ipMasked: ctx.ipMasked });
  return { kind: 'pending', pending };
}

/**
 * Запрос сброса: ответ всегда одинаковый, существование аккаунта не раскрывается.
 * Запрос владельцу создаётся только для существующего пользователя и после rate limit.
 */
export async function startPasswordReset(input: { username: string; clientSecret?: string }, ctx: RequestContext): Promise<{ created: boolean }> {
  const username = normalizeUsername(input.username);
  const user = isValidUsername(username) ? getUserByUsername(username) : null;
  if (!user) {
    // Выравниваем время ответа фиктивной работой Argon2.
    await dummyVerify('reset-probe');
    audit({ action: 'auth.reset_requested_unknown', metadata: { usernameLength: username.length }, ipMasked: ctx.ipMasked });
    return { created: false };
  }
  const pending = await createPendingRequest({
    type: 'PASSWORD_RESET',
    username: user.username,
    userId: user.id,
    metadata: pendingMeta(ctx),
    clientApprovalSecret: input.clientSecret,
  });
  audit({ actorId: user.id, action: 'auth.reset_requested', targetType: 'pending', targetId: pending.requestId, ipMasked: ctx.ipMasked });
  return { created: true };
}

export interface CreatedUserResult {
  user: UserRow;
  session: CreatedSession;
}

/** Создание пользователя + профиля + настроек + сессии в одной транзакции (после `y`). */
export function finalizeRegistration(row: { username: string; display_name: string | null; password_hash: string | null }, ipMasked: string | null, userAgent: string | null): CreatedUserResult {
  if (!row.password_hash) throw errors.internal('Заявка регистрации повреждена');
  const existing = getUserByUsername(row.username);
  if (existing) throw errors.conflict('Логин уже занят');
  const id = crypto.randomUUID();
  const created = now();
  tx(() => {
    run(
      `INSERT INTO users(id, username, display_name, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, row.username, row.display_name ?? row.username, JSON.stringify(DEFAULT_SETTINGS), created, created],
    );
    run('INSERT INTO credentials(user_id, password_hash, algo, password_changed_at) VALUES (?, ?, ?, ?)', [
      id, row.password_hash!, 'argon2id', created,
    ]);
  });
  const session = createSession(id, { ip: ipMasked, userAgent });
  const user = getUserById(id)!;
  audit({ actorId: id, action: 'auth.registration_approved', targetType: 'user', targetId: id, ipMasked });
  return { user, session };
}

export function finalizeLogin(userId: string, ipMasked: string | null, userAgent: string | null): CreatedSession {
  const user = getUserById(userId);
  if (!user) throw errors.notFound('Пользователь не найден');
  const session = createSession(userId, { ip: ipMasked, userAgent });
  audit({ actorId: userId, action: 'auth.login_approved', targetType: 'session', targetId: session.sessionId, ipMasked });
  return session;
}

/** Завершение сброса: новый пароль, отзыв всех сессий. */
export async function completePasswordReset(payload: { userId: string; newPassword: string }, ipMasked: string | null): Promise<void> {
  const problem = passwordProblem(payload.newPassword);
  if (problem) throw errors.badRequest(problem);
  const user = getUserById(payload.userId);
  if (!user) throw errors.notFound('Пользователь не найден');
  const hash = await hashPassword(payload.newPassword);
  tx(() => {
    run('UPDATE credentials SET password_hash = ?, password_changed_at = ?, failed_attempts = 0, locked_until = NULL WHERE user_id = ?', [
      hash, now(), payload.userId,
    ]);
    run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now(), payload.userId]);
  });
  audit({ actorId: payload.userId, action: 'auth.password_reset_completed', targetType: 'user', targetId: payload.userId, ipMasked });
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string, ipMasked: string | null): Promise<void> {
  const credential = get<{ password_hash: string }>('SELECT password_hash FROM credentials WHERE user_id = ?', [userId]);
  if (!credential) throw errors.notFound('Учётные данные не найдены');
  const ok = await verifyPassword(credential.password_hash, currentPassword);
  if (!ok) {
    audit({ actorId: userId, action: 'auth.password_change_failed', ipMasked });
    throw new AppError(400, 'bad_password', 'Текущий пароль неверен');
  }
  const problem = passwordProblem(newPassword);
  if (problem) throw errors.badRequest(problem);
  const hash = await hashPassword(newPassword);
  run('UPDATE credentials SET password_hash = ?, password_changed_at = ? WHERE user_id = ?', [hash, now(), userId]);
  audit({ actorId: userId, action: 'auth.password_changed', ipMasked });
}

export function enableTfa(userId: string, secretHex: string): void {
  run('UPDATE users SET tfa_secret = ?, tfa_enabled = 1, updated_at = ? WHERE id = ?', [secretHex, now(), userId]);
}

export function disableTfa(userId: string): void {
  run('UPDATE users SET tfa_secret = NULL, tfa_enabled = 0, updated_at = ? WHERE id = ?', [now(), userId]);
}
