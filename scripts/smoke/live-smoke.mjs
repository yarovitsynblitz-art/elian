#!/usr/bin/env node
/**
 * Живой смоук-тест: поднимает production-сборку сервера во временном каталоге,
 * проходит регистрацию → подтверждение владельцем (через stdin консоли) → сессию,
 * создаёт чат, отправляет сообщения, проверяет поиск, реакции, WebSocket и PWA-раздачу.
 *
 * Запуск: node scripts/smoke/live-smoke.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elian-live-'));
const dataDir = path.join(workDir, 'data');
const secretsDir = path.join(workDir, 'secrets');
const port = 3311 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
const password = 'proverka-zhivogo-servera-2026';

for (const dir of [dataDir, secretsDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

let failures = 0;
let checks = 0;
function check(name, condition, extra = '') {
  checks += 1;
  if (condition) {
    console.log(`  ✔ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✘ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logs = [];

const child = spawn(process.execPath, [path.join(root, 'apps/server/dist/index.js')], {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: dataDir,
    SECRETS_DIR: secretsDir,
    PUBLIC_DOMAIN: 'smoke.test',
    PUBLIC_URL: base,
    LOG_LEVEL: 'info',
    ARGON2_MEMORY_KIB: '19456',
    ARGON2_TIME_COST: '2',
    TERMUX_NOTIFICATIONS: 'false',
    RATE_LIMIT_ENABLED: 'false',
    DB_ENCRYPTION: 'required',
    WEB_DIST_DIR: path.join(root, 'apps/web/dist'),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
child.stderr.on('data', (chunk) => logs.push(chunk.toString()));

async function waitHealthy(timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${base}/api/v1/health`);
      if (response.ok) return true;
    } catch { /* ещё поднимается */ }
    await sleep(250);
  }
  return false;
}

class Client {
  constructor() {
    this.cookies = new Map();
  }
  cookieHeader() {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
  }
  store(response) {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const cookie of raw) {
      const [pair] = cookie.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
  }
  async request(method, urlPath, body, headers = {}) {
    const response = await fetch(`${base}${urlPath}`, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: base,
        cookie: this.cookieHeader(),
        'x-csrf-token': this.cookies.get('elian_csrf') ?? '',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.store(response);
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, json, text, response };
  }
  get(p) { return this.request('GET', p); }
  post(p, b) { return this.request('POST', p, b); }
  patch(p, b) { return this.request('PATCH', p, b); }
  del(p, b) { return this.request('DELETE', p, b); }
}

function approveNext() {
  child.stdin.write('y\n');
}

