import crypto from 'node:crypto';
import { run } from '../db/index.js';
import { now } from './time.js';
import { redact } from './log.js';

/** Аудит: только действия и безопасные метаданные. Пароли/токены вырезаются. */
export function audit(params: {
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ipMasked?: string | null;
}): void {
  try {
    run(
      'INSERT INTO audit_log(id, actor_id, action, target_type, target_id, metadata, ip_masked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        crypto.randomUUID(),
        params.actorId ?? null,
        params.action,
        params.targetType ?? null,
        params.targetId ?? null,
        JSON.stringify(redact(params.metadata ?? {})),
        params.ipMasked ?? null,
        now(),
      ],
    );
  } catch {
    // аудит не должен ломать основной сценарий
  }
}
