import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3-multiple-ciphers';
import { env, ensureDirs, paths } from '../config/env.js';
import { dbKey } from '../config/secrets.js';
import { error as logError, info } from '../lib/log.js';
import { now } from '../lib/time.js';

export type DB = Database.Database;

let instance: DB | null = null;
let encryptionActive = false;

/**
 * Каталог миграций. После сборки .sql копируются в dist/db/migrations (scripts/copy-assets.mjs),
 * но при запуске из исходников через tsx используется src/db/migrations.
 */
function resolveMigrationsDir(): string {
  const candidates = [
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/db/migrations'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.readdirSync(candidate).some((file) => file.endsWith('.sql'))) return candidate;
  }
  throw new Error(`Каталог миграций не найден (искали: ${candidates.join(', ')})`);
}

const MIGRATIONS_DIR = resolveMigrationsDir();

export function isEncryptionActive(): boolean {
  return encryptionActive;
}

/** Проверяет, что файл БД реально зашифрован (без ключа открыть нельзя). */
function assertEncryption(file: string): boolean {
  if (env.dbEncryption === 'off') return false;
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) return true; // новая БД
  try {
    const probe = new Database(file, { readonly: true });
    probe.prepare('SELECT count(*) FROM sqlite_master').get();
    probe.close();
    logError('Файл базы данных читается без ключа — шифрование НЕ активно!');
    return false;
  } catch {
    return true;
  }
}

export function openDatabase(): DB {
  if (instance) return instance;
  ensureDirs();
  fs.mkdirSync(path.dirname(paths.dbFile), { recursive: true, mode: 0o700 });
  encryptionActive = assertEncryption(paths.dbFile);

  const db = new Database(paths.dbFile);
  if (env.dbEncryption !== 'off') {
    db.pragma(`key = "x'${dbKey()}'"`);
    db.pragma("cipher = 'sqlcipher'");
    db.pragma('cipher_migrate');
  }
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 134217728');

  instance = db;
  if (env.dbEncryption !== 'off' && !encryptionActive) {
    throw new Error('Не удалось подтвердить шифрование базы данных. Установите DB_ENCRYPTION=off только для разработки.');
  }
  return db;
}

export function closeDatabase(): void {
  if (!instance) return;
  try { instance.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
  instance.close();
  instance = null;
}

export function getDb(): DB {
  return instance ?? openDatabase();
}

export function listMigrations(): Array<{ name: string; sql: string }> {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
}

export function runMigrations(options: { silent?: boolean } = {}): string[] {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT name FROM migrations').all() as Array<{ name: string }>).map((r) => r.name),
  );
  const ran: string[] = [];
  for (const migration of listMigrations()) {
    if (applied.has(migration.name)) continue;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO migrations(name, applied_at) VALUES (?, ?)').run(migration.name, now());
    });
    try {
      apply();
      ran.push(migration.name);
      if (!options.silent) info(`Миграция применена: ${migration.name}`);
    } catch (err) {
      logError(`Миграция ${migration.name} не применена`, { error: String(err) });
      throw err;
    }
  }
  return ran;
}

export function getMeta(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO app_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

/** Транзакция с автоматическим повтором при SQLITE_BUSY. */
export function tx<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}

export function all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, params: unknown[] = []): Database.RunResult {
  return getDb().prepare(sql).run(...params);
}
