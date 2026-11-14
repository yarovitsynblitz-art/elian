import type { MessageEntity } from './types.js';

/** ULID-генератор (Crockford base32, 26 символов, монотонный по времени). */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = 0;
let lastRandom: number[] = [];

/** Случайные base32-цифры (0..31) — 16 цифр = 80 бит энтропии. */
function randomDigits(count: number): number[] {
  const out: number[] = [];
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const buf = new Uint8Array(count);
    globalThis.crypto.getRandomValues(buf);
    for (let i = 0; i < count; i++) out.push(buf[i]! % 32);
    return out;
  }
  for (let i = 0; i < count; i++) out.push(Math.floor(Math.random() * 32));
  return out;
}

export function ulid(now = Date.now()): string {
  let timeChars = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    timeChars = ENCODING[t % 32] + timeChars;
    t = Math.floor(t / 32);
  }
  if (now === lastTime) {
    // Монотонный инкремент base32-цифр: гарантирует уникальность в пределах миллисекунды.
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      if (lastRandom[i]! < 31) { lastRandom[i]! += 1; break; }
      lastRandom[i] = 0;
    }
  } else {
    lastRandom = randomDigits(16);
    lastTime = now;
  }
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ENCODING[lastRandom[i] ?? 0];
  return timeChars + rand;
}

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

/** Нормализация @username: нижний регистр, без ведущего @. */
export function normalizeUsername(raw: string): string {
  return String(raw ?? '').trim().replace(/^@+/, '').toLowerCase();
}

export function isValidUsername(raw: string): boolean {
  const u = normalizeUsername(raw);
  return /^[a-z][a-z0-9_]{3,31}$/.test(u);
}

/** Маскирование IP: 203.0.113.42 -> 203.0.113.*, IPv6 -> первые 3 группы. */
export function maskIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const clean = ip.replace(/^::ffff:/, '');
  if (clean.includes(':')) {
    const parts = clean.split(':').filter(Boolean);
    return `${parts.slice(0, 3).join(':')}::*`;
  }
  const parts = clean.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.*`;
  return '—';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

/** Простая проверка сложности пароля (без утечки на сервере). */
export function passwordProblem(password: string): string | null {
  if (typeof password !== 'string') return 'Пароль обязателен';
  if (password.length < 10) return 'Пароль должен быть не короче 10 символов';
  if (password.length > 200) return 'Пароль слишком длинный';
  if (/[\u0000-\u001f\u007f]/.test(password)) return 'Пароль содержит недопустимые символы';
  const classes = [/[a-zа-я]/, /[A-ZА-Я]/, /[0-9]/, /[^\w\s]/].filter((re) => re.test(password)).length;
  if (classes < 2 && password.length < 16) return 'Пароль слишком простой: добавьте цифры, символы или регистр';
  if (/^(.)\1+$/.test(password)) return 'Пароль слишком простой';
  const common = ['password', 'qwerty', '123456', 'пароль', '111111', 'letmein'];
  if (common.some((c) => password.toLowerCase().includes(c))) return 'Пароль содержит распространённую последовательность';
  return null;
}

/** Разбор подмножества Markdown в entities + plain text. */
export function parseEntities(input: string): { text: string; entities: MessageEntity[] } {
  const entities: MessageEntity[] = [];
  let out = '';
  let i = 0;
  type Marker = { ch: string; type: MessageEntity['type']; len: 1 | 2 };
  const markers: Marker[] = [
    { ch: '**', type: 'bold', len: 2 },
    { ch: '__', type: 'underline', len: 2 },
    { ch: '~~', type: 'strike', len: 2 },
    { ch: '||', type: 'spoiler', len: 2 },
    { ch: '`', type: 'code', len: 1 },
    { ch: '*', type: 'italic', len: 1 },
    { ch: '_', type: 'italic', len: 1 },
  ];
  const stack: Array<{ type: MessageEntity['type']; start: number }> = [];
  while (i < input.length) {
    const two = input.slice(i, i + 2);
    const one = input[i]!;
    if (one === '\\' && i + 1 < input.length && '*_~`|\\'.includes(input[i + 1]!)) {
      out += input[i + 1];
      i += 2;
      continue;
    }
    const marker = markers.find((m) => (m.len === 2 ? m.ch === two : m.ch === one));
    if (marker) {
      const top = stack[stack.length - 1];
      if (top && top.type === marker.type) {
        const start = stack.pop()!.start;
        if (out.length > start) entities.push({ type: marker.type, offset: start, length: out.length - start });
        i += marker.len;
        continue;
      }
      const closable = stack.findIndex((s) => s.type === marker.type);
      if (closable >= 0) {
        while (stack.length - 1 > closable) stack.pop();
        const start = stack.pop()!.start;
        if (out.length > start) entities.push({ type: marker.type, offset: start, length: out.length - start });
        i += marker.len;
        continue;
      }
      stack.push({ type: marker.type, start: out.length });
      i += marker.len;
      continue;
    }
    out += one;
    i += 1;
  }
  // незакрытые маркеры игнорируем как форматирование
  const mentionRe = /(^|\s)@([a-zA-Z][a-zA-Z0-9_]{3,31})/g;
  let m: RegExpExecArray | null;
  while ((m = mentionRe.exec(out))) {
    const offset = m.index + m[1]!.length;
    entities.push({ type: 'mention', offset, length: m[2]!.length + 1 });
  }
  const hashRe = /(^|\s)#([\p{L}\p{N}_]{2,64})/gu;
  while ((m = hashRe.exec(out))) {
    entities.push({ type: 'hashtag', offset: m.index + m[1]!.length, length: m[2]!.length + 1 });
  }
  const linkRe = /https?:\/\/[^\s<>"']+/g;
  while ((m = linkRe.exec(out))) {
    entities.push({ type: 'text_link', offset: m.index, length: m[0].length, url: m[0] });
  }
  entities.sort((a, b) => a.offset - b.offset || a.length - b.length);
  return { text: out, entities };
}

/** Экранирование HTML (серверные страницы/письма не используются, но нужно для preview). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function relativeTime(iso: string, locale: 'ru' | 'en' = 'ru'): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return locale === 'ru' ? 'только что' : 'just now';
  if (diff < 3600) return locale === 'ru' ? `${Math.floor(diff / 60)} мин назад` : `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return locale === 'ru' ? `${Math.floor(diff / 3600)} ч назад` : `${Math.floor(diff / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(locale === 'ru' ? 'ru-RU' : 'en-US');
}
