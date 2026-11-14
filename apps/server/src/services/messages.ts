import crypto from 'node:crypto';
import {
  LIMITS, parseEntities, REACTION_WHITELIST,
  type Attachment, type AttachmentKind, type Message, type MessageEntity, type Poll, type ReactionSummary,
} from '@elian/shared';
import { all, get, run, tx } from '../db/index.js';
import { errors } from '../lib/errors.js';
import { now } from '../lib/time.js';
import type { MemberRow } from './chats.js';

export interface MessageRow {
  id: string;
  chat_id: string;
  seq: number;
  sender_id: string | null;
  text: string;
  entities: string;
  reply_to_id: string | null;
  thread_root_id: string | null;
  forwarded_from_chat_id: string | null;
  forwarded_from_user_id: string | null;
  forwarded_name: string | null;
  author_signature: string | null;
  silent: number;
  pinned: number;
  pinned_at: string | null;
  via_bot_id: string | null;
  client_message_id: string | null;
  has_media: number;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface AttachmentRow {
  id: string;
  message_id: string;
  kind: AttachmentKind;
  position: number;
  media_id: string | null;
  thumb_media_id: string | null;
  file_name: string | null;
  mime_type: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  waveform: string | null;
  spoiler: number;
  latitude: number | null;
  longitude: number | null;
  contact_name: string | null;
  contact_username: string | null;
  poll_id: string | null;
}

export interface AttachmentInput {
  kind: AttachmentKind;
  mediaId?: string | null;
  thumbMediaId?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  size?: number | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  waveform?: number[] | null;
  spoiler?: boolean;
  latitude?: number | null;
  longitude?: number | null;
  contactName?: string | null;
  contactUsername?: string | null;
  pollId?: string | null;
}

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export function serializeAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    kind: row.kind,
    mediaId: row.media_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    size: row.size,
    width: row.width,
    height: row.height,
    duration: row.duration,
    waveform: safeJson<number[] | null>(row.waveform, null),
    thumbnailMediaId: row.thumb_media_id,
    spoiler: Boolean(row.spoiler),
    latitude: row.latitude,
    longitude: row.longitude,
    contactName: row.contact_name,
    contactUsername: row.contact_username,
    pollId: row.poll_id,
    url: row.media_id ? `/api/v1/media/${row.media_id}/content` : null,
    thumbUrl: row.thumb_media_id
      ? `/api/v1/media/${row.thumb_media_id}/content`
      : row.media_id && (row.kind === 'photo' || row.kind === 'video')
        ? `/api/v1/media/${row.media_id}/content`
        : null,
    downloadUrl: row.media_id ? `/api/v1/media/${row.media_id}/download` : null,
  };
}

export function serializePoll(pollId: string, viewerId: string): Poll | null {
  const row = get<{
    id: string; question: string; options: string; anonymous: number; multiple: number; quiz: number;
    correct_option_id: string | null; closed: number; created_by: string;
  }>('SELECT * FROM polls WHERE id = ?', [pollId]);
  if (!row) return null;
  const options = safeJson<Array<{ id: string; text: string }>>(row.options, []);
  const votes = all<{ option_id: string; c: number }>('SELECT option_id, count(*) AS c FROM votes WHERE poll_id = ? GROUP BY option_id', [pollId]);
  const myVotes = all<{ option_id: string }>('SELECT option_id FROM votes WHERE poll_id = ? AND user_id = ?', [pollId, viewerId]);
  const countByOption = new Map(votes.map((v) => [v.option_id, v.c]));
  const total = votes.reduce((sum, v) => sum + v.c, 0);
  const voted = new Set(myVotes.map((v) => v.option_id));
  return {
    id: row.id,
    question: row.question,
    options: options.map((o) => ({
      id: o.id,
      text: o.text,
      votes: row.anonymous && !voted.has(o.id) && total > 0 && !row.closed ? countByOption.get(o.id) ?? 0 : countByOption.get(o.id) ?? 0,
    })),
    anonymous: Boolean(row.anonymous),
    multiple: Boolean(row.multiple),
    quiz: Boolean(row.quiz),
    correctOptionId: row.closed || voted.size ? row.correct_option_id : null,
    closed: Boolean(row.closed),
    totalVotes: total,
    votedOptionIds: [...voted],
    createdBy: row.created_by,
  };
}

