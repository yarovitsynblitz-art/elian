import { env } from '../config/env.js';

/** Поля, которые никогда не должны попадать в логи, аудит, уведомления и дампы. */
export const SECRET_FIELDS = [
  'password', 'newPassword', 'currentPassword', 'confirmPassword', 'passwordHash', 'password_hash',
  'token', 'accessToken', 'refreshToken', 'authorization', 'cookie', 'set-cookie', 'approvalSecret',
  'sessionSecret', 'csrf', 'csrfToken', 'secret', 'tfaSecret', 'webhookSecret', 'dbKey', 'mediaKey',
  'privateKey', 'apiKey', 'clientSecret',
] as const;

const SECRET_SET = new Set(SECRET_FIELDS.map((f) => f.toLowerCase()));
const REDACTED = '[redacted]';

/** Централизованная очистка объектов перед логированием/аудитом/уведомлением. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 6) return REDACTED as unknown as T;
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_SET.has(key.toLowerCase()) ? REDACTED : redact(val, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

/** Маскирование строки-маркера пароля в произвольном тексте (страховка для логов). */
export function scrub(text: string, knownSecret?: string): string {
  let out = text;
  for (const field of SECRET_FIELDS) {
    out = out.replace(new RegExp(`("?${field}"?\\s*[:=]\\s*)"[^"]*"`, 'gi'), `$1"${REDACTED}"`);
  }
  if (knownSecret && knownSecret.length >= 6) {
    out = out.split(knownSecret).join(REDACTED);
  }
  return out;
}

export const logLevel = env.logLevel;

export function info(message: string, meta?: Record<string, unknown>): void {
  if (env.logLevel === 'silent') return;
  const suffix = meta ? ` ${JSON.stringify(redact(meta))}` : '';
  console.log(`[elian] ${message}${suffix}`);
}

export function warn(message: string, meta?: Record<string, unknown>): void {
  const suffix = meta ? ` ${JSON.stringify(redact(meta))}` : '';
  console.warn(`[elian][warn] ${message}${suffix}`);
}

export function error(message: string, meta?: Record<string, unknown>): void {
  const suffix = meta ? ` ${JSON.stringify(redact(meta))}` : '';
  console.error(`[elian][error] ${message}${suffix}`);
}
