import fs from 'node:fs';

/**
 * Определение MIME по «магическим» байтам.
 *
 * Зачем: телефон (Android-камера, Opera, HEIC с iPhone, «Поделиться» из галереи)
 * часто отдаёт файл с пустым `type`, с `application/octet-stream` или с типом,
 * которого сервер не ждёт. Раньше такой файл отклонялся как «неподдерживаемый»,
 * и вложение просто не отправлялось. Теперь тип восстанавливается по содержимому.
 */

const BRANDS: Record<string, string> = {
  heic: 'image/heic', heix: 'image/heic', hevc: 'image/heic', heim: 'image/heic',
  mif1: 'image/heif', msf1: 'image/heif', avif: 'image/avif',
  isom: 'video/mp4', iso2: 'video/mp4', mp41: 'video/mp4', mp42: 'video/mp4', avc1: 'video/mp4', dash: 'video/mp4',
  qt: 'video/quicktime', M4V: 'video/x-m4v', '3gp4': 'video/3gpp', '3gp5': 'video/3gpp', '3g2a': 'video/3gpp2',
  M4A: 'audio/mp4', m4a: 'audio/mp4',
};

export function sniffMime(head: Buffer): string | null {
  if (!head || head.length < 12) return null;
  const ascii = (from: number, to: number): string => head.subarray(from, to).toString('latin1');

  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    return BRANDS[brand] ?? 'video/mp4';
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video/webm';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return 'audio/mpeg';
  if (head[0] === 0xff && (head[1]! & 0xf6) === 0xf0) return 'audio/aac';
  if (ascii(0, 4) === '%PDF') return 'application/pdf';
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'application/zip';
  return null;
}

/** Читает первые байты файла и возвращает тип по содержимому (или null). */
export async function sniffMimeFromFile(filePath: string): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buffer, 0, 64, 0);
    return sniffMime(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const EXTENSION_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', bmp: 'image/bmp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', '3gp': 'video/3gpp',
  m4v: 'video/x-m4v', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  opus: 'audio/opus', flac: 'audio/flac',
  pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain',
};

/** MIME по расширению имени файла (последний резерв, если содержимое не опознано). */
export function mimeFromFileName(fileName: string | null | undefined): string | null {
  if (!fileName) return null;
  const match = /\.([a-z0-9]{1,5})$/i.exec(fileName.trim());
  if (!match) return null;
  return EXTENSION_MIME[match[1]!.toLowerCase()] ?? null;
}
