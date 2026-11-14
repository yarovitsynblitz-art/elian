import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get, run } from '../db/index.js';
import { errors } from '../lib/errors.js';
import { requireAuth } from '../auth/sessions.js';
import { now, plusMs } from '../lib/time.js';
import { contactIds, getUserById, isContact, toPublicUser, userSettings } from '../services/users.js';
import { enforce, RULES } from '../lib/rate-limit.js';
import { getMedia, canAccessMedia } from '../services/media.js';
import { emitToChat, emitToUser } from '../realtime/index.js';
import { getMembership } from '../services/chats.js';

const storySchema = z.object({
  kind: z.enum(['photo', 'video', 'text']),
  text: z.string().max(700).nullable().optional(),
  mediaId: z.string().nullable().optional(),
  background: z.string().max(64).nullable().optional(),
  privacy: z.enum(['everyone', 'contacts', 'close_friends', 'selected']).default('contacts'),
  privacyList: z.array(z.string()).max(200).optional(),
  duration: z.number().int().min(1).max(60).optional(),
});

function canViewStory(viewerId: string, ownerId: string, privacy: string, list: string[]): boolean {
  if (viewerId === ownerId) return true;
  const owner = getUserById(ownerId);
  if (!owner) return false;
  switch (privacy) {
    case 'everyone': return true;
    case 'contacts': return isContact(ownerId, viewerId) || isContact(viewerId, ownerId);
    case 'close_friends': {
      const settings = userSettings(owner);
      return settings.privacy.closeFriends.includes(viewerId);
    }
    case 'selected': return list.includes(viewerId);
    default: return false;
  }
}

