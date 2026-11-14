import crypto from 'node:crypto';
import {
  DEFAULT_ADMIN_PERMISSIONS, DEFAULT_MEMBER_PERMISSIONS,
  type ChatPermissions, type ChatSummary, type ChatType, type MemberRole,
} from '@elian/shared';
import { all, get, run, tx } from '../db/index.js';
import { errors } from '../lib/errors.js';
import { now } from '../lib/time.js';

export interface ChatRow {
  id: string;
  type: ChatType;
  title: string | null;
  username: string | null;
  description: string | null;
  avatar_media_id: string | null;
  is_public: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  last_seq: number;
  member_count: number;
  slow_mode_seconds: number;
  discussion_chat_id: string | null;
  linked_channel_id: string | null;
  default_permissions: string;
  signature_enabled: number;
  deleted_at: string | null;
}

export interface MemberRow {
  chat_id: string;
  user_id: string;
  role: MemberRole;
  permissions: string;
  joined_at: string;
  invited_by: string | null;
  muted_until: string | null;
  banned: number;
  banned_at: string | null;
  banned_by: string | null;
  last_read_seq: number;
  last_delivered_seq: number;
  pinned: number;
  archived: number;
  muted: number;
  muted_until_chat: string | null;
  notifications: string;
}

export function getChat(chatId: string): ChatRow | null {
  return get<ChatRow>('SELECT * FROM chats WHERE id = ? AND deleted_at IS NULL', [chatId]) ?? null;
}

export function requireChat(chatId: string): ChatRow {
  const chat = getChat(chatId);
  if (!chat) throw errors.notFound('Чат не найден');
  return chat;
}

export function getMembership(chatId: string, userId: string): MemberRow | null {
  return get<MemberRow>('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?', [chatId, userId]) ?? null;
}

export function requireMembership(chatId: string, userId: string): MemberRow {
  const member = getMembership(chatId, userId);
  if (!member || member.banned) throw errors.forbidden('Нет доступа к этому чату');
  return member;
}

export function effectivePermissions(chat: ChatRow, member: MemberRow): ChatPermissions {
  if (member.role === 'owner') {
    return Object.fromEntries(Object.keys(DEFAULT_ADMIN_PERMISSIONS).map((k) => [k, true])) as unknown as ChatPermissions;
  }
  const base = member.role === 'admin' ? { ...DEFAULT_ADMIN_PERMISSIONS } : { ...DEFAULT_MEMBER_PERMISSIONS };
  let chatDefaults: Partial<ChatPermissions> = {};
  try { chatDefaults = JSON.parse(chat.default_permissions || '{}'); } catch { /* ignore */ }
  let overrides: Partial<ChatPermissions> = {};
  try { overrides = JSON.parse(member.permissions || '{}'); } catch { /* ignore */ }
  const merged = { ...base, ...chatDefaults, ...overrides } as ChatPermissions;
  if (chat.type === 'channel' && member.role === 'member') {
    merged.sendMessages = false;
    merged.sendMedia = false;
  }
  return merged;
}

export function canSend(chat: ChatRow, member: MemberRow, kind: 'text' | 'media' = 'text'): boolean {
  const perms = effectivePermissions(chat, member);
  if (member.muted_until && new Date(member.muted_until).getTime() > Date.now()) return false;
  return kind === 'media' ? perms.sendMedia && perms.sendMessages : perms.sendMessages;
}

export function requirePermission(chat: ChatRow, member: MemberRow, permission: keyof ChatPermissions): void {
  const perms = effectivePermissions(chat, member);
  if (!perms[permission]) throw errors.forbidden('Недостаточно прав для этого действия');
}

function chatTitle(chat: ChatRow, viewerId: string): string {
  if (chat.type !== 'private') return chat.title ?? 'Без названия';
  const peer = get<{ display_name: string; username: string }>(
    `SELECT u.display_name, u.username FROM chat_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.chat_id = ? AND m.user_id <> ? LIMIT 1`,
    [chat.id, viewerId],
  );
  return peer?.display_name ?? 'Личный чат';
}

