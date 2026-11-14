import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db/index.js';
import { ensureDirs } from '../src/config/env.js';
import { getSecret } from '../src/config/secrets.js';
import { approvePending, listPending, rejectPending } from '../src/auth/pending.js';

export interface Harness {
  app: FastifyInstance;
  close: () => Promise<void>;
}

export async function boot(): Promise<Harness> {
  ensureDirs();
  getSecret('DB_KEY');
  getSecret('MEDIA_KEY');
  getSecret('SESSION_PEPPER');
  openDatabase();
  runMigrations({ silent: true });
  const { app } = await buildApp({ serveStatic: false, logger: false });
  await app.ready();
  return {
    app,
    close: async () => {
      await app.close();
      closeDatabase();
    },
  };
}

export interface Client {
  cookies: Record<string, string>;
  userId?: string;
}

export function cookieHeader(client: Client): string {
  return Object.entries(client.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

export function captureCookies(setCookie: string | string[] | undefined, client: Client): void {
  if (!setCookie) return;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const raw of list) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === '' || /Expires=Thu, 01 Jan 1970/i.test(raw)) delete client.cookies[name];
    else client.cookies[name] = value;
  }
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
}

export async function api<T = any>(
  app: FastifyInstance,
  client: Client | null,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { body?: unknown; headers?: Record<string, string>; csrf?: boolean; origin?: string } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (client && Object.keys(client.cookies).length) headers.cookie = cookieHeader(client);
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.origin) headers.origin = options.origin;
  if (options.csrf !== false && client?.cookies.elian_csrf && method !== 'GET') {
    headers['x-csrf-token'] = client.cookies.elian_csrf;
  }
  const res = await app.inject({
    method,
    url,
    headers,
    payload: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (client) captureCookies(res.headers['set-cookie'] as string | string[] | undefined, client);
  let parsed: unknown = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch { parsed = res.body; }
  return { status: res.statusCode, body: parsed as T, headers: res.headers as Record<string, unknown> };
}

export interface RegisteredUser {
  client: Client;
  username: string;
  password: string;
  userId: string;
  user: unknown;
}

/** Полный сценарий: заявка → подтверждение владельцем (как `y` в Termux) → обмен на сессию. */
export async function registerUser(
  app: FastifyInstance,
  input: { username: string; password: string; displayName?: string },
  options: { approve?: boolean } = {},
): Promise<RegisteredUser & { pending: { requestId: string; approvalSecret: string; code: string } }> {
  const res = await api(app, null, 'POST', '/api/v1/auth/register', {
    body: { username: input.username, displayName: input.displayName ?? input.username, password: input.password },
  });
  if (res.status !== 202) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  const pendingRow = listPending().find((row) => row.id === res.body.requestId)!;
  if (options.approve === false) {
    return { pending: { ...res.body, code: pendingRow.code }, client: { cookies: {} }, username: input.username, password: input.password, userId: '', user: null };
  }
  approvePending(pendingRow.id, 'test-owner');
  const client: Client = { cookies: {} };
  const exchange = await api(app, client, 'POST', '/api/v1/auth/pending/exchange-registration', {
    body: { requestId: res.body.requestId, approvalSecret: res.body.approvalSecret },
  });
  if (exchange.status !== 200) throw new Error(`exchange failed: ${exchange.status} ${JSON.stringify(exchange.body)}`);
  client.userId = exchange.body.user.id;
  return {
    pending: { ...res.body, code: pendingRow.code },
    client,
    user: exchange.body.user,
    userId: exchange.body.user.id,
    username: input.username,
    password: input.password,
  };
}

export async function loginUser(
  app: FastifyInstance,
  input: { username: string; password: string },
): Promise<{ pending: { requestId: string; approvalSecret: string; code: string }; client: Client; user?: any }> {
  const res = await api(app, null, 'POST', '/api/v1/auth/login', { body: input });
  if (res.status !== 202) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const pendingRow = listPending().find((row) => row.id === res.body.requestId)!;
  approvePending(pendingRow.id, 'test-owner');
  const client: Client = { cookies: {} };
  const exchange = await api(app, client, 'POST', '/api/v1/auth/pending/exchange', {
    body: { requestId: res.body.requestId, approvalSecret: res.body.approvalSecret },
  });
  if (exchange.status !== 200) throw new Error(`exchange failed: ${exchange.status} ${JSON.stringify(exchange.body)}`);
  client.userId = exchange.body.user.id;
  return { pending: { ...res.body, code: pendingRow.code }, client, user: exchange.body.user };
}

export async function createGroup(app: FastifyInstance, client: Client, title: string, memberIds: string[] = []): Promise<any> {
  const res = await api(app, client, 'POST', '/api/v1/chats', { body: { type: 'group', title, memberIds } });
  if (res.status !== 201) throw new Error(`create chat failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.chat;
}

export async function openPrivateChat(app: FastifyInstance, client: Client, peerId: string): Promise<any> {
  const res = await api(app, client, 'POST', '/api/v1/chats/private', { body: { userId: peerId } });
  if (res.status >= 300) throw new Error(`private chat failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.chat;
}

export { approvePending, rejectPending, listPending };
