import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BRAND, LIMITS } from '@elian/shared';
import { all, get, run } from '../db/index.js';
import { env } from '../config/env.js';
import { requireAuth } from '../auth/sessions.js';
import { errors } from '../lib/errors.js';
import { enforce, RULES } from '../lib/rate-limit.js';
import { mediaStats } from '../services/media.js';
import { getUserById, searchUsers, toPublicUser, userSettings } from '../services/users.js';
import { getChat, getMembership, listChatSummaries, toChatSummary } from '../services/chats.js';
import { serializeMessage } from '../services/messages.js';
import { getMessageRow } from '../services/messages.js';
import { now } from '../lib/time.js';
import { sendPush, vapidPublicKey } from '../services/push.js';
import { pendingStats } from '../auth/pending.js';
import { openapiDocument } from './openapi.js';

export async function miscRoutes(app: FastifyInstance): Promise<void> {
  /** Публичная конфигурация клиента: брендинг, лимиты, фичи, VAPID/ICE. Без секретов. */
  app.get('/config', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    reply.send({
      brand: BRAND,
      version: '1.0.0',
      limits: LIMITS,
      features: {
        registration: env.registrationEnabled,
        ownerApproval: env.requireOwnerApproval,
        push: Boolean(env.vapid),
        calls: { oneToOne: true, group: false, turn: Boolean(env.turn) },
        gifSearch: Boolean(process.env.GIF_PROVIDER_URL),
        stories: true,
        bots: true,
        stickers: true,
        encryptionAtRest: env.dbEncryption !== 'off',
        e2e: false,
      },
      vapidPublicKey: vapidPublicKey(),
      iceServers: env.turn
        ? [{ urls: ['stun:stun.l.google.com:19302'], }, { urls: env.turn.urls, username: env.turn.username, credential: env.turn.credential }]
        : [{ urls: ['stun:stun.l.google.com:19302'] }],
      domain: env.domain,
    });
  });

  app.get('/health', async (_req, reply) => {
    const dbOk = (() => { try { get('SELECT 1 AS ok'); return true; } catch { return false; } })();
    reply.code(dbOk ? 200 : 503).send({
      status: dbOk ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      time: now(),
      version: '1.0.0',
      database: dbOk ? 'ok' : 'error',
      encryptionAtRest: env.dbEncryption !== 'off',
      // Никаких секретов, путей и внутренних идентификаторов.
    });
  });

  app.get('/openapi.json', async (_req, reply) => reply.send(openapiDocument()));

  // ---- Глобальный поиск ----
  app.get('/search', async (req, reply) => {
    const auth = requireAuth(req);
    const { q } = z.object({ q: z.string().min(1).max(100) }).parse(req.query);
    enforce(`search:${auth.userId}`, RULES.search);
    const term = q.replace(/^@/, '').trim();
    const users = searchUsers(term, auth.userId).slice(0, 10).map((u) => toPublicUser(auth.userId, u));
    const publicChats = all<{ id: string }>(
      `SELECT id FROM chats WHERE deleted_at IS NULL AND is_public = 1 AND (lower(username) LIKE ? OR lower(title) LIKE ?) LIMIT 10`,
      [`${term.toLowerCase()}%`, `%${term.toLowerCase()}%`],
    ).map((r) => {
      const chat = getChat(r.id)!;
      const member = getMembership(r.id, auth.userId);
      return member ? toChatSummary(chat, member) : null;
    }).filter(Boolean);
    const messageRows = all<{ id: string }>(
      `SELECT f.message_id AS id FROM messages_fts f
       JOIN chat_members m ON m.chat_id = f.chat_id AND m.user_id = ?
       JOIN messages msg ON msg.id = f.message_id AND msg.deleted_at IS NULL
       WHERE messages_fts MATCH ? ORDER BY msg.seq DESC LIMIT 20`,
      [auth.userId, term.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '')}"*`).join(' ') || '""'],
    );
    const messages = messageRows.map((r) => getMessageRow(r.id)).filter(Boolean).map((row) => serializeMessage(row!, auth.userId));
    reply.send({ users,
      chats: listChatSummaries(auth.userId).filter((c) => c.title.toLowerCase().includes(term.toLowerCase())).slice(0, 10),
      publicChats, messages });
  });

  // ---- Web Push ----
  app.get('/push/public-key', async (_req, reply) => reply.send({ publicKey: vapidPublicKey() }));

  app.post('/push/subscribe', async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({
      endpoint: z.string().url().max(500),
      keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(200) }),
    }).parse(req.body);
    run(
      `INSERT INTO push_subscriptions(id, user_id, endpoint, p256dh, auth, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      [globalThis.crypto.randomUUID(), auth.userId, body.endpoint, body.keys.p256dh, body.keys.auth, req.headers['user-agent'] ?? null, now()],
    );
    reply.code(201).send({ status: 'ok' });
  });

  app.delete('/push/subscribe', async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({ endpoint: z.string().url() }).parse(req.body);
    run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [body.endpoint, auth.userId]);
    reply.send({ status: 'ok' });
  });

  app.post('/push/test', async (req, reply) => {
    const auth = requireAuth(req);
    const result = await sendPush(auth.userId, { title: 'Элиан', body: 'Тестовое уведомление', chatId: null });
    reply.send(result);
  });

  // ---- Стикеры ----
  app.get('/stickers/packs', async (req, reply) => {
    const auth = requireAuth(req);
    const installed = all<{ pack_id: string }>('SELECT pack_id FROM user_sticker_packs WHERE user_id = ? ORDER BY position', [auth.userId]);
    const publicPacks = all<{ id: string; title: string; short_name: string; kind: string }>(
      'SELECT id, title, short_name, kind FROM sticker_packs WHERE is_public = 1 ORDER BY created_at LIMIT 50',
    );
    const ids = new Set([...installed.map((i) => i.pack_id), ...publicPacks.map((p) => p.id)]);
    const packs = [...ids].map((id) => {
      const pack = get<{ id: string; title: string; short_name: string; kind: string; owner_id: string | null }>('SELECT * FROM sticker_packs WHERE id = ?', [id]);
      if (!pack) return null;
      const stickers = all<{ id: string; media_id: string; emoji: string | null }>('SELECT id, media_id, emoji FROM stickers WHERE pack_id = ? ORDER BY position', [id]);
      return {
        ...pack,
        installed: installed.some((i) => i.pack_id === id),
        stickers: stickers.map((s) => ({ id: s.id, emoji: s.emoji, url: `/api/v1/media/${s.media_id}/content`, thumbUrl: `/api/v1/media/${s.media_id}/thumbnail` })),
      };
    }).filter(Boolean);
    reply.send({ packs });
  });

  app.post('/stickers/packs/:id/install', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(8) }).parse(req.params);
    if (!get('SELECT 1 FROM sticker_packs WHERE id = ?', [id])) throw errors.notFound('Набор не найден');
    run('INSERT INTO user_sticker_packs(user_id, pack_id, position, installed_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [
      auth.userId, id, Date.now() % 10000, now(),
    ]);
    reply.send({ status: 'ok' });
  });

  app.delete('/stickers/packs/:id/install', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(8) }).parse(req.params);
    run('DELETE FROM user_sticker_packs WHERE user_id = ? AND pack_id = ?', [auth.userId, id]);
    reply.send({ status: 'ok' });
  });

  app.post('/stickers/packs', async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({ title: z.string().min(1).max(64), shortName: z.string().min(3).max(32), kind: z.enum(['static', 'animated', 'video']).default('static'), isPublic: z.boolean().default(true) }).parse(req.body);
    const id = globalThis.crypto.randomUUID();
    run('INSERT INTO sticker_packs(id, owner_id, title, short_name, kind, is_public, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id, auth.userId, body.title, body.shortName.toLowerCase(), body.kind, body.isPublic ? 1 : 0, now(),
    ]);
    reply.code(201).send({ packId: id });
  });

  app.post('/stickers/packs/:id/stickers', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(8) }).parse(req.params);
    const pack = get<{ owner_id: string }>('SELECT owner_id FROM sticker_packs WHERE id = ?', [id]);
    if (!pack) throw errors.notFound('Набор не найден');
    if (pack.owner_id !== auth.userId) throw errors.forbidden('Не ваш набор');
    const body = z.object({ mediaId: z.string().min(10), emoji: z.string().max(8).nullable().optional() }).parse(req.body);
    const stickerId = globalThis.crypto.randomUUID();
    run('INSERT INTO stickers(id, pack_id, media_id, emoji, position) VALUES (?, ?, ?, ?, ?)', [
      stickerId, id, body.mediaId, body.emoji ?? null, Date.now() % 100000,
    ]);
    reply.code(201).send({ stickerId });
  });

  // ---- GIF: провайдер настраивается снаружи ----
  app.get('/gifs/search', async (req, reply) => {
    const auth = requireAuth(req);
    const { q } = z.object({ q: z.string().min(1).max(60) }).parse(req.query);
    enforce(`search:${auth.userId}`, RULES.search);
    const provider = process.env.GIF_PROVIDER_URL;
    if (!provider) {
      reply.code(501).send({
        error: 'gif_provider_not_configured',
        message: 'GIF-поиск требует внешнего провайдера. Укажите GIF_PROVIDER_URL и GIF_PROVIDER_KEY в .env (см. docs/LIMITATIONS.md).',
        localCatalog: [],
      });
      return;
    }
    try {
      const url = `${provider}?q=${encodeURIComponent(q)}&limit=24`;
      const res = await fetch(url, { headers: process.env.GIF_PROVIDER_KEY ? { authorization: `Bearer ${process.env.GIF_PROVIDER_KEY}` } : {} });
      if (!res.ok) throw new Error(`provider ${res.status}`);
      const payload = await res.json();
      reply.send({ provider: provider.replace(/^https?:\/\//, '').split('/')[0], gifs: payload });
    } catch {
      reply.code(502).send({ error: 'gif_provider_error', message: 'Провайдер GIF недоступен' });
    }
  });

  // ---- Модерация владельца (локальные метрики, без секретов) ----
  app.get('/admin/metrics', async (req, reply) => {
    const auth = requireAuth(req);
    const adminUsername = process.env.OWNER_USERNAME;
    const user = getUserById(auth.userId);
    if (!adminUsername || !user || user.username !== adminUsername.toLowerCase()) {
      throw errors.forbidden('Доступно только владельцу сервера');
    }
    const media = mediaStats();
    reply.send({
      users: get<{ c: number }>('SELECT count(*) AS c FROM users WHERE deleted_at IS NULL')?.c ?? 0,
      chats: get<{ c: number }>('SELECT count(*) AS c FROM chats WHERE deleted_at IS NULL')?.c ?? 0,
      messages: get<{ c: number }>('SELECT count(*) AS c FROM messages WHERE deleted_at IS NULL')?.c ?? 0,
      sessions: get<{ c: number }>('SELECT count(*) AS c FROM sessions WHERE revoked_at IS NULL')?.c ?? 0,
      pending: pendingStats(),
      media,
      reports: get<{ c: number }>("SELECT count(*) AS c FROM reports WHERE status = 'open'")?.c ?? 0,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.get('/admin/audit', async (req, reply) => {
    const auth = requireAuth(req);
    const adminUsername = process.env.OWNER_USERNAME;
    const user = getUserById(auth.userId);
    if (!adminUsername || !user || user.username !== adminUsername.toLowerCase()) throw errors.forbidden('Доступно только владельцу');
    const rows = all<{ id: string; actor_id: string | null; action: string; target_type: string | null; target_id: string | null; metadata: string; created_at: string }>(
      'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200',
    );
    reply.send({ entries: rows });
  });

  app.get('/admin/reports', async (req, reply) => {
    const auth = requireAuth(req);
    const adminUsername = process.env.OWNER_USERNAME;
    const user = getUserById(auth.userId);
    if (!adminUsername || !user || user.username !== adminUsername.toLowerCase()) throw errors.forbidden('Доступно только владельцу');
    const rows = all('SELECT * FROM reports ORDER BY created_at DESC LIMIT 200');
    reply.send({ reports: rows });
  });

  void userSettings;
}
