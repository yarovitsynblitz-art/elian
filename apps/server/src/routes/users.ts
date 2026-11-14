import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isValidUsername, normalizeUsername, RESERVED_USERNAMES } from '@elian/shared';
import { all, get, run } from '../db/index.js';
import { errors } from '../lib/errors.js';
import { requireAuth, revokeAllUserSessions, revokeSession, listUserSessions, toSelfUser } from '../auth/sessions.js';
import { addMember, ensurePrivateChat, listChatSummaries, toChatSummary, getChat, getMembership } from '../services/chats.js';
import {
  blockedIds, contactIds, getUserById, getUserByUsername, isBlocked, isContact, saveSettings, searchUsers, toPublicUser, userSettings,
} from '../services/users.js';
import { changePassword, disableTfa, enableTfa, completePasswordReset } from '../auth/service.js';
import { requestMeta } from '../app.js';
import { audit } from '../lib/audit.js';
import { now } from '../lib/time.js';
import { randomHex, base32Encode, totpCode, verifyTotp } from '../lib/tokens.js';
import { enforce, RULES } from '../lib/rate-limit.js';
import { storeUpload } from '../services/media.js';
import { getMedia } from '../services/media.js';
import { tmpFileFromUpload } from './media.js';

const profileSchema = z.object({
  displayName: z.string().min(1).max(64).optional(),
  bio: z.string().max(255).nullable().optional(),
  phone: z.string().max(32).nullable().optional(),
  birthDate: z.string().max(10).nullable().optional(),
});

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me', async (req, reply) => {
    const auth = requireAuth(req);
    const user = getUserById(auth.userId)!;
    reply.send({ user: toSelfUser(user) });
  });

  app.patch('/me', async (req, reply) => {
    const auth = requireAuth(req);
    const body = profileSchema.parse(req.body);
    const current = getUserById(auth.userId)!;
    const displayName = body.displayName?.trim() ?? current.display_name;
    if (!displayName || displayName.length > 64) throw errors.badRequest('Некорректное имя');
    if (body.bio && body.bio.length > 255) throw errors.badRequest('Био длиннее 255 символов');
    run('UPDATE users SET display_name = ?, bio = ?, phone = ?, birth_date = ?, updated_at = ? WHERE id = ?', [
      displayName,
      body.bio === undefined ? current.bio : body.bio,
      body.phone === undefined ? current.phone : body.phone,
      body.birthDate === undefined ? current.birth_date : body.birthDate,
      now(),
      auth.userId,
    ]);
    const updated = getUserById(auth.userId)!;
    reply.send({ user: toSelfUser(updated) });
  });

  app.post('/me/username', async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({ username: z.string().min(2).max(40), password: z.string().min(1).max(200) }).parse(req.body);
    enforce(`username:${auth.userId}`, RULES.generic);
    const username = normalizeUsername(body.username);
    if (!isValidUsername(username)) throw errors.badRequest('Некорректный логин');
    if (RESERVED_USERNAMES.has(username)) throw errors.badRequest('Логин зарезервирован');
    const exists = getUserByUsername(username);
    if (exists && exists.id !== auth.userId) throw errors.conflict('Логин уже занят');
    const user = getUserById(auth.userId)!;
    const settings = userSettings(user);
    // Смена username: подтверждаем паролем, старый освобождается сразу.
    const { verifyPassword } = await import('../lib/password.js');
    const credential = get<{ password_hash: string }>('SELECT password_hash FROM credentials WHERE user_id = ?', [auth.userId]);
    if (!credential || !(await verifyPassword(credential.password_hash, body.password))) {
      throw errors.badRequest('Пароль неверен');
    }
    const previous = user.username;
    run('UPDATE users SET username = ?, username_changed_at = ?, updated_at = ? WHERE id = ?', [username, now(), now(), auth.userId]);
    run('INSERT INTO audit_log(id, actor_id, action, target_type, target_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      globalThis.crypto.randomUUID(), auth.userId, 'user.username_changed', 'user', auth.userId,
      JSON.stringify({ from: previous, to: username }), now(),
    ]);
    void settings;
    reply.send({ user: toSelfUser(getUserById(auth.userId)!) });
  });

  app.get('/me/settings', async (req, reply) => {
    const auth = requireAuth(req);
    reply.send({ settings: userSettings(getUserById(auth.userId)!) });
  });

  app.patch('/me/settings', async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({
      privacy: z.record(z.any()).optional(),
      notifications: z.record(z.any()).optional(),
      appearance: z.record(z.any()).optional(),
      chats: z.record(z.any()).optional(),
      business: z.record(z.any()).optional(),
      language: z.enum(['ru', 'en']).optional(),
      showPhone: z.boolean().optional(),
      experimental: z.record(z.boolean()).optional(),
    }).parse(req.body);
    const current = userSettings(getUserById(auth.userId)!);
    const merged = {
      ...current,
      ...body,
      privacy: { ...current.privacy, ...(body.privacy ?? {}) },
      notifications: { ...current.notifications, ...(body.notifications ?? {}) },
      appearance: { ...current.appearance, ...(body.appearance ?? {}) },
      chats: { ...current.chats, ...(body.chats ?? {}) },
      business: { ...current.business, ...(body.business ?? {}) },
    };
    const saved = saveSettings(auth.userId, merged);
    audit({ actorId: auth.userId, action: 'user.settings_updated', metadata: { sections: Object.keys(body) } });
    reply.send({ settings: saved });
  });

  app.post('/me/password', async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) }).parse(req.body);
    const meta = requestMeta(req);
    await changePassword(auth.userId, body.currentPassword, body.newPassword, meta.ipMasked);
    revokeAllUserSessions(auth.userId, auth.session.id);
    reply.send({ status: 'ok', message: 'Пароль изменён, остальные сессии завершены' });
  });

  app.post('/me/avatar', async (req, reply) => {
    const auth = requireAuth(req);
    enforce(`avatar:${auth.userId}`, RULES.upload);
    const upload = await tmpFileFromUpload(req);
    if (!upload) throw errors.badRequest('Файл не передан');
    const media = await storeUpload({
      ownerId: auth.userId,
      tempPath: upload.tempPath,
      mimeType: upload.mimeType,
      fileName: upload.fileName,
      kind: 'photo',
      maxBytes: 8 * 1024 * 1024,
    });
    run('UPDATE users SET avatar_media_id = ?, updated_at = ? WHERE id = ?', [media.id, now(), auth.userId]);
    reply.send({ user: toSelfUser(getUserById(auth.userId)!), mediaId: media.id });
  });

  app.get('/users/:username', async (req, reply) => {
    const auth = requireAuth(req);
    const { username } = z.object({ username: z.string().min(1).max(40) }).parse(req.params);
    const user = getUserByUsername(normalizeUsername(username));
    if (!user) throw errors.notFound('Пользователь не найден');
    const viewer = getUserById(auth.userId)!;
    const commonChats = all<{ chat_id: string }>(
      `SELECT m1.chat_id FROM chat_members m1 JOIN chat_members m2 ON m2.chat_id = m1.chat_id
       WHERE m1.user_id = ? AND m2.user_id = ? LIMIT 20`,
      [auth.userId, user.id],
    ).map((r) => {
      const chat = getChat(r.chat_id);
      const member = getMembership(r.chat_id, auth.userId);
      return chat && member ? toChatSummary(chat, member) : null;
    }).filter(Boolean);
    void viewer;
    reply.send({ user: toPublicUser(auth.userId, user), commonChats, chatUrl: `${'https://' + 'PUBLIC_DOMAIN'}/@${user.username}` });
  });

  app.get('/users/id/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10).max(64) }).parse(req.params);
    const user = getUserById(id);
    if (!user) throw errors.notFound('Пользователь не найден');
    reply.send({ user: toPublicUser(auth.userId, user) });
  });

  app.get('/me/sessions', async (req, reply) => {
    const auth = requireAuth(req);
    reply.send({ sessions: listUserSessions(auth.userId, auth.session.id) });
  });

  app.delete('/me/sessions/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(8) }).parse(req.params);
    const ok = revokeSession(id, auth.userId);
    if (!ok) throw errors.notFound('Сессия не найдена');
    reply.send({ status: 'ok' });
  });

  app.delete('/me/sessions', async (req, reply) => {
    const auth = requireAuth(req);
    revokeAllUserSessions(auth.userId, auth.session.id);
    audit({ actorId: auth.userId, action: 'user.sessions_revoked' });
    reply.send({ status: 'ok' });
  });

  app.delete('/me', async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({ password: z.string().min(1).max(200), confirm: z.literal(true) }).parse(req.body);
    const { verifyPassword } = await import('../lib/password.js');
    const credential = get<{ password_hash: string }>('SELECT password_hash FROM credentials WHERE user_id = ?', [auth.userId]);
    if (!credential || !(await verifyPassword(credential.password_hash, body.password))) throw errors.badRequest('Пароль неверен');
    // Мягкое удаление + анонимизация. Полная очистка выполняется планировщиком.
    run('UPDATE users SET deleted_at = ?, username = ?, display_name = ?, bio = NULL, phone = NULL, avatar_media_id = NULL WHERE id = ?', [
      now(), `deleted_${auth.userId.slice(0, 8)}`, 'Удалённый аккаунт', auth.userId,
    ]);
    run('UPDATE sessions SET revoked_at = ? WHERE user_id = ?', [now(), auth.userId]);
    audit({ actorId: auth.userId, action: 'user.deleted' });
    reply.send({ status: 'ok' });
  });

  // ---- Контакты и блокировки ----
  app.get('/contacts', async (req, reply) => {
    const auth = requireAuth(req);
    const users = contactIds(auth.userId).map((id) => getUserById(id)).filter(Boolean).map((u) => toPublicUser(auth.userId, u!));
    reply.send({ contacts: users });
  });

  app.post('/contacts/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    if (!getUserById(id)) throw errors.notFound('Пользователь не найден');
    run('INSERT INTO contacts(owner_id, contact_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [auth.userId, id, now()]);
    reply.send({ status: 'ok' });
  });

  app.delete('/contacts/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    run('DELETE FROM contacts WHERE owner_id = ? AND contact_id = ?', [auth.userId, id]);
    reply.send({ status: 'ok' });
  });

  app.get('/blocks', async (req, reply) => {
    const auth = requireAuth(req);
    const users = blockedIds(auth.userId).map((id) => getUserById(id)).filter(Boolean).map((u) => toPublicUser(auth.userId, u!));
    reply.send({ blocked: users });
  });

  app.post('/blocks/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    if (!getUserById(id)) throw errors.notFound('Пользователь не найден');
    run('INSERT INTO blocks(owner_id, blocked_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [auth.userId, id, now()]);
    reply.send({ status: 'ok' });
  });

  app.delete('/blocks/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    run('DELETE FROM blocks WHERE owner_id = ? AND blocked_id = ?', [auth.userId, id]);
    reply.send({ status: 'ok' });
  });

  // ---- Поиск пользователей (глобальный поиск по @username) ----
  app.get('/search/users', async (req, reply) => {
    const auth = requireAuth(req);
    const { q } = z.object({ q: z.string().min(1).max(40) }).parse(req.query);
    enforce(`search:${auth.userId}`, RULES.search);
    const users = searchUsers(q, auth.userId).map((u) => toPublicUser(auth.userId, u));
    reply.send({ users });
  });

  // ---- Жалобы ----
  app.post('/reports', async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({
      targetUserId: z.string().optional(),
      targetChatId: z.string().optional(),
      messageId: z.string().optional(),
      reason: z.enum(['spam', 'abuse', 'violence', 'fraud', 'illegal', 'other']),
      comment: z.string().max(500).optional(),
    }).parse(req.body);
    enforce(`report:${auth.userId}`, RULES.report);
    run(
      `INSERT INTO reports(id, reporter_id, target_user_id, target_chat_id, message_id, reason, comment, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      [globalThis.crypto.randomUUID(), auth.userId, body.targetUserId ?? null, body.targetChatId ?? null, body.messageId ?? null, body.reason, body.comment ?? null, now()],
    );
    reply.code(201).send({ status: 'ok' });
  });

  // ---- TOTP ----
  app.post('/me/tfa/setup', async (req, reply) => {
    const auth = requireAuth(req);
    const secret = randomHex(20);
    const user = getUserById(auth.userId)!;
    reply.send({
      secretBase32: base32Encode(Buffer.from(secret, 'hex')),
      otpauthUrl: `otpauth://totp/Elian:${encodeURIComponent('@' + user.username)}?secret=${base32Encode(Buffer.from(secret, 'hex'))}&issuer=Elian&algorithm=SHA1&digits=6&period=30`,
      secretHex: secret,
    });
  });

  app.post('/me/tfa/enable', async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({ secretHex: z.string().min(20).max(100), code: z.string().min(6).max(8) }).parse(req.body);
    if (!verifyTotp(body.secretHex, body.code)) throw errors.badRequest('Неверный код');
    enableTfa(auth.userId, body.secretHex);
    audit({ actorId: auth.userId, action: 'user.tfa_enabled' });
    reply.send({ status: 'ok' });
  });

  app.post('/me/tfa/disable', async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({ password: z.string().min(1) }).parse(req.body);
    const { verifyPassword } = await import('../lib/password.js');
    const credential = get<{ password_hash: string }>('SELECT password_hash FROM credentials WHERE user_id = ?', [auth.userId]);
    if (!credential || !(await verifyPassword(credential.password_hash, body.password))) throw errors.badRequest('Пароль неверен');
    disableTfa(auth.userId);
    audit({ actorId: auth.userId, action: 'user.tfa_disabled' });
    reply.send({ status: 'ok' });
  });

  // ---- Диагностика (без секретов) ----
  app.get('/me/diagnostics', async (req, reply) => {
    const auth = requireAuth(req);
    const chats = listChatSummaries(auth.userId);
    reply.send({
      chats: chats.length,
      sessions: listUserSessions(auth.userId, auth.session.id).length,
      serverTime: now(),
      contacts: contactIds(auth.userId).length,
      blocked: blockedIds(auth.userId).length,
    });
  });

  app.get('/media/own', async (req, reply) => {
    const auth = requireAuth(req);
    const rows = all<{ id: string; kind: string; mime_type: string; size: number; created_at: string }>(
      'SELECT id, kind, mime_type, size, created_at FROM media WHERE owner_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100',
      [auth.userId],
    );
    reply.send({ media: rows });
  });

  // Экспорт данных аккаунта (JSON, без секретов).
  app.get('/me/export', async (req, reply) => {
    const auth = requireAuth(req);
    const user = getUserById(auth.userId)!;
    const chats = listChatSummaries(auth.userId);
    const messages = all<{ chat_id: string; text: string; created_at: string }>(
      'SELECT chat_id, text, created_at FROM messages WHERE sender_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 5000',
      [auth.userId],
    );
    reply.header('content-disposition', `attachment; filename="elian-export-${user.username}.json"`);
    reply.send({
      exportedAt: now(),
      profile: toSelfUser(user),
      settings: userSettings(user),
      chats,
      messages,
      note: 'Пароли и токены в экспорт не включаются',
    });
  });

  void ensurePrivateChat;
  void isContact;
  void isBlocked;
  void addMember;
  void getMedia;
  void completePasswordReset;
  void totpCode;
}
