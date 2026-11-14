import type { FastifyInstance } from 'fastify';
import { Server as SocketServer, type Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData, Message } from '@elian/shared';
import { env } from '../config/env.js';
import { getMembership, getChat, toChatSummary, isMember, type ChatRow } from '../services/chats.js';
import { insertMessage, markRead, serializeMessage, canSendHelper } from '../services/messages-realtime.js';
import { reactionSummaries } from '../services/messages.js';
import { resolveSessionToken } from '../auth/sessions.js';
import { pendingStatusForClient } from '../auth/pending.js';
import { touchLastSeen } from '../services/users.js';
import { bus } from '../lib/bus.js';
import { info, warn } from '../lib/log.js';
import { all, run } from '../db/index.js';
import { now } from '../lib/time.js';
import { verifyApprovalSecretFor } from '../auth/pending.js';

let ioRef: SocketServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData> | null = null;

export function getIo() {
  return ioRef;
}

export function emitToChat(chatId: string, event: keyof ServerToClientEvents, payload: unknown): void {
  if (!ioRef) return;
  (ioRef.to(`chat:${chatId}`) as unknown as { emit: (e: string, p: unknown) => void }).emit(event, payload);
}

/**
 * Доставка нового сообщения каждому участнику персонально (user-room), а не только
 * подписчикам открытого чата: иначе у получателя не обновляется список чатов и счётчик.
 */
export function emitMessageToMembers(chatId: string, row: Parameters<typeof serializeMessage>[0], chat: ChatRow): void {
  const members = all<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = ? AND banned = 0', [chatId]);
  for (const entry of members) {
    const member = getMembership(chatId, entry.user_id);
    if (!member) continue;
    emitToUser(entry.user_id, 'message:new', {
      message: serializeMessage(row, entry.user_id),
      chat: toChatSummary(chat, member),
    });
  }
}

/**
 * Событие всем участникам чата персонально (user-room): работает даже если у получателя
 * чат не открыт — иначе правки, удаления и реакции «теряются» в списке.
 */
export function emitToChatMembers(chatId: string, event: keyof ServerToClientEvents, payload: unknown): void {
  const members = all<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = ? AND banned = 0', [chatId]);
  for (const entry of members) emitToUser(entry.user_id, event, payload);
}

/** Правка сообщения: каждому участнику своя сериализация (isOutgoing у всех разный). */
export function emitMessageEditToMembers(chatId: string, row: Parameters<typeof serializeMessage>[0]): void {
  const members = all<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = ? AND banned = 0', [chatId]);
  for (const entry of members) {
    emitToUser(entry.user_id, 'message:edited', { message: serializeMessage(row, entry.user_id) });
  }
}

/** Изменение реакций: byMe пересчитывается для каждого получателя. */
export function emitReactionsToMembers(chatId: string, messageId: string): void {
  const members = all<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = ? AND banned = 0', [chatId]);
  for (const entry of members) {
    emitToUser(entry.user_id, 'reaction:changed', {
      chatId,
      messageId,
      reactions: reactionSummaries(messageId, entry.user_id),
    });
  }
}

/** Обновление карточки чата для конкретного пользователя (создание чата, права, закрепления). */
export function emitChatToUser(userId: string, chatId: string): void {
  const chat = getChat(chatId);
  const member = getMembership(chatId, userId);
  if (!chat || !member) return;
  emitToUser(userId, 'chat:updated', { chat: toChatSummary(chat, member) });
}

/** Оповещает всех участников об изменении карточки чата. */
export function emitChatToMembers(chatId: string): void {
  const members = all<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = ? AND banned = 0', [chatId]);
  for (const entry of members) emitChatToUser(entry.user_id, chatId);
}

