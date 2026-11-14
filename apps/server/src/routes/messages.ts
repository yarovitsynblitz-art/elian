import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseEntities } from '@elian/shared';
import { all, get, run } from '../db/index.js';
import { errors } from '../lib/errors.js';
import { requireAuth } from '../auth/sessions.js';
import {
  canSend, getChat, getMembership, requireChat, requireMembership, requirePermission, toChatSummary,
} from '../services/chats.js';
import {
  closePoll, deleteMessage, editMessage, getMessageRow, insertMessage, listMessages, markRead, pinMessage,
  serializeMessage, toggleReaction, votePoll, type AttachmentInput,
} from '../services/messages.js';
import { getMessageRow as getRow } from '../services/messages.js';
import { now, plusMinutes } from '../lib/time.js';
import { audit } from '../lib/audit.js';
import { enforce, RULES } from '../lib/rate-limit.js';
import { emitToChatMembers, emitMessageEditToMembers, emitMessageToMembers, emitReactionsToMembers } from '../realtime/index.js';
import { mutualBlocked, userSettings, getUserById } from '../services/users.js';
import { normalizeUsername } from '@elian/shared';

const attachmentSchema = z.object({
  kind: z.enum(['photo', 'video', 'audio', 'voice', 'video_note', 'file', 'sticker', 'gif', 'location', 'contact', 'poll']),
  mediaId: z.string().min(10).nullable().optional(),
  thumbMediaId: z.string().min(10).nullable().optional(),
  fileName: z.string().max(200).nullable().optional(),
  mimeType: z.string().max(120).nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
  width: z.number().int().nullable().optional(),
  height: z.number().int().nullable().optional(),
  duration: z.number().nonnegative().nullable().optional(),
  waveform: z.array(z.number().min(0).max(100)).max(120).nullable().optional(),
  spoiler: z.boolean().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  contactName: z.string().max(120).nullable().optional(),
  contactUsername: z.string().max(64).nullable().optional(),
  pollId: z.string().nullable().optional(),
});

