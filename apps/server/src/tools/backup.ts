import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, env, paths } from '../config/env.js';
import { getSecret } from '../config/secrets.js';
import { openDatabase, closeDatabase, runMigrations } from '../db/index.js';
import { createBackup, restoreBackup, verifyBackup } from '../services/backup.js';

/**
 * CLI резервного копирования.
 *
 * Парольная фраза бэкапа НЕ передаётся аргументом командной строки (иначе попадёт в ps/history):
 *   ELIAN_BACKUP_PASSPHRASE_FILE=/path/to/pass.elb  (файл с фразой, права 600)
 *   ELIAN_BACKUP_PASSPHRASE=...                     (для неинтерактивных сценариев)
 * Бэкап шифруется отдельным ключом; ключ/фраза не лежат внутри архива.
 */
function passphrase(): string {
  const fromFile = process.env.ELIAN_BACKUP_PASSPHRASE_FILE;
  if (fromFile) {
    if (!fs.existsSync(fromFile)) throw new Error(`Файл парольной фразы не найден: ${fromFile}`);
    const mode = fs.statSync(fromFile).mode & 0o777;
    if ((mode & 0o077) !== 0) console.warn(`[backup] файл парольной фразы доступен другим (${mode.toString(8)}) — рекомендуется chmod 600`);
    const value = fs.readFileSync(fromFile, 'utf8').trim();
    if (value.length < 12) throw new Error('Парольная фраза бэкапа слишком короткая (минимум 12 символов)');
    return value;
  }
  const direct = process.env.ELIAN_BACKUP_PASSPHRASE?.trim();
  if (direct && direct.length >= 12) return direct;
  throw new Error('Не задана парольная фраза: используйте ELIAN_BACKUP_PASSPHRASE_FILE или ELIAN_BACKUP_PASSPHRASE');
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'create';
  ensureDirs();
  getSecret('DB_KEY');
  getSecret('MEDIA_KEY');

  if (command === 'create') {
    const outDir = arg('--out') ?? paths.backupDir;
    openDatabase();
    runMigrations({ silent: true });
    const result = await createBackup(passphrase(), { outDir });
    closeDatabase();
    console.log(JSON.stringify({ status: 'ok', file: result.file, bytes: result.bytes, media: result.manifest.media.length }, null, 2));
    return;
  }

  if (command === 'verify') {
    const file = arg('--file');
    if (!file) throw new Error('Укажите --file <архив>');
    const result = await verifyBackup(path.resolve(file), passphrase());
    console.log(JSON.stringify({ status: result.ok ? 'ok' : 'corrupted', media: result.manifest.media.length, mediaBytes: result.mediaBytes }, null, 2));
    if (!result.ok) process.exitCode = 2;
    return;
  }

  if (command === 'list') {
    const dir = arg('--out') ?? paths.backupDir;
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((file) => file.endsWith('.elnb')).map((file) => ({
          file: path.join(dir, file),
          bytes: fs.statSync(path.join(dir, file)).size,
          created: fs.statSync(path.join(dir, file)).mtime.toISOString(),
        }))
      : [];
    console.log(JSON.stringify({ backups: files }, null, 2));
    return;
  }

  if (command === 'restore') {
    const file = arg('--file');
    if (!file) throw new Error('Укажите --file <архив>');
    // Сервер должен быть остановлен: SQLite-файл заменяется целиком.
    const result = await restoreBackup(path.resolve(file), passphrase());
    console.log(JSON.stringify({ status: 'ok', dbFile: result.dbFile, mediaFiles: result.mediaFiles }, null, 2));
    return;
  }

  if (command === 'key') {
    // Создаёт файл парольной фразы в каталоге секретов (600), если его ещё нет.
    const target = arg('--file') ?? path.join(env.secretsDir, 'backup-passphrase.key');
    if (fs.existsSync(target)) {
      console.log(JSON.stringify({ status: 'exists', file: target }, null, 2));
      return;
    }
    const phrase = (await import('node:crypto')).randomBytes(32).toString('base64url');
    fs.writeFileSync(target, `${phrase}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ status: 'created', file: target }, null, 2));
    return;
  }

  console.error('Команды: create | verify --file F | restore --file F | list | key');
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[backup] ошибка: ${(error as Error).message}`);
  process.exit(1);
});