export function serializeMessage(row: MessageRow, viewerId: string): Message {
  const sender = row.sender_id
    ? get<{ id: string; username: string; display_name: string; avatar_media_id: string | null }>(
      'SELECT id, username, display_name, avatar_media_id FROM users WHERE id = ?', [row.sender_id],
    )
    : null;
  const attachments = all<AttachmentRow>('SELECT * FROM attachments WHERE message_id = ? ORDER BY position', [row.id]).map(serializeAttachment);
  const attachmentsWithPoll = attachments.map((a) => (a.pollId ? { ...a, ...(a) } : a));
  const pollRow = all<{ id: string }>('SELECT id FROM polls WHERE message_id = ? LIMIT 1', [row.id])[0];
  const reactions = all<{ emoji: string; user_id: string }>('SELECT emoji, user_id FROM reactions WHERE message_id = ?', [row.id]);
  const grouped = new Map<string, string[]>();
  for (const r of reactions) {
    const list = grouped.get(r.emoji) ?? [];
    list.push(r.user_id);
    grouped.set(r.emoji, list);
  }
  const reactionSummary: ReactionSummary[] = [...grouped.entries()]
    .map(([emoji, userIds]) => ({ emoji, count: userIds.length, byMe: userIds.includes(viewerId), recentUserIds: userIds.slice(0, 5) }))
    .sort((a, b) => b.count - a.count);
  const reply = row.reply_to_id
    ? get<MessageRow & { sender_name: string | null }>(
      `SELECT m.*, u.display_name AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?`,
      [row.reply_to_id],
    )
    : null;
  const replyAttachments = reply ? all<AttachmentRow>('SELECT kind FROM attachments WHERE message_id = ? LIMIT 1', [reply.id]) : [];
  const peerReadSeq = get<{ last_read_seq: number }>(
    `SELECT last_read_seq FROM chat_members WHERE chat_id = ? AND user_id <> ? LIMIT 1`,
    [row.chat_id, viewerId],
  )?.last_read_seq ?? 0;
  const chat = get<{ type: string }>('SELECT type FROM chats WHERE id = ?', [row.chat_id]);
  return {
    id: row.id,
    chatId: row.chat_id,
    seq: row.seq,
    senderId: row.sender_id,
    sender: sender
      ? { id: sender.id, username: sender.username, displayName: sender.display_name, avatarUrl: sender.avatar_media_id ? `/api/v1/media/${sender.avatar_media_id}/content` : null }
      : null,
    authorSignature: row.author_signature,
    text: row.deleted_at ? '' : row.text,
    entities: row.deleted_at ? [] : safeJson<MessageEntity[]>(row.entities, []),
    attachments: row.deleted_at ? [] : attachmentsWithPoll,
    poll: pollRow ? serializePoll(pollRow.id, viewerId) : null,
    replyToId: row.reply_to_id,
    replyTo: reply
      ? {
        id: reply.id,
        text: reply.text.slice(0, 200),
        senderId: reply.sender_id,
        senderName: reply.sender_name,
        attachmentKind: (replyAttachments[0]?.kind as AttachmentKind) ?? null,
      }
      : null,
    forwardedFrom: row.forwarded_name
      ? { chatId: row.forwarded_from_chat_id, userId: row.forwarded_from_user_id, name: row.forwarded_name }
      : null,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    pinned: Boolean(row.pinned),
    silent: Boolean(row.silent),
    viaBotId: row.via_bot_id,
    reactions: reactionSummary,
    deliveredToAll: chat?.type === 'private' ? row.seq <= peerReadSeq : false,
    readByAll: chat?.type === 'private' ? row.seq <= peerReadSeq : false,
    clientMessageId: row.client_message_id,
    threadRootId: row.thread_root_id,
    isOutgoing: row.sender_id === viewerId,
  };
}

export interface SendMessageParams {
  chatId: string;
  senderId: string | null;
  text?: string;
  attachments?: AttachmentInput[];
  replyToId?: string | null;
  threadRootId?: string | null;
  silent?: boolean;
  clientMessageId?: string | null;
  viaBotId?: string | null;
  authorSignature?: string | null;
  forwardedFrom?: { chatId?: string | null; userId?: string | null; name: string } | null;
  poll?: { question: string; options: string[]; anonymous?: boolean; multiple?: boolean; quiz?: boolean; correctOptionId?: string | null } | null;
  /** Разрешает обойти проверку прав (системные сообщения, отложенные). */
  system?: boolean;
  createdAt?: string;
}

