import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { all, get, run } from '../db/index.js';
import { errors } from '../lib/errors.js';
import { requireAuth } from '../auth/sessions.js';
import { now } from '../lib/time.js';
import { normalizeUsername, isValidUsername } from '@elian/shared';
import { sha256 } from '../lib/tokens.js';
import { insertMessage } from '../services/messages.js';
import { emitToChat } from '../realtime/index.js';
import { toChatSummary, ensurePrivateChat, getMembership } from '../services/chats.js';
import { getUserById } from '../services/users.js';
import { audit } from '../lib/audit.js';

/**
 * Собственный Bot API Элиан. Это НЕ Telegram Bot API: контракт другой,
 * совместимость не заявляется (см. docs/API.md).
 */
const botMessageSchema = z.object({
  chat_id: z.string().min(10),
  text: z.string().max(4096).optional(),
  reply_markup: z.object({
    inline_keyboard: z.array(z.array(z.object({ text: z.string().max(64), callback_data: z.string().max(64).optional(), url: z.string().url().optional() }))).max(8),
  }).optional(),
});

function botByToken(token: string) {
  return get<{ id: string; owner_id: string; username: string; display_name: string; enabled: number; commands: string; webhook_url: string | null }>(
    'SELECT * FROM bots WHERE token_hash = ?', [sha256(token)],
  );
}

function queueUpdate(botId: string, payload: unknown): void {
  run('INSERT INTO bot_updates(bot_id, payload, created_at) VALUES (?, ?, ?)', [botId, JSON.stringify(payload), now()]);
}