export function toChatSummary(chat: ChatRow, member: MemberRow, extra: { firstUnreadId?: string | null } = {}): ChatSummary {
  const unread = get<{ c: number }>(
    `SELECT count(*) AS c FROM messages
     WHERE chat_id = ? AND seq > ? AND deleted_at IS NULL AND (sender_id IS NULL OR sender_id <> ?)`,
    [chat.id, member.last_read_seq, member.user_id],
  )?.c ?? 0;
  const last = get<{ text: string; sender_id: string | null; has_media: number; seq: number }>(
    'SELECT text, sender_id, has_media, seq FROM messages WHERE chat_id = ? AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1',
    [chat.id],
  );
  const draft = get<{ text: string }>('SELECT text FROM drafts WHERE user_id = ? AND chat_id = ?', [member.user_id, chat.id]);
  const pinned = get<{ id: string }>('SELECT id FROM messages WHERE chat_id = ? AND pinned = 1 AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1', [chat.id]);
  const peerCount = chat.type === 'private' ? 2 : chat.member_count;
  return {
    id: chat.id,
    type: chat.type,
    title: chatTitle(chat, member.user_id),
    username: chat.username,
    avatarUrl: chat.avatar_media_id ? `/api/v1/media/${chat.avatar_media_id}/content` : privateAvatar(chat, member.user_id),
    unreadCount: unread,
    unreadMentions: 0,
    pinned: Boolean(member.pinned),
    archived: Boolean(member.archived),
    muted: Boolean(member.muted) || (member.muted_until_chat ? new Date(member.muted_until_chat).getTime() > Date.now() : false),
    mutedUntil: member.muted_until_chat,
    lastMessageAt: chat.last_message_at,
    lastMessagePreview: last ? (last.has_media ? '📎 Вложение' : last.text.slice(0, 120)) : null,
    lastMessageSenderId: last?.sender_id ?? null,
    memberCount: peerCount,
    draftText: draft?.text ?? null,
    role: member.role,
    isPublic: Boolean(chat.is_public),
    description: chat.description,
    slowModeSeconds: chat.slow_mode_seconds,
    permissions: effectivePermissions(chat, member),
    pinnedMessageId: pinned?.id ?? null,
    firstUnreadMessageId: extra.firstUnreadId ?? null,
    readOutboxMaxSeq: member.last_read_seq,
  };
}

function privateAvatar(chat: ChatRow, viewerId: string): string | null {
  if (chat.type !== 'private') return null;
  const peer = get<{ avatar_media_id: string | null }>(
    `SELECT u.avatar_media_id FROM chat_members m JOIN users u ON u.id = m.user_id
     WHERE m.chat_id = ? AND m.user_id <> ? LIMIT 1`,
    [chat.id, viewerId],
  );
  return peer?.avatar_media_id ? `/api/v1/media/${peer.avatar_media_id}/content` : null;
}

export function memberChatIds(userId: string, opts: { archived?: boolean } = {}): ChatRow[] {
  const rows = all<ChatRow>(
    `SELECT c.* FROM chats c JOIN chat_members m ON m.chat_id = c.id
     WHERE m.user_id = ? AND c.deleted_at IS NULL AND m.banned = 0
       ${opts.archived === undefined ? '' : 'AND m.archived = ?'}
     ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
    opts.archived === undefined ? [userId] : [userId, opts.archived ? 1 : 0],
  );
  return rows;
}

export function listChatSummaries(userId: string, opts: { archived?: boolean } = {}): ChatSummary[] {
  const chats = memberChatIds(userId, opts);
  const out: ChatSummary[] = [];
  for (const chat of chats) {
    const member = getMembership(chat.id, userId);
    if (member) out.push(toChatSummary(chat, member));
  }
  return out;
}

/** Личный чат: канонический ключ по паре пользователей. */
export function ensurePrivateChat(userA: string, userB: string): { chat: ChatRow; created: boolean } {
  if (userA === userB) throw errors.badRequest('Нельзя создать личный чат с самим собой');
  const existing = get<ChatRow>(
    `SELECT c.* FROM chats c
     JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ?
     JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ?
     WHERE c.type = 'private' AND c.deleted_at IS NULL
     LIMIT 1`,
    [userA, userB],
  );
  if (existing) return { chat: existing, created: false };
  const id = crypto.randomUUID();
  const ts = now();
  tx(() => {
    run(
      `INSERT INTO chats(id, type, title, is_public, created_by, created_at, updated_at, member_count, default_permissions)
       VALUES (?, 'private', NULL, 0, ?, ?, ?, 2, '{}')`,
      [id, userA, ts, ts],
    );
    run(`INSERT INTO chat_members(chat_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`, [id, userA, ts]);
    run(`INSERT INTO chat_members(chat_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`, [id, userB, ts]);
  });
  return { chat: requireChat(id), created: true };
}

export function validateChatUsername(username: string, excludeChatId?: string): string {
  const normalized = username.replace(/^@/, '').toLowerCase();
  if (!/^[a-z][a-z0-9_]{3,31}$/.test(normalized)) throw errors.badRequest('Некорректный публичный адрес (4–32 символа: a-z, 0-9, _)');
  const existing = get<{ id: string }>('SELECT id FROM chats WHERE username = ? COLLATE NOCASE', [normalized]);
  if (existing && existing.id !== excludeChatId) throw errors.conflict('Этот адрес уже занят');
  const usernameTaken = get<{ id: string }>('SELECT id FROM users WHERE username = ? COLLATE NOCASE', [normalized]);
  if (usernameTaken) throw errors.conflict('Адрес совпадает с логином пользователя');
  return normalized;
}

export function createChat(params: {
  type: 'group' | 'channel';
  title: string;
  description?: string | null;
  username?: string | null;
  isPublic?: boolean;
  ownerId: string;
  memberIds?: string[];
}): ChatRow {
  const title = params.title.trim();
  if (title.length < 1 || title.length > 128) throw errors.badRequest('Название должно быть от 1 до 128 символов');
  const username = params.username ? validateChatUsername(params.username) : null;
  if (username && !params.isPublic) throw errors.badRequest('Публичный адрес требует публичного чата');
  const id = crypto.randomUUID();
  const ts = now();
  const members = Array.from(new Set([params.ownerId, ...(params.memberIds ?? [])]));
  tx(() => {
    run(
      `INSERT INTO chats(id, type, title, username, description, is_public, created_by, created_at, updated_at, member_count, default_permissions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, params.type, title, username, params.description ?? null, params.isPublic ? 1 : 0, params.ownerId, ts, ts, members.length, '{}'],
    );
    run(`INSERT INTO chat_members(chat_id, user_id, role, joined_at, permissions) VALUES (?, ?, 'owner', ?, '{}')`, [id, params.ownerId, ts]);
    for (const memberId of members) {
      if (memberId === params.ownerId) continue;
      run(`INSERT INTO chat_members(chat_id, user_id, role, joined_at, invited_by) VALUES (?, ?, 'member', ?, ?)`, [id, memberId, ts, params.ownerId]);
    }
    if (params.type === 'channel') {
      // Обсуждение создаётся лениво, но ссылка на канал нужна сразу.
      run('UPDATE chats SET signature_enabled = 0 WHERE id = ?', [id]);
    }
  });
  return requireChat(id);
}

