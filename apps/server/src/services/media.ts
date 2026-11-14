import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { get, all, run } from '../db/index.js';
import { paths } from '../config/env.js';
import { decryptAll, encryptFileToFile } from '../lib/media-crypto.js';
import { errors } from '../lib/errors.js';
import { sniffMimeFromFile, mimeFromFileName } from '../lib/mime-sniff.js';
import { warn } from '../lib/log.js';
import { now } from '../lib/time.js';
import { isMember } from './chats.js';

export interface MediaRow {
  id: string;
  owner_id: string | null;
  kind: string;
  mime_type: string;
  size: number;
  encrypted_size: number;
  file_name: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  waveform: string | null;
  sha256: string | null;
  storage_path: string;
  thumb_path: string | null;
  is_encrypted: number;
  created_at: string;
  deleted_at: string | null;
}

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska',
  'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/opus',
  'application/pdf', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream',
  'text/plain', 'text/csv', 'application/json', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel', 'application/rtf',
]);

export function isAllowedMime(mime: string): boolean {
  if (!mime || mime === 'application/octet-stream') return false;
  return ALLOWED_MIME.has(mime) || mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/');
}

/**
 * Итоговый MIME файла: доверяем клиенту только если тип осмысленный и разрешённый,
 * иначе восстанавливаем по содержимому, и лишь затем — по расширению.
 */
export async function resolveMime(
  declared: string | null | undefined,
  filePath: string,
  fileName: string | null,
): Promise<string> {
  const clean = (declared ?? '').split(';')[0]!.trim().toLowerCase();
  if (isAllowedMime(clean)) return clean;
  const sniffed = await sniffMimeFromFile(filePath);
  if (sniffed && isAllowedMime(sniffed)) return sniffed;
  const byName = mimeFromFileName(fileName);
  if (byName && isAllowedMime(byName)) return byName;
  return clean || 'application/octet-stream';
}

