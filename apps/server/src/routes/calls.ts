import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get, run } from '../db/index.js';
import { errors } from '../lib/errors.js';
import { requireAuth } from '../auth/sessions.js';
import { now, secondsBetween } from '../lib/time.js';
import { env } from '../config/env.js';
import { getMembership, ensurePrivateChat, requireChat } from '../services/chats.js';
import { emitToUser } from '../realtime/index.js';
import { getUserById, toPublicUser, userSettings } from '../services/users.js';
import { audit } from '../lib/audit.js';

export async function callRoutes(app: FastifyInstance): Promise<void> {
  /** ICE-конфигурация. Без TURN звонки работают только в благоприятных сетях. */
  app.get('/calls/config', async (_req, reply) => {
    const iceServers: Array<Record<string, unknown>> = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    let turnConfigured = false;
    if (env.turn) {
      iceServers.push({ urls: env.turn.urls, username: env.turn.username, credential: env.turn.credential });
      turnConfigured = true;
    }
    reply.send({
      iceServers,
      turnConfigured,
      warning: turnConfigured ? null : 'TURN не настроен: звонки могут не устанавливаться за симметричным NAT. См. docs/LIMITATIONS.md.',
      groupCalls: 'requires_external_service',
    });
  });

  app.post('/calls', async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({
      peerId: z.string().min(10).optional(),
      chatId: z.string().min(10).optional(),
      media: z.enum(['audio', 'video']).default('audio'),
    }).parse(req.body);
    let peerId = body.peerId ?? null;
    if (!peerId && body.chatId) {
      const chat = requireChat(body.chatId);
      if (chat.type !== 'private') throw errors.badRequest('Групповые звонки требуют внешнего SFU (см. LIMITATIONS.md)');
      const peer = get<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id <> ?', [body.chatId, auth.userId]);
      peerId = peer?.user_id ?? null;
    }
    if (!peerId) throw errors.badRequest('Не указан собеседник');
    if (peerId === auth.userId) throw errors.badRequest('Нельзя позвонить себе');
    const peerUser = getUserById(peerId);
    if (!peerUser) throw errors.notFound('Пользователь не найден');
    const peerSettings = userSettings(peerUser);
    if (peerSettings.privacy.calls === 'nobody') throw errors.forbidden('Пользователь запретил звонки');
    if (peerSettings.privacy.calls === 'contacts' && !get('SELECT 1 FROM contacts WHERE owner_id = ? AND contact_id = ?', [peerId, auth.userId])) {
      throw errors.forbidden('Пользователь принимает звонки только от контактов');
    }
    const { chat } = ensurePrivateChat(auth.userId, peerId);
    const id = globalThis.crypto.randomUUID();
    run(
      `INSERT INTO calls(id, chat_id, initiator_id, peer_id, media, status, started_at) VALUES (?, ?, ?, ?, ?, 'ringing', ?)`,
      [id, chat.id, auth.userId, peerId, body.media, now()],
    );
    run('INSERT INTO call_participants(call_id, user_id, state) VALUES (?, ?, ?)', [id, auth.userId, 'joined']);
    run('INSERT INTO call_participants(call_id, user_id, state) VALUES (?, ?, ?)', [id, peerId, 'invited']);
    emitToUser(peerId, 'call:state', {
      id, chatId: chat.id, peer: toPublicUser(peerId, getUserById(auth.userId)!),
      direction: 'incoming', media: body.media, status: 'ringing', startedAt: now(), endedAt: null, durationSeconds: 0, endReason: null,
    });
    audit({ actorId: auth.userId, action: 'call.started', targetType: 'call', targetId: id, metadata: { media: body.media } });
    reply.code(201).send({
      call: {
        id, chatId: chat.id, peer: toPublicUser(auth.userId, peerUser), direction: 'outgoing', media: body.media,
        status: 'ringing', startedAt: now(), endedAt: null, durationSeconds: 0, endReason: null,
      },
    });
  });

  app.post('/calls/:id/answer', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const call = get<{ id: string; peer_id: string; status: string; started_at: string; chat_id: string }>('SELECT * FROM calls WHERE id = ?', [id]);
    if (!call) throw errors.notFound('Звонок не найден');
    if (call.peer_id !== auth.userId) throw errors.forbidden('Не ваш звонок');
    if (call.status !== 'ringing') throw errors.badRequest('Звонок уже обработан');
    run(`UPDATE calls SET status = 'active', answered_at = ? WHERE id = ?`, [now(), id]);
    run(`UPDATE call_participants SET state = 'joined', joined_at = ? WHERE call_id = ? AND user_id = ?`, [now(), id, auth.userId]);
    reply.send({ status: 'ok' });
  });

  app.post('/calls/:id/end', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const body = z.object({ reason: z.enum(['hangup', 'decline', 'busy', 'timeout', 'no_turn', 'ice_failed', 'aborted']).default('hangup') }).parse(req.body ?? {});
    const call = get<{ id: string; initiator_id: string; peer_id: string; status: string; answered_at: string | null; started_at: string }>('SELECT * FROM calls WHERE id = ?', [id]);
    if (!call) throw errors.notFound('Звонок не найден');
    if (call.initiator_id !== auth.userId && call.peer_id !== auth.userId) throw errors.forbidden('Не ваш звонок');
    const endedAt = now();
    const duration = call.answered_at ? secondsBetween(call.answered_at, endedAt) : 0;
    const status = call.status === 'ringing' ? (body.reason === 'decline' ? 'declined' : 'missed') : 'ended';
    run('UPDATE calls SET status = ?, ended_at = ?, duration_seconds = ?, end_reason = ? WHERE id = ?', [status, endedAt, duration, body.reason, id]);
    run('UPDATE call_participants SET state = ?, left_at = ? WHERE call_id = ?', [status, endedAt, id]);
    const other = call.initiator_id === auth.userId ? call.peer_id : call.initiator_id;
    emitToUser(other, 'call:state', {
      id, chatId: null, peer: null, direction: 'incoming', media: 'audio', status: status as never,
      startedAt: call.started_at, endedAt, durationSeconds: duration, endReason: body.reason,
    });
    audit({ actorId: auth.userId, action: 'call.ended', targetType: 'call', targetId: id, metadata: { reason: body.reason, duration } });
    reply.send({ status: 'ok', durationSeconds: duration });
  });

  app.get('/calls/history', async (req, reply) => {
    const auth = requireAuth(req);
    const rows = all<{ id: string; chat_id: string; initiator_id: string; peer_id: string; media: string; status: string; started_at: string; ended_at: string | null; duration_seconds: number; end_reason: string | null }>(
      `SELECT * FROM calls WHERE initiator_id = ? OR peer_id = ? ORDER BY started_at DESC LIMIT 50`,
      [auth.userId, auth.userId],
    );
    reply.send({
      calls: rows.map((r) => {
        const otherId = r.initiator_id === auth.userId ? r.peer_id : r.initiator_id;
        const other = getUserById(otherId);
        return {
          id: r.id, chatId: r.chat_id, peer: other ? toPublicUser(auth.userId, other) : null,
          direction: r.initiator_id === auth.userId ? 'outgoing' : 'incoming',
          media: r.media, status: r.status, startedAt: r.started_at, endedAt: r.ended_at,
          durationSeconds: r.duration_seconds, endReason: r.end_reason,
        };
      }),
    });
    void getMembership;
  });
}
