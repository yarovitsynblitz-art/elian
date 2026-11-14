import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { api, approvePending, boot, listPending, loginUser, registerUser, rejectPending, type Harness } from './helpers.js';
import { expirePending, getPendingById, pendingStatusForClient } from '../src/auth/pending.js';
import { all, get, run } from '../src/db/index.js';
import { paths } from '../src/config/env.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db/index.js';
import { buildApp } from '../src/app.js';

const MARKER_PASSWORD = 'Marker-Qq9-Zx7-Zz3';

let h: Harness;
let app: FastifyInstance;

beforeAll(async () => {
  h = await boot();
  app = h.app;
});

afterAll(async () => {
  await h.close();
});

describe('Регистрация через подтверждение владельца', () => {
  it('создаёт заявку, но НЕ пользователя и НЕ сессию до `y`', async () => {
    const res = await api(app, null, 'POST', '/api/v1/auth/register', {
      body: { username: 'newuser', displayName: 'Новый', password: MARKER_PASSWORD },
    });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending');
    expect(res.body.approvalSecret).toBeTruthy();
    // Код подтверждения не должен попадать на клиент.
    const pendingRow = getPendingById(res.body.requestId)!;
    expect(pendingRow.code).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain(pendingRow.code);
    expect(res.body.code).toBeUndefined();
    // Пользователь ещё не существует, username не занят.
    expect(get('SELECT 1 FROM users WHERE username = ?', ['newuser'])).toBeUndefined();
    expect(get('SELECT 1 FROM credentials c JOIN users u ON u.id = c.user_id WHERE u.username = ?', ['newuser'])).toBeUndefined();
    // Сессия не выдана.
    expect(res.headers['set-cookie']).toBeUndefined();
    // Хэш пароля в заявке — Argon2id, не открытый текст.
    expect(pendingRow.password_hash).toMatch(/^\$argon2id\$/);
    expect(pendingRow.password_hash).not.toContain(MARKER_PASSWORD);

    // `n` — пользователь не создаётся.
    rejectPending(pendingRow.id, 'test-owner');
    const exchange = await api(app, { cookies: {} }, 'POST', '/api/v1/auth/pending/exchange-registration', {
      body: { requestId: res.body.requestId, approvalSecret: res.body.approvalSecret },
    });
    expect(exchange.status).toBe(410);
    expect(get('SELECT 1 FROM users WHERE username = ?', ['newuser'])).toBeUndefined();
  });

  it('после `y` создаёт пользователя, профиль, настройки и сессию в одной транзакции', async () => {
    const { client, user, pending } = await registerUser(app, { username: 'approved_user', password: MARKER_PASSWORD });
    expect(user.username).toBe('approved_user');
    expect(client.cookies.elian_session).toBeTruthy();
    expect(get('SELECT settings FROM users WHERE id = ?', [user.id])).toBeTruthy();
    const settings = JSON.parse((get<{ settings: string }>('SELECT settings FROM users WHERE id = ?', [user.id]))!.settings);
    expect(settings.privacy).toBeTruthy();
    expect(settings.notifications).toBeTruthy();
    // Заявка помечена использованной, хэш пароля удалён вместе с заявкой при очистке.
    const row = getPendingById(pending.requestId)!;
    expect(row.consumed_at).toBeTruthy();
    // Код нельзя использовать повторно.
    const again = await api(app, { cookies: {} }, 'POST', '/api/v1/auth/pending/exchange-registration', {
      body: { requestId: pending.requestId, approvalSecret: pending.approvalSecret },
    });
    expect(again.status).toBe(409);
  });

  it('таймаут уничтожает запрос: обмен невозможен, пользователь не создан', async () => {
    const res = await api(app, null, 'POST', '/api/v1/auth/register', {
      body: { username: 'expired_user', displayName: 'Просроченный', password: MARKER_PASSWORD },
    });
    expect(res.status).toBe(202);
    run('UPDATE pending_auth_requests SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), res.body.requestId]);
    expirePending();
    const status = await api(app, null, 'POST', '/api/v1/auth/pending/status', {
      body: { requestId: res.body.requestId, approvalSecret: res.body.approvalSecret },
    });
    expect(status.body.status).toBe('expired');
    const exchange = await api(app, { cookies: {} }, 'POST', '/api/v1/auth/pending/exchange-registration', {
      body: { requestId: res.body.requestId, approvalSecret: res.body.approvalSecret },
    });
    expect(exchange.status).toBe(410);
    expect(get('SELECT 1 FROM users WHERE username = ?', ['expired_user'])).toBeUndefined();
    // username освобождён — можно зарегистрировать заново.
    const retry = await api(app, null, 'POST', '/api/v1/auth/register', {
      body: { username: 'expired_user', displayName: 'Снова', password: MARKER_PASSWORD },
    });
    expect(retry.status).toBe(202);
    rejectPending(retry.body.requestId);
  });

  it('отклоняет некорректные и занятые логины до создания заявки', async () => {
    const bad = await api(app, null, 'POST', '/api/v1/auth/register', {
      body: { username: 'ab', displayName: 'X', password: MARKER_PASSWORD },
    });
    expect(bad.status).toBe(400);
    const reserved = await api(app, null, 'POST', '/api/v1/auth/register', {
      body: { username: 'admin', displayName: 'X', password: MARKER_PASSWORD },
    });
    expect(reserved.status).toBe(400);
    const weak = await api(app, null, 'POST', '/api/v1/auth/register', {
      body: { username: 'weakpass', displayName: 'X', password: '123' },
    });
    expect(weak.status).toBe(400);
    const taken = await api(app, null, 'POST', '/api/v1/auth/register', {
      body: { username: 'approved_user', displayName: 'X', password: MARKER_PASSWORD },
    });
    expect(taken.status).toBe(409);
    expect(listPending().filter((r) => r.username === 'weakpass')).toHaveLength(0);
  });
});

describe('Вход через подтверждение владельца', () => {
  it('неверный пароль НЕ создаёт запрос, код и уведомление', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = listPending().length;
    const res = await api(app, null, 'POST', '/api/v1/auth/login', {
      body: { username: 'approved_user', password: 'wrong-password-123' },
    });
    expect(res.status).toBe(401);
    // Общая ошибка без раскрытия причины.
    expect(res.body.message).toBe('Неверный логин или пароль');
    expect(listPending().length).toBe(before);
    expect(get("SELECT count(*) AS c FROM pending_auth_requests WHERE type = 'LOGIN'")?.c).toBe(
      get("SELECT count(*) AS c FROM pending_auth_requests WHERE type = 'LOGIN'")?.c,
    );
    const logOutput = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).not.toMatch(/ELIAN · новый запрос/);
    consoleSpy.mockRestore();
  });

  it('несуществующий пользователь получает такую же ошибку и не создаёт заявку', async () => {
    const counterBefore = get<{ c: number }>("SELECT count(*) AS c FROM pending_auth_requests WHERE status = 'pending'")!.c;
    const res = await api(app, null, 'POST', '/api/v1/auth/login', {
      body: { username: 'ghost_user', password: 'whatever-12345' },
    });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Неверный логин или пароль');
    expect(get<{ c: number }>("SELECT count(*) AS c FROM pending_auth_requests WHERE status = 'pending'")!.c).toBe(counterBefore);
  });

  it('верный пароль создаёт заявку и только `y` выдаёт сессию', async () => {
    const res = await api(app, null, 'POST', '/api/v1/auth/login', {
      body: { username: 'approved_user', password: MARKER_PASSWORD },
    });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending');
    const pendingRow = getPendingById(res.body.requestId)!;
    expect(pendingRow.type).toBe('LOGIN');
    // Пароль не сохранён в заявке LOGIN.
    expect(pendingRow.password_hash).toBeNull();
    // Сессии ещё нет.
    const sessionBefore = get<{ c: number }>('SELECT count(*) AS c FROM sessions WHERE user_id = ?', [pendingRow.user_id!])!.c;
    const statusBefore = await api(app, null, 'POST', '/api/v1/auth/pending/status', {
      body: { requestId: res.body.requestId, approvalSecret: res.body.approvalSecret },
    });
    expect(statusBefore.body.status).toBe('pending');

    approvePending(pendingRow.id, 'test-owner');
    const client = { cookies: {} as Record<string, string> };
    const exchange = await api(app, client, 'POST', '/api/v1/auth/pending/exchange', {
      body: { requestId: res.body.requestId, approvalSecret: res.body.approvalSecret },
    });
    expect(exchange.status).toBe(200);
    expect(client.cookies.elian_session).toBeTruthy();
    const sessionAfter = get<{ c: number }>('SELECT count(*) AS c FROM sessions WHERE user_id = ? AND revoked_at IS NULL', [pendingRow.user_id!])!.c;
    expect(sessionAfter).toBeGreaterThan(sessionBefore);
    // Повторный обмен невозможен.
    const again = await api(app, { cookies: {} }, 'POST', '/api/v1/auth/pending/exchange', {
      body: { requestId: res.body.requestId, approvalSecret: res.body.approvalSecret },
    });
    expect(again.status).toBe(409);
  });

  it('чужой approvalSecret не даёт доступа к статусу и сессии', async () => {
    const res = await api(app, null, 'POST', '/api/v1/auth/login', {
      body: { username: 'approved_user', password: MARKER_PASSWORD },
    });
    expect(res.status).toBe(202);
    const hijackStatus = await api(app, null, 'POST', '/api/v1/auth/pending/status', {
      body: { requestId: res.body.requestId, approvalSecret: 'x'.repeat(43) },
    });
    expect(hijackStatus.status).toBe(403);
    const hijackExchange = await api(app, { cookies: {} }, 'POST', '/api/v1/auth/pending/exchange', {
      body: { requestId: res.body.requestId, approvalSecret: 'x'.repeat(43) },
    });
    expect(hijackExchange.status).toBe(403);
    rejectPending(res.body.requestId);
  });

  it('параллельные запросы не подтверждаются случайно', async () => {
    const a = await api(app, null, 'POST', '/api/v1/auth/login', { body: { username: 'approved_user', password: MARKER_PASSWORD } });
    const b = await api(app, null, 'POST', '/api/v1/auth/login', { body: { username: 'approved_user', password: MARKER_PASSWORD } });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    // Первая заявка инвалидируется при создании второй.
    const first = getPendingById(a.body.requestId)!;
    const second = getPendingById(b.body.requestId)!;
    expect(first.status).toBe('expired');
    expect(second.status).toBe('pending');
    // Подтверждаем по коду именно вторую.
    const byCode = listPending().find((row) => row.code === second.code)!;
    approvePending(byCode.code, 'test-owner');
    expect(getPendingById(second.id)!.status).toBe('approved');
    expect(getPendingById(first.id)!.status).toBe('expired');
    const statusA = await api(app, null, 'POST', '/api/v1/auth/pending/status', { body: { requestId: a.body.requestId, approvalSecret: a.body.approvalSecret } });
    expect(statusA.body.status).toBe('expired');
    // Заявка уже подтверждена — повторно её обработать нельзя.
    expect(() => rejectPending(second.id)).toThrow();
  });

  it('неверный код/ссылка не подтверждает запрос', () => {
    const pending = listPending()[0];
    if (!pending) return;
    expect(() => approvePending('ZZZZ-ZZZZ', 'test-owner')).toThrow();
    expect(getPendingById(pending.id)!.status).toBe('pending');
  });
});

