import crypto from 'node:crypto';
import type { PendingStatus } from '@elian/shared';
import { all, get, run } from '../db/index.js';
import { bus } from '../lib/bus.js';
import { AppError, errors } from '../lib/errors.js';
import { warn } from '../lib/log.js';
import { approvalCode, randomToken, sha256 } from '../lib/tokens.js';
import { now, plusMinutes, isPast } from '../lib/time.js';
import { env } from '../config/env.js';
import { notifyOwner, cancelNotification, type OwnerNotice } from '../owner/notifier.js';

export type PendingType = 'REGISTRATION' | 'LOGIN' | 'PASSWORD_RESET';

export interface PendingRow {
  id: string;
  type: PendingType;
  username: string;
  user_id: string | null;
  display_name: string | null;
  password_hash: string | null;
  approval_secret_hash: string;
  code: string;
  status: PendingStatus;
  metadata: string;
  attempts: number;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  consumed_at: string | null;
}

export interface PendingMetadata {
  device: string | null;
  userAgent: string | null;
  ipMasked: string | null;
  requestId: string | null;
}

export function hashApprovalSecret(secret: string): string {
  return sha256(secret);
}

function metadataOf(row: PendingRow): PendingMetadata {
  try {
    return { device: null, userAgent: null, ipMasked: null, requestId: null, ...JSON.parse(row.metadata) };
  } catch {
    return { device: null, userAgent: null, ipMasked: null, requestId: null };
  }
}

export function toOwnerView(row: PendingRow): OwnerNotice {
  const meta = metadataOf(row);
  return {
    type: row.type,
    requestId: row.id,
    username: row.username,
    code: row.code,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    device: meta.device,
    ipMasked: meta.ipMasked,
  };
}

/** Делает истёкшие запросы `expired` (идемпотентно). */
export function expirePending(): number {
  const stamp = now();
  const expired = all<PendingRow>('SELECT * FROM pending_auth_requests WHERE status = ? AND expires_at <= ?', ['pending', stamp]);
  for (const row of expired) {
    run('UPDATE pending_auth_requests SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = ?', [
      'expired', stamp, 'system', row.id, 'pending',
    ]);
    cancelNotification(row.id);
    bus.emitEvent('pending:changed', { requestId: row.id, status: 'expired' });
  }
  // Подчищаем старые неиспользованные заявки (хэши паролей не храним дольше TTL).
  run('DELETE FROM pending_auth_requests WHERE status <> ? AND expires_at < ?', ['pending', new Date(Date.now() - 86_400_000).toISOString()]);
  return expired.length;
}

export interface CreatePendingInput {
  type: PendingType;
  username: string;
  userId?: string | null;
  displayName?: string | null;
  passwordHash?: string | null;
  metadata: PendingMetadata;
  ttlMinutes?: number;
  /** Секрет, сгенерированный клиентом (нужно для сброса пароля без раскрытия аккаунта). */
  clientApprovalSecret?: string;
}

export interface CreatedPending {
  requestId: string;
  approvalSecret: string;
  code: string;
  expiresAt: string;
}

