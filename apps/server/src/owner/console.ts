import readline from 'node:readline';
import { bus } from '../lib/bus.js';
import { info } from '../lib/log.js';
import { get, getMeta } from '../db/index.js';
import {
  approvePending, getPendingById, listPending, pendingStats, rejectPending, toOwnerView, expirePending, type PendingRow,
} from '../auth/pending.js';
import { env } from '../config/env.js';

/**
 * Локальная консоль владельца (stdin в tmux). Никогда не публикуется по HTTP.
 * Команды: list, show <код|id>, y [код|id], n [код|id], pending, stats, help.
 */
let currentId: string | null = null;

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatRow(row: PendingRow, marker: string): string {
  const view = toOwnerView(row);
  const code = env.ownerNotificationShowCode ? view.code : '••••-••••';
  return `${marker} ${shortId(view.requestId)}  ${view.type.padEnd(15)} @${view.username.padEnd(24)} ${code}  ${view.createdAt}  ${view.device ?? '—'}  ${view.ipMasked ?? '—'}`;
}

function printQueue(): void {
  expirePending();
  const rows = listPending();
  if (!rows.length) {
    console.log('  Очередь пуста. Ожидание запросов…');
    return;
  }
  console.log(`\n  Очередь подтверждений (${rows.length}):`);
  console.log('  ID        ТИП             ЛОГИН                    КОД        СОЗДАН                    УСТРОЙСТВО              IP');
  for (const row of rows) {
    console.log(formatRow(row, row.id === currentId ? '→' : ' '));
  }
  console.log('  Подтвердить: y [id|код] · Отклонить: n [id|код] · Подробнее: show <id|код>\n');
}

function printShow(reference: string): void {
  const row = getPendingById(reference) ?? listPending().find((r) => r.code === reference.toUpperCase() || shortId(r.id) === reference.toLowerCase());
  if (!row) {
    console.log(`  Запрос «${reference}» не найден среди ожидающих.`);
    return;
  }
  const view = toOwnerView(row);
  console.log([
    '',
    `  ID:         ${view.requestId}`,
    `  Тип:        ${view.type}`,
    `  Логин:      @${view.username}`,
    `  Код:        ${env.ownerNotificationShowCode ? view.code : 'скрыт настройкой'}`,
    `  Создан:     ${view.createdAt}`,
    `  Истекает:   ${view.expiresAt}`,
    `  Устройство: ${view.device ?? '—'}`,
    `  IP:         ${view.ipMasked ?? '—'}`,
    '  (Пароль, хэш пароля и токены недоступны по построению схемы)',
    '',
  ].join('\n'));
}

function resolveTarget(arg: string | undefined): string | null {
  if (arg) return arg;
  if (currentId) return currentId;
  const rows = listPending();
  if (rows.length === 1) return rows[0]!.id;
  console.log('  Несколько запросов в очереди — укажите код или id: y <код>. Текущий запрос показан со стрелкой →');
  return null;
}

function handle(action: 'y' | 'n', arg: string | undefined): void {
  const target = resolveTarget(arg);
  if (!target) return;
  try {
    const row = action === 'y' ? approvePending(target) : rejectPending(target);
    console.log(`  ${action === 'y' ? '✔ ПОДТВЕРЖДЕНО' : '✖ ОТКЛОНЕНО'}: ${row.type} @${row.username} (${shortId(row.id)})`);
    if (currentId === row.id) currentId = null;
    const rest = listPending();
    if (rest.length) printQueue();
    else console.log('  Очередь пуста.');
  } catch (err) {
    console.log(`  Ошибка: ${(err as Error).message}`);
  }
}

function printStats(): void {
  const stats = pendingStats();
  const users = get<{ c: number }>('SELECT count(*) AS c FROM users WHERE deleted_at IS NULL')?.c ?? 0;
  const chats = get<{ c: number }>('SELECT count(*) AS c FROM chats WHERE deleted_at IS NULL')?.c ?? 0;
  const messages = get<{ c: number }>('SELECT count(*) AS c FROM messages WHERE deleted_at IS NULL')?.c ?? 0;
  console.log([
    '',
    `  Пользователи: ${users}   Чаты: ${chats}   Сообщения: ${messages}`,
    `  Запросов в очереди: ${stats.pending}${stats.oldest ? ` (старейший ${stats.oldest})` : ''}`,
    `  Версия: ${getMeta('schema_version') ?? '1'}`,
    '',
  ].join('\n'));
}

const HELP = `
  Elian owner console
    list                — очередь запросов подтверждения
    show <id|код>       — подробности запроса
    y [id|код]          — подтвердить (без аргумента — текущий показанный запрос)
    n [id|код]          — отклонить
    pending             — количество запросов в очереди
    stats               — статистика сервера
    help                — эта справка
    Ctrl+C              — выход (сервер продолжает работать)
`;

export function startOwnerConsole(options: { onExit?: () => void } = {}): () => void {
  if (!env.ownerConsole || env.isTest) return () => {};
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'elian> ' });
  const off = bus.onEvent('pending:created', ({ requestId }) => {
    currentId = requestId;
    const row = getPendingById(requestId);
    if (row) {
      console.log(`\n  Новый запрос ${shortId(row.id)} — введите y для подтверждения или n для отказа.\n`);
    }
  });
  console.log('\n  👋 Консоль владельца Elian. Команды: list, show, y, n, stats, help\n');
  rl.prompt();
  rl.on('line', (raw) => {
    const line = raw.trim();
    const [cmdRaw, ...rest] = line.split(/\s+/);
    const cmd = (cmdRaw ?? '').toLowerCase();
    const arg = rest[0];
    switch (cmd) {
      case '': break;
      case 'help': case '?': console.log(HELP); break;
      case 'list': case 'ls': printQueue(); break;
      case 'show': printShow(arg ?? currentId ?? ''); break;
      case 'y': case 'yes': handle('y', arg); break;
      case 'n': case 'no': handle('n', arg); break;
      case 'pending': console.log(`  В очереди: ${pendingStats().pending}`); break;
      case 'stats': printStats(); break;
      case 'quit': case 'exit': rl.close(); options.onExit?.(); break;
      default: console.log(`  Неизвестная команда «${cmd}». help — справка.`);
    }
    rl.prompt();
  });
  rl.on('close', () => info('owner console закрыта, сервер продолжает работу'));
  return () => {
    off();
    rl.close();
  };
}

/** Используется CLI-утилитой (tools/owner-cli.ts) — локально, без HTTP. */
export function ownerCliCommand(argv: string[]): number {
  const [cmd, arg] = argv;
  switch ((cmd ?? 'list').toLowerCase()) {
    case 'list': printQueue(); return 0;
    case 'show': printShow(arg ?? ''); return 0;
    case 'y': handle('y', arg); return 0;
    case 'n': handle('n', arg); return 0;
    case 'stats': printStats(); return 0;
    default: console.log(HELP); return 1;
  }
}