export async function botRoutes(app: FastifyInstance): Promise<void> {
  // ---- Управление ботами (обычная авторизация) ----
  app.get('/bots', async (req, reply) => {
    const auth = requireAuth(req);
    const rows = all<{ id: string; username: string; display_name: string; long_polling: number; webhook_url: string | null; enabled: number; created_at: string }>(
      'SELECT id, username, display_name, long_polling, webhook_url, enabled, created_at FROM bots WHERE owner_id = ?',
      [auth.userId],
    );
    reply.send({ bots: rows });
  });

  app.post('/bots', async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({ username: z.string().min(3).max(32), displayName: z.string().min(1).max(64) }).parse(req.body);
    const username = normalizeUsername(body.username);
    const botUsername = username.endsWith('bot') ? username : `${username}_bot`;
    if (!isValidUsername(botUsername)) throw errors.badRequest('Некорректный username бота');
    if (get('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE', [botUsername])) throw errors.conflict('Логин занят пользователем');
    if (get('SELECT 1 FROM bots WHERE username = ? COLLATE NOCASE', [botUsername])) throw errors.conflict('Бот с таким именем уже существует');
    const token = `${botUsername}:${randomBytes(24).toString('base64url')}`;
    const id = globalThis.crypto.randomUUID();
    // Бот — это и пользователь (для отображения в чатах), и запись в bots.
    run(
      `INSERT INTO users(id, username, display_name, settings, is_bot, created_at, updated_at)
       VALUES (?, ?, ?, '{}', 1, ?, ?)`,
      [id, botUsername, body.displayName, now(), now()],
    );
    run(
      `INSERT INTO bots(id, owner_id, username, display_name, token_hash, token_hint, long_polling, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [id, auth.userId, botUsername, body.displayName, sha256(token), token.slice(0, 12), now()],
    );
    audit({ actorId: auth.userId, action: 'bot.created', targetType: 'bot', targetId: id });
    // Токен показывается один раз.
    reply.code(201).send({ bot: { id, username: botUsername, displayName: body.displayName }, token });
  });

  app.patch('/bots/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const bot = get<{ owner_id: string }>('SELECT owner_id FROM bots WHERE id = ?', [id]);
    if (!bot) throw errors.notFound('Бот не найден');
    if (bot.owner_id !== auth.userId) throw errors.forbidden('Не ваш бот');
    const body = z.object({
      displayName: z.string().min(1).max(64).optional(),
      webhookUrl: z.string().url().nullable().optional(),
      longPolling: z.boolean().optional(),
      enabled: z.boolean().optional(),
      commands: z.array(z.object({ command: z.string().max(32), description: z.string().max(200) })).max(30).optional(),
    }).parse(req.body);
    run(
      `UPDATE bots SET display_name = COALESCE(?, display_name), webhook_url = COALESCE(?, webhook_url),
        long_polling = COALESCE(?, long_polling), enabled = COALESCE(?, enabled), commands = COALESCE(?, commands)
       WHERE id = ?`,
      [
        body.displayName ?? null, body.webhookUrl === undefined ? null : body.webhookUrl,
        body.longPolling === undefined ? null : body.longPolling ? 1 : 0,
        body.enabled === undefined ? null : body.enabled ? 1 : 0,
        body.commands ? JSON.stringify(body.commands) : null, id,
      ],
    );
    reply.send({ status: 'ok' });
  });

  app.delete('/bots/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const bot = get<{ owner_id: string }>('SELECT owner_id FROM bots WHERE id = ?', [id]);
    if (!bot) throw errors.notFound('Бот не найден');
    if (bot.owner_id !== auth.userId) throw errors.forbidden('Не ваш бот');
    run('DELETE FROM bots WHERE id = ?', [id]);
    run('UPDATE users SET deleted_at = ? WHERE id = ?', [now(), id]);
    reply.send({ status: 'ok' });
  });

  app.post('/bots/:id/token', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const bot = get<{ owner_id: string; username: string }>('SELECT owner_id, username FROM bots WHERE id = ?', [id]);
    if (!bot) throw errors.notFound('Бот не найден');
    if (bot.owner_id !== auth.userId) throw errors.forbidden('Не ваш бот');
    const token = `${bot.username}:${randomBytes(24).toString('base64url')}`;
    run('UPDATE bots SET token_hash = ?, token_hint = ? WHERE id = ?', [sha256(token), token.slice(0, 12), id]);
    reply.send({ token });
  });

  // ---- Bot API (по токену) ----
  const botScope = '/bot/:token';
  const tokenSchema = z.object({ token: z.string().min(10).max(200) });

  app.get(`${botScope}/getMe`, async (req, reply) => {
    const { token } = tokenSchema.parse(req.params);
    const bot = botByToken(token);
    if (!bot) throw errors.unauthorized('Неверный токен бота');
    reply.send({ ok: true, result: { id: bot.id, username: bot.username, display_name: bot.display_name, commands: JSON.parse(bot.commands || '[]') } });
  });

  app.get(`${botScope}/getUpdates`, async (req, reply) => {
    const { token } = tokenSchema.parse(req.params);
    const bot = botByToken(token);
    if (!bot) throw errors.unauthorized('Неверный токен бота');
    const offset = z.object({ offset: z.coerce.number().optional(), limit: z.coerce.number().min(1).max(100).default(50) }).parse(req.query ?? {});
    const rows = all<{ id: number; payload: string }>(
      'SELECT id, payload FROM bot_updates WHERE bot_id = ? AND id > ? ORDER BY id LIMIT ?',
      [bot.id, offset.offset ?? 0, offset.limit],
    );
    if (rows.length) {
      run(`UPDATE bot_updates SET consumed_at = ? WHERE bot_id = ? AND id <= ?`, [now(), bot.id, rows[rows.length - 1]!.id]);
    }
    reply.send({ ok: true, result: rows.map((r) => ({ update_id: r.id, ...JSON.parse(r.payload) })) });
  });

  app.post(`${botScope}/sendMessage`, async (req, reply) => {
    const { token } = tokenSchema.parse(req.params);
    const bot = botByToken(token);
    if (!bot || !bot.enabled) throw errors.unauthorized('Бот недоступен');
    const body = botMessageSchema.parse(req.body);
    const chat = get<{ id: string; type: string }>('SELECT id, type FROM chats WHERE id = ? AND deleted_at IS NULL', [body.chat_id]);
    if (!chat) throw errors.notFound('Чат не найден');
    const member = getMembership(chat.id, bot.id);
    if (!member) throw errors.forbidden('Бот не добавлен в этот чат');
    const row = insertMessage({ chatId: chat.id, senderId: bot.id, text: body.text ?? '', viaBotId: bot.id });
    const message = { ...row };
    emitToChat(chat.id, 'message:new', {
      message: {
        id: row.id, chatId: row.chat_id, seq: row.seq, senderId: bot.id,
        sender: { id: bot.id, username: bot.username, displayName: bot.display_name, avatarUrl: null },
        authorSignature: null, text: row.text, entities: [], attachments: [], poll: null, replyToId: null, replyTo: null,
        forwardedFrom: null, createdAt: row.created_at, editedAt: null, deletedAt: null, pinned: false, silent: false,
        viaBotId: bot.id, reactions: [], deliveredToAll: false, readByAll: false,
        clientMessageId: null, threadRootId: null, isOutgoing: false,
      },
      chat: toChatSummary(chat as never, member),
    });
    void message;
    reply.send({ ok: true, result: { message_id: row.id, seq: row.seq } });
  });

  app.post(`${botScope}/answerCallbackQuery`, async (req, reply) => {
    const { token } = tokenSchema.parse(req.params);
    const bot = botByToken(token);
    if (!bot) throw errors.unauthorized('Неверный токен бота');
    const body = z.object({ callback_query_id: z.string(), text: z.string().max(200).optional() }).parse(req.body);
    queueUpdate(bot.id, { type: 'callback_answer', callback_query_id: body.callback_query_id, text: body.text });
    reply.send({ ok: true });
  });

  /** Пользователь вызывает команду бота: создаёт апдейт для long polling/webhook. */
  app.post('/bots/:username/invoke', async (req, reply) => {
    const auth = requireAuth(req);
    const { username } = z.object({ username: z.string() }).parse(req.params);
    const body = z.object({ command: z.string().min(1).max(64), text: z.string().max(4096).optional(), chatId: z.string().optional() }).parse(req.body);
    const bot = get<{ id: string; owner_id: string; username: string }>('SELECT id, owner_id, username FROM bots WHERE username = ? COLLATE NOCASE', [normalizeUsername(username)]);
    if (!bot) throw errors.notFound('Бот не найден');
    const { chat } = ensurePrivateChat(auth.userId, bot.id);
    queueUpdate(bot.id, {
      type: 'message',
      from: { id: auth.userId },
      chat: { id: chat.id },
      text: `/${body.command}${body.text ? ` ${body.text}` : ''}`,
      date: Math.floor(Date.now() / 1000),
    });
    reply.send({ status: 'queued', chatId: chat.id });
    void getUserById;
  });
}
