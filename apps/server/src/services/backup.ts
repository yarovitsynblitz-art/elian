import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, setMeta } from '../db/index.js';
import { env, ensureDirs, paths } from '../config/env.js';
import { now } from '../lib/time.js';
import { error as logError, info } from '../lib/log.js';

/**
 * Бэкап Элиан: файл базы (уже зашифрован SQLCipher), все файлы медиа и манифест
 * упаковываются в один архив и шифруются отдельным ключом, производным от пароля
 * бэкапа (scrypt + AES-256-GCM). Пароль бэкапа НЕ хранится в архиве.
 */
const MAGIC = Buffer.from('ELNBK1\x00\x00', 'binary');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

interface ManifestEntry { name: string; size: number }
interface Manifest {
  version: 1;
  createdAt: string;
  app: string;
  dbFile: string;
  dbSize: number;
  media: ManifestEntry[];
  migrations: string[];
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
}

async function writeAll(handle: fs.promises.FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    offset += bytesWritten;
  }
}

export async function createBackup(passphrase: string, options: { outDir?: string } = {}): Promise<{ file: string; bytes: number; manifest: Manifest }> {
  if (!passphrase || passphrase.length < 12) throw new Error('Пароль бэкапа должен быть не короче 12 символов');
  ensureDirs();
  const outDir = options.outDir ?? paths.backupDir;
  await fs.promises.mkdir(outDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `elian-backup-${stamp}.elnb`);
  const tmpDb = path.join(outDir, `.snapshot-${crypto.randomUUID()}.db`);

  // Консистентный снимок открытой базы средствами SQLite.
  getDb().exec(`VACUUM INTO '${tmpDb.replace(/'/g, "''")}'`);
  const dbStat = await fs.promises.stat(tmpDb);
  const mediaFiles = (await fs.promises.readdir(paths.mediaFiles).catch(() => [] as string[])).sort();
  const thumbs = (await fs.promises.readdir(paths.mediaThumbs).catch(() => [] as string[])).sort();
  const entries: Array<{ name: string; abs: string; size: number }> = [];
  for (const name of mediaFiles) {
    const abs = path.join(paths.mediaFiles, name);
    entries.push({ name: `media/${name}`, abs, size: (await fs.promises.stat(abs)).size });
  }
  for (const name of thumbs) {
    const abs = path.join(paths.mediaThumbs, name);
    entries.push({ name: `thumbs/${name}`, abs, size: (await fs.promises.stat(abs)).size });
  }
  const migrations = (
    getDb().prepare('SELECT name FROM migrations ORDER BY id').all() as Array<{ name: string }>
  ).map((m) => m.name);
  const manifest: Manifest = {
    version: 1,
    createdAt: now(),
    app: 'elian',
    dbFile: 'elian.db',
    dbSize: dbStat.size,
    media: entries.map((e) => ({ name: e.name, size: e.size })),
    migrations,
  };
  const manifestBuffer = Buffer.from(JSON.stringify(manifest), 'utf8');
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const out = await fs.promises.open(file, 'w', 0o600);
  try {
    await writeAll(out, Buffer.concat([MAGIC, salt, iv]));
    await writeAll(out, cipher.update(Buffer.alloc(0)));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(manifestBuffer.length, 0);
    await writeAll(out, cipher.update(header));
    await writeAll(out, cipher.update(manifestBuffer));
    const dbHandle = await fs.promises.open(tmpDb, 'r');
    try {
      const buf = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      for (;;) {
        const { bytesRead } = await dbHandle.read(buf, 0, buf.length, position);
        if (!bytesRead) break;
        position += bytesRead;
        await writeAll(out, cipher.update(buf.subarray(0, bytesRead)));
      }
    } finally {
      await dbHandle.close();
    }
    for (const entry of entries) {
      const handle = await fs.promises.open(entry.abs, 'r');
      try {
        const nameBuf = Buffer.from(entry.name, 'utf8');
        const nameHeader = Buffer.alloc(12);
        nameHeader.writeUInt32BE(nameBuf.length, 0);
        nameHeader.writeBigUInt64BE(BigInt(entry.size), 4);
        await writeAll(out, cipher.update(nameHeader));
        await writeAll(out, cipher.update(nameBuf));
        const buf = Buffer.allocUnsafe(1024 * 1024);
        let position = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buf, 0, buf.length, position);
          if (!bytesRead) break;
          position += bytesRead;
          await writeAll(out, cipher.update(buf.subarray(0, bytesRead)));
        }
      } finally {
        await handle.close();
      }
    }
    await writeAll(out, cipher.final());
    await writeAll(out, cipher.getAuthTag());
  } finally {
    await out.close();
    await fs.promises.unlink(tmpDb).catch(() => {});
  }
  const stat = await fs.promises.stat(file);
  info('backup: создан', { file, bytes: stat.size });
  return { file, bytes: stat.size, manifest };
}

/** Последовательное чтение расшифрованного потока (без загрузки архива в память). */
class DecryptedReader {
  private buffer = Buffer.alloc(0);
  private position: number;
  private readonly end: number;
  private finished = false;

  constructor(
    private readonly handle: fs.promises.FileHandle,
    private readonly decipher: crypto.DecipherGCM,
    start: number,
    end: number,
  ) {
    this.position = start;
    this.end = end;
  }

  private async fill(minBytes: number): Promise<void> {
    while (this.buffer.length < minBytes && this.position < this.end) {
      const size = Math.min(1024 * 1024, this.end - this.position);
      const chunk = Buffer.allocUnsafe(size);
      const { bytesRead } = await this.handle.read(chunk, 0, size, this.position);
      if (!bytesRead) break;
      this.position += bytesRead;
      this.buffer = Buffer.concat([this.buffer, this.decipher.update(chunk.subarray(0, bytesRead))]);
    }
  }