const started = Date.now();
try {
  const healthy = await waitHealthy();
  check('сервер поднялся и /health отвечает', healthy);
  if (!healthy) throw new Error('сервер не запустился:\n' + logs.join(''));

  const health = await fetch(`${base}/api/v1/health`).then((r) => r.json());
  check('health отдаёт статус ok', health.status === 'ok' || health.ok === true, JSON.stringify(health).slice(0, 120));

  const indexHtml = await fetch(`${base}/`);
  const html = await indexHtml.text();
  check('PWA-оболочка раздаётся с того же origin', indexHtml.ok && html.includes('<div id="root">'));
  const manifest = await fetch(`${base}/manifest.webmanifest`);
  check('manifest.webmanifest доступен', manifest.ok);
  const sw = await fetch(`${base}/sw.js`);
  check('service worker доступен', sw.ok);

  const alice = new Client();
  const anonymous = await alice.get('/api/v1/me');
  check('неаутентифицированный /me даёт 401', anonymous.status === 401);

  const username = `smoke_${Date.now().toString(36)}`;
  const registration = await alice.post('/api/v1/auth/register', {
    username,
    displayName: 'Смоук Тест',
    password,
  });
  check('регистрация создаёт заявку (не активного пользователя)', registration.status === 202, `${registration.status} ${registration.text.slice(0, 160)}`);
  const requestId = registration.json?.requestId;
  const clientSecret = registration.json?.approvalSecret;
  check('клиент не получает код подтверждения', !registration.text.includes('code') || !/[A-Z0-9]{4}-[A-Z0-9]{4}/.test(registration.text));

  const loginBeforeApproval = await alice.post('/api/v1/auth/login', { username, password });
  check('до подтверждения войти нельзя', loginBeforeApproval.status >= 400, `status=${loginBeforeApproval.status}`);

  const statusPending = await alice.post('/api/v1/auth/pending/status', { requestId, approvalSecret: clientSecret });
  check('статус заявки = pending', statusPending.json?.status === 'pending', statusPending.text.slice(0, 120));

  approveNext();
  await sleep(1200);
  const statusApproved = await alice.post('/api/v1/auth/pending/status', { requestId, approvalSecret: clientSecret });
  check('после y владельца статус = approved', statusApproved.json?.status === 'approved', statusApproved.text.slice(0, 160));

  const exchange = await alice.post('/api/v1/auth/pending/exchange-registration', { requestId, approvalSecret: clientSecret });
  check('обмен заявки даёт сессию', exchange.status === 200 && alice.cookies.has('elian_session'), `${exchange.status}`);
  const me = await alice.get('/api/v1/me');
  check('/me возвращает профиль', me.status === 200 && me.json?.user?.username === username);

  check('после входа выдан CSRF-cookie для double-submit', alice.cookies.has('elian_csrf'));
  const noCsrf = await fetch(`${base}/api/v1/chats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: alice.cookieHeader() },
    body: JSON.stringify({ type: 'group', title: 'без csrf', memberIds: [] }),
  });
  check('мутация без CSRF-заголовка отклонена (403)', noCsrf.status === 403, `status=${noCsrf.status}`);

  const reuse = await alice.post('/api/v1/auth/pending/exchange-registration', { requestId, approvalSecret: clientSecret });
  check('повторный обмен заявки отклонён', reuse.status >= 400);

  const group = await alice.post('/api/v1/chats', { type: 'group', title: 'Смоук-группа', memberIds: [], isPublic: false });
  check('группа создаётся', group.status === 201, `${group.status} ${group.text.slice(0, 160)}`);
  const chatId = group.json?.chat?.id;

  const message = await alice.post(`/api/v1/chats/${chatId}/messages`, {
    text: 'Привет, **мир**! Тестовое сообщение со *смоук-теста*',
    clientMessageId: crypto.randomUUID(),
  });
  check('сообщение отправляется и парсится в entities', message.status === 201 && Array.isArray(message.json?.message?.entities), `${message.status} ${message.text.slice(0, 160)}`);

  const reaction = await alice.post(`/api/v1/messages/${message.json.message.id}/reactions`, { emoji: '👍', active: true });
  check('реакция ставится', reaction.status < 300, `${reaction.status}`);

  const search = await alice.get('/api/v1/search?q=%D0%BC%D0%B8%D1%80');
  check('поиск находит сообщение', search.status === 200 && search.json?.messages?.length > 0, `${search.status} ${search.text.slice(0, 160)}`);

  const chatSearch = await alice.get(`/api/v1/chats/${chatId}/search?q=Привет`);
  check('поиск внутри чата работает', chatSearch.status === 200);

  const uploaded = await uploadFile(alice, 'photo.png', pngBytes());
  check('загрузка медиа проходит', uploaded.status === 201, `${uploaded.status} ${uploaded.text.slice(0, 160)}`);
  if (uploaded.status === 201) {
    const mediaId = uploaded.json.media.id;
    const content = await fetch(`${base}/api/v1/media/${mediaId}/content`, { headers: { cookie: alice.cookieHeader() } });
    const buffer = Buffer.from(await content.arrayBuffer());
    check('скачивание возвращает исходные байты (расшифровка)', buffer.equals(pngBytes()));
  }

  const folder = await alice.post('/api/v1/folders', { name: 'Смоук', emoji: '📁', rules: [], includedChatIds: [], excludedChatIds: [], unreadOnly: false });
  check('папка создаётся', folder.status === 201, `${folder.status}`);

  const story = await alice.post('/api/v1/stories', { kind: 'text', text: 'Смоук-история', background: '#4B3AF0', privacy: 'contacts', duration: 5 });
  check('история публикуется', story.status === 201, `${story.status} ${story.text.slice(0, 120)}`);

  const callCfg = await alice.get('/api/v1/calls/config');
  check('ICE-конфигурация отдаётся', callCfg.status === 200 && Array.isArray(callCfg.json?.iceServers));

  const exportData = await alice.get('/api/v1/me/export');
  check('экспорт данных доступен', exportData.status === 200);

  const diag = await alice.get('/api/v1/me/diagnostics');
  check('диагностика доступна', diag.status === 200);

  const adminAttempt = await alice.post('/api/v1/auth/pending/approve', { requestId });
  check('публичный вызов подтверждения невозможен', adminAttempt.status === 404 || adminAttempt.status === 405);

  // WebSocket: подключение и доставка своего сообщения
  const wsResult = await websocketProbe(alice);
  check('Socket.IO подключается по сессии и доставляет message:new', wsResult.ok, wsResult.detail);

  const logout = await alice.post('/api/v1/auth/logout', {});
  check('выход завершает сессию', logout.status === 200);
  const afterLogout = await alice.get('/api/v1/me');
  check('после выхода /me снова 401', afterLogout.status === 401);

  const dbFiles = fs.readdirSync(dataDir).filter((file) => file.startsWith('elian.db'));
  check('база создана на диске', dbFiles.length > 0, dbFiles.join(','));
  const dbHead = fs.readFileSync(path.join(dataDir, 'elian.db')).subarray(0, 16).toString('latin1');
  check('файл БД зашифрован (не содержит SQLite-заголовка)', !dbHead.startsWith('SQLite format 3'), dbHead.replace(/[^\x20-\x7e]/g, '.'));

  const secretFiles = fs.readdirSync(secretsDir);
  check('секреты сгенерированы вне каталога данных', secretFiles.length >= 3, secretFiles.join(','));
  const modes = secretFiles.map((file) => fs.statSync(path.join(secretsDir, file)).mode & 0o777);
  check('права секретов 600', modes.every((mode) => mode === 0o600), modes.map((m) => m.toString(8)).join(','));

  const logText = logs.join('');
  check('пароль не попал в логи', !logText.includes(password));
  check('код подтверждения не попал в ответы API', !registration.text.includes('code'));
} catch (error) {
  failures += 1;
  console.error('Смоук упал:', error.message);
} finally {
  child.kill('SIGTERM');
  await sleep(400);
  const tail = logs.join('');
  const passwordLeak = tail.includes(password);
  check('лог сервера не содержит пароль (итог)', !passwordLeak);
  console.log(`\nИтог: ${checks - failures}/${checks} проверок успешно, ${((Date.now() - started) / 1000).toFixed(1)} с`);
  console.log(`Временный каталог: ${workDir}`);
  if (failures > 0) {
    console.log('\n--- хвост лога сервера ---\n' + tail.split('\n').slice(-40).join('\n'));
  }
  process.exit(failures > 0 ? 1 : 0);
}

async function uploadFile(client, name, bytes) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/png' }), name);
  form.append('kind', 'photo');
  const response = await fetch(`${base}/api/v1/media/upload`, {
    method: 'POST',
    headers: { origin: base, cookie: client.cookieHeader(), 'x-csrf-token': client.cookies.get('elian_csrf') ?? '' },
    body: form,
  });
  client.store(response);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: response.status, json, text };
}

function pngBytes() {
  // 1×1 PNG
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
}

async function websocketProbe(client) {
  const { io } = await import('socket.io-client');
  return new Promise((resolve) => {
    const socket = io(base, {
      transports: ['websocket'],
      extraHeaders: { cookie: client.cookieHeader() },
      reconnection: false,
      timeout: 8000,
    });
    const timer = setTimeout(() => {
      socket.close();
      resolve({ ok: false, detail: 'таймаут подключения' });
    }, 9000);
    socket.on('connect', async () => {
      const chats = await client.get('/api/v1/chats');
      const chatId = chats.json?.chats?.[0]?.id;
      socket.emit('chat:subscribe', { chatId }, () => undefined);
      socket.emit('message:send', { chatId, text: 'сообщение через websocket', clientMessageId: crypto.randomUUID() }, (ack) => {
        if (!ack?.ok) {
          clearTimeout(timer);
          socket.close();
          resolve({ ok: false, detail: JSON.stringify(ack).slice(0, 160) });
        }
      });
      socket.on('message:new', (payload) => {
        clearTimeout(timer);
        socket.close();
        resolve({ ok: payload?.message?.text === 'сообщение через websocket', detail: JSON.stringify(payload?.message?.text).slice(0, 80) });
      });
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      socket.close();
      resolve({ ok: false, detail: error.message });
    });
  });
}
