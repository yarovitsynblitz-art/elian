import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SelfUser, SessionInfo } from '@elian/shared';
import type { UserRow } from '../services/users.js';
import { all, get, run } from '../db/index.js';
import { env } from '../config/env.js';
import { getSecret } from '../config/secrets.js';
import { errors } from '../lib/errors.js';
import { parseSettings } from '../services/settings.js';
import { deviceFingerprint, deviceLabel } from '../lib/ip.js';
import { randomToken, safeEqual } from '../lib/tokens.js';
import { now, plusDays } from '../lib/time.js';

const SECURE_COOKIE = env.isProduction;

type SessionRow = {
  id: string;
  user_id: string;
  device_id: string | null;
  token_hash: string;
  csrf_hash: string;
  ip_masked: string | null;
  user_agent: string | null;
  created_at: string;
  last_active_at: string;
  expires_at: string;
  revoked_at: string | null;
};

function hashToken(token: string): string {
  return crypto.createHmac('sha256', getSecret('SESSION_PEPPER')).update(token, 'utf8').digest('hex');
}

function hashCsrf(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface CreatedSession {
  sessionId: string;
  token: string;
  csrfToken: string;
  expiresAt: string;
}

export function createSession(userId: string, meta: { ip?: string | null; userAgent?: string | null }): CreatedSession {
  const id = crypto.randomUUID();
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = plusDays(env.sessionTtlDays);
  const ua = meta.userAgent ?? null;
  const fingerprint = deviceFingerprint(ua);
  const existing = get<{ id: string }>(
    'SELECT id FROM devices WHERE user_id = ? AND fingerprint = ?',
    [userId, fingerprint],
  );
  let deviceId = existing?.id;
  if (deviceId) {
    run('UPDATE devices SET last_active_at = ?, user_agent = ? WHERE id = ?', [now(), ua, deviceId]);
  } else {
    deviceId = crypto.randomUUID();
    run(
      `INSERT INTO devices(id, user_id, fingerprint, name, platform, user_agent, created_at, last_active_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [deviceId, userId, fingerprint, deviceLabel(ua), null, ua, now(), now()],
    );
  }
  run(
    `INSERT INTO sessions(id, user_id, device_id, token_hash, csrf_hash, ip_masked, user_agent, created_at, last_active_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, deviceId, hashToken(token), hashCsrf(csrfToken), meta.ip ?? null, ua, now(), now(), expiresAt],
  );
  return { sessionId: id, token, csrfToken, expiresAt };
}

export function setSessionCookies(reply: FastifyReply, created: CreatedSession): void {
  reply.setCookie(env.sessionCookieName, created.token, {
    httpOnly: true,
    secure: SECURE_COOKIE,
    sameSite: 'lax',
    path: '/',
    expires: new Date(created.expiresAt),
  });
  // CSRF-токен доступен JS (double-submit), но привязан к серверной сессии.
  reply.setCookie(env.csrfCookieName, created.csrfToken, {
    httpOnly: false,
    secure: SECURE_COOKIE,
    sameSite: 'lax',
    path: '/',
    expires: new Date(created.expiresAt),
  });
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(env.sessionCookieName, { path: '/' });
  reply.clearCookie(env.csrfCookieName, { path: '/' });
}

export interface AuthContext {
  session: SessionRow;
  userId: string;
}

export function resolveSessionToken(token: string | undefined): AuthContext | null {
  if (!token) return null;
  const row = get<SessionRow>('SELECT * FROM sessions WHERE token_hash = ?', [hashToken(token)]);
  if (!row || row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [now(), row.id]);
    return null;
  }
  return { session: row, userId: row.user_id };
}

export function verifyCsrf(session: SessionRow, headerToken: string | undefined, cookieToken: string | undefined): boolean {
  if (!headerToken || !cookieToken) return false;
  if (!safeEqual(hashCsrf(headerToken), session.csrf_hash)) return false;
  return safeEqual(headerToken, cookieToken);
}

export function touchSession(sessionId: string): void {
  run('UPDATE sessions SET last_active_at = ? WHERE id = ?', [now(), sessionId]);
}

export function revokeSession(sessionId: string, userId: string): boolean {
  const res = run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [now(), sessionId, userId]);
  return res.changes > 0;
}

export function revokeAllUserSessions(userId: string, exceptSessionId?: string): void {
  if (exceptSessionId) {
    run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL', [now(), userId, exceptSessionId]);
  } else {
    run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now(), userId]);
  }
}

export function listUserSessions(userId: string, currentSessionId: string): SessionInfo[] {
  const rows = all<SessionRow & { device_name: string | null; platform: string | null }>(
    `SELECT s.*, d.name AS device_name, d.platform
     FROM sessions s LEFT JOIN devices d ON d.id = s.device_id
     WHERE s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
     ORDER BY s.last_active_at DESC`,
    [userId, now()],
  );
  return rows.map((r) => ({
    id: r.id,
    device: r.device_name ?? deviceLabel(r.user_agent),
    platform: r.platform,
    ipMasked: r.ip_masked,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
    current: r.id === currentSessionId,
  }));
}

export function requireAuth(req: FastifyRequest): AuthContext {
  const auth = (req as FastifyRequest & { auth?: AuthContext }).auth;
  if (!auth) throw errors.unauthorized();
  return auth;
}

export function toSelfUser(row: UserRow): SelfUser {
  const settings = parseSettings(row.settings);
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    avatarUrl: row.avatar_media_id ? `/api/v1/media/${row.avatar_media_id}/content` : null,
    lastSeenAt: row.last_seen_at,
    online: Date.now() - new Date(row.last_seen_at ?? 0).getTime() < 90_000,
    isContact: false,
    isBlocked: false,
    isBlockedBy: false,
    isBot: Boolean(row.is_bot),
    premium: Boolean(row.premium),
    birthDate: row.birth_date,
    phone: settings.showPhone ? row.phone : null,
    createdAt: row.created_at,
    tfaEnabled: Boolean(row.tfa_enabled),
    phoneVisible: Boolean(settings.showPhone),
  };
}