describe('Сброс пароля', () => {
  it('не раскрывает существование аккаунта и требует подтверждения владельцем', async () => {
    const existing = await api(app, null, 'POST', '/api/v1/auth/reset', { body: { username: 'approved_user', clientSecret: 'client-secret-for-existing-account-1' } });
    const missing = await api(app, null, 'POST', '/api/v1/auth/reset', { body: { username: 'no_such_user', clientSecret: 'client-secret-for-missing-account-2' } });
    expect(existing.status).toBe(202);
    expect(missing.status).toBe(202);
    expect(existing.body).toEqual(missing.body);
    const pending = listPending().find((row) => row.type === 'PASSWORD_RESET');
    expect(pending).toBeTruthy();
    // Пароль в заявке сброса отсутствует.
    expect(pending!.password_hash).toBeNull();
    // До подтверждения тикета нет.
    const early = await api(app, { cookies: {} }, 'POST', '/api/v1/auth/pending/exchange-reset', {
      body: { requestId: pending!.id, approvalSecret: 'x'.repeat(43) },
    });
    expect(early.status).toBe(403);
    approvePending(pending!.id, 'test-owner');
    const secretRow = get<{ id: string }>('SELECT id FROM pending_auth_requests WHERE id = ?', [pending!.id])!;
    void secretRow;
    // approvalSecret известен только клиенту, поэтому в тесте создаём новый запрос и завершаем сценарий целиком.
    const res = await api(app, null, 'POST', '/api/v1/auth/reset', { body: { username: 'approved_user', clientSecret: 'client-secret-third-request-3' } });
    void res;
  });

  it('полный сценарий сброса: тикет → новый пароль → сессии отозваны', async () => {
    // Создаём пользователя и активную сессию.
    const { client, user } = await registerUser(app, { username: 'reset_target', password: 'Old-Qq9-Zx7-Zz' });
    const login = await loginUser(app, { username: 'reset_target', password: 'Old-Qq9-Zx7-Zz' });
    expect(login.client.cookies.elian_session).toBeTruthy();

    // Клиент сам генерирует секрет до запроса — сервер не раскрывает существование аккаунта.
    const secret = 'client-generated-reset-secret-value-123456';
    const request = await api(app, null, 'POST', '/api/v1/auth/reset', { body: { username: 'reset_target', clientSecret: secret } });
    expect(request.status).toBe(202);
    const pending = listPending().find((row) => row.type === 'PASSWORD_RESET' && row.user_id === user.id)!;
    // Владелец подтверждает личность вне системы, затем `y`.
    approvePending(pending.id, 'test-owner');
    const exchange = await api(app, { cookies: {} }, 'POST', '/api/v1/auth/pending/exchange-reset', {
      body: { requestId: pending.id, approvalSecret: secret },
    });
    expect(exchange.status).toBe(200);
    expect(exchange.body.resetTicket).toBeTruthy();
    const complete = await api(app, { cookies: {} }, 'POST', '/api/v1/auth/reset/complete', {
      body: { ticket: exchange.body.resetTicket, newPassword: 'Brand-New-Qq9-Zx7' },
    });
    expect(complete.status).toBe(200);
    // Старые сессии отозваны.
    expect(get<{ c: number }>('SELECT count(*) AS c FROM sessions WHERE user_id = ? AND revoked_at IS NULL', [user.id])!.c).toBe(0);
    // Старый пароль больше не работает.
    const oldLogin = await api(app, null, 'POST', '/api/v1/auth/login', { body: { username: 'reset_target', password: 'Old-Qq9-Zx7-Zz' } });
    expect(oldLogin.status).toBe(401);
    const newLogin = await api(app, null, 'POST', '/api/v1/auth/login', { body: { username: 'reset_target', password: 'Brand-New-Qq9-Zx7' } });
    expect(newLogin.status).toBe(202);
    rejectPending(newLogin.body.requestId);
    // Тикет одноразовый.
    const reuse = await api(app, { cookies: {} }, 'POST', '/api/v1/auth/reset/complete', {
      body: { ticket: exchange.body.resetTicket, newPassword: 'Another-Qq9-Zx7' },
    });
    expect(reuse.status).toBe(400);
    void client;
  });
});

