import crypto from 'node:crypto';
import { getSecret } from '../config/secrets.js';

function sign(payload: string): string {
  return crypto.createHmac('sha256', getSecret('SESSION_PEPPER')).update(payload).digest('base64url');
}

export interface TicketPayload {
  purpose: 'password_reset';
  requestId: string;
  userId: string;
  exp: number;
}

/** Одноразовый тикет сброса пароля: подписан, короткоживущий, без секретов внутри. */
export function issueTicket(payload: TicketPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

export function readTicket(ticket: string, purpose: TicketPayload['purpose']): TicketPayload | null {
  const [encoded, signature] = ticket.split('.');
  if (!encoded || !signature) return null;
  if (sign(encoded) !== signature) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TicketPayload;
    if (payload.purpose !== purpose) return null;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
