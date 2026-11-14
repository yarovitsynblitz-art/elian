import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { requestMeta } from '../app.js';
import { RULES, enforce } from '../lib/rate-limit.js';
import { errors, AppError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { deviceLabel } from '../lib/ip.js';
import { issueTicket, readTicket } from '../lib/tickets.js';
import { sha256 } from '../lib/tokens.js';
import {
  startLogin, startPasswordReset, startRegistration, finalizeRegistration, finalizeLogin, completePasswordReset,
} from '../auth/service.js';
import { consumePending, pendingStatusForClient, destroyPending, expirePending } from '../auth/pending.js';
import {
  clearSessionCookies, createSession, requireAuth, resolveSessionToken, revokeSession, setSessionCookies, toSelfUser,
} from '../auth/sessions.js';
import { getUserById } from '../services/users.js';
import { now } from '../lib/time.js';
import { get, run } from '../db/index.js';

const registerSchema = z.object({
  username: z.string().min(1).max(40),
  displayName: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
});

const loginSchema = z.object({
  username: z.string().min(1).max(40),
  password: z.string().min(1).max(200),
  totp: z.string().min(6).max(8).optional(),
});

const pendingSchema = z.object({
  requestId: z.string().uuid(),
  approvalSecret: z.string().min(20).max(200),
});

const resetCompleteSchema = z.object({
  ticket: z.string().min(20).max(2000),
  newPassword: z.string().min(1).max(200),
});

function meta(req: FastifyRequest) {
  const m = requestMeta(req);
  return {
    ipMasked: m.ipMasked,
    userAgent: m.userAgent,
    device: deviceLabel(m.userAgent),
    requestId: m.requestId,
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/register', async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const m = meta(req);
    enforce(`register:${m.ipMasked ?? 'unknown'}`, RULES.register);
    const pending = await startRegistration(body, m);
    reply.code(202).send({
      status: 'pending',
      requestId: pending.requestId,
      approvalSecret: pending.approvalSecret,
      expiresAt: pending.expiresAt,
      // Код подтверждения НИКОГДА не отправляется клиенту — только владельцу в Termux.
    });
  });

  app.post('/login', async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const m = meta(req);
    enforce(`login:${m.ipMasked ?? 'unknown'}:${body.username.toLowerCase()}`, RULES.login);
    try {
      const result = await startLogin(body, m);
      if (result.kind === 'tfa_required') {
        reply.code(401).send({ error: 'tfa_required', message: 'Введите код двухфакторной аутентификации' });
        return;
      }
      reply.code(202).send({
        status: 'pending',
        requestId: result.pending.requestId,
        approvalSecret: result.pending.approvalSecret,
        expiresAt: result.pending.expiresAt,
      });
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 401) {
        // Добавляем небольшую задержку, чтобы перебор был дороже.
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      throw err;
    }
  });

  app.post('/pending/status', async (req, reply) => {
    const body = pendingSchema.parse(req.body);
    enforce(`pending:${req.ip ?? 'unknown'}`, RULES.pending);
    const { status, row } = pendingStatusForClient(body.requestId, body.approvalSecret);
    reply.send({ status, type: row.type, expiresAt: row.expires_at });
  });

  app.post('/pending/exchange', async (req, reply) => {
    const body = pendingSchema.parse(req.body);
    const m = meta(req);
    enforce(`pending:${req.ip ?? 'unknown'}`, RULES.pending);
    const row = consumePending(body.requestId, body.approvalSecret, 'LOGIN');
    const session = finalizeLogin(row.user_id!, m.ipMasked, m.userAgent);
    setSessionCookies(reply, session);
    const user = getUserById(row.user_id!)!;
    reply.send({ status: 'approved', sessionId: session.sessionId, user: toSelfUser(user) });
  });

  app.post('/pending/exchange-registration', async (req, reply) => {
    const body = pendingSchema.parse(req.body);
    const m = meta(req);
    enforce(`pending:${req.ip ?? 'unknown'}`, RULES.pending);
    const row = consumePending(body.requestId, body.approvalSecret, 'REGISTRATION');
    const result = finalizeRegistration(row, m.ipMasked, m.userAgent);
    setSessionCookies(reply, result.session);
    reply.send({ status: 'approved', sessionId: result.session.sessionId, user: toSelfUser(result.user) });
  });

  app.post('/pending/exchange-reset', async (req, reply) => {
    const body = pendingSchema.parse(req.body);
    const m = meta(req);
    enforce(`pending:${req.ip ?? 'unknown'}`, RULES.pending);
    const row = consumePending(body.requestId, body.approvalSecret, 'PASSWORD_RESET');
    const ticket = issueTicket({ purpose: 'password_reset', requestId: row.id, userId: row.user_id!, exp: Date.now() + 10 * 60_000 });
    audit({ actorId: row.user_id, action: 'auth.reset_ticket_issued', targetType: 'pending', targetId: row.id, ipMasked: m.ipMasked });
    reply.send({ status: 'approved', resetTicket: ticket });
  });

  app.post('/reset', async (req, reply) => {
    const body = z.object({ username: z.string().min(1).max(40), clientSecret: z.string().min(24).max(200).optional() }).parse(req.body);
    const m = meta(req);
    enforce(`reset:${m.ipMasked ?? 'unknown'}`, RULES.reset);
    await startPasswordReset(body, m);
    // Одинаковый ответ независимо от существования аккаунта.
    reply.code(202).send({ status: 'accepted', message: 'Если аккаунт существует, запрос передан владельцу сервера' });
  });

  /** Статус запроса сброса по клиентскому секрету (секрет известен только инициатору). */
  app.post('/reset/status', async (req, reply) => {
    const body = z.object({ clientSecret: z.string().min(24).max(200) }).parse(req.body);
    enforce(`reset-status:${req.ip ?? 'unknown'}`, RULES.pending);
    const row = get<{ id: string; status: string; expires_at: string }>(
      'SELECT id, status, expires_at FROM pending_auth_requests WHERE approval_secret_hash = ? AND type = ?',
      [sha256(body.clientSecret), 'PASSWORD_RESET'],
    );
    if (!row) {
      reply.code(404).send({ found: false, message: 'Запрос не найден' });
      return;
    }
    expirePending();
    const fresh = get<{ status: string }>('SELECT status FROM pending_auth_requests WHERE id = ?', [row.id])!;
    reply.send({ found: true, requestId: row.id, status: fresh.status, expiresAt: row.expires_at });
  });

  app.post('/reset/complete', async (req, reply) => {
    const body = resetCompleteSchema.parse(req.body);
    const m = meta(req);
    enforce(`reset-complete:${m.ipMasked ?? 'unknown'}`, RULES.reset);
    const payload = readTicket(body.ticket, 'password_reset');
    if (!payload) throw errors.badRequest('Ссылка сброса недействительна или истекла');
    // Тикет одноразовый: после смены пароля он не пройдёт повторно (сессии отозваны, а
    // заявка уже consumed — проверим это явно).
    // Одноразовость тикета: атомарно «сжигаем» заявку до смены пароля.
    const claimed = run(
      'UPDATE pending_auth_requests SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NOT NULL AND attempts = 1',
      [payload.requestId],
    ).changes;
    if (claimed !== 1) throw errors.badRequest('Ссылка сброса уже использована или недействительна');
    await completePasswordReset({ userId: payload.userId, newPassword: body.newPassword }, m.ipMasked);
    reply.send({ status: 'ok', message: 'Пароль изменён. Войдите с новым паролем.' });
  });

  app.post('/logout', async (req, reply) => {
    const auth = (req as FastifyRequest & { auth?: { session: { id: string }; userId: string } }).auth;
    if (auth) {
      revokeSession(auth.session.id, auth.userId);
      audit({ actorId: auth.userId, action: 'auth.logout', targetType: 'session', targetId: auth.session.id });
    }
    clearSessionCookies(reply);
    reply.send({ status: 'ok' });
  });

  app.get('/me', async (req, reply) => {
    const auth = requireAuth(req);
    const user = getUserById(auth.userId);
    if (!user) throw errors.unauthorized();
    reply.send({ user: toSelfUser(user) });
  });

  app.get('/csrf', async (req, reply) => {
    const token = req.cookies[env.csrfCookieName] ?? null;
    reply.send({ csrfToken: token });
  });

  /** Проверка «жив ли» pending-запрос без секрета: только факт наличия id. */
  app.get('/pending/:id/exists', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = get<{ status: string }>('SELECT status FROM pending_auth_requests WHERE id = ?', [id]);
    reply.send({ exists: !!row });
  });
}

export { resolveSessionToken, createSession, now, destroyPending };
