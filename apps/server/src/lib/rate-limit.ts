import { env } from '../config/env.js';
import { errors } from './errors.js';

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export type RateLimitRule = { limit: number; windowMs: number };

export const RULES = {
  login: { limit: 6, windowMs: 5 * 60_000 },
  register: { limit: 5, windowMs: 15 * 60_000 },
  reset: { limit: 4, windowMs: 15 * 60_000 },
  pending: { limit: 240, windowMs: 60_000 },
  search: { limit: 60, windowMs: 60_000 },
  upload: { limit: 40, windowMs: 60_000 },
  createChat: { limit: 20, windowMs: 60_000 },
  message: { limit: 120, windowMs: 60_000 },
  reaction: { limit: 240, windowMs: 60_000 },
  report: { limit: 10, windowMs: 60_000 },
  generic: { limit: 240, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;

export function hit(key: string, rule: RateLimitRule): { allowed: boolean; remaining: number; retryAfter: number } {
  if (!env.rateLimits.enabled) return { allowed: true, remaining: rule.limit, retryAfter: 0 };
  const limit = Math.max(1, Math.round(rule.limit * env.rateLimits.factor));
  const at = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= at) {
    buckets.set(key, { count: 1, resetAt: at + rule.windowMs });
    return { allowed: true, remaining: limit - 1, retryAfter: 0 };
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((bucket.resetAt - at) / 1000) };
  }
  return { allowed: true, remaining: limit - bucket.count, retryAfter: 0 };
}

export function enforce(key: string, rule: RateLimitRule): void {
  const result = hit(key, rule);
  if (!result.allowed) {
    throw errors.tooMany(`Слишком много запросов. Повторите через ${result.retryAfter} с.`);
  }
}

export function reset(key?: string): void {
  if (key) buckets.delete(key);
  else buckets.clear();
}

/** Периодическая очистка, чтобы Map не разрастался. */
export function sweep(): void {
  const at = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= at) buckets.delete(key);
}