export async function storyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stories', async (req, reply) => {
    const auth = requireAuth(req);
    const rows = all<{ id: string; user_id: string; kind: string; text: string | null; media_id: string | null; background: string | null; privacy: string; privacy_list: string; duration: number; created_at: string; expires_at: string }>(
      `SELECT * FROM stories WHERE deleted_at IS NULL AND expires_at > ? ORDER BY created_at ASC`,
      [now()],
    );
    const authorIds = [...new Set(rows.map((r) => r.user_id))];
    const visible = rows.filter((r) => canViewStory(auth.userId, r.user_id, r.privacy, JSON.parse(r.privacy_list || '[]')));
    const grouped = new Map<string, typeof visible>();
    for (const story of visible) {
      const list = grouped.get(story.user_id) ?? [];
      list.push(story);
      grouped.set(story.user_id, list);
    }
    const result = [...grouped.entries()].map(([userId, stories]) => {
      const user = getUserById(userId);
      const viewed = all<{ story_id: string }>('SELECT story_id FROM story_views WHERE user_id = ? AND story_id IN (' + stories.map(() => '?').join(',') + ')', [auth.userId, ...stories.map((s) => s.id)]);
      const viewedIds = new Set(viewed.map((v) => v.story_id));
      return {
        user: toPublicUser(auth.userId, user!),
        stories: stories.map((s) => ({
          id: s.id, userId: s.user_id, kind: s.kind, text: s.text, mediaId: s.media_id,
          url: s.media_id ? `/api/v1/media/${s.media_id}/content` : null,
          thumbUrl: s.media_id ? `/api/v1/media/${s.media_id}/thumbnail` : null,
          background: s.background, duration: s.duration, createdAt: s.created_at, expiresAt: s.expires_at,
          privacy: s.privacy, seen: viewedIds.has(s.id),
          viewCount: get<{ c: number }>('SELECT count(*) AS c FROM story_views WHERE story_id = ?', [s.id])?.c ?? 0,
          user: { id: userId, username: user!.username, displayName: user!.display_name, avatarUrl: user!.avatar_media_id ? `/api/v1/media/${user!.avatar_media_id}/content` : null },
        })),
        allSeen: stories.every((s) => viewedIds.has(s.id)),
      };
    });
    void authorIds;
    reply.send({ groups: result });
  });

  app.post('/stories', async (req, reply) => {
    const auth = requireAuth(req);
    enforce(`story:${auth.userId}`, RULES.upload);
    const body = storySchema.parse(req.body);
    if (body.kind === 'text' && !body.text) throw errors.badRequest('Текст обязателен для текстовой истории');
    if (body.kind !== 'text' && !body.mediaId) throw errors.badRequest('Нужен файл истории');
    if (body.mediaId) {
      const media = getMedia(body.mediaId);
      if (!media || !canAccessMedia(auth.userId, media)) throw errors.badRequest('Файл недоступен');
    }
    const id = globalThis.crypto.randomUUID();
    run(
      `INSERT INTO stories(id, user_id, kind, text, media_id, background, privacy, privacy_list, duration, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, auth.userId, body.kind, body.text ?? null, body.mediaId ?? null, body.background ?? null,
        body.privacy, JSON.stringify(body.privacyList ?? []), body.duration ?? 5, now(), plusMs(24 * 3600_000),
      ],
    );
    // Уведомляем контакты (они увидят историю в списке).
    for (const contactId of contactIds(auth.userId)) emitToUser(contactId, 'story:new', { userId: auth.userId });
    reply.code(201).send({ storyId: id, expiresAt: plusMs(24 * 3600_000) });
  });

  app.post('/stories/:id/view', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const story = get<{ user_id: string; privacy: string; privacy_list: string }>('SELECT user_id, privacy, privacy_list FROM stories WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!story) throw errors.notFound('История не найдена');
    if (!canViewStory(auth.userId, story.user_id, story.privacy, JSON.parse(story.privacy_list || '[]'))) throw errors.forbidden('Нет доступа');
    run('INSERT INTO story_views(story_id, user_id, viewed_at) VALUES (?, ?, ?) ON CONFLICT(story_id, user_id) DO UPDATE SET viewed_at = excluded.viewed_at', [id, auth.userId, now()]);
    reply.send({ status: 'ok' });
  });

  app.post('/stories/:id/reaction', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const body = z.object({ emoji: z.string().min(1).max(8), replyText: z.string().max(500).optional() }).parse(req.body);
    const story = get<{ user_id: string }>('SELECT user_id FROM stories WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!story) throw errors.notFound('История не найдена');
    run('INSERT INTO story_views(story_id, user_id, viewed_at, reaction) VALUES (?, ?, ?, ?) ON CONFLICT(story_id, user_id) DO UPDATE SET reaction = excluded.reaction', [id, auth.userId, now(), body.emoji]);
    // Ответ в чат: создаём личный чат и сообщение (если разрешено).
    const { ensurePrivateChat } = await import('../services/chats.js');
    const { insertMessage, serializeMessage } = await import('../services/messages.js');
    const { chat } = ensurePrivateChat(auth.userId, story.user_id);
    const row = insertMessage({
      chatId: chat.id,
      senderId: auth.userId,
      text: `${body.emoji}${body.replyText ? ` ${body.replyText}` : ''} (ответ на историю)`,
    });
    const member = getMembership(chat.id, auth.userId)!;
    emitToChat(chat.id, 'message:new', { message: serializeMessage(row, auth.userId), chat: { id: chat.id } as never });
    void member;
    reply.send({ status: 'ok' });
  });

  app.get('/stories/:id/views', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const story = get<{ user_id: string }>('SELECT user_id FROM stories WHERE id = ?', [id]);
    if (!story) throw errors.notFound('История не найдена');
    if (story.user_id !== auth.userId) throw errors.forbidden('Только автор видит просмотры');
    const rows = all<{ user_id: string; viewed_at: string; reaction: string | null }>('SELECT user_id, viewed_at, reaction FROM story_views WHERE story_id = ? ORDER BY viewed_at DESC', [id]);
    reply.send({ views: rows.map((r) => ({ user: toPublicUser(auth.userId, getUserById(r.user_id)!), viewedAt: r.viewed_at, reaction: r.reaction })) });
  });

  app.delete('/stories/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const story = get<{ user_id: string }>('SELECT user_id FROM stories WHERE id = ?', [id]);
    if (!story) throw errors.notFound('История не найдена');
    if (story.user_id !== auth.userId) throw errors.forbidden('Можно удалять только свои истории');
    run('UPDATE stories SET deleted_at = ?, archived = 1 WHERE id = ?', [now(), id]);
    reply.send({ status: 'ok' });
  });

  app.get('/stories/archive/list', async (req, reply) => {
    const auth = requireAuth(req);
    const rows = all<{ id: string; kind: string; text: string | null; media_id: string | null; created_at: string; expires_at: string }>(
      'SELECT id, kind, text, media_id, created_at, expires_at FROM stories WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100',
      [auth.userId],
    );
    reply.send({ stories: rows });
  });
}
