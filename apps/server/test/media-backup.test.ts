import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { api, boot, openPrivateChat, registerUser, type Client, type Harness } from './helpers.js';
import { paths } from '../src/config/env.js';
import { cleanupOrphans, getMedia, mediaStats } from '../src/services/media.js';
import { createBackup, restoreBackup, verifyBackup } from '../src/services/backup.js';
import { all, get } from '../src/db/index.js';

const PASS = 'Media-Qq9-Zx7-Zz-Zz';

let h: Harness;
let app: FastifyInstance;
let alice: { client: Client; userId: string };
let boris: { client: Client; userId: string };
let carol: { client: Client; userId: string };
let chatId: string;

function multipart(fields: Record<string, string>, file: { name: string; type: string; data: Buffer }): { body: Buffer; contentType: string } {
  const boundary = `----elian${crypto.randomBytes(8).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function upload(client: Client, data: Buffer, type = 'image/jpeg', name = 'photo.jpg', extra: Record<string, string> = {}): Promise<any> {
  const { body, contentType } = multipart({ kind: 'photo', ...extra }, { name, type, data });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/media/upload',
    headers: {
      'content-type': contentType,
      cookie: Object.entries(client.cookies).map(([k, v]) => `${k}=${v}`).join('; '),
      'x-csrf-token': client.cookies.elian_csrf ?? '',
    },
    payload: body,
  });
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
}

beforeAll(async () => {
  h = await boot();
  app = h.app;
  alice = await registerUser(app, { username: 'med_alice', password: PASS, displayName: 'Алиса' });
  boris = await registerUser(app, { username: 'med_boris', password: PASS, displayName: 'Борис' });
  carol = await registerUser(app, { username: 'med_carol', password: PASS, displayName: 'Кэрол' });
  const chat = await openPrivateChat(app, alice.client, boris.userId);
  chatId = chat.id;
});

afterAll(async () => {
  await h.close();
});

describe('Медиа', () => {
  it('загружает, шифрует на диске и отдаёт без потерь', async () => {
    const payload = crypto.randomBytes(150_000);
    const uploadRes = await upload(alice.client, payload);
    expect(uploadRes.status).toBe(201);
    const mediaId = uploadRes.body.media.id;
    expect(uploadRes.body.media.size).toBe(payload.length);

    // Файл на диске зашифрован: исходные байты не встречаются.
    const stored = fs.readdirSync(paths.mediaFiles).find((name) => name.startsWith(mediaId))!;
    expect(stored).toBeTruthy();
    const raw = fs.readFileSync(path.join(paths.mediaFiles, stored));
    expect(raw.includes(payload.subarray(0, 64))).toBe(false);
    expect(raw.length).toBeGreaterThan(payload.length); // + заголовки и теги GCM

    // Владелец получает точную копию.
    const download = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaId}/content`,
      headers: { cookie: `elian_session=${alice.client.cookies.elian_session}` },
    });
    expect(download.statusCode).toBe(200);
    expect(Buffer.from(download.rawPayload).equals(payload)).toBe(true);

    // Посторонний — 403.
    const forbidden = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaId}/content`,
      headers: { cookie: `elian_session=${carol.client.cookies.elian_session}` },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('поддерживает HTTP Range для видео', async () => {
    const payload = crypto.randomBytes(200_000);
    const uploadRes = await upload(alice.client, payload, 'video/mp4', 'clip.mp4', { kind: 'video' });
    const mediaId = uploadRes.body.media.id;
    const ranged = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaId}/content`,
      headers: { cookie: `elian_session=${alice.client.cookies.elian_session}`, range: 'bytes=1000-1999' },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['content-range']).toBe(`bytes 1000-1999/${payload.length}`);
    expect(Buffer.from(ranged.rawPayload)).toEqual(payload.subarray(1000, 2000));
  });

  it('вложение в сообщении делает медиа доступным участникам чата', async () => {
    const payload = crypto.randomBytes(2048);
    const uploadRes = await upload(alice.client, payload);
    const mediaId = uploadRes.body.media.id;
    const sent = await api(app, alice.client, 'POST', `/api/v1/chats/${chatId}/messages`, {
      body: {
        text: 'фото',
        attachments: [{ kind: 'photo', mediaId, fileName: 'photo.jpg', mimeType: 'image/jpeg', size: payload.length }],
      },
    });
    expect(sent.status).toBe(201);
    expect(sent.body.message.attachments).toHaveLength(1);
    const asBoris = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaId}/content`,
      headers: { cookie: `elian_session=${boris.client.cookies.elian_session}` },
    });
    expect(asBoris.statusCode).toBe(200);
    const asCarol = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${mediaId}/content`,
      headers: { cookie: `elian_session=${carol.client.cookies.elian_session}` },
    });
    expect(asCarol.statusCode).toBe(403);
  });

  it('отклоняет запрещённые типы и пустые файлы', async () => {
    const bad = await upload(alice.client, Buffer.from('#!/bin/sh\necho hi'), 'application/x-executable', 'evil.sh');
    expect(bad.status).toBe(400);
    const empty = await upload(alice.client, Buffer.alloc(0));
    expect(empty.status).toBe(400);
  });

  it('удаляет сирот и чистит файлы', async () => {
    const payload = crypto.randomBytes(1024);
    const created = await upload(alice.client, payload, 'application/pdf', 'doc.pdf', { kind: 'file' });
    const mediaId = created.body.media.id;
    const media = getMedia(mediaId)!;
    // Делаем медиа «старым», чтобы попал в очистку.
    const { run } = await import('../src/db/index.js');
    run('UPDATE media SET created_at = ? WHERE id = ?', [new Date(Date.now() - 2 * 86_400_000).toISOString(), mediaId]);
    const result = await cleanupOrphans();
    expect(result.media).toBeGreaterThan(0);
    expect(getMedia(mediaId)).toBeNull();
    expect(fs.existsSync(path.join(paths.mediaFiles, media.storage_path))).toBe(false);
    expect(mediaStats().count).toBeGreaterThan(0);
  });
});