function detectKind(mime: string, requested?: string): string {
  if (requested && ['photo', 'video', 'audio', 'voice', 'video_note', 'file', 'sticker', 'gif'].includes(requested)) return requested;
  if (mime.startsWith('image/')) return mime === 'image/gif' ? 'gif' : 'photo';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

export interface StoreUploadInput {
  ownerId: string;
  tempPath: string;
  mimeType: string;
  fileName: string | null;
  kind?: string;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  waveform?: number[] | null;
  thumb?: Buffer | null;
  maxBytes: number;
}

export async function storeUpload(input: StoreUploadInput): Promise<MediaRow> {
  const stat = await fs.promises.stat(input.tempPath);
  if (stat.size === 0) throw errors.badRequest('Пустой файл');
  if (stat.size > input.maxBytes) throw errors.badRequest('Файл больше допустимого размера');
  if (!isAllowedMime(input.mimeType)) {
    warn('upload_rejected_mime', { mimeType: input.mimeType, size: stat.size, fileName: input.fileName ?? null });
    throw errors.badRequest('Этот тип файла не поддерживается');
  }
  const id = crypto.randomUUID();
  const ext = mimeExtension(input.mimeType);
  const safeName = `${id}.eln${ext ? `.${ext}` : ''}`;
  const targetPath = path.join(paths.mediaFiles, safeName);
  const result = await encryptFileToFile(input.tempPath, targetPath);
  let thumbPath: string | null = null;
  if (input.thumb && input.thumb.length > 0 && input.thumb.length < 512 * 1024) {
    thumbPath = `${id}.thumb.eln`;
    await fs.promises.writeFile(path.join(paths.mediaThumbs, thumbPath), input.thumb, { mode: 0o600 });
  }
  run(
    `INSERT INTO media(id, owner_id, kind, mime_type, size, encrypted_size, file_name, width, height, duration,
       waveform, sha256, storage_path, thumb_path, is_encrypted, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      id, input.ownerId, detectKind(input.mimeType, input.kind), input.mimeType, result.size, result.storedSize,
      input.fileName ? path.basename(input.fileName).slice(0, 180) : null, input.width ?? null, input.height ?? null,
      input.duration ?? null, input.waveform ? JSON.stringify(input.waveform.slice(0, 120)) : null,
      result.sha256, safeName, thumbPath, now(),
    ],
  );
  await fs.promises.unlink(input.tempPath).catch(() => {});
  return get<MediaRow>('SELECT * FROM media WHERE id = ?', [id])!;
}

function mimeExtension(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/aac': 'aac',
    'image/heic': 'heic', 'image/heif': 'heif', 'image/bmp': 'bmp',
    'video/3gpp': '3gp', 'video/3gpp2': '3g2', 'video/x-matroska': 'mkv', 'video/x-m4v': 'm4v', 'video/x-msvideo': 'avi',
    'audio/opus': 'opus', 'audio/flac': 'flac',
    'application/pdf': 'pdf', 'application/zip': 'zip', 'text/plain': 'txt',
  };
  return map[mime] ?? 'bin';
}

export function getMedia(id: string): MediaRow | null {
  return get<MediaRow>('SELECT * FROM media WHERE id = ? AND deleted_at IS NULL', [id]) ?? null;
}

/** Доступ к медиа: владелец, участник чата с вложением, публичный аватар или стикер. */
export function canAccessMedia(userId: string, media: MediaRow): boolean {
  if (media.owner_id === userId) return true;
  const asAvatar = get<{ id: string }>('SELECT id FROM users WHERE avatar_media_id = ? AND deleted_at IS NULL LIMIT 1', [media.id]);
  if (asAvatar) return true;
  const asChatAvatar = get<{ id: string }>('SELECT id FROM chats WHERE avatar_media_id = ? AND deleted_at IS NULL LIMIT 1', [media.id]);
  if (asChatAvatar && isMember(asChatAvatar.id, userId)) return true;
  const asSticker = get<{ id: string }>('SELECT id FROM stickers WHERE media_id = ? LIMIT 1', [media.id]);
  if (asSticker) return true;
  const asStory = get<{ id: string }>('SELECT id FROM stories WHERE media_id = ? AND deleted_at IS NULL AND expires_at > ? LIMIT 1', [media.id, now()]);
  if (asStory) return true;
  const attachment = get<{ chat_id: string }>(
    `SELECT m.chat_id FROM attachments a JOIN messages m ON m.id = a.message_id
     WHERE (a.media_id = ? OR a.thumb_media_id = ?) AND m.deleted_at IS NULL LIMIT 1`,
    [media.id, media.id],
  );
  if (attachment && isMember(attachment.chat_id, userId)) return true;
  return false;
}

export async function readThumb(media: MediaRow): Promise<Buffer> {
  if (!media.thumb_path) throw errors.notFound('Превью нет');
  return fs.promises.readFile(path.join(paths.mediaThumbs, media.thumb_path));
}

export async function readWhole(media: MediaRow): Promise<Buffer> {
  return decryptAll(path.join(paths.mediaFiles, media.storage_path), media.size);
}

/** Удаление медиа и файлов (физическая очистка). */
export async function deleteMedia(media: MediaRow): Promise<void> {
  run('UPDATE media SET deleted_at = ? WHERE id = ?', [now(), media.id]);
  await fs.promises.unlink(path.join(paths.mediaFiles, media.storage_path)).catch(() => {});
  if (media.thumb_path) await fs.promises.unlink(path.join(paths.mediaThumbs, media.thumb_path)).catch(() => {});
}

/** Очистка сирот: файлы без ссылок старше суток. */
export async function cleanupOrphans(): Promise<{ media: number; files: number }> {
  const orphans = all<MediaRow>(
    `SELECT * FROM media m WHERE m.created_at < ? AND m.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.media_id = m.id OR a.thumb_media_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_media_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM chats c WHERE c.avatar_media_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM stickers s WHERE s.media_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM stories st WHERE st.media_id = m.id)
     LIMIT 500`,
    [new Date(Date.now() - 86_400_000).toISOString()],
  );
  for (const media of orphans) await deleteMedia(media);
  let files = 0;
  const known = new Set(all<{ storage_path: string }>('SELECT storage_path FROM media').map((m) => m.storage_path));
  for (const file of await fs.promises.readdir(paths.mediaFiles).catch(() => [] as string[])) {
    if (!known.has(file)) {
      await fs.promises.unlink(path.join(paths.mediaFiles, file)).catch(() => {});
      files++;
    }
  }
  return { media: orphans.length, files };
}

export function mediaStats(): { count: number; bytes: number } {
  const row = get<{ c: number; b: number }>('SELECT count(*) AS c, coalesce(sum(encrypted_size), 0) AS b FROM media WHERE deleted_at IS NULL');
  return { count: row?.c ?? 0, bytes: row?.b ?? 0 };
}