const sendSchema = z.object({
  text: z.string().max(4096).optional(),
  attachments: z.array(attachmentSchema).max(10).optional(),
  replyToId: z.string().nullable().optional(),
  threadRootId: z.string().nullable().optional(),
  silent: z.boolean().optional(),
  clientMessageId: z.string().min(1).max(80).optional(),
  poll: z.object({
    question: z.string().min(1).max(255),
    options: z.array(z.string().min(1).max(100)).min(2).max(10),
    anonymous: z.boolean().optional(),
    multiple: z.boolean().optional(),
    quiz: z.boolean().optional(),
    correctOptionId: z.string().nullable().optional(),
  }).nullable().optional(),
  scheduleAt: z.string().datetime().nullable().optional(),
});

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/chats/:id/messages', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    requireMembership(id, auth.userId);
    const query = z.object({
      beforeSeq: z.coerce.number().int().positive().optional(),
      afterSeq: z.coerce.number().int().nonnegative().optional(),
      aroundSeq: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      threadRootId: z.string().optional(),
    }).parse(req.query);
    reply.send(listMessages({ chatId: id, viewerId: auth.userId, ...query }));
  });

  app.post('/chats/:id/messages', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const chat = requireChat(id);
    const member = requireMembership(id, auth.userId);
    enforce(`message:${auth.userId}`, RULES.message);
    const body = sendSchema.parse(req.body);
    if (chat.type === 'private') {
      const peer = get<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id <> ?', [id, auth.userId]);
      if (peer && mutualBlocked(auth.userId, peer.user_id)) throw errors.forbidden('Пользователь вас заблокировал');
    }
    const hasMedia = (body.attachments?.length ?? 0) > 0;
    if (!canSend(chat, member, hasMedia ? 'media' : 'text')) throw errors.forbidden('Отправка сообщений ограничена');
    // Slow mode
    if (chat.slow_mode_seconds > 0 && member.role === 'member') {
      const last = get<{ created_at: string }>('SELECT created_at FROM messages WHERE chat_id = ? AND sender_id = ? ORDER BY seq DESC LIMIT 1', [id, auth.userId]);
      if (last && Date.now() - new Date(last.created_at).getTime() < chat.slow_mode_seconds * 1000) {
        throw errors.tooMany('Включён медленный режим. Подождите немного.');
      }
    }
    if (body.scheduleAt) {
      const when = new Date(body.scheduleAt);
      if (when.getTime() < Date.now() + 30_000) throw errors.badRequest('Время отправки должно быть в будущем');
      const scheduledId = globalThis.crypto.randomUUID();
      run(
        `INSERT INTO scheduled_messages(id, chat_id, sender_id, text, silent, send_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [scheduledId, id, auth.userId, body.text ?? '', body.silent ? 1 : 0, when.toISOString(), now()],
      );
      reply.code(202).send({ status: 'scheduled', scheduledId, sendAt: when.toISOString() });
      return;
    }
    const authorSignature = chat.type === 'channel' && chat.signature_enabled
      ? (getUserById(auth.userId)?.display_name ?? null)
      : null;
    const row = insertMessage({
      chatId: id,
      senderId: auth.userId,
      text: body.text ?? '',
      attachments: (body.attachments ?? []) as AttachmentInput[],
      replyToId: body.replyToId ?? null,
      threadRootId: body.threadRootId ?? null,
      silent: body.silent,
      clientMessageId: body.clientMessageId ?? null,
      poll: body.poll ?? null,
      authorSignature,
    });
    const message = serializeMessage(row, auth.userId);
    const summary = toChatSummary(requireChat(id), member);
    emitMessageToMembers(id, row, chat);
    reply.code(201).send({ message, chat: summary });
  });

  app.patch('/messages/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const body = z.object({ text: z.string().min(1).max(4096) }).parse(req.body);
    const row = getRow(id);
    if (!row) throw errors.notFound('Сообщение не найдено');
    const member = requireMembership(row.chat_id, auth.userId);
    const chat = requireChat(row.chat_id);
    const perms = member.role !== 'member';
    const updated = editMessage(id, auth.userId, body.text, perms);
    const message = serializeMessage(updated, auth.userId);
    emitMessageEditToMembers(row.chat_id, updated);
    audit({ actorId: auth.userId, action: 'message.edited', targetType: 'message', targetId: id });
    void chat;
    reply.send({ message });
  });

  app.delete('/messages/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const query = z.object({ forEveryone: z.enum(['0', '1']).optional() }).parse(req.query ?? {});
    const row = getRow(id);
    if (!row) throw errors.notFound('Сообщение не найдено');
    const member = requireMembership(row.chat_id, auth.userId);
    const result = deleteMessage(id, auth.userId, query.forEveryone !== '0', member.role !== 'member');
    emitToChatMembers(row.chat_id, 'message:deleted', { chatId: row.chat_id, messageId: id, forEveryone: result.forEveryone });
    audit({ actorId: auth.userId, action: 'message.deleted', targetType: 'message', targetId: id });
    reply.send({ status: 'ok' });
  });

  app.post('/messages/:id/reactions', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const body = z.object({ emoji: z.string().min(1).max(16), active: z.boolean() }).parse(req.body);
    enforce(`reaction:${auth.userId}`, RULES.reaction);
    const row = getRow(id);
    if (!row) throw errors.notFound('Сообщение не найдено');
    requireMembership(row.chat_id, auth.userId);
    const reactions = toggleReaction(id, auth.userId, body.emoji, body.active);
    emitReactionsToMembers(row.chat_id, id);
    reply.send({ reactions });
  });

  app.post('/messages/:id/pin', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const body = z.object({ pinned: z.boolean() }).parse(req.body);
    const row = getRow(id);
    if (!row) throw errors.notFound('Сообщение не найдено');
    const chat = requireChat(row.chat_id);
    const member = requireMembership(row.chat_id, auth.userId);
    if (chat.type !== 'private') requirePermission(chat, member, 'pinMessages');
    const updated = pinMessage(id, body.pinned);
    const message = serializeMessage(updated, auth.userId);
    emitToChatMembers(row.chat_id, 'chat:updated', { chat: toChatSummary(chat, member) });
    reply.send({ message });
  });

  app.post('/messages/forward', async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({
      messageIds: z.array(z.string().min(10)).min(1).max(20),
      toChatId: z.string().min(10),
      hideAuthor: z.boolean().optional(),
    }).parse(req.body);
    const target = requireChat(body.toChatId);
    const targetMember = requireMembership(body.toChatId, auth.userId);
    if (!canSend(target, targetMember)) throw errors.forbidden('Нет прав на отправку в этот чат');
    const created = [];
    for (const messageId of body.messageIds) {
      const source = getRow(messageId);
      if (!source || source.deleted_at) continue;
      const sourceMember = getMembership(source.chat_id, auth.userId);
      if (!sourceMember || sourceMember.banned) continue;
      const sourceChat = requireChat(source.chat_id);
      const sourceSender = source.sender_id ? getUserById(source.sender_id) : null;
      const senderSettings = sourceSender ? userSettings(sourceSender) : null;
      if (senderSettings && !senderSettings.privacy.forwarding) throw errors.forbidden('Автор запретил пересылку своих сообщений');
      const attachments = all<{ kind: string; media_id: string | null; thumb_media_id: string | null; file_name: string | null; mime_type: string | null; size: number | null; width: number | null; height: number | null; duration: number | null; waveform: string | null; spoiler: number }>(
        'SELECT * FROM attachments WHERE message_id = ? ORDER BY position', [messageId],
      ).map((a) => ({
        kind: a.kind as AttachmentInput['kind'],
        mediaId: a.media_id,
        thumbMediaId: a.thumb_media_id,
        fileName: a.file_name,
        mimeType: a.mime_type,
        size: a.size,
        width: a.width,
        height: a.height,
        duration: a.duration,
        waveform: a.waveform ? JSON.parse(a.waveform) : null,
        spoiler: Boolean(a.spoiler),
      }));
      const row = insertMessage({
        chatId: body.toChatId,
        senderId: auth.userId,
        text: source.text,
        attachments,
        forwardedFrom: body.hideAuthor ? null : {
          chatId: sourceChat.type === 'private' ? null : source.chat_id,
          userId: source.sender_id,
          name: sourceChat.type === 'private' ? (sourceSender?.display_name ?? 'Пользователь') : (sourceChat.title ?? 'Чат'),
        },
      });
      created.push(row);
    }
    if (!created.length) throw errors.badRequest('Нечего пересылать');
    const summary = toChatSummary(requireChat(body.toChatId), targetMember);
    const targetChat = requireChat(body.toChatId);
    for (const row of created) emitMessageToMembers(body.toChatId, row, targetChat);
    reply.code(201).send({ messages: created.map((r) => serializeMessage(r, auth.userId)), chat: summary });
  });

  app.post('/chats/:id/read', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const member = requireMembership(id, auth.userId);
    const body = z.object({ upToSeq: z.number().int().nonnegative() }).parse(req.body);
    const seq = markRead(id, auth.userId, body.upToSeq, member);
    emitToChatMembers(id, 'receipt', { chatId: id, messageIds: [], userId: auth.userId, kind: 'read', at: now() });
    reply.send({ status: 'ok', upToSeq: seq });
  });

  app.post('/chats/:id/delivered', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    requireMembership(id, auth.userId);
    const body = z.object({ upToSeq: z.number().int().nonnegative() }).parse(req.body);
    run('UPDATE chat_members SET last_delivered_seq = max(last_delivered_seq, ?) WHERE chat_id = ? AND user_id = ?', [body.upToSeq, id, auth.userId]);
    reply.send({ status: 'ok' });
  });

  app.post('/chats/:id/typing', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    requireMembership(id, auth.userId);
    const body = z.object({ kind: z.enum(['typing', 'voice', 'upload', 'stop']).default('typing') }).parse(req.body ?? {});
    emitToChatMembers(id, 'typing', { chatId: id, userId: auth.userId, kind: body.kind });
    reply.send({ status: 'ok' });
  });

  app.get('/chats/:id/search', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    requireMembership(id, auth.userId);
    enforce(`search:${auth.userId}`, RULES.search);
    const q = z.object({
      q: z.string().min(1).max(100),
      from: z.string().optional(),
      kind: z.enum(['photo', 'video', 'file', 'audio', 'voice', 'link']).optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      limit: z.coerce.number().min(1).max(50).default(20),
    }).parse(req.query);
    let rows: Array<{ id: string }> = [];
    if (q.kind === 'link') {
      rows = all<{ id: string }>(
        `SELECT id FROM messages WHERE chat_id = ? AND deleted_at IS NULL AND text LIKE '%http%' ORDER BY seq DESC LIMIT ?`,
        [id, q.limit],
      );
    } else if (q.kind) {
      rows = all<{ id: string }>(
        `SELECT m.id FROM messages m JOIN attachments a ON a.message_id = m.id
         WHERE m.chat_id = ? AND m.deleted_at IS NULL AND a.kind = ? ORDER BY m.seq DESC LIMIT ?`,
        [id, q.kind, q.limit],
      );
    } else {
      const matchQuery = q.q.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '')}"*`).join(' ');
      rows = all<{ id: string }>(
        `SELECT m.id FROM messages_fts f JOIN messages m ON m.id = f.message_id
         WHERE f.chat_id = ? AND messages_fts MATCH ? AND m.deleted_at IS NULL
         ORDER BY m.seq DESC LIMIT ?`,
        [id, matchQuery, q.limit],
      );
      if (!rows.length) {
        rows = all<{ id: string }>(
          'SELECT id FROM messages WHERE chat_id = ? AND text LIKE ? AND deleted_at IS NULL ORDER BY seq DESC LIMIT ?',
          [id, `%${q.q}%`, q.limit],
        );
      }
    }
    const messages = rows
      .map((r) => getRow(r.id))
      .filter(Boolean)
      .filter((row) => {
        if (q.from && row!.sender_id !== q.from) return false;
        if (q.dateFrom && row!.created_at < q.dateFrom) return false;
        if (q.dateTo && row!.created_at > q.dateTo) return false;
        return true;
      })
      .map((row) => serializeMessage(row!, auth.userId));
    reply.send({ messages });
  });

  app.get('/chats/:id/media', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    requireMembership(id, auth.userId);
    const kind = z.object({ kind: z.string().optional() }).parse(req.query);
    const rows = all<{ message_id: string; id: string }>(
      `SELECT a.message_id, a.id FROM attachments a JOIN messages m ON m.id = a.message_id
       WHERE m.chat_id = ? AND m.deleted_at IS NULL ${kind.kind ? 'AND a.kind = ?' : ''}
       ORDER BY m.seq DESC LIMIT 100`,
      kind.kind ? [id, kind.kind] : [id],
    );
    const messages = Array.from(new Set(rows.map((r) => r.message_id)))
      .map((mid) => getRow(mid))
      .filter(Boolean)
      .map((row) => serializeMessage(row!, auth.userId));
    reply.send({ messages });
  });

  // ---- Опросы ----
  app.post('/polls/:id/vote', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const body = z.object({ optionIds: z.array(z.string()).min(1).max(10) }).parse(req.body);
    const poll = get<{ chat_id: string }>('SELECT chat_id FROM polls WHERE id = ?', [id]);
    if (!poll) throw errors.notFound('Опрос не найден');
    requireMembership(poll.chat_id, auth.userId);
    const result = votePoll(id, auth.userId, body.optionIds);
    emitToChatMembers(poll.chat_id, 'chat:updated', { chat: toChatSummary(requireChat(poll.chat_id), getMembership(poll.chat_id, auth.userId)!) });
    reply.send({ poll: result });
  });

  app.post('/polls/:id/close', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const result = closePoll(id, auth.userId);
    reply.send({ poll: result });
  });

  // ---- Черновики ----
  app.put('/chats/:id/draft', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    requireMembership(id, auth.userId);
    const body = z.object({ text: z.string().max(4096), replyToId: z.string().nullable().optional() }).parse(req.body);
    const settings = userSettings(getUserById(auth.userId)!);
    if (!settings.chats.drafts) {
      reply.send({ status: 'ignored' });
      return;
    }
    if (!body.text.trim()) {
      run('DELETE FROM drafts WHERE user_id = ? AND chat_id = ?', [auth.userId, id]);
    } else {
      run(
        `INSERT INTO drafts(user_id, chat_id, text, reply_to_id, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, chat_id) DO UPDATE SET text = excluded.text, reply_to_id = excluded.reply_to_id, updated_at = excluded.updated_at`,
        [auth.userId, id, body.text, body.replyToId ?? null, now()],
      );
    }
    reply.send({ status: 'ok' });
  });

  // ---- Отложенные сообщения ----
  app.get('/messages/scheduled/list', async (req, reply) => {
    const auth = requireAuth(req);
    const rows = all<{ id: string; chat_id: string; text: string; send_at: string; status: string }>(
      `SELECT id, chat_id, text, send_at, status FROM scheduled_messages
       WHERE sender_id = ? AND status = 'pending' ORDER BY send_at`,
      [auth.userId],
    );
    reply.send({ scheduled: rows });
  });

  app.delete('/messages/scheduled/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(8) }).parse(req.params);
    const result = run(`UPDATE scheduled_messages SET status = 'cancelled' WHERE id = ? AND sender_id = ? AND status = 'pending'`, [id, auth.userId]);
    if (!result.changes) throw errors.notFound('Отложенное сообщение не найдено');
    reply.send({ status: 'ok' });
  });

  void plusMinutes;
  void normalizeUsername;
  void parseEntities;
  void errors;
}
