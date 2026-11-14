import type { FastifyRequest } from 'fastify';
import { maskIp } from '@elian/shared';
import { env } from '../config/env.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Реальный IP: доверяем заголовкам Cloudflare только если TCP-соединение пришло
 * с локального адреса (Cloudflare Tunnel всегда подключается к 127.0.0.1).
 */
export function clientIp(req: FastifyRequest): string | null {
  const remote = req.socket.remoteAddress ?? null;
  const isLocal = remote ? LOOPBACK.has(remote) : false;
  if (env.trustCloudflareProxy && isLocal) {
    const cf = (req.headers['cf-connecting-ip'] as string | undefined) ?? null;
    if (cf) return cf.trim();
    const xff = (req.headers['x-forwarded-for'] as string | undefined) ?? null;
    if (xff) return xff.split(',')[0]!.trim();
  }
  return remote;
}

export function maskedClientIp(req: FastifyRequest): string | null {
  return maskIp(clientIp(req));
}

export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? '').toLowerCase();
  if (!ua) return 'Неизвестное устройство';
  const os = ua.includes('android') ? 'Android'
    : ua.includes('iphone') || ua.includes('ipad') ? 'iOS'
    : ua.includes('windows') ? 'Windows'
    : ua.includes('mac os') ? 'macOS'
    : ua.includes('linux') ? 'Linux' : 'Другое';
  const browser = ua.includes('edg/') ? 'Edge'
    : ua.includes('chrome') ? 'Chrome'
    : ua.includes('firefox') ? 'Firefox'
    : ua.includes('safari') ? 'Safari' : 'Клиент';
  return `${browser} · ${os}`;
}

export function deviceFingerprint(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? '').slice(0, 200);
  return require_crypto(ua);
}

function require_crypto(value: string): string {
  // изолировано, чтобы не тянуть crypto в клиентские бандлы
  return Buffer.from(value).toString('base64').slice(0, 64);
}