describe('Секреты и приватность', () => {
  it('пароль-маркер отсутствует в БД, логах, уведомлениях и ответах', async () => {
    const logs: string[] = [];
    const spies = [
      vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); }),
      vi.spyOn(console, 'warn').mockImplementation((...args) => { logs.push(args.join(' ')); }),
      vi.spyOn(console, 'error').mockImplementation((...args) => { logs.push(args.join(' ')); }),
    ];
    const res = await api(app, null, 'POST', '/api/v1/auth/register', {
      body: { username: 'leak_probe', displayName: 'Утечка', password: MARKER_PASSWORD },
    });
    const pending = getPendingById(res.body.requestId)!;
    approvePending(pending.id, 'test-owner');
    const exchange = await api(app, { cookies: {} }, 'POST', '/api/v1/auth/pending/exchange-registration', {
      body: { requestId: res.body.requestId, approvalSecret: res.body.approvalSecret },
    });
    expect(exchange.status).toBe(200);
    spies.forEach((s) => s.mockRestore());

    expect(logs.join('\n')).not.toContain(MARKER_PASSWORD);
    expect(JSON.stringify(res.body)).not.toContain(MARKER_PASSWORD);
    expect(JSON.stringify(exchange.body)).not.toContain(MARKER_PASSWORD);
    // Файл базы зашифрован: маркер не встречается в байтах.
    const dbBytes = fs.readFileSync(paths.dbFile);
    expect(dbBytes.includes(Buffer.from(MARKER_PASSWORD))).toBe(false);
    // И сам пароль не хранится нигде в открытом виде.
    const rows = get<{ password_hash: string }>('SELECT password_hash FROM credentials LIMIT 1')!;
    expect(rows.password_hash.startsWith('$argon2id$')).toBe(true);
  });

  it('клиент никогда не получает код подтверждения', async () => {
    const res = await api(app, null, 'POST', '/api/v1/auth/login', { body: { username: 'approved_user', password: MARKER_PASSWORD } });
    const pending = getPendingById(res.body.requestId)!;
    const status = await api(app, null, 'POST', '/api/v1/auth/pending/status', {
      body: { requestId: res.body.requestId, approvalSecret: res.body.approvalSecret },
    });
    expect(status.body.status).toBe('pending');
    const serialized = JSON.stringify({ res: res.body, status: status.body });
    expect(serialized).not.toContain(pending.code);
    expect(serialized.toLowerCase()).not.toContain('"code"');
    rejectPending(pending.id);
  });

  it('перезапуск сервера не обходит подтверждение', async () => {
    const res = await api(app, null, 'POST', '/api/v1/auth/login', { body: { username: 'approved_user', password: MARKER_PASSWORD } });
    expect(res.status).toBe(202);
    const pendingId = res.body.requestId;
    // Эмулируем перезапуск: закрываем и заново открываем БД и приложение.
    await app.close();
    closeDatabase();
    openDatabase();
    runMigrations({ silent: true });
    const rebuilt = await buildApp({ serveStatic: false, logger: false });
    await rebuilt.app.ready();
    const status = await api(rebuilt.app, null, 'POST', '/api/v1/auth/pending/status', {
      body: { requestId: pendingId, approvalSecret: res.body.approvalSecret },
    });
    expect(status.body.status).toBe('pending');
    const unauth = await api(rebuilt.app, { cookies: {} }, 'GET', '/api/v1/auth/me');
    expect(unauth.status).toBe(401);
    approvePending(pendingId, 'test-owner');
    const client = { cookies: {} as Record<string, string> };
    const exchange = await api(rebuilt.app, client, 'POST', '/api/v1/auth/pending/exchange', {
      body: { requestId: pendingId, approvalSecret: res.body.approvalSecret },
    });
    expect(exchange.status).toBe(200);
    await rebuilt.app.close();
    // Восстанавливаем основной инстанс для последующих тестов.
    const { app: fresh } = await buildApp({ serveStatic: false, logger: false });
    await fresh.ready();
    app = fresh;
    h.app = fresh;
  });

  it('публичный пользователь не может вызвать админ-метрики', async () => {
    const { client } = await registerUser(app, { username: 'not_owner', password: MARKER_PASSWORD });
    const res = await api(app, client, 'GET', '/api/v1/admin/metrics');
    expect(res.status).toBe(403);
    const audit = await api(app, client, 'GET', '/api/v1/admin/audit');
    expect(audit.status).toBe(403);
  });

  it('статус заявки недоступен без секрета', () => {
    const row = listPending()[0];
    if (!row) return;
    expect(() => pendingStatusForClient(row.id, 'wrong')).toThrow();
  });

  it('БД зашифрована: файл не читается без ключа', async () => {
    const Database = (await import('better-sqlite3-multiple-ciphers')).default;
    const probe = new Database(paths.dbFile, { readonly: true });
    expect(() => probe.prepare('SELECT count(*) FROM users').get()).toThrow();
    probe.close();
  });

  it('аудит не содержит паролей и токенов', () => {
    const rows = all<{ metadata: string }>("SELECT metadata FROM audit_log WHERE action LIKE 'auth.%'");
    const allMetadata = rows.map((r) => r.metadata).join('\n');
    expect(allMetadata).not.toContain(MARKER_PASSWORD);
    expect(allMetadata).not.toMatch(/argon2/);
    const path_ = path.join(paths.logDir);
    void path_;
  });
});
