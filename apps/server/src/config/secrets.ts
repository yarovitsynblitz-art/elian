import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env, ensureDirs, paths } from './env.js';

/**
 * Секреты хранятся вне каталога данных и вне репозитория.
 * Если файла нет — генерируется криптографически случайный ключ с правами 600.
 */
const cache = new Map<string, string>();

function readSecretFile(name: string): string | null {
  const fromEnv = process.env[name];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const file = path.join(paths.secretsDir, `${name.toLowerCase()}.key`);
  if (!fs.existsSync(file)) return null;
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!value) return null;
  const mode = fs.statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    console.warn(`[security] ${file} имеет слишком широкие права (${mode.toString(8)}), исправляю на 600`);
    fs.chmodSync(file, 0o600);
  }
  return value;
}

function writeSecretFile(name: string, value: string): void {
  const file = path.join(paths.secretsDir, `${name.toLowerCase()}.key`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
}

export function getSecret(name: 'DB_KEY' | 'MEDIA_KEY' | 'SESSION_PEPPER' | 'OWNER_CONSOLE_TOKEN', opts: { create?: boolean } = {}): string {
  if (cache.has(name)) return cache.get(name)!;
  let value = readSecretFile(name);
  if (!value) {
    if (opts.create === false) throw new Error(`Секрет ${name} не найден в ${paths.secretsDir}`);
    ensureDirs();
    value = crypto.randomBytes(32).toString('hex');
    writeSecretFile(name, value);
    console.log(`[security] Сгенерирован новый секрет ${name} (${path.join(paths.secretsDir, name.toLowerCase() + '.key')})`);
  }
  cache.set(name, value);
  return value;
}

/** Ключ медиа: 32 байта из hex/base64, пригодный для AES-256-GCM. */
export function mediaKey(): Buffer {
  const raw = getSecret('MEDIA_KEY');
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('MEDIA_KEY должен быть 32 байта (64 hex-символа)');
  return buf;
}

export function dbKey(): string {
  const key = getSecret('DB_KEY');
  if (!env.isTest && env.dbEncryption === 'required' && key.length < 32) {
    throw new Error('DB_KEY слишком короткий');
  }
  return key;
}
