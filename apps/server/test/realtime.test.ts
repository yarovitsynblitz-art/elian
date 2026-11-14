import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { io as ioClient, type Socket } from 'socket.io-client';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { ensureDirs } from '../src/config/env.js';
import { getSecret } from '../src/config/secrets.js';
import { buildApp } from '../src/app.js';
import { api, cookieHeader, openPrivateChat, registerUser, type Client } from './helpers.js';

const PASS = 'Realtime-Qq9-Zx7-Zz';

let app: FastifyInstance;
let baseUrl: string;
let alice: { client: Client; userId: string };
let boris: { client: Client; userId: string };
let chatId: string;
const sockets: Socket[] = [];

function connect(client: Client): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      path: '/socket.io',
      transports: ['websocket'],
      extraHeaders: { cookie: cookieHeader(client) },
      reconnection: false,
    });
    sockets.push(socket);
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket connect timeout')), 5000);
  });
}

function waitFor<T>(socket: Socket, event: string, timeout = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting ${event}`)), timeout);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

beforeAll(async () => {
  ensureDirs();
  getSecret('DB_KEY');
  getSecret('MEDIA_KEY');
  getSecret('SESSION_PEPPER');
  openDatabase();
  runMigrations({ silent: true });
  const built = await buildApp({ serveStatic: false, logger: false });
  app = built.app;
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  alice = await registerUser(app, { username: 'rt_alice', password: PASS, displayName: 'Алиса' });
  boris = await registerUser(app, { username: 'rt_boris', password: PASS, displayName: 'Борис' });
  const chat = await openPrivateChat(app, alice.client, boris.userId);
  chatId = chat.id;
});

afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  await app.close();
});

describe('Realtime доставка', () => {
  it('два реальных клиента обмениваются сообщениями в реальном времени', async () => {
    const aliceSocket = await connect(alice.client);
    const borisSocket = await connect(boris.client);
    const received = waitFor<{ message: { text: string; seq: number } }>(borisSocket, 'message:new');
    const ack = await new Promise<{ ok: boolean; seq?: number }>((resolve) => {
      aliceSocket.emit('message:send', { chatId, clientMessageId: 'c-1', text: 'привет по сокету' }, resolve);
    });
    expect(ack.ok).toBe(true);
    const payload = await received;
    expect(payload.message.text).toBe('привет по сокету');
    expect(payload.message.seq).toBe(ack.seq);
    aliceSocket.disconnect();
    borisSocket.disconnect();
  });

  it('HTTP-сообщение доходит до socket-клиента, typing и receipt работают', async () => {
    const borisSocket = await connect(boris.client);
    const typing = waitFor<{ userId: string; kind: string }>(borisSocket, 'typing');
    const aliceSocket = await connect(alice.client);
    aliceSocket.emit('typing', { chatId, kind: 'typing' });
    const typingPayload = await typing;
    expect(typingPayload.userId).toBe(alice.userId);

    const newMessage = waitFor<{ message: { text: string } }>(borisSocket, 'message:new');
    const sent = await api(app, alice.client, 'POST', `/api/v1/chats/${chatId}/messages`, { body: { text: 'через HTTP' } });
    expect(sent.status).toBe(201);
    const payload = await newMessage;
    expect(payload.message.text).toBe('через HTTP');

    const receipt = waitFor<{ userId: string; kind: string }>(aliceSocket, 'receipt');
    borisSocket.emit('receipt:read', { chatId, upToSeq: 999 });
    const receiptPayload = await receipt;
    expect(receiptPayload.userId).toBe(boris.userId);
    aliceSocket.disconnect();
    borisSocket.disconnect();
  });

  it('offline/online и reconnect не теряют и не дублируют сообщения', async () => {
    const before = await api(app, alice.client, 'GET', `/api/v1/chats/${chatId}/messages?limit=100`);
    const lastSeq = before.body.messages.at(-1)?.seq ?? 0;
    // Борис вне сети: три сообщения через HTTP.
    for (const text of ['offline-1', 'offline-2', 'offline-3']) {
      const res = await api(app, alice.client, 'POST', `/api/v1/chats/${chatId}/messages`, {
        body: { text, clientMessageId: `idem-${text}` },
      });
      expect(res.status).toBe(201);
    }
    // Повторная отправка с тем же clientMessageId не создаёт дубль (идемпотентность outbox).
    const duplicate = await api(app, alice.client, 'POST', `/api/v1/chats/${chatId}/messages`, {
      body: { text: 'offline-3', clientMessageId: 'idem-offline-3' },
    });
    expect(duplicate.status).toBe(201);
    // Клиент после реконнекта догружает пропущенное.
    const borisSocket = await connect(boris.client);
    const catchUp = await api(app, boris.client, 'GET', `/api/v1/chats/${chatId}/messages?afterSeq=${lastSeq}`);
    const texts = catchUp.body.messages.map((m: { text: string }) => m.text);
    expect(texts.filter((t: string) => t.startsWith('offline-'))).toEqual(['offline-1', 'offline-2', 'offline-3']);
    const seqs = catchUp.body.messages.map((m: { seq: number }) => m.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    borisSocket.disconnect();
  });

  it('реакции и редактирование рассылаются подписчикам', async () => {
    const aliceSocket = await connect(alice.client);
    const borisSocket = await connect(boris.client);
    const sent = await api(app, alice.client, 'POST', `/api/v1/chats/${chatId}/messages`, { body: { text: 'реагируй' } });
    const messageId = sent.body.message.id;
    const reactionEvent = waitFor<{ reactions: Array<{ emoji: string; count: number }> }>(aliceSocket, 'reaction:changed');
    await api(app, boris.client, 'POST', `/api/v1/messages/${messageId}/reactions`, { body: { emoji: '🔥', active: true } });
    const reaction = await reactionEvent;
    expect(reaction.reactions[0]!.emoji).toBe('🔥');
    expect(reaction.reactions[0]!.count).toBe(1);

    const editEvent = waitFor<{ message: { text: string; editedAt: string } }>(borisSocket, 'message:edited');
    await api(app, alice.client, 'PATCH', `/api/v1/messages/${messageId}`, { body: { text: 'отредактировано' } });
    const edited = await editEvent;
    expect(edited.message.text).toBe('отредактировано');
    expect(edited.message.editedAt).toBeTruthy();
    aliceSocket.disconnect();
    borisSocket.disconnect();
  });

  it('нельзя подписаться на чужой чат', async () => {
    const carol = await registerUser(app, { username: 'rt_carol', password: PASS, displayName: 'Кэрол' });
    const socket = await connect(carol.client);
    const ok = await new Promise<boolean>((resolve) => socket.emit('chat:subscribe', { chatId }, resolve));
    expect(ok).toBe(false);
    // А участник — может.
    const borisSocket = await connect(boris.client);
    const okMember = await new Promise<boolean>((resolve) => borisSocket.emit('chat:subscribe', { chatId }, resolve));
    expect(okMember).toBe(true);
    socket.disconnect();
    borisSocket.disconnect();
  });

  it('анонимный сокет не может отправлять сообщения и не получает чужие', async () => {
    const socket = ioClient(baseUrl, { path: '/socket.io', transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', reject);
    });
    const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      socket.emit('message:send', { chatId, clientMessageId: 'anon', text: 'аноним' }, resolve);
    });
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('unauthorized');
    socket.disconnect();
  });

  it('присутствие: событие presence:changed для общих чатов', async () => {
    const aliceSocket = await connect(alice.client);
    const presence = waitFor<{ userId: string; online: boolean }>(aliceSocket, 'presence:changed', 8000);
    const borisSocket = await connect(boris.client);
    const payload = await presence;
    expect(payload.userId).toBe(boris.userId);
    expect(payload.online).toBe(true);
    aliceSocket.disconnect();
    borisSocket.disconnect();
  });
});
