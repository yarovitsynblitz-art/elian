import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { DEFAULT_ADMIN_PERMISSIONS } from '@elian/shared';
import { all, get, run, tx } from '../db/index.js';
import { errors } from '../lib/errors.js';
import { requireAuth } from '../auth/sessions.js';
import {
  addMember, banMember, canManageMembers, createChat, effectivePermissions, ensurePrivateChat, getChat, getMembership,
  isMember, listChatSummaries, listMembers, recountMembers, removeMember, requireChat, requireMembership,
  requirePermission, toChatSummary, unbanMember, validateChatUsername,
} from '../services/chats.js';
import { getUserById, getUserByUsername, isBlocked, mutualBlocked, toPublicUser } from '../services/users.js';
import { now, plusMinutes } from '../lib/time.js';
import { audit } from '../lib/audit.js';
import { enforce, RULES } from '../lib/rate-limit.js';
import { sha256 } from '../lib/tokens.js';
import { emitToChat, emitChatToMembers, emitChatToUser } from '../realtime/index.js';

const createChatSchema = z.object({
  type: z.enum(['group', 'channel']),
  title: z.string().min(1).max(128),
  description: z.string().max(1024).nullable().optional(),
  username: z.string().max(40).nullable().optional(),
  isPublic: z.boolean().optional(),
  memberIds: z.array(z.string().min(10)).max(200).optional(),
});

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/chats', async (req, reply) => {
    const auth = requireAuth(req);
    const { archived } = z.object({ archived: z.enum(['0', '1']).optional() }).parse(req.query);
    const chats = listChatSummaries(auth.userId, archived === undefined ? {} : { archived: archived === '1' });
    reply.send({ chats });
  });

  app.post('/chats/private', async (req, reply) => {
    const auth = requireAuth(req);
    const body = z.object({ userId: z.string().min(10), username: z.string().optional() }).parse(req.body);
    enforce(`chat-private:${auth.userId}`, RULES.createChat);
    const peer = body.userId ? getUserById(body.userId) : body.username ? getUserByUsername(body.username) : null;
    if (!peer) throw errors.notFound('Пользователь не найден');
    if (peer.id === auth.userId) throw errors.badRequest('Нельзя открыть чат с самим собой');
    if (mutualBlocked(auth.userId, peer.id)) throw errors.forbidden('Чат недоступен: пользователь заблокирован');
    const { chat, created } = ensurePrivateChat(auth.userId, peer.id);
    const member = getMembership(chat.id, auth.userId)!;
    if (created) {
      // Собеседник должен увидеть новый чат сразу, без перезагрузки списка.
      emitChatToUser(peer.id, chat.id);
      emitChatToUser(auth.userId, chat.id);
    }
    reply.code(created ? 201 : 200).send({ chat: toChatSummary(chat, member) });
  });

  app.post('/chats', async (req, reply) => {
    const auth = requireAuth(req);
    const body = createChatSchema.parse(req.body);
    enforce(`chat-create:${auth.userId}`, RULES.createChat);
    const memberIds = (body.memberIds ?? []).filter((id) => getUserById(id) && !isBlocked(id, auth.userId));
    const chat = createChat({
      type: body.type,
      title: body.title,
      description: body.description ?? null,
      username: body.username ?? null,
      isPublic: body.isPublic ?? false,
      ownerId: auth.userId,
      memberIds,
    });
    audit({ actorId: auth.userId, action: `chat.${body.type}_created`, targetType: 'chat', targetId: chat.id });
    // Персональные карточки чата всем участникам (включая владельца).
    emitChatToMembers(chat.id);
    const member = getMembership(chat.id, auth.userId)!;
    reply.code(201).send({ chat: toChatSummary(chat, member) });
  });

  app.get('/chats/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const chat = requireChat(id);
    const member = requireMembership(id, auth.userId);
    const extra: Record<string, unknown> = {};
    if (chat.type === 'private') {
      const peerId = get<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id <> ?', [id, auth.userId]);
      if (peerId) extra.peer = toPublicUser(auth.userId, getUserById(peerId.user_id)!);
    }
    reply.send({ chat: toChatSummary(chat, member), ...extra });
  });

  app.patch('/chats/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const chat = requireChat(id);
    const member = requireMembership(id, auth.userId);
    if (chat.type !== 'private') requirePermission(chat, member, 'manageChat');
    const body = z.object({
      title: z.string().min(1).max(128).optional(),
      description: z.string().max(1024).nullable().optional(),
      username: z.string().max(40).nullable().optional(),
      isPublic: z.boolean().optional(),
      slowModeSeconds: z.number().int().min(0).max(3600).optional(),
      defaultPermissions: z.record(z.boolean()).optional(),
      signatureEnabled: z.boolean().optional(),
      discussionChatId: z.string().nullable().optional(),
    }).parse(req.body);
    if (body.username) validateChatUsername(body.username, id);
    run(
      `UPDATE chats SET title = COALESCE(?, title), description = COALESCE(?, description),
        username = COALESCE(?, username), is_public = COALESCE(?, is_public),
        slow_mode_seconds = COALESCE(?, slow_mode_seconds),
        default_permissions = COALESCE(?, default_permissions),
        signature_enabled = COALESCE(?, signature_enabled),
        discussion_chat_id = COALESCE(?, discussion_chat_id),
        updated_at = ?
       WHERE id = ?`,
      [
        body.title ?? null,
        body.description === undefined ? null : body.description,
        body.username ?? null,
        body.isPublic === undefined ? null : body.isPublic ? 1 : 0,
        body.slowModeSeconds ?? null,
        body.defaultPermissions ? JSON.stringify(body.defaultPermissions) : null,
        body.signatureEnabled === undefined ? null : body.signatureEnabled ? 1 : 0,
        body.discussionChatId === undefined ? null : body.discussionChatId,
        now(),
        id,
      ],
    );
    const updated = requireChat(id);
    audit({ actorId: auth.userId, action: 'chat.updated', targetType: 'chat', targetId: id, metadata: { fields: Object.keys(body) } });
    const summary = toChatSummary(updated, member);
    emitToChat(id, 'chat:updated', { chat: summary });
    reply.send({ chat: summary });
  });

  app.patch('/chats/:id/avatar', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const chat = requireChat(id);
    const member = requireMembership(id, auth.userId);
    requirePermission(chat, member, 'manageChat');
    const body = z.object({ mediaId: z.string().min(10) }).parse(req.body);
    run('UPDATE chats SET avatar_media_id = ?, updated_at = ? WHERE id = ?', [body.mediaId, now(), id]);
    reply.send({ chat: toChatSummary(requireChat(id), member) });
  });

  app.delete('/chats/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const chat = requireChat(id);
    const member = requireMembership(id, auth.userId);
    if (chat.type !== 'private' && member.role === 'owner') {
      run('UPDATE chats SET deleted_at = ? WHERE id = ?', [now(), id]);
      audit({ actorId: auth.userId, action: 'chat.deleted', targetType: 'chat', targetId: id });
      emitToChat(id, 'chat:removed', { chatId: id });
      reply.send({ status: 'deleted' });
      return;
    }
    removeMember(id, auth.userId);
    audit({ actorId: auth.userId, action: 'chat.left', targetType: 'chat', targetId: id });
    emitToChat(id, 'chat:removed', { chatId: id });
    reply.send({ status: 'left' });
  });

  // ---- Участники ----
  app.get('/chats/:id/members', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    requireMembership(id, auth.userId);
    const { limit, offset } = z.object({ limit: z.coerce.number().min(1).max(200).default(100), offset: z.coerce.number().min(0).default(0) }).parse(req.query);
    const rows = listMembers(id, limit, offset);
    reply.send({
      members: rows.map(({ member, user }) => ({
        user: toPublicUser(auth.userId, getUserById(user.id)!),
        role: member.role,
        permissions: JSON.parse(member.permissions || '{}'),
        mutedUntil: member.muted_until,
        joinedAt: member.joined_at,
      })),
      total: get<{ c: number }>('SELECT count(*) AS c FROM chat_members WHERE chat_id = ? AND banned = 0', [id])?.c ?? 0,
    });
  });

  app.post('/chats/:id/members', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const chat = requireChat(id);
    const member = requireMembership(id, auth.userId);
    requirePermission(chat, member, 'inviteUsers');
    const body = z.object({ userIds: z.array(z.string().min(10)).min(1).max(50) }).parse(req.body);
    const added: string[] = [];
    for (const userId of body.userIds) {
      const user = getUserById(userId);
      if (!user) continue;
      if (isBlocked(userId, auth.userId)) continue;
      addMember(id, userId, 'member', auth.userId);
      added.push(userId);
      emitToChat(id, 'chat:updated', { chat: toChatSummary(chat, getMembership(id, userId)!) });
    }
    audit({ actorId: auth.userId, action: 'chat.members_added', targetType: 'chat', targetId: id, metadata: { count: added.length } });
    reply.send({ added });
  });

  app.delete('/chats/:id/members/:userId', async (req, reply) => {
    const auth = requireAuth(req);
    const { id, userId } = z.object({ id: z.string().min(10), userId: z.string().min(10) }).parse(req.params);
    const chat = requireChat(id);
    const actor = requireMembership(id, auth.userId);
    if (userId !== auth.userId) {
      if (!canManageMembers(chat, actor)) throw errors.forbidden('Недостаточно прав');
      const target = getMembership(id, userId);
      if (!target) throw errors.notFound('Участник не найден');
      if (target.role === 'owner') throw errors.forbidden('Нельзя удалить владельца');
    }
    removeMember(id, userId);
    audit({ actorId: auth.userId, action: 'chat.member_removed', targetType: 'chat', targetId: id, metadata: { userId } });
    emitToChat(id, 'chat:updated', { chat: toChatSummary(chat, actor) });
    reply.send({ status: 'ok' });
  });

  app.post('/chats/:id/members/:userId/ban', async (req, reply) => {
    const auth = requireAuth(req);
    const { id, userId } = z.object({ id: z.string().min(10), userId: z.string().min(10) }).parse(req.params);
    const chat = requireChat(id);
    const actor = requireMembership(id, auth.userId);
    requirePermission(chat, actor, 'banUsers');
    const target = getMembership(id, userId);
    if (!target) throw errors.notFound('Участник не найден');
    if (target.role === 'owner') throw errors.forbidden('Нельзя заблокировать владельца');
    banMember(id, userId, auth.userId);
    audit({ actorId: auth.userId, action: 'chat.member_banned', targetType: 'chat', targetId: id, metadata: { userId } });
    reply.send({ status: 'ok' });
  });

  app.post('/chats/:id/members/:userId/unban', async (req, reply) => {
    const auth = requireAuth(req);
    const { id, userId } = z.object({ id: z.string().min(10), userId: z.string().min(10) }).parse(req.params);
    const chat = requireChat(id);
    const actor = requireMembership(id, auth.userId);
    requirePermission(chat, actor, 'banUsers');
    unbanMember(id, userId);
    audit({ actorId: auth.userId, action: 'chat.member_unbanned', targetType: 'chat', targetId: id, metadata: { userId } });
    reply.send({ status: 'ok' });
  });

  app.post('/chats/:id/members/:userId/mute', async (req, reply) => {
    const auth = requireAuth(req);
    const { id, userId } = z.object({ id: z.string().min(10), userId: z.string().min(10) }).parse(req.params);
    const chat = requireChat(id);
    const actor = requireMembership(id, auth.userId);
    requirePermission(chat, actor, 'muteUsers');
    const body = z.object({ minutes: z.number().int().min(0).max(60 * 24 * 365) }).parse(req.body);
    const until = body.minutes > 0 ? plusMinutes(body.minutes) : null;
    run('UPDATE chat_members SET muted_until = ? WHERE chat_id = ? AND user_id = ?', [until, id, userId]);
    audit({ actorId: auth.userId, action: 'chat.member_muted', targetType: 'chat', targetId: id, metadata: { userId, minutes: body.minutes } });
    reply.send({ status: 'ok', mutedUntil: until });
  });

  app.post('/chats/:id/members/:userId/role', async (req, reply) => {
    const auth = requireAuth(req);
    const { id, userId } = z.object({ id: z.string().min(10), userId: z.string().min(10) }).parse(req.params);
    const chat = requireChat(id);
    const actor = requireMembership(id, auth.userId);
    if (actor.role !== 'owner') throw errors.forbidden('Только владелец может менять роли');
    const body = z.object({ role: z.enum(['admin', 'member']), permissions: z.record(z.boolean()).optional() }).parse(req.body);
    run('UPDATE chat_members SET role = ?, permissions = ? WHERE chat_id = ? AND user_id = ?', [
      body.role, JSON.stringify(body.permissions ?? {}), id, userId,
    ]);
    audit({ actorId: auth.userId, action: 'chat.role_changed', targetType: 'chat', targetId: id, metadata: { userId, role: body.role } });
    reply.send({ status: 'ok' });
  });

  app.post('/chats/:id/transfer', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const chat = requireChat(id);
    const actor = requireMembership(id, auth.userId);
    if (actor.role !== 'owner') throw errors.forbidden('Только владелец может передать чат');
    const body = z.object({ userId: z.string().min(10) }).parse(req.body);
    if (!getMembership(id, body.userId)) throw errors.badRequest('Пользователь не состоит в чате');
    tx(() => {
      run(`UPDATE chat_members SET role = 'admin' WHERE chat_id = ? AND user_id = ?`, [id, auth.userId]);
      run(`UPDATE chat_members SET role = 'owner' WHERE chat_id = ? AND user_id = ?`, [id, body.userId]);
    });
    audit({ actorId: auth.userId, action: 'chat.ownership_transferred', targetType: 'chat', targetId: id, metadata: { to: body.userId } });
    reply.send({ status: 'ok' });
  });

  // ---- Настройки чата для пользователя ----
  for (const [action, column] of [['pin', 'pinned'], ['archive', 'archived'], ['mute', 'muted']] as const) {
    app.post(`/chats/:id/${action}`, async (req, reply) => {
      const auth = requireAuth(req);
      const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
      requireMembership(id, auth.userId);
      const body = z.object({ value: z.boolean() }).parse(req.body);
      if (action === 'mute') {
        const minutes = z.object({ value: z.boolean(), minutes: z.number().int().min(0).max(600000).optional() }).parse(req.body);
        run('UPDATE chat_members SET muted = ?, muted_until_chat = ? WHERE chat_id = ? AND user_id = ?', [
          minutes.value ? 1 : 0, minutes.value && minutes.minutes ? plusMinutes(minutes.minutes) : null, id, auth.userId,
        ]);
      } else {
        run(`UPDATE chat_members SET ${column} = ? WHERE chat_id = ? AND user_id = ?`, [body.value ? 1 : 0, id, auth.userId]);
      }
      const chat = requireChat(id);
      reply.send({ chat: toChatSummary(chat, getMembership(id, auth.userId)!) });
    });
  }

  // ---- Приглашения ----
  app.get('/chats/:id/invites', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const chat = requireChat(id);
    const member = requireMembership(id, auth.userId);
    requirePermission(chat, member, 'manageInvites');
    const rows = all<{ id: string; token_hint: string; created_at: string; expires_at: string | null; max_uses: number | null; uses: number; requires_approval: number }>(
      'SELECT id, token_hint, created_at, expires_at, max_uses, uses, requires_approval FROM invites WHERE chat_id = ? AND revoked_at IS NULL ORDER BY created_at DESC',
      [id],
    );
    reply.send({ invites: rows });
  });

  app.post('/chats/:id/invites', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const chat = requireChat(id);
    const member = requireMembership(id, auth.userId);
    requirePermission(chat, member, 'manageInvites');
    const body = z.object({ expiresInHours: z.number().int().min(1).max(24 * 365).nullable().optional(), maxUses: z.number().int().min(1).max(100000).nullable().optional(), requiresApproval: z.boolean().optional() }).parse(req.body ?? {});
    const token = randomBytes(18).toString('base64url');
    const inviteId = globalThis.crypto.randomUUID();
    run(
      `INSERT INTO invites(id, chat_id, token_hash, token_hint, created_by, created_at, expires_at, max_uses, requires_approval)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        inviteId, id, sha256(token), token.slice(0, 6), auth.userId, now(),
        body.expiresInHours ? plusMinutes(body.expiresInHours * 60) : null,
        body.maxUses ?? null, body.requiresApproval ? 1 : 0,
      ],
    );
    audit({ actorId: auth.userId, action: 'chat.invite_created', targetType: 'chat', targetId: id });
    // Токен показывается один раз: в БД хранится только хэш.
    reply.code(201).send({ inviteId, token, link: `/join/${token}` });
  });

  app.delete('/invites/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(8) }).parse(req.params);
    const invite = get<{ chat_id: string }>('SELECT chat_id FROM invites WHERE id = ?', [id]);
    if (!invite) throw errors.notFound('Приглашение не найдено');
    const chat = requireChat(invite.chat_id);
    const member = requireMembership(invite.chat_id, auth.userId);
    requirePermission(chat, member, 'manageInvites');
    run('UPDATE invites SET revoked_at = ? WHERE id = ?', [now(), id]);
    reply.send({ status: 'ok' });
  });

  app.post('/join/:token', async (req, reply) => {
    const auth = requireAuth(req);
    const { token } = z.object({ token: z.string().min(8).max(120) }).parse(req.params);
    const invite = get<{ id: string; chat_id: string; expires_at: string | null; max_uses: number | null; uses: number; requires_approval: number; revoked_at: string | null }>(
      'SELECT * FROM invites WHERE token_hash = ?', [sha256(token)],
    );
    if (!invite || invite.revoked_at) throw errors.notFound('Приглашение недействительно');
    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) throw errors.badRequest('Срок приглашения истёк');
    if (invite.max_uses && invite.uses >= invite.max_uses) throw errors.badRequest('Лимит использований исчерпан');
    const chat = requireChat(invite.chat_id);
    if (isMember(chat.id, auth.userId)) {
      reply.send({ chat: toChatSummary(chat, getMembership(chat.id, auth.userId)!) });
      return;
    }
    if (invite.requires_approval) {
      run(
        `INSERT INTO join_requests(id, chat_id, user_id, invite_id, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING`,
        [globalThis.crypto.randomUUID(), chat.id, auth.userId, invite.id, now()],
      );
      reply.code(202).send({ status: 'pending_approval' });
      return;
    }
    addMember(chat.id, auth.userId, 'member', invite.uses > 0 ? null : chat.created_by);
    run('UPDATE invites SET uses = uses + 1 WHERE id = ?', [invite.id]);
    audit({ actorId: auth.userId, action: 'chat.joined_by_invite', targetType: 'chat', targetId: chat.id });
    reply.send({ chat: toChatSummary(requireChat(chat.id), getMembership(chat.id, auth.userId)!) });
  });

  app.get('/chats/:id/join-requests', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const chat = requireChat(id);
    const member = requireMembership(id, auth.userId);
    requirePermission(chat, member, 'inviteUsers');
    const rows = all<{ id: string; user_id: string; message: string | null; created_at: string }>(
      `SELECT id, user_id, message, created_at FROM join_requests WHERE chat_id = ? AND status = 'pending' ORDER BY created_at`,
      [id],
    );
    reply.send({ requests: rows.map((r) => ({ id: r.id, user: toPublicUser(auth.userId, getUserById(r.user_id)!), message: r.message, createdAt: r.created_at })) });
  });

  app.post('/chats/:id/join-requests/:requestId', async (req, reply) => {
    const auth = requireAuth(req);
    const { id, requestId } = z.object({ id: z.string().min(10), requestId: z.string().min(8) }).parse(req.params);
    const chat = requireChat(id);
    const member = requireMembership(id, auth.userId);
    requirePermission(chat, member, 'inviteUsers');
    const body = z.object({ approve: z.boolean() }).parse(req.body);
    const request = get<{ user_id: string }>('SELECT user_id FROM join_requests WHERE id = ? AND chat_id = ?', [requestId, id]);
    if (!request) throw errors.notFound('Заявка не найдена');
    tx(() => {
      run('UPDATE join_requests SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?', [body.approve ? 'approved' : 'rejected', now(), auth.userId, requestId]);
      if (body.approve) addMember(id, request.user_id, 'member', auth.userId);
    });
    reply.send({ status: 'ok' });
  });

  // ---- Публичные чаты ----
  app.get('/chats/search/public', async (req, reply) => {
    const auth = requireAuth(req);
    const { q } = z.object({ q: z.string().min(1).max(64) }).parse(req.query);
    enforce(`search:${auth.userId}`, RULES.search);
    const term = q.replace(/^@/, '').toLowerCase();
    const rows = all<{ id: string }>(
      `SELECT id FROM chats WHERE deleted_at IS NULL AND is_public = 1
        AND (lower(username) = ? OR lower(username) LIKE ? OR lower(title) LIKE ?)
        ORDER BY member_count DESC LIMIT 20`,
      [term, `${term}%`, `${term}%`],
    );
    const chats = rows.map((r) => {
      const chat = getChat(r.id)!;
      const member = getMembership(r.id, auth.userId);
      if (member && !member.banned) return toChatSummary(chat, member);
      return {
        id: chat.id, type: chat.type, title: chat.title ?? '', username: chat.username,
        avatarUrl: chat.avatar_media_id ? `/api/v1/media/${chat.avatar_media_id}/content` : null,
        unreadCount: 0, unreadMentions: 0, pinned: false, archived: false, muted: false, mutedUntil: null,
        lastMessageAt: chat.last_message_at, lastMessagePreview: null, lastMessageSenderId: null,
        memberCount: chat.member_count, draftText: null, role: null, isPublic: true,
        description: chat.description, slowModeSeconds: chat.slow_mode_seconds, permissions: null,
        pinnedMessageId: null,
      };
    });
    reply.send({ chats });
  });

  app.post('/chats/:id/join', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const chat = requireChat(id);
    if (!chat.is_public) throw errors.forbidden('Чат приватный, нужна ссылка-приглашение');
    addMember(id, auth.userId, 'member', null);
    audit({ actorId: auth.userId, action: 'chat.joined_public', targetType: 'chat', targetId: id });
    reply.send({ chat: toChatSummary(requireChat(id), getMembership(id, auth.userId)!) });
  });

  // ---- Статистика канала ----
  app.get('/chats/:id/stats', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const chat = requireChat(id);
    const member = requireMembership(id, auth.userId);
    if (chat.type === 'channel' && member.role === 'member') throw errors.forbidden('Статистика доступна админам');
    const messages = get<{ c: number }>('SELECT count(*) AS c FROM messages WHERE chat_id = ? AND deleted_at IS NULL', [id])?.c ?? 0;
    const reactions = get<{ c: number }>('SELECT count(*) AS c FROM reactions r JOIN messages m ON m.id = r.message_id WHERE m.chat_id = ?', [id])?.c ?? 0;
    const perDay = all<{ day: string; c: number }>(
      `SELECT substr(created_at, 1, 10) AS day, count(*) AS c FROM messages
       WHERE chat_id = ? AND created_at > ? GROUP BY day ORDER BY day`,
      [id, new Date(Date.now() - 30 * 86_400_000).toISOString()],
    );
    reply.send({
      memberCount: chat.member_count,
      messages,
      reactions,
      perDay,
      growth: all<{ day: string; c: number }>(
        `SELECT substr(joined_at, 1, 10) AS day, count(*) AS c FROM chat_members
         WHERE chat_id = ? AND joined_at > ? GROUP BY day ORDER BY day`,
        [id, new Date(Date.now() - 30 * 86_400_000).toISOString()],
      ),
    });
  });

  // ---- Журнал действий администраторов ----
  app.get('/chats/:id/audit', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const chat = requireChat(id);
    const member = requireMembership(id, auth.userId);
    if (member.role === 'member') throw errors.forbidden('Журнал доступен администраторам');
    const rows = all<{ id: string; actor_id: string; action: string; metadata: string; created_at: string }>(
      'SELECT id, actor_id, action, metadata, created_at FROM audit_log WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC LIMIT 200',
      ['chat', id],
    );
    reply.send({ entries: rows });
  });

  void recountMembers;
  void DEFAULT_ADMIN_PERMISSIONS;
  void effectivePermissions;
  void plusMinutes;
}
