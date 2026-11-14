import { run } from '../db/index.js';
import { now } from '../lib/time.js';

/** Удаление истёкших/отозванных сессий (старше суток после отзыва). */
export function cleanupExpiredSessions(): number {
  const res = run(
    'DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)',
    [now(), new Date(Date.now() - 86_400_000).toISOString()],
  );
  return res.changes;
}
