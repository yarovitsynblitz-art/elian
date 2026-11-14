import Dexie, { type Table } from 'dexie';
import type { ChatSummary, Message } from '@elian/shared';

/** Локальный кэш и offline-outbox (IndexedDB через Dexie). */
export interface CachedChat {
  id: string;
  summary: ChatSummary;
  updatedAt: number;
}

export interface CachedMessage {
  id: string;
  chatId: string;
  seq: number;
  message: Message;
  updatedAt: number;
}

export interface OutboxItem {
  id: string;
  chatId: string;
  text: string;
  clientMessageId: string;
  createdAt: number;
  attempts: number;
  status: 'queued' | 'sending' | 'failed';
  replyToId?: string | null;
}

export interface CachedUser {
  id: string;
  payload: unknown;
  updatedAt: number;
}

class ElianDatabase extends Dexie {
  chats!: Table<CachedChat, string>;
  messages!: Table<CachedMessage, string>;
  outbox!: Table<OutboxItem, string>;
  users!: Table<CachedUser, string>;
  settings!: Table<{ key: string; value: unknown }, string>;

  constructor() {
    super('elian');
    this.version(1).stores({
      chats: 'id, updatedAt',
      messages: 'id, chatId, seq, [chatId+seq]',
      outbox: 'id, chatId, createdAt',
      users: 'id',
      settings: 'key',
    });
  }
}

export const db = new ElianDatabase();

export async function cacheChats(chats: ChatSummary[]): Promise<void> {
  const now = Date.now();
  await db.chats.bulkPut(chats.map((summary) => ({ id: summary.id, summary, updatedAt: now })));
}

export async function cacheMessages(messages: Message[]): Promise<void> {
  const now = Date.now();
  await db.messages.bulkPut(
    messages.map((message) => ({ id: message.id, chatId: message.chatId, seq: message.seq, message, updatedAt: now })),
  );
}

export async function readCachedMessages(chatId: string, limit = 60): Promise<Message[]> {
  const rows = await db.messages.where('chatId').equals(chatId).reverse().sortBy('seq');
  return rows.slice(-limit).map((row) => row.message);
}

export async function readCachedChats(): Promise<ChatSummary[]> {
  const rows = await db.chats.toArray();
  return rows
    .sort((a, b) => (b.summary.lastMessageAt ?? '').localeCompare(a.summary.lastMessageAt ?? ''))
    .map((row) => row.summary);
}

export async function queueOutbox(item: Omit<OutboxItem, 'attempts' | 'status'>): Promise<void> {
  await db.outbox.put({ ...item, attempts: 0, status: 'queued' });
}

export async function pendingOutbox(chatId?: string): Promise<OutboxItem[]> {
  const rows = chatId ? await db.outbox.where('chatId').equals(chatId).toArray() : await db.outbox.toArray();
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

export async function removeOutbox(id: string): Promise<void> {
  await db.outbox.delete(id);
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await db.settings.put({ key, value });
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const row = await db.settings.get(key);
  return row?.value as T | undefined;
}

export async function clearCache(): Promise<void> {
  await Promise.all([db.messages.clear(), db.chats.clear(), db.users.clear()]);
}
