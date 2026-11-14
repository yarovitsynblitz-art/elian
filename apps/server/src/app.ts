import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { env, paths } from './config/env.js';
import { AppError } from './lib/errors.js';
import { error as logError, info } from './lib/log.js';
import { maskedClientIp } from './lib/ip.js';
import { resolveSessionToken, touchSession, verifyCsrf, type AuthContext } from './auth/sessions.js';
import { clientIp } from './lib/ip.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { chatRoutes } from './routes/chats.js';
import { messageRoutes } from './routes/messages.js';
import { mediaRoutes } from './routes/media.js';
import { storyRoutes } from './routes/stories.js';
import { callRoutes } from './routes/calls.js';
import { botRoutes } from './routes/bots.js';
import { miscRoutes } from './routes/misc.js';
import { folderRoutes } from './routes/folders.js';
import { attachRealtime } from './realtime/index.js';
import type { Server as SocketServer } from 'socket.io';

export interface RequestWithAuth extends FastifyRequest {
  auth?: AuthContext;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CSRF_EXEMPT_PREFIXES = ['/api/v1/auth/login', '/api/v1/auth/register', '/api/v1/auth/reset', '/api/v1/auth/pending', '/api/v1/bot/'];

function isSameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser клиент (curl, тесты, Capacitor) без cookie-подделки
  const host = req.headers.host;
  try {
    const originUrl = new URL(origin);
    if (host && originUrl.host === host) return true;
    if (env.allowedOrigins.includes(origin)) return true;
    if (env.publicUrl && originUrl.origin === new URL(env.publicUrl).origin) return true;
    if (originUrl.hostname.endsWith('.trycloudflare.com')) return true;
    return false;
  } catch {
    return false;
  }
}

export async function buildApp(options: { serveStatic?: boolean; logger?: boolean } = {}): Promise<{ app: FastifyInstance; io: SocketServer }> {
  const app = Fastify({
    logger: options.logger === false ? false : {
      level: env.logLevel === 'silent' ? 'silent' : env.logLevel,
      redact: {
        paths: [
          'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]',
          'req.body.password', 'req.body.newPassword', 'req.body.currentPassword',
          'req.body.approvalSecret', 'req.body.token', 'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
      serializers: {
        req: (req) => ({ method: req.method, url: req.url?.split('?')[0], ip: req.ip ? '[masked]' : undefined }),
      },
      transport: undefined,
    },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
    requestIdHeader: 'x-request-id',
    genReqId: () => globalThis.crypto.randomUUID(),
  });

  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: env.mediaMaxBytes, files: 2, fields: 20 },
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('permissions-policy', 'geolocation=(self), microphone=(self), camera=(self)');
    reply.header('cross-origin-opener-policy', 'same-origin');
    if (!isSameOrigin(req) && MUTATING.has(req.method)) {
      reply.code(403).send({ error: 'bad_origin', message: 'Запрос с недопустимого источника' });
      return reply;
    }
  });

  app.addHook('preHandler', async (req: RequestWithAuth, reply) => {
    const token = req.cookies[env.sessionCookieName];
    const auth = resolveSessionToken(token);
    if (auth) {
      req.auth = auth;
      // Регулярное обновление last_active + last_seen без лишних записей на каждый запрос.
      const lastActive = new Date(auth.session.last_active_at).getTime();
      if (Date.now() - lastActive > 60_000) {
        touchSession(auth.session.id);
        const { touchLastSeen } = await import('./services/users.js');
        touchLastSeen(auth.userId);
      }
    }
    if (MUTATING.has(req.method) && req.auth && !CSRF_EXEMPT_PREFIXES.some((p) => req.url.startsWith(p))) {
      const ok = verifyCsrf(req.auth.session, req.headers['x-csrf-token'] as string | undefined, req.cookies[env.csrfCookieName]);
      if (!ok) {
        reply.code(403).send({ error: 'csrf_failed', message: 'Недействительный CSRF-токен' });
        return reply;
      }
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      reply.code(err.statusCode >= 200 && err.statusCode < 300 && err.statusCode !== 202 ? 400 : err.statusCode).send({
        error: err.code, message: err.message, details: err.details, requestId: req.id,
      });
      return;
    }
    if (err instanceof ZodError) {
      reply.code(400).send({
        error: 'validation_error',
        message: 'Проверьте правильность заполнения полей',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        requestId: req.id,
      });
      return;
    }
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE' || (err as { code?: string }).code === 'FST_FILES_LIMIT') {
      reply.code(413).send({ error: 'too_large', message: 'Файл превышает допустимый размер', requestId: req.id });
      return;
    }
    if ((err as { statusCode?: number }).statusCode === 429) {
      reply.code(429).send({ error: 'rate_limited', message: 'Слишком много запросов', requestId: req.id });
      return;
    }
    const e = err as Error & { statusCode?: number };
    logError('unhandled_error', { requestId: req.id, message: e.message, stack: env.isProduction ? undefined : e.stack });
    reply.code((err as { statusCode?: number }).statusCode ?? 500).send({
      error: 'internal', message: 'Внутренняя ошибка сервера', requestId: req.id,
    });
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/') && !reply.getHeader('cache-control')) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(userRoutes, { prefix: '/api/v1' });
  await app.register(chatRoutes, { prefix: '/api/v1' });
  await app.register(messageRoutes, { prefix: '/api/v1' });
  await app.register(folderRoutes, { prefix: '/api/v1' });
  await app.register(mediaRoutes, { prefix: '/api/v1' });
  await app.register(storyRoutes, { prefix: '/api/v1' });
  await app.register(callRoutes, { prefix: '/api/v1' });
  await app.register(botRoutes, { prefix: '/api/v1' });
  await app.register(miscRoutes, { prefix: '/api/v1' });

  const io = attachRealtime(app);

  if (options.serveStatic !== false && fs.existsSync(paths.webDist)) {
    await app.register(fastifyStatic, {
      root: paths.webDist,
      prefix: '/',
      wildcard: false,
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) res.setHeader('cache-control', 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/socket.io')) {
        reply.code(404).send({ error: 'not_found', message: 'Маршрут не найден', requestId: req.id });
        return;
      }
      reply.header('content-type', 'text/html; charset=utf-8');
      reply.send(fs.createReadStream(path.join(paths.webDist, 'index.html')));
    });
    app.get('/healthz', async (_req, reply) => reply.send({ status: 'ok' }));
  }

  app.addHook('onClose', async () => {
    io.close();
  });

  info('Elian HTTP слой готов', { port: env.port, production: env.isProduction });
  return { app, io };
}

export function requestMeta(req: FastifyRequest): { ipMasked: string | null; ip: string | null; userAgent: string | null; requestId: string } {
  return {
    ipMasked: maskedClientIp(req),
    ip: clientIp(req),
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    requestId: req.id,
  };
}

export function sendError(reply: FastifyReply, err: unknown): void {
  if (err instanceof AppError) {
    reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    return;
  }
  reply.code(500).send({ error: 'internal', message: 'Внутренняя ошибка' });
}