export function addMember(chatId: string, userId: string, role: MemberRole = 'member', invitedBy?: string | null): void {
  const chat = requireChat(chatId);
  tx(() => {
    run(
      `INSERT INTO chat_members(chat_id, user_id, role, joined_at, invited_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, user_id) DO UPDATE SET banned = 0, banned_at = NULL, banned_by = NULL`,
      [chatId, userId, role, now(), invitedBy ?? null],
    );
    recountMembers(chatId);
    run('UPDATE chats SET updated_at = ? WHERE id = ?', [now(), chatId]);
  });
  void chat;
}

export function removeMember(chatId: string, userId: string): void {
  tx(() => {
    run('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
    recountMembers(chatId);
  });
}

export function recountMembers(chatId: string): void {
  const count = get<{ c: number }>('SELECT count(*) AS c FROM chat_members WHERE chat_id = ? AND banned = 0', [chatId])?.c ?? 0;
  run('UPDATE chats SET member_count = ? WHERE id = ?', [count, chatId]);
}

export function banMember(chatId: string, userId: string, byId: string): void {
  run('UPDATE chat_members SET banned = 1, banned_at = ?, banned_by = ? WHERE chat_id = ? AND user_id = ?', [now(), byId, chatId, userId]);
  recountMembers(chatId);
}

export function unbanMember(chatId: string, userId: string): void {
  run('UPDATE chat_members SET banned = 0, banned_at = NULL, banned_by = NULL, joined_at = ? WHERE chat_id = ? AND user_id = ?', [now(), chatId, userId]);
  recountMembers(chatId);
}

export function listMembers(chatId: string, limit = 100, offset = 0): Array<{ member: MemberRow; user: { id: string; username: string; display_name: string; avatar_media_id: string | null } }> {
  const rows = all<MemberRow & { username: string; display_name: string; avatar_media_id: string | null }>(
    `SELECT m.*, u.username, u.display_name, u.avatar_media_id
     FROM chat_members m JOIN users u ON u.id = m.user_id
     WHERE m.chat_id = ? AND m.banned = 0 AND u.deleted_at IS NULL
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.display_name
     LIMIT ? OFFSET ?`,
    [chatId, limit, offset],
  );
  return rows.map((row) => ({
    member: row,
    user: { id: row.user_id, username: row.username, display_name: row.display_name, avatar_media_id: row.avatar_media_id },
  }));
}

export function canManageMembers(chat: ChatRow, member: MemberRow): boolean {
  const perms = effectivePermissions(chat, member);
  return member.role === 'owner' || (member.role === 'admin' && (perms.banUsers || perms.muteUsers));
}

export function isMember(chatId: string, userId: string): boolean {
  const row = getMembership(chatId, userId);
  return !!row && !row.banned;
}
