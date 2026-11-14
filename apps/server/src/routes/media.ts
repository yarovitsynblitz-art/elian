import type { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { env } from '../config/env.js';
import { errors } from '../lib/errors.js';
import { requireAuth } from '../auth/sessions.js';
import { canAccessMedia, deleteMedia, getMedia, readWhole, readThumb, resolveMime, storeUpload } from '../services/media.js';
import { decryptRange } from '../lib/media-crypto.js';
import { enforce, RULES } from '../lib/rate-limit.js';
import { audit } from '../lib/audit.js';
import { paths } from '../config/env.js';

export interface UploadPart {
  tempPath: string;
  mimeType: string;
  fileName: string | null;
  fields: Record<string, string>;
}

/** Сохраняет multipart-файл во временный файл (стрим, без больших буферов в памяти). */
export async function tmpFileFromUpload(req: FastifyRequest): Promise<UploadPart | null> {
  if (!req.isMultipart()) return null;
  const data = await req.file({
    limits: { fileSize: env.mediaMaxBytes, files: 1 },
  });
  if (!data) return null;
  const tempPath = path.join(os.tmpdir(), `elian-upload-${globalThis.crypto.randomUUID()}`);
  await fs.promises.mkdir(paths.mediaFiles, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(tempPath, { mode: 0o600 });
    data.file.pipe(out);
    out.on('finish', () => resolve());
    out.on('error', reject);
    data.file.on('error', reject);
    data.file.on('limit', () => {
      out.destroy();
      reject(errors.badRequest('Файл превышает допустимый размер'));
    });
  });
  return {
    tempPath,
    mimeType: data.mimetype || 'application/octet-stream',
    fileName: data.filename ?? null,
    fields: (data.fields ?? {}) as unknown as Record<string, string>,
  };
}

function fieldNumber(fields: Record<string, string>, key: string): number | null {
  const raw = fields[key];
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  app.post('/media/upload', async (req, reply) => {
    const auth = requireAuth(req);
    enforce(`upload:${auth.userId}`, RULES.upload);
    let part: UploadPart | null = null;
    try {
      part = await tmpFileFromUpload(req);
      if (!part) throw errors.badRequest('Файл не передан (multipart/form-data, поле file)');
      const waveformRaw = part.fields.waveform;
      const media = await storeUpload({
        ownerId: auth.userId,
        tempPath: part.tempPath,
        mimeType: await resolveMime(part.mimeType, part.tempPath, part.fileName),
        fileName: part.fileName,
        kind: part.fields.kind,
        width: fieldNumber(part.fields, 'width'),
        height: fieldNumber(part.fields, 'height'),
        duration: fieldNumber(part.fields, 'duration'),
        waveform: waveformRaw ? (JSON.parse(waveformRaw) as number[]) : null,
        thumb: part.fields.thumbBase64 ? Buffer.from(part.fields.thumbBase64, 'base64') : null,
        maxBytes: env.mediaMaxBytes,
      });
      audit({ actorId: auth.userId, action: 'media.uploaded', targetType: 'media', targetId: media.id, metadata: { kind: media.kind, size: media.size } });
      reply.code(201).send({
        media: {
          id: media.id,
          kind: media.kind,
          mimeType: media.mime_type,
          size: media.size,
          fileName: media.file_name,
          width: media.width,
          height: media.height,
          duration: media.duration,
          url: `/api/v1/media/${media.id}/content`,
          thumbUrl: media.thumb_path ? `/api/v1/media/${media.id}/thumbnail` : `/api/v1/media/${media.id}/content`,
          downloadUrl: `/api/v1/media/${media.id}/download`,
        },
      });
    } finally {
      if (part?.tempPath) await fs.promises.unlink(part.tempPath).catch(() => {});
    }
  });

  app.get('/media/:id/thumbnail', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const media = getMedia(id);
    if (!media) throw errors.notFound('Медиа не найдено');
    if (!canAccessMedia(auth.userId, media)) throw errors.forbidden('Нет доступа к файлу');
    const buf = await readThumb(media);
    reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', 'private, max-age=86400')
      .header('etag', `"${media.id}-thumb"`)
      .send(buf);
  });

  app.get('/media/:id/content', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const media = getMedia(id);
    if (!media) throw errors.notFound('Медиа не найдено');
    if (!canAccessMedia(auth.userId, media)) throw errors.forbidden('Нет доступа к файлу');
    const range = req.headers.range;
    const total = media.size;
    const commonHeaders = {
      'content-type': media.mime_type,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(media.file_name ?? 'file')}`,
    };
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (match) {
        const start = match[1] ? Number.parseInt(match[1], 10) : 0;
        const end = match[2] ? Math.min(Number.parseInt(match[2], 10), total - 1) : total - 1;
        if (start > end || start >= total) {
          reply.code(416).header('content-range', `bytes */${total}`).send();
          return;
        }
        const chunk = await decryptRange(path.join(paths.mediaFiles, media.storage_path), total, start, end);
        reply
          .code(206)
          .headers(commonHeaders)
          .header('content-range', `bytes ${start}-${end}/${total}`)
          .header('content-length', String(chunk.length))
          .send(chunk);
        return;
      }
    }
    const buf = await readWhole(media);
    reply.headers(commonHeaders).header('content-length', String(buf.length)).send(buf);
  });

  app.get('/media/:id/download', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const media = getMedia(id);
    if (!media) throw errors.notFound('Медиа не найдено');
    if (!canAccessMedia(auth.userId, media)) throw errors.forbidden('Нет доступа к файлу');
    const buf = await readWhole(media);
    reply
      .header('content-type', media.mime_type)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(media.file_name ?? 'file')}`)
      .header('content-length', String(buf.length))
      .send(buf);
  });

  app.delete('/media/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: z.string().min(10) }).parse(req.params);
    const media = getMedia(id);
    if (!media) throw errors.notFound('Медиа не найдено');
    if (media.owner_id !== auth.userId) throw errors.forbidden('Можно удалять только свои файлы');
    await deleteMedia(media);
    reply.send({ status: 'ok' });
  });
}
