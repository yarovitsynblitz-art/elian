import { all, get, run } from '../db/index.js';
import { expirePending } from '../auth/pending.js';
import { insertMessage } from '../services/messages.js';
import { emitToChat } from '../realtime/index.js';
import { cleanupOrphans } from '../services/media.js';
import { sweep } from '../lib/rate-limit.js';
import { cleanupExpiredSessions } from '../auth/sessions-cleanup.js';
import { info, warn } from '../lib/log.js';
import { now } from '../lib/time.js';
import { getMembership, getChat, toChatSummary, isMember } from '../services/chats.js';
import { serializeMessage } from '../services/messages.js';
import { sendPush } from '../services/push.js';
import { userSettings, getUserById } from '../services/users.js';

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const expired = expirePending();
    if (expired) info(`scheduler: истекло запросов подтверждения: ${expired}`);

    // Отложенные сообщения
    const due = all<{ id: string; chat_id: string; sender_id: string; text: string; silent: number }>(
      `SELECT id, chat_id, sender_id, text, silent FROM scheduled_messages
       WHERE status = 'pending' AND send_at <= ? LIMIT 20`,
      [now()],
    );
    for (const item of due) {
      try {
        if (!isMember(item.chat_id, item.sender_id)) throw new Error('sender_not_member');
        const row = insertMessage({ chatId: item.chat_id, senderId: item.sender_id, text: item.text, silent: Boolean(item.silent) });
        run(`UPDATE scheduled_messages SET status = 'sent' WHERE id = ?`, [item.id]);
        const chat = getChat(item.chat_id);
        const member = getMembership(item.chat_id, item.sender_id);
        if (chat && member) emitToChat(item.chat_id, 'message:new', { message: serializeMessage(row, item.sender_id), chat: toChatSummary(chat, member) });
      } catch (err) {
        run(`UPDATE scheduled_messages SET status = 'failed', error = ? WHERE id = ?`, [(err as Error).message, item.id]);
      }
    }

    // Уведомления + push для непрочитанных (с учётом настроек)
    const unreadRows = all<{ chat_id: string; user_id: string; c: number }>(
      `SELECT m.chat_id, m.user_id, count(*) AS c FROM chat_members m
       JOIN messages msg ON msg.chat_id = m.chat_id AND msg.seq > m.last_read_seq AND msg.deleted_at IS NULL
       WHERE m.muted = 0 AND msg.sender_id <> m.user_id AND msg.created_at > ?
       GROUP BY m.chat_id, m.user_id LIMIT 50`,
      [new Date(Date.now() - 60_000).toISOString()],
    );
    for (const row of unreadRows) {
      const user = getUserById(row.user_id);
      if (!user) continue;
      const settings = userSettings(user);
      const chat = getChat(row.chat_id);
      if (!chat) continue;
      const enabled = chat.type === 'private' ? settings.notifications.private : chat.type === 'group' ? settings.notifications.groups : settings.notifications.channels;
      if (!enabled || settings.notifications.mentionsOnly) continue;
      await sendPush(row.user_id, {
        title: chat.type === 'private' ? 'Новое сообщение' : (chat.title ?? 'Элиан'),
        body: settings.notifications.preview ? `${row.c} новых сообщений` : 'Новые сообщения',
        chatId: row.chat_id,
      });
      run('INSERT INTO notifications(id, user_id, chat_id, kind, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        globalThis.crypto.randomUUID(), row.user_id, row.chat_id, 'message', null, null, now(),
      ]);
    }

    // Истёкшие истории
    const stories = all<{ id: string; media_id: string | null }>(
      'SELECT id, media_id FROM stories WHERE expires_at < ? AND deleted_at IS NULL LIMIT 100',
      [now()],
    );
    for (const story of stories) run('UPDATE stories SET archived = 1 WHERE id = ?', [story.id]);

    // Приглашения с истёкшим сроком
    run('UPDATE invites SET revoked_at = ? WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?', [now(), now()]);

    // Очистка сессий, бот-апдейтов, старых заявок
    cleanupExpiredSessions();
    run('DELETE FROM bot_updates WHERE created_at < ?', [new Date(Date.now() - 7 * 86_400_000).toISOString()]);
    run('DELETE FROM scheduled_jobs WHERE status = ? AND created_at < ?', ['done', new Date(Date.now() - 30 * 86_400_000).toISOString()]);
    run('DELETE FROM login_attempts WHERE window_start < ?', [new Date(Date.now() - 86_400_000).toISOString()]);
    sweep();

    // Раз в 10 минут — очистка сирот медиа
    if (Date.now() % 600_000 < 30_000) {
      const orphans = await cleanupOrphans();
      if (orphans.media || orphans.files) info('scheduler: очистка медиа', orphans);
    }
  } catch (err) {
    warn('scheduler error', { message: (err as Error).message });
  } finally {
    running = false;
  }
}

export function startScheduler(intervalMs = 15_000): () => void {
  if (timer) return () => {};
  timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  void tick();
  info(`Планировщик запущен (интервал ${intervalMs} мс)`);
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}

export async function runSchedulerOnce(): Promise<void> {
  await tick();
}