export function insertMessage(params: SendMessageParams): MessageRow {
  const text = (params.text ?? '').trim();
  const attachments = params.attachments ?? [];
  if (!params.system) {
    if (!text && attachments.length === 0 && !params.poll) throw errors.badRequest('Сообщение пустое');
    if (text.length > LIMITS.messageMax) throw errors.badRequest(`Сообщение длиннее ${LIMITS.messageMax} символов`);
    if (attachments.length > 10) throw errors.badRequest('Не более 10 вложений в сообщении');
  }
  if (params.replyToId) {
    const reply = get<{ chat_id: string }>('SELECT chat_id FROM messages WHERE id = ? AND deleted_at IS NULL', [params.replyToId]);
    if (!reply || reply.chat_id !== params.chatId) throw errors.badRequest('Ответ на сообщение из другого чата невозможен');
  }
  if (params.clientMessageId) {
    const existing = get<MessageRow>(
      'SELECT * FROM messages WHERE chat_id = ? AND sender_id IS ? AND client_message_id = ?',
      [params.chatId, params.senderId, params.clientMessageId],
    );
    if (existing) return existing;
  }
  const parsed = parseEntities(text);
  const id = crypto.randomUUID();
  const createdAt = params.createdAt ?? now();
  return tx(() => {
    const seqRow = get<{ last_seq: number }>('SELECT last_seq FROM chats WHERE id = ?', [params.chatId]);
    if (!seqRow) throw errors.notFound('Чат не найден');
    const seq = seqRow.last_seq + 1;
    run('UPDATE chats SET last_seq = ?, last_message_at = ?, updated_at = ? WHERE id = ?', [seq, createdAt, createdAt, params.chatId]);
    run(
      `INSERT INTO messages(id, chat_id, seq, sender_id, text, entities, reply_to_id, thread_root_id,
        forwarded_from_chat_id, forwarded_from_user_id, forwarded_name, author_signature, silent, via_bot_id,
        client_message_id, has_media, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, params.chatId, seq, params.senderId, parsed.text, JSON.stringify(parsed.entities), params.replyToId ?? null,
        params.threadRootId ?? null, params.forwardedFrom?.chatId ?? null, params.forwardedFrom?.userId ?? null,
        params.forwardedFrom?.name ?? null, params.authorSignature ?? null, params.silent ? 1 : 0, params.viaBotId ?? null,
        params.clientMessageId ?? null, attachments.length > 0 || params.poll ? 1 : 0, createdAt,
      ],
    );
    let position = 0;
    for (const attachment of attachments) {
      const attachmentId = crypto.randomUUID();
      if (attachment.mediaId) {
        const media = get<{ id: string }>('SELECT id FROM media WHERE id = ? AND deleted_at IS NULL', [attachment.mediaId]);
        if (!media) throw errors.badRequest('Вложение ссылается на неизвестный файл');
      }
      run(
        `INSERT INTO attachments(id, message_id, kind, position, media_id, thumb_media_id, file_name, mime_type, size,
          width, height, duration, waveform, spoiler, latitude, longitude, contact_name, contact_username, poll_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attachmentId, id, attachment.kind, position++, attachment.mediaId ?? null, attachment.thumbMediaId ?? null,
          attachment.fileName ?? null, attachment.mimeType ?? null, attachment.size ?? null, attachment.width ?? null,
          attachment.height ?? null, attachment.duration ?? null,
          attachment.waveform ? JSON.stringify(attachment.waveform.slice(0, 120)) : null,
          attachment.spoiler ? 1 : 0, attachment.latitude ?? null, attachment.longitude ?? null,
          attachment.contactName ?? null, attachment.contactUsername ?? null, attachment.pollId ?? null,
        ],
      );
    }
    if (params.poll) {
      if (params.poll.options.length < 2 || params.poll.options.length > 10) throw errors.badRequest('В опросе должно быть 2–10 вариантов');
      const pollId = crypto.randomUUID();
      const optionRows = params.poll.options.map((optionText) => ({ id: crypto.randomUUID(), text: optionText.slice(0, 100) }));
      run(
        `INSERT INTO polls(id, chat_id, message_id, question, options, anonymous, multiple, quiz, correct_option_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          pollId, params.chatId, id, params.poll.question.slice(0, 255), JSON.stringify(optionRows),
          params.poll.anonymous === false ? 0 : 1, params.poll.multiple ? 1 : 0, params.poll.quiz ? 1 : 0,
          params.poll.correctOptionId ?? null, params.senderId ?? '', createdAt,
        ],
      );
      run('UPDATE messages SET has_media = 1 WHERE id = ?', [id]);
    }
    run('UPDATE chat_members SET archived = 0 WHERE chat_id = ? AND archived = 1', [params.chatId]);
    return get<MessageRow>('SELECT * FROM messages WHERE id = ?', [id])!;
  });
}

export function listMessages(params: {
  chatId: string;
  viewerId: string;
  beforeSeq?: number | null;
  afterSeq?: number | null;
  aroundSeq?: number | null;
  limit?: number;
  threadRootId?: string | null;
}): { messages: Message[]; hasMore: boolean; oldestSeq: number | null } {
  const limit = Math.min(Math.max(params.limit ?? 40, 1), 100);
  let rows: MessageRow[];
  if (params.aroundSeq) {
    const before = all<MessageRow>(
      'SELECT * FROM messages WHERE chat_id = ? AND seq <= ? AND deleted_at IS NULL ORDER BY seq DESC LIMIT ?',
      [params.chatId, params.aroundSeq, Math.ceil(limit / 2)],
    );
    const after = all<MessageRow>(
      'SELECT * FROM messages WHERE chat_id = ? AND seq > ? AND deleted_at IS NULL ORDER BY seq ASC LIMIT ?',
      [params.chatId, params.aroundSeq, Math.floor(limit / 2)],
    );
    rows = [...before.reverse(), ...after];
    return { messages: rows.map((r) => serializeMessage(r, params.viewerId)), hasMore: before.length + after.length >= limit, oldestSeq: rows[0]?.seq ?? null };
  }
  if (params.afterSeq != null) {
    rows = all<MessageRow>(
      'SELECT * FROM messages WHERE chat_id = ? AND seq > ? AND deleted_at IS NULL ORDER BY seq ASC LIMIT ?',
      [params.chatId, params.afterSeq, limit],
    );
  } else {
    rows = all<MessageRow>(
      'SELECT * FROM messages WHERE chat_id = ? AND seq < ? AND deleted_at IS NULL ORDER BY seq DESC LIMIT ?',
      [params.chatId, params.beforeSeq ?? Number.MAX_SAFE_INTEGER, limit + 1],
    );
    const hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
    rows.reverse();
    return { messages: rows.map((r) => serializeMessage(r, params.viewerId)), hasMore, oldestSeq: rows[0]?.seq ?? null };
  }
  return { messages: rows.map((r) => serializeMessage(r, params.viewerId)), hasMore: rows.length === limit, oldestSeq: rows[0]?.seq ?? null };
}

export function getMessageRow(messageId: string): MessageRow | null {
  return get<MessageRow>('SELECT * FROM messages WHERE id = ?', [messageId]) ?? null;
}

export function editMessage(messageId: string, editorId: string, newText: string, canEditOthers: boolean): MessageRow {
  const row = getMessageRow(messageId);
  if (!row || row.deleted_at) throw errors.notFound('Сообщение не найдено');
  if (row.sender_id !== editorId && !canEditOthers) throw errors.forbidden('Можно редактировать только свои сообщения');
  const text = newText.trim();
  if (!text) throw errors.badRequest('Текст не может быть пустым');
  if (text.length > LIMITS.messageMax) throw errors.badRequest('Слишком длинный текст');
  const parsed = parseEntities(text);
  tx(() => {
    run('INSERT INTO message_edits(id, message_id, text, entities, edited_by, edited_at) VALUES (?, ?, ?, ?, ?, ?)', [
      crypto.randomUUID(), messageId, row.text, row.entities, editorId, now(),
    ]);
    run('UPDATE messages SET text = ?, entities = ?, edited_at = ? WHERE id = ?', [parsed.text, JSON.stringify(parsed.entities), now(), messageId]);
  });
  return getMessageRow(messageId)!;
}

export function deleteMessage(messageId: string, actorId: string, forEveryone: boolean, canDeleteOthers: boolean): { chatId: string; forEveryone: boolean } {
  const row = getMessageRow(messageId);
  if (!row) throw errors.notFound('Сообщение не найдено');
  if (row.sender_id !== actorId && !canDeleteOthers) throw errors.forbidden('Недостаточно прав');
  if (forEveryone) {
    run('UPDATE messages SET deleted_at = ?, deleted_by = ?, text = \'\', entities = \'[]\', has_media = 0 WHERE id = ?', [now(), actorId, messageId]);
    run('DELETE FROM reactions WHERE message_id = ?', [messageId]);
  } else {
    run('UPDATE messages SET deleted_at = ?, deleted_by = ? WHERE id = ?', [now(), actorId, messageId]);
  }
  return { chatId: row.chat_id, forEveryone };
}

/** Реакции глазами конкретного пользователя (byMe считается для него). */
export function reactionSummaries(messageId: string, viewerId: string): ReactionSummary[] {
  const grouped = new Map<string, string[]>();
  for (const r of all<{ emoji: string; user_id: string }>('SELECT emoji, user_id FROM reactions WHERE message_id = ?', [messageId])) {
    const list = grouped.get(r.emoji) ?? [];
    list.push(r.user_id);
    grouped.set(r.emoji, list);
  }
  return [...grouped.entries()]
    .map(([e, ids]) => ({ emoji: e, count: ids.length, byMe: ids.includes(viewerId), recentUserIds: ids.slice(0, 5) }))
    .sort((a, b) => b.count - a.count);
}

export function toggleReaction(messageId: string, userId: string, emoji: string, active: boolean): ReactionSummary[] {
  if (!REACTION_WHITELIST.includes(emoji as (typeof REACTION_WHITELIST)[number]) && [...emoji].length > 8) {
    throw errors.badRequest('Недопустимая реакция');
  }
  const row = getMessageRow(messageId);
  if (!row || row.deleted_at) throw errors.notFound('Сообщение не найдено');
  if (active) {
    run('INSERT INTO reactions(message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [messageId, userId, emoji, now()]);
  } else {
    run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [messageId, userId, emoji]);
  }
  return reactionSummaries(messageId, userId);
}

export function pinMessage(messageId: string, pinned: boolean): MessageRow {
  const row = getMessageRow(messageId);
  if (!row) throw errors.notFound('Сообщение не найдено');
  run('UPDATE messages SET pinned = ?, pinned_at = ? WHERE id = ?', [pinned ? 1 : 0, pinned ? now() : null, messageId]);
  return getMessageRow(messageId)!;
}

export function markRead(chatId: string, userId: string, upToSeq: number, member: MemberRow): number {
  const target = Math.min(upToSeq, get<{ last_seq: number }>('SELECT last_seq FROM chats WHERE id = ?', [chatId])?.last_seq ?? 0);
  if (target <= member.last_read_seq) return member.last_read_seq;
  run('UPDATE chat_members SET last_read_seq = ?, last_delivered_seq = max(last_delivered_seq, ?) WHERE chat_id = ? AND user_id = ?', [
    target, target, chatId, userId,
  ]);
  run('UPDATE drafts SET text = text WHERE 0');
  return target;
}

export function markDelivered(chatId: string, userId: string, upToSeq: number): void {
  run('UPDATE chat_members SET last_delivered_seq = max(last_delivered_seq, ?) WHERE chat_id = ? AND user_id = ?', [upToSeq, chatId, userId]);
}

export function votePoll(pollId: string, userId: string, optionIds: string[]): Poll {
  const poll = get<{ options: string; multiple: number; closed: number }>('SELECT options, multiple, closed FROM polls WHERE id = ?', [pollId]);
  if (!poll) throw errors.notFound('Опрос не найден');
  if (poll.closed) throw errors.badRequest('Опрос закрыт');
  const options = safeJson<Array<{ id: string }>>(poll.options, []);
  const valid = new Set(options.map((o) => o.id));
  const chosen = optionIds.filter((id) => valid.has(id));
  if (!chosen.length) throw errors.badRequest('Выберите вариант');
  if (!poll.multiple && chosen.length > 1) throw errors.badRequest('Можно выбрать только один вариант');
  tx(() => {
    if (!poll.multiple) run('DELETE FROM votes WHERE poll_id = ? AND user_id = ?', [pollId, userId]);
    for (const optionId of chosen) {
      run('INSERT INTO votes(poll_id, option_id, user_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [pollId, optionId, userId, now()]);
    }
  });
  return serializePoll(pollId, userId)!;
}

export function closePoll(pollId: string, userId: string): Poll {
  const poll = get<{ created_by: string; chat_id: string }>('SELECT created_by, chat_id FROM polls WHERE id = ?', [pollId]);
  if (!poll) throw errors.notFound('Опрос не найден');
  const member = get<MemberRow>('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?', [poll.chat_id, userId]);
  if (poll.created_by !== userId && (!member || member.role === 'member')) throw errors.forbidden('Недостаточно прав');
  run('UPDATE polls SET closed = 1 WHERE id = ?', [pollId]);
  return serializePoll(pollId, userId)!;
}