  async readExactly(length: number): Promise<Buffer> {
    await this.fill(length);
    if (this.buffer.length < length) throw new Error('Архив повреждён (недостаточно данных)');
    const out = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return out;
  }

  async readUInt32(): Promise<number> {
    return (await this.readExactly(4)).readUInt32BE(0);
  }

  async pipeTo(target: fs.promises.FileHandle, length: number): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      await this.fill(Math.min(remaining, 1024 * 1024));
      if (!this.buffer.length) throw new Error('Архив повреждён (обрыв данных)');
      const take = Math.min(remaining, this.buffer.length);
      const chunk = this.buffer.subarray(0, take);
      this.buffer = this.buffer.subarray(take);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await target.write(chunk, offset, chunk.length - offset);
        offset += bytesWritten;
      }
      remaining -= take;
    }
  }

  finish(): void {
    if (this.finished) return;
    this.decipher.final(); // проверка тега GCM
    this.finished = true;
  }
}

async function openArchive(file: string, passphrase: string): Promise<{ reader: DecryptedReader; manifest: Manifest; handle: fs.promises.FileHandle }> {
  const handle = await fs.promises.open(file, 'r');
  const stat = await fs.promises.stat(file);
  const head = Buffer.alloc(MAGIC.length + SALT_LEN + IV_LEN);
  await handle.read(head, 0, head.length, 0);
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) {
    await handle.close();
    throw new Error('Это не архив Элиан');
  }
  const salt = head.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = head.subarray(MAGIC.length + SALT_LEN);
  const key = deriveKey(passphrase, salt);
  const tagPos = stat.size - TAG_LEN;
  const tag = Buffer.alloc(TAG_LEN);
  await handle.read(tag, 0, TAG_LEN, tagPos);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const reader = new DecryptedReader(handle, decipher, head.length, tagPos);
  const manifestLength = await reader.readUInt32();
  const manifest = JSON.parse((await reader.readExactly(manifestLength)).toString('utf8')) as Manifest;
  return { reader, manifest, handle };
}

export async function verifyBackup(file: string, passphrase: string): Promise<{ manifest: Manifest; ok: boolean; mediaBytes: number }> {
  const { reader, manifest, handle } = await openArchive(file, passphrase);
  try {
    await reader.readExactly(manifest.dbSize);
    let mediaBytes = 0;
    for (const entry of manifest.media) {
      const nameLength = await reader.readUInt32();
      const size = Number((await reader.readExactly(8)).readBigUInt64BE(0));
      await reader.readExactly(nameLength);
      await reader.readExactly(size);
      mediaBytes += size;
    }
    reader.finish();
    return { manifest, ok: true, mediaBytes };
  } finally {
    await handle.close();
  }
}

export interface RestoreResult { dbFile: string; mediaFiles: number; manifest: Manifest }

/** Восстановление в указанный каталог (по умолчанию — текущий dataDir). */
export async function restoreBackup(file: string, passphrase: string, target?: { dataDir?: string; mediaDir?: string }): Promise<RestoreResult> {
  const dataDir = target?.dataDir ?? env.dataDir;
  const mediaDir = target?.mediaDir ?? path.join(dataDir, 'media');
  const mediaFilesDir = path.join(mediaDir, 'files');
  const mediaThumbsDir = path.join(mediaDir, 'thumbs');
  await fs.promises.mkdir(mediaFilesDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(mediaThumbsDir, { recursive: true, mode: 0o700 });
  const tmpDb = path.join(dataDir, `.restore-${crypto.randomUUID()}.db`);
  const { reader, manifest, handle } = await openArchive(file, passphrase);
  let restored = 0;
  try {
    const dbHandle = await fs.promises.open(tmpDb, 'w', 0o600);
    try {
      await reader.pipeTo(dbHandle, manifest.dbSize);
    } finally {
      await dbHandle.sync();
      await dbHandle.close();
    }
    for (const entry of manifest.media) {
      const nameLength = await reader.readUInt32();
      const size = Number((await reader.readExactly(8)).readBigUInt64BE(0));
      const name = (await reader.readExactly(nameLength)).toString('utf8');
      const isThumb = name.startsWith('thumbs/');
      const targetDir = isThumb ? mediaThumbsDir : mediaFilesDir;
      const out = await fs.promises.open(path.join(targetDir, path.basename(name)), 'w', 0o600);
      try {
        await reader.pipeTo(out, size);
      } finally {
        await out.sync();
        await out.close();
      }
      void entry;
      restored++;
    }
    reader.finish();
    // Проверяем, что восстановленная база открывается с текущим ключом.
    const Database = (await import('better-sqlite3-multiple-ciphers')).default;
    const { dbKey } = await import('../config/secrets.js');
    const probe = new Database(tmpDb);
    probe.pragma(`key = "x'${dbKey()}'"`);
    probe.prepare('SELECT count(*) FROM users').get();
    probe.close();
    const targetDb = path.join(dataDir, 'elian.db');
    if (fs.existsSync(targetDb)) await fs.promises.copyFile(targetDb, `${targetDb}.before-restore-${Date.now()}`);
    await fs.promises.rename(tmpDb, targetDb);
    info('backup: восстановление завершено', { dbFile: targetDb, mediaFiles: restored });
    return { dbFile: targetDb, mediaFiles: restored, manifest };
  } catch (err) {
    await fs.promises.unlink(tmpDb).catch(() => {});
    logError('backup: восстановление не удалось', { message: (err as Error).message });
    throw err;
  } finally {
    await handle.close();
  }
}

export function markBackupComplete(file: string): void {
  setMeta('last_backup_at', now());
  setMeta('last_backup_file', path.basename(file));
}