export function emitToUser(userId: string, event: keyof ServerToClientEvents, payload: unknown): void {
  if (!ioRef) return;
  (ioRef.to(`user:${userId}`) as unknown as { emit: (e: string, p: unknown) => void }).emit(event, payload);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** Список пользователей, состоящих с данным в общих чатах (для presence). */
function presenceAudience(userId: string): string[] {
  const rows = all<{ user_id: string }>(
    `SELECT DISTINCT m2.user_id FROM chat_members m1
     JOIN chat_members m2 ON m2.chat_id = m1.chat_id
     WHERE m1.user_id = ? AND m2.user_id <> ?`,
    [userId, userId],
  );
  return rows.map((r) => r.user_id);
}

export function attachRealtime(app: FastifyInstance) {
  const io = new SocketServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(app.server, {
    path: '/socket.io',
    serveClient: false,
    maxHttpBufferSize: 1e6,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (env.allowedOrigins.includes(origin)) return callback(null, true);
        try {
          const host = new URL(origin).hostname;
          if (host.endsWith('trycloudflare.com')) return callback(null, true);
        } catch { /* ignore */ }
        const publicHost = env.publicUrl ? new URL(env.publicUrl).host : '';
        try {
          if (publicHost && new URL(origin).host === publicHost) return callback(null, true);
        } catch { /* ignore */ }
        callback(new Error('origin_not_allowed'));
      },
      credentials: true,
    },
  });
  ioRef = io;

  io.use((socket, next) => {
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const auth = resolveSessionToken(cookies[env.sessionCookieName]);
    if (!auth) {
      // Анонимное соединение разрешено только для наблюдения за pending-запросом.
      socket.data.userId = undefined;
      next();
      return;
    }
    socket.data.userId = auth.userId;
    socket.data.sessionId = auth.session.id;
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    if (userId) {
      socket.join(`user:${userId}`);
      touchLastSeen(userId);
      for (const peerId of presenceAudience(userId)) {
        emitToUser(peerId, 'presence:changed', { userId, online: true, lastSeenAt: now() });
      }
      // Автоподписка на все чаты пользователя.
      for (const row of all<{ chat_id: string }>('SELECT chat_id FROM chat_members WHERE user_id = ? AND banned = 0', [userId])) {
        socket.join(`chat:${row.chat_id}`);
      }
    }

    socket.on('auth:watch_pending', ({ requestId }, ack) => {
      // Наблюдение за статусом требует approval secret, проверяем его сразу.
      const secret = (socket.handshake.auth as { pendingSecret?: string })?.pendingSecret;
      if (!secret) {
        ack?.(false);
        return;
      }
      try {
        pendingStatusForClient(requestId, secret);
        socket.join(`pending:${requestId}`);
        ack?.(true);
      } catch {
        ack?.(false);
      }
    });

    socket.on('chat:subscribe', ({ chatId }, ack) => {
      if (!userId || !isMember(chatId, userId)) {
        ack?.(false);
        return;
      }
      socket.join(`chat:${chatId}`);
      ack?.(true);
    });

    socket.on('chat:unsubscribe', ({ chatId }) => {
      socket.leave(`chat:${chatId}`);
    });

    socket.on('typing', ({ chatId, kind }) => {
      if (!userId || !isMember(chatId, userId)) return;
      socket.to(`chat:${chatId}`).emit('typing', { chatId, userId, kind });
    });

    socket.on('receipt:read', ({ chatId, upToSeq }) => {
      if (!userId) return;
      const member = getMembership(chatId, userId);
      if (!member) return;
      const seq = markRead(chatId, userId, upToSeq, member);
      socket.to(`chat:${chatId}`).emit('receipt', {
        chatId, messageIds: [], userId, kind: 'read', at: now(),
      });
      void seq;
    });

    socket.on('message:send', (payload, ack) => {
      if (!userId) {
        ack?.({ ok: false, error: 'unauthorized' });
        return;
      }
      try {
        const chat = getChat(payload.chatId);
        if (!chat) throw new Error('chat_not_found');
        const member = getMembership(payload.chatId, userId);
        if (!member || member.banned) throw new Error('forbidden');
        if (!canSendHelper(chat, member)) throw new Error('forbidden');
        const row = insertMessage({
          chatId: payload.chatId,
          senderId: userId,
          text: payload.text,
          clientMessageId: payload.clientMessageId,
        });
        emitMessageToMembers(payload.chatId, row, chat);
        ack?.({ ok: true, seq: row.seq });
      } catch (err) {
        ack?.({ ok: false, error: (err as Error).message });
      }
    });

    socket.on('call:signal', ({ callId, to, kind, data }) => {
      if (!userId) return;
      emitToUser(to, 'call:signal', { callId, from: userId, kind, data });
    });

    socket.on('presence:ping', () => {
      if (userId) touchLastSeen(userId);
    });

    socket.on('disconnect', () => {
      if (!userId) return;
      const stillOnline = io.sockets.adapter.rooms.get(`user:${userId}`)?.size ?? 0;
      if (stillOnline > 0) return;
      const stamp = now();
      run('UPDATE users SET last_seen_at = ? WHERE id = ?', [stamp, userId]);
      for (const peerId of presenceAudience(userId)) {
        emitToUser(peerId, 'presence:changed', { userId, online: false, lastSeenAt: stamp });
      }
    });

    socket.on('error', (err) => warn('socket error', { message: (err as Error).message }));
  });

  bus.onEvent('pending:changed', ({ requestId, status }) => {
    io.to(`pending:${requestId}`).emit('auth:pending_status', { requestId, status });
  });
  bus.onEvent('session:revoked', ({ userId, sessionId }) => {
    emitToUser(userId, 'auth:session_revoked', { sessionId });
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.userId === userId && socket.data.sessionId === sessionId) socket.disconnect(true);
    }
  });

  info('Socket.IO готов', { path: '/socket.io' });
  return io;
}

export type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/** Помощник для отложенной/серверной отправки сообщений во все подключённые клиенты чата. */
export function broadcastMessage(message: Message): void {
  emitToChat(message.chatId, 'message:new', { message, chat: null });
}

export { verifyApprovalSecretFor };