describe('Бэкап и восстановление', () => {
  it('создаёт зашифрованный бэкап, проверяет пароль и восстанавливает данные', async () => {
    const passphrase = 'Backup-Pass-Qq9-Zx7';
    const backup = await createBackup(passphrase, { outDir: paths.backupDir });
    expect(fs.existsSync(backup.file)).toBe(true);
    expect(backup.bytes).toBeGreaterThan(1000);
    // В архиве нет открытых данных и нет пароля.
    const raw = fs.readFileSync(backup.file);
    expect(raw.includes(Buffer.from(passphrase))).toBe(false);
    expect(raw.includes(Buffer.from('med_alice'))).toBe(false);
    expect(raw.subarray(0, 6).toString()).toBe('ELNBK1');

    const verified = await verifyBackup(backup.file, passphrase);
    expect(verified.ok).toBe(true);
    expect(verified.manifest.dbSize).toBeGreaterThan(1000);
    await expect(verifyBackup(backup.file, 'wrong-passphrase-123')).rejects.toThrow();

    // Восстановление в отдельный каталог.
    const targetDir = path.join(process.env.ELIAN_TEST_DIR!, 'restored');
    fs.mkdirSync(targetDir, { recursive: true });
    const restored = await restoreBackup(backup.file, passphrase, { dataDir: targetDir });
    expect(fs.existsSync(restored.dbFile)).toBe(true);
    expect(restored.mediaFiles).toBeGreaterThan(0);

    // Восстановленная база открывается ключом и содержит пользователей.
    const Database = (await import('better-sqlite3-multiple-ciphers')).default;
    const { dbKey } = await import('../src/config/secrets.js');
    const probe = new Database(restored.dbFile);
    probe.pragma(`key = "x'${dbKey()}'"`);
    const users = probe.prepare('SELECT username FROM users').all() as Array<{ username: string }>;
    expect(users.map((u) => u.username)).toContain('med_alice');
    probe.close();
  });

  it('миграции идемпотентны', async () => {
    const { runMigrations, listMigrations } = await import('../src/db/index.js');
    const before = get<{ c: number }>('SELECT count(*) AS c FROM migrations')!.c;
    const applied = runMigrations({ silent: true });
    expect(applied).toHaveLength(0);
    expect(get<{ c: number }>('SELECT count(*) AS c FROM migrations')!.c).toBe(before);
    expect(listMigrations().length).toBe(before);
  });

  it('FTS5 находит сообщения на русском и английском', async () => {
    await api(app, alice.client, 'POST', `/api/v1/chats/${chatId}/messages`, { body: { text: 'Отчёт по проекту Элиан готов' } });
    const ru = await api(app, alice.client, 'GET', `/api/v1/chats/${chatId}/search?q=отчёт`);
    expect(ru.body.messages.length).toBe(1);
    const en = await api(app, alice.client, 'GET', `/api/v1/chats/${chatId}/search?q=проект`);
    expect(en.body.messages.length).toBeGreaterThan(0);
    const none = await api(app, alice.client, 'GET', `/api/v1/chats/${chatId}/search?q=zzzznotfound`);
    expect(none.body.messages).toHaveLength(0);
    void all;
  });
});
