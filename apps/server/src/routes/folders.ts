import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get, run } from '../db/index.js';
import { errors } from '../lib/errors.js';
import { requireAuth } from '../auth/sessions.js';
import { now } from '../lib/time.js';
import { listChatSummaries, getMembership, requireChat, toChatSummary } from '../services/chats.js';
import { isContact } from '../services/users.js';
import type { ChatSummary, Folder, FolderRule } from '@elian/shared';

const ruleSchema = z.object({
  type: z.enum(['chat', 'type', 'unread', 'contact', 'hasMedia', 'pinned', 'muted']),
  value: z.string().nullable().optional(),
  include: z.boolean(),
});

const folderSchema = z.object({
  name: z.string().min(1).max(40),
  emoji: z.string().max(8).nullable().optional(),
  position: z.number().int().min(0).max(100).optional(),
  rules: z.array(ruleSchema).max(20).optional(),
  includedChatIds: z.array(z.string()).max(200).optional(),
  excludedChatIds: z.array(z.string()).max(200).optional(),
  unreadOnly: z.boolean().optional(),
});

function rowToFolder(row: {
  id: string; name: string; emoji: string | null; position: number; rules: string; included_chat_ids: string;
  excluded_chat_ids: string; unread_only: number;
}): Folder {
  const parse = (raw: string) => { try { return JSON.parse(raw); } catch { return []; } };
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    position: row.position,
    rules: parse(row.rules) as FolderRule[],
    includedChatIds: parse(row.included_chat_ids) as string[],
    excludedChatIds: parse(row.excluded_chat_ids) as string[],
    unreadOnly: Boolean(row.unread_only),
  };
}

export function applyFolder(folder: Folder, chats: ChatSummary[], userId: string): ChatSummary[] {
  const included = new Set(folder.includedChatIds);
  const excluded = new Set(folder.excludedChatIds);
  return chats.filter((chat) => {
    if (excluded.has(chat.id)) return false;
    if (included.has(chat.id)) return true;
    if (!folder.rules.length) return false;
    // Все правила должны выполняться (AND), каждое — с учётом include.
    return folder.rules.every((rule) => {
      let matched = false;
      switch (rule.type) {
        case 'chat': matched = chat.id === rule.value; break;
        case 'type': matched = chat.type === rule.value; break;
        case 'unread': matched = chat.unreadCount > 0; break;
        case 'contact': {
          const peerId = chat.lastMessageSenderId;
          matched = peerId ? isContact(userId, peerId) : false;
          break;
        }
        case 'hasMedia': matched = true; break;
        case 'pinned': matched = chat.pinned; break;
        case 'muted': matched = chat.muted; break;
      }
      return rule.include ? matched : !matched;
    });
  });
}

export async function folderRoutes(app: FastifyInstance): Promise<void> {
  app.get('/folders', async (req, reply) => {
    const auth = requireAuth(req);
    const rows = all('SELECT * FROM folders WHERE user_id = ? ORDER BY position, created_at', [auth.userId]) as Parameters<typeof rowToFolder>[0][];
    reply.send({ folders: rows.map(rowToFolder) });
  });

  app.post('/folders', async (req, reply) => {
    const auth = requireAuth(req);
    const body = folderSchema.parse(req.body);
    const count = get<{ c: number }>('SELECT count(*) AS c FROM folders WHERE user_id = ?', [auth.userId])?.c ?? 0;
    if (count >= 10) throw errors.badRequest('Не более 10 папок');
    const id = globalThis.crypto.randomUUID();
    run(
      `INSERT INTO folders(id, user_id, name, emoji, position, rules, included_chat_ids, excluded_chat_ids, unread_only, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, auth.userId, body.name, body.emoji ?? null, body.position ?? count,
        JSON.stringify(body.rules ?? []), JSON.stringify(body.includedChatIds ?? []),
        JSON.stringify(body.excludedChatIds ?? []), body.unreadOnly ? 1 : 0, now(),
      ],
    );
    const row = get('SELECT * FROM folders WHERE id = ?', [id]) as Parameters<typeof rowToFolder>[0];
    reply.code(201).send({ folder: rowToFolder(row) });
  });

  app.patch('/folders/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(8) }).parse(req.params);
    const body = folderSchema.partial().parse(req.body);
    const existing = get('SELECT * FROM folders WHERE id = ? AND user_id = ?', [id, auth.userId]);
    if (!existing) throw errors.notFound('Папка не найдена');
    run(
      `UPDATE folders SET name = COALESCE(?, name), emoji = COALESCE(?, emoji), position = COALESCE(?, position),
        rules = COALESCE(?, rules), included_chat_ids = COALESCE(?, included_chat_ids),
        excluded_chat_ids = COALESCE(?, excluded_chat_ids), unread_only = COALESCE(?, unread_only)
       WHERE id = ? AND user_id = ?`,
      [
        body.name ?? null, body.emoji ?? null, body.position ?? null,
        body.rules ? JSON.stringify(body.rules) : null,
        body.includedChatIds ? JSON.stringify(body.includedChatIds) : null,
        body.excludedChatIds ? JSON.stringify(body.excludedChatIds) : null,
        body.unreadOnly === undefined ? null : body.unreadOnly ? 1 : 0,
        id, auth.userId,
      ],
    );
    const row = get('SELECT * FROM folders WHERE id = ?', [id]) as Parameters<typeof rowToFolder>[0];
    reply.send({ folder: rowToFolder(row) });
  });

  app.delete('/folders/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(8) }).parse(req.params);
    run('DELETE FROM folders WHERE id = ? AND user_id = ?', [id, auth.userId]);
    reply.send({ status: 'ok' });
  });

  app.get('/folders/:id/chats', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(8) }).parse(req.params);
    const row = get('SELECT * FROM folders WHERE id = ? AND user_id = ?', [id, auth.userId]) as Parameters<typeof rowToFolder>[0] | undefined;
    if (!row) throw errors.notFound('Папка не найдена');
    const folder = rowToFolder(row);
    const chats = listChatSummaries(auth.userId, { archived: false });
    const filtered = applyFolder(folder, chats, auth.userId);
    reply.send({ chats: folder.unreadOnly ? filtered.filter((c) => c.unreadCount > 0) : filtered });
  });

  void requireChat;
  void toChatSummary;
  void getMembership;
}
