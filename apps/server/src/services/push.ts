import webpush from 'web-push';
import { all, run } from '../db/index.js';
import { env } from '../config/env.js';
import { info, warn } from '../lib/log.js';
import { now } from '../lib/time.js';

let configured = false;

function ensureConfigured(): boolean {
  if (!env.vapid) return false;
  if (!configured) {
    webpush.setVapidDetails(env.vapid.subject, env.vapid.publicKey, env.vapid.privateKey);
    configured = true;
  }
  return true;
}

export function vapidPublicKey(): string | null {
  return env.vapid?.publicKey ?? null;
}

export interface PushPayload {
  title: string;
  body: string;
  chatId: string | null;
  messageId?: string;
  tag?: string;
}

/** Web Push: честно деградирует, если VAPID не настроен (возвращает reason). */
export async function sendPush(userId: string, payload: PushPayload): Promise<{ sent: number; failed: number; reason?: string }> {
  if (!ensureConfigured()) return { sent: 0, failed: 0, reason: 'vapid_not_configured' };
  const subscriptions = all<{ id: string; endpoint: string; p256dh: string; auth: string; failures: number }>(
    'SELECT id, endpoint, p256dh, auth, failures FROM push_subscriptions WHERE user_id = ?',
    [userId],
  );
  let sent = 0;
  let failed = 0;
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ ...payload, url: payload.chatId ? `/?chat=${payload.chatId}` : '/' }),
        { TTL: 300 },
      );
      sent++;
      run('UPDATE push_subscriptions SET last_success_at = ?, failures = 0 WHERE id = ?', [now(), sub.id]);
    } catch (err) {
      failed++;
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        run('DELETE FROM push_subscriptions WHERE id = ?', [sub.id]);
        info('push: подписка удалена (410/404)');
      } else {
        run('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?', [sub.id]);
        warn('push: ошибка отправки', { status });
      }
    }
  }
  return { sent, failed };
}
