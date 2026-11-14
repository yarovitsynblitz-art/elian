import { execFile } from 'node:child_process';
import { env } from '../config/env.js';
import { info } from '../lib/log.js';

export interface OwnerNotice {
  type: 'REGISTRATION' | 'LOGIN' | 'PASSWORD_RESET';
  requestId: string;
  username: string;
  code: string;
  createdAt: string;
  expiresAt: string;
  device: string | null;
  ipMasked: string | null;
}

const TYPE_LABEL: Record<OwnerNotice['type'], string> = {
  REGISTRATION: 'РЕГИСТРАЦИЯ',
  LOGIN: 'ВХОД',
  PASSWORD_RESET: 'СБРОС ПАРОЛЯ',
};

let notificationAvailable: boolean | null = null;

function termuxNotificationAvailable(): Promise<boolean> {
  if (notificationAvailable !== null) return Promise.resolve(notificationAvailable);
  return new Promise((resolve) => {
    execFile('sh', ['-c', 'command -v termux-notification'], (err) => {
      notificationAvailable = !err;
      resolve(notificationAvailable);
    });
  });
}

/**
 * Вывод запроса в консоль Termux. Пароль, хэш пароля и токены сюда не попадают
 * по построению: в OwnerNotice таких полей нет.
 */
export function printBanner(notice: OwnerNotice): void {
  const line = '═'.repeat(56);
  const codeLine = env.ownerNotificationShowCode ? `  Код:      ${notice.code}` : '  Код:      скрыт (OWNER_NOTIFICATION_SHOW_CODE=false)';
  const rows = [
    '',
    `╔${line}╗`,
    `║  ELIAN · новый запрос ${TYPE_LABEL[notice.type].padEnd(34)}║`,
    `╠${line}╣`,
    `  Логин:    @${notice.username}`,
    `  Запрос:   ${notice.requestId}`,
    codeLine,
    `  Создан:   ${notice.createdAt}`,
    `  Истекает: ${notice.expiresAt}`,
    `  Устройство: ${notice.device ?? '—'}`,
    `  IP:       ${notice.ipMasked ?? '—'}`,
    `╚${line}╝`,
    `  Подтвердить: y     Отклонить: n     Список: list     Подробнее: show ${notice.requestId.slice(0, 8)}`,
    '',
  ];
  console.log(rows.join('\n'));
}

export async function notifyOwner(notice: OwnerNotice): Promise<void> {
  printBanner(notice);
  info('owner_notice', { type: notice.type, requestId: notice.requestId, username: notice.username, code: env.ownerNotificationShowCode ? notice.code : '[hidden]' });
  if (!env.termuxNotifications) return;
  if (!(await termuxNotificationAvailable())) return;
  const body = env.ownerNotificationShowCode
    ? `@${notice.username} · код ${notice.code}`
    : `@${notice.username} · код скрыт`;
  const args = [
    'termux-notification',
    '--id', `elian-${notice.requestId}`,
    '--title', `Elian: ${TYPE_LABEL[notice.type]} требует подтверждения`,
    '--content', body,
    '--priority', 'high',
    '--group', 'elian-auth',
  ];
  execFile('sh', ['-c', args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')], (err) => {
    if (err) info('termux-notification недоступен, используется только консоль');
  });
}

export function cancelNotification(requestId: string): void {
  if (!env.termuxNotifications) return;
  execFile('sh', ['-c', `command -v termux-notification-remove >/dev/null 2>&1 && termux-notification-remove elian-${requestId}`], () => {});
}
