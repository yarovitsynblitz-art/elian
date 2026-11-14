import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Мини-загрузчик .env (без внешних зависимостей). */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const repoRoot = path.resolve(new URL('../../../../', import.meta.url).pathname);
loadDotEnv(process.env.ELIAN_ENV_FILE ?? path.join(repoRoot, '.env'));

function str(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}
function int(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}
function bool(name: string, fallback: boolean): boolean {
  const v = str(name).toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on', 'y'].includes(v);
}
function list(name: string): string[] {
  return str(name).split(',').map((s) => s.trim()).filter(Boolean);
}

export type AppEnv = {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  isTest: boolean;
  host: string;
  port: number;
  domain: string;
  publicUrl: string;
  dataDir: string;
  mediaDir: string;
  logDir: string;
  backuptDir: string;
  secretsDir: string;
  webDistDir: string;
  dbFile: string;
  dbEncryption: 'required' | 'off';
  sessionCookieName: string;
  csrfCookieName: string;
  sessionTtlDays: number;
  argon2: { memoryCost: number; timeCost: number; parallelism: number };
  ownerNotificationShowCode: boolean;
  termuxNotifications: boolean;
  ownerConsole: boolean;
  allowedOrigins: string[];
  trustCloudflareProxy: boolean;
  mediaMaxBytes: number;
  vapid: { subject: string; publicKey: string; privateKey: string } | null;
  turn: { urls: string[]; username: string; credential: string } | null;
  rateLimits: { enabled: boolean; factor: number };
  seedDemo: boolean;
  logLevel: string;
  pendingTtlMinutes: number;
  registrationEnabled: boolean;
  requireOwnerApproval: boolean;
};

export function loadEnv(): AppEnv {
  const nodeEnv = (str('NODE_ENV', 'development') as AppEnv['nodeEnv']) ?? 'development';
  const dataDir = path.resolve(str('DATA_DIR', path.join(repoRoot, 'data')));
  const secretsDir = path.resolve(str('SECRETS_DIR', path.join(os.homedir(), '.elian', 'secrets')));
  const domain = str('PUBLIC_DOMAIN', 'localhost');
  const vapidPub = str('VAPID_PUBLIC_KEY');
  const vapidPriv = str('VAPID_PRIVATE_KEY');
  const turnUrls = list('TURN_URLS');
  const env: AppEnv = {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    isTest: nodeEnv === 'test',
    host: str('HOST', '127.0.0.1'),
    port: int('PORT', 3000),
    domain,
    publicUrl: str('PUBLIC_URL', `https://${domain}`),
    dataDir,
    mediaDir: path.resolve(str('MEDIA_DIR', path.join(dataDir, 'media'))),
    logDir: path.resolve(str('LOG_DIR', path.join(dataDir, 'logs'))),
    backuptDir: path.resolve(str('BACKUP_DIR', path.join(dataDir, 'backups'))),
    secretsDir,
    webDistDir: path.resolve(str('WEB_DIST_DIR', path.join(repoRoot, 'apps', 'web', 'dist'))),
    dbFile: path.resolve(str('DB_FILE', path.join(dataDir, 'elian.db'))),
    dbEncryption: str('DB_ENCRYPTION', 'required') === 'off' ? 'off' : 'required',
    sessionCookieName: str('SESSION_COOKIE_NAME', 'elian_session'),
    csrfCookieName: str('CSRF_COOKIE_NAME', 'elian_csrf'),
    sessionTtlDays: int('SESSION_TTL_DAYS', 30),
    argon2: {
      memoryCost: int('ARGON2_MEMORY_KIB', 19456),
      timeCost: int('ARGON2_TIME_COST', 2),
      parallelism: int('ARGON2_PARALLELISM', 1),
    },
    ownerNotificationShowCode: bool('OWNER_NOTIFICATION_SHOW_CODE', true),
    termuxNotifications: bool('TERMUX_NOTIFICATIONS', true),
    ownerConsole: bool('OWNER_CONSOLE', true),
    allowedOrigins: list('ALLOWED_ORIGINS'),
    trustCloudflareProxy: bool('TRUST_CLOUDFLARE_PROXY', true),
    mediaMaxBytes: int('MEDIA_MAX_BYTES', 100 * 1024 * 1024),
    vapid: vapidPub && vapidPriv ? { subject: str('VAPID_SUBJECT', `mailto:owner@${domain}`), publicKey: vapidPub, privateKey: vapidPriv } : null,
    turn: turnUrls.length ? { urls: turnUrls, username: str('TURN_USERNAME'), credential: str('TURN_CREDENTIAL') } : null,
    rateLimits: { enabled: bool('RATE_LIMIT_ENABLED', !process.env.VITEST), factor: Number(str('RATE_LIMIT_FACTOR', '1')) || 1 },
    seedDemo: bool('SEED_DEMO', false),
    logLevel: str('LOG_LEVEL', nodeEnv === 'production' ? 'info' : 'debug'),
    pendingTtlMinutes: int('PENDING_TTL_MINUTES', 5),
    registrationEnabled: bool('REGISTRATION_ENABLED', true),
    requireOwnerApproval: bool('REQUIRE_OWNER_APPROVAL', true),
  };
  return env;
}

export const env = loadEnv();
export const paths = {
  dbFile: env.dbFile,
  mediaDir: env.mediaDir,
  mediaFiles: path.join(env.mediaDir, 'files'),
  mediaThumbs: path.join(env.mediaDir, 'thumbs'),
  logDir: env.logDir,
  backupDir: env.backuptDir,
  secretsDir: env.secretsDir,
  webDist: env.webDistDir,
};

export function ensureDirs(): void {
  for (const dir of [env.dataDir, paths.mediaFiles, paths.mediaThumbs, paths.logDir, paths.backupDir, env.secretsDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