export async function createPendingRequest(input: CreatePendingInput): Promise<CreatedPending> {
  expirePending();
  const id = crypto.randomUUID();
  const approvalSecret = input.clientApprovalSecret ?? randomToken(32);
  if (approvalSecret.length < 24) throw errors.badRequest('Слишком короткий секрет запроса');
  const code = approvalCode(8);
  const ttl = input.ttlMinutes ?? env.pendingTtlMinutes;
  const expiresAt = plusMinutes(ttl);
  const createdAt = now();
  // Один активный запрос на пользователя и тип: старый инвалидируется.
  if (input.userId) {
    run('UPDATE pending_auth_requests SET status = ?, decided_at = ? WHERE user_id = ? AND type = ? AND status = ?', [
      'expired', createdAt, input.userId, input.type, 'pending',
    ]);
  }
  run(
    `INSERT INTO pending_auth_requests
       (id, type, username, user_id, display_name, password_hash, approval_secret_hash, code, status, metadata, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [
      id,
      input.type,
      input.username,
      input.userId ?? null,
      input.displayName ?? null,
      input.passwordHash ?? null,
      hashApprovalSecret(approvalSecret),
      code,
      JSON.stringify({
        device: input.metadata.device ?? null,
        userAgent: (input.metadata.userAgent ?? '').slice(0, 200) || null,
        ipMasked: input.metadata.ipMasked ?? null,
        requestId: input.metadata.requestId ?? null,
      }),
      createdAt,
      expiresAt,
    ],
  );
  const row = get<PendingRow>('SELECT * FROM pending_auth_requests WHERE id = ?', [id])!;
  bus.emitEvent('pending:created', { requestId: id });
  await notifyOwner(toOwnerView(row));
  return { requestId: id, approvalSecret, code, expiresAt };
}

/** Поиск запроса по коду (полному или с дефисом) либо по id/префиксу id. */
export function findPendingByReference(reference: string): PendingRow | null {
  const ref = reference.trim().toUpperCase();
  if (!ref) return null;
  const byCode = get<PendingRow>('SELECT * FROM pending_auth_requests WHERE code = ? AND status = ?', [ref, 'pending']);
  if (byCode) return byCode;
  const normalizedCode = ref.includes('-') ? ref : `${ref.slice(0, 4)}-${ref.slice(4)}`;
  const byCode2 = get<PendingRow>('SELECT * FROM pending_auth_requests WHERE code = ? AND status = ?', [normalizedCode, 'pending']);
  if (byCode2) return byCode2;
  const byId = get<PendingRow>('SELECT * FROM pending_auth_requests WHERE id = ? AND status = ?', [ref.toLowerCase(), 'pending']);
  if (byId) return byId;
  const byPrefix = all<PendingRow>(
    'SELECT * FROM pending_auth_requests WHERE status = ? AND lower(id) LIKE ? ORDER BY created_at LIMIT 2',
    ['pending', `${ref.toLowerCase()}%`],
  );
  return byPrefix.length === 1 ? byPrefix[0]! : null;
}

export function listPending(): PendingRow[] {
  expirePending();
  return all<PendingRow>('SELECT * FROM pending_auth_requests WHERE status = ? ORDER BY created_at ASC', ['pending']);
}

function decide(reference: string, status: 'approved' | 'rejected', decidedBy = 'owner'): PendingRow {
  expirePending();
  const found = findPendingByReference(reference);
  if (!found) throw new AppError(404, 'pending_not_found', `Активный запрос «${reference}» не найден`);
  if (isPast(found.expires_at)) throw new AppError(410, 'pending_expired', 'Срок действия запроса истёк');
  const changed = run(
    'UPDATE pending_auth_requests SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = ?',
    [status, now(), decidedBy, found.id, 'pending'],
  ).changes;
  if (changed !== 1) throw new AppError(409, 'pending_conflict', 'Запрос уже обработан');
  cancelNotification(found.id);
  const row = get<PendingRow>('SELECT * FROM pending_auth_requests WHERE id = ?', [found.id])!;
  bus.emitEvent('pending:changed', { requestId: row.id, status });
  return row;
}

export function approvePending(reference: string, decidedBy = 'owner'): PendingRow {
  return decide(reference, 'approved', decidedBy);
}

export function rejectPending(reference: string, decidedBy = 'owner'): PendingRow {
  return decide(reference, 'rejected', decidedBy);
}

/**
 * Проверка статуса по (id, approvalSecret). Секрет известен только клиенту,
 * поэтому по одному id статус не выдаётся.
 */
export function pendingStatusForClient(requestId: string, approvalSecret: string): { row: PendingRow; status: PendingStatus } {
  expirePending();
  const row = get<PendingRow>('SELECT * FROM pending_auth_requests WHERE id = ?', [requestId]);
  if (!row) throw errors.notFound('Запрос не найден или уничтожен');
  if (row.approval_secret_hash !== hashApprovalSecret(approvalSecret)) {
    warn('pending_status: неверный approval secret', { requestId });
    throw errors.forbidden('Неверный секрет запроса');
  }
  return { row, status: row.status };
}

/** Помечает подтверждённый запрос использованным. Одноразово и атомарно. */
export function consumePending(requestId: string, approvalSecret: string, expectedType: PendingType): PendingRow {
  const { row } = pendingStatusForClient(requestId, approvalSecret);
  if (row.type !== expectedType) throw errors.badRequest('Тип запроса не совпадает');
  if (row.status === 'pending') throw new AppError(202, 'pending', 'Ожидаем подтверждение владельца');
  if (row.status !== 'approved') throw new AppError(410, row.status, 'Запрос отклонён или истёк');
  if (row.consumed_at) throw new AppError(409, 'already_consumed', 'Запрос уже использован');
  const changes = run(
    'UPDATE pending_auth_requests SET consumed_at = ?, attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL AND status = ?',
    [now(), requestId, 'approved'],
  ).changes;
  if (changes !== 1) throw new AppError(409, 'already_consumed', 'Запрос уже использован');
  return row;
}

export function getPendingById(id: string): PendingRow | null {
  return get<PendingRow>('SELECT * FROM pending_auth_requests WHERE id = ?', [id]) ?? null;
}

/** Полное удаление заявки (при отказе/таймауте) — вместе с хэшем пароля. */
export function destroyPending(id: string): void {
  run('DELETE FROM pending_auth_requests WHERE id = ?', [id]);
}

export function cancelPendingForUser(userId: string, type: PendingType): void {
  run('UPDATE pending_auth_requests SET status = ?, decided_at = ? WHERE user_id = ? AND type = ? AND status = ?', [
    'rejected', now(), userId, type, 'pending',
  ]);
}

export function pendingStats(): { pending: number; oldest: string | null } {
  const row = get<{ c: number; oldest: string | null }>(
    'SELECT count(*) AS c, min(created_at) AS oldest FROM pending_auth_requests WHERE status = ?',
    ['pending'],
  );
  return { pending: row?.c ?? 0, oldest: row?.oldest ?? null };
}

/** Проверка approval secret без раскрытия статуса (для socket-подписки). */
export function verifyApprovalSecretFor(requestId: string, approvalSecret: string): boolean {
  const row = getPendingById(requestId);
  return !!row && row.approval_secret_hash === hashApprovalSecret(approvalSecret);
}
