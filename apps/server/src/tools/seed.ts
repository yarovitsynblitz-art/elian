import { DEFAULT_SETTINGS } from '../services/settings.js';
import { all, get, run } from '../db/index.js';
import { ensureDirs, env } from '../config/env.js';
import { openDatabase, runMigrations } from '../db/index.js';
import { getSecret } from '../config/secrets.js';
import { hashPassword } from '../lib/password.js';
import { now } from '../lib/time.js';
import { parseEntities } from '@elian/shared';

/**
 * Демо-данные: два пользователя, группа, канал, сообщения.
 * Пароли демо-аккаунтов печатаются один раз и предназначены только для локальной проверки.
 */
async function main(): Promise<void> {
  ensureDirs();
  getSecret('DB_KEY');
  getSecret('MEDIA_KEY');
  getSecret('SESSION_PEPPER');
  openDatabase();
  runMigrations({ silent: true });
  if (!env.seedDemo) {
    console.log('SEED_DEMO=false — демо-данные не создаются. Установите SEED_DEMO=true, если нужно.');
    return;
  }
  const existing = get<{ c: number }>('SELECT count(*) AS c FROM users');
  if ((existing?.c ?? 0) > 0) {
    console.log('В базе уже есть пользователи — seed пропущен (идемпотентность).');
    return;
  }
  const users = [
    { username: 'alice', displayName: 'Алиса', password: 'Elian-demo-Alice-1' },
    { username: 'boris', displayName: 'Борис', password: 'Elian-demo-Boris-2' },
  ];
  const ids: Record<string, string> = {};
  for (const u of users) {
    const id = globalThis.crypto.randomUUID();
    ids[u.username] = id;
    run('INSERT INTO users(id, username, display_name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id, u.username, u.displayName, JSON.stringify(DEFAULT_SETTINGS), now(), now(),
    ]);
    run('INSERT INTO credentials(user_id, password_hash, algo, password_changed_at) VALUES (?, ?, ?, ?)', [
      id, await hashPassword(u.password), 'argon2id', now(),
    ]);
    console.log(`demo user @${u.username} пароль: ${u.password}`);
  }
  const chatId = globalThis.crypto.randomUUID();
  run(`INSERT INTO chats(id, type, title, is_public, created_by, created_at, updated_at, member_count) VALUES (?, 'group', 'Демо-группа', 0, ?, ?, ?, 2)`, [
    chatId, ids.alice, now(), now(),
  ]);
  run(`INSERT INTO chat_members(chat_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`, [chatId, ids.alice, now()]);
  run(`INSERT INTO chat_members(chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`, [chatId, ids.boris, now()]);
  const texts = ['Привет! Это «Элиан».', 'Сообщения реальные, сервер работает :)', 'Проверим **жирный** и ||спойлер||'];
  let seq = 0;
  for (const text of texts) {
    seq++;
    const parsed = parseEntities(text);
    run(
      `INSERT INTO messages(id, chat_id, seq, sender_id, text, entities, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [globalThis.crypto.randomUUID(), chatId, seq, ids.alice, parsed.text, JSON.stringify(parsed.entities), now()],
    );
  }
  run('UPDATE chats SET last_seq = ?, last_message_at = ? WHERE id = ?', [seq, now(), chatId]);
  console.log('Демо-группа создана. Войдите как @alice (владелец должен подтвердить вход в консоли).');
  void all;
}

void main();
