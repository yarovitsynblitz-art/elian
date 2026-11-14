import { randomBytes } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';
import { env } from '../config/env.js';
import { errors } from './errors.js';

/**
 * Хэширование паролей — Argon2id в WebAssembly (hash-wasm).
 *
 * Почему не нативный npm-пакет `argon2`: на Termux (Android/clang/libc++) его C++-биндинги
 * не собираются, а установка мессенджера на телефон не должна требовать компилятора.
 * hash-wasm — чистый WASM: одинаково работает на x86_64, aarch64, Android, без node-gyp.
 * Формат хэшей тот же (PHC: `$argon2id$v=19$m=...,t=...,p=...$salt$hash`), поэтому
 * уже сохранённые пароли остаются валидными.
 */

const params = {
  iterations: env.argon2.timeCost,
  parallelism: env.argon2.parallelism,
  memorySize: env.argon2.memoryCost,
  hashLength: 32,
} as const;

const SALT_BYTES = 16;

/** Фиктивный хэш для выравнивания времени ответа при несуществующем пользователе. */
let dummyHashPromise: Promise<string> | null = null;

async function computeHash(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(SALT_BYTES),
    iterations: params.iterations,
    parallelism: params.parallelism,
    memorySize: params.memorySize,
    hashLength: params.hashLength,
    outputType: 'encoded',
  });
}

function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = computeHash('elian-dummy-password-for-timing-equalization').catch(() => '');
  }
  return dummyHashPromise;
}

export async function hashPassword(password: string): Promise<string> {
  try {
    return await computeHash(password);
  } catch {
    throw errors.internal('Не удалось обработать пароль');
  }
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash });
  } catch {
    return false;
  }
}

/** Выполняет verify по фиктивному хэшу, чтобы не раскрывать существование аккаунта по времени. */
export async function dummyVerify(password: string): Promise<false> {
  const hash = await getDummyHash();
  if (hash) await verifyPassword(hash, password);
  return false;
}

const PHC_RE = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/;

export function needsRehash(hash: string): boolean {
  const m = PHC_RE.exec(hash);
  if (!m) return true;
  const [, version, memory, time, parallelism] = m;
  return (
    Number(version) !== 19 ||
    Number(memory) !== params.memorySize ||
    Number(time) !== params.iterations ||
    Number(parallelism) !== params.parallelism
  );
}

export const passwordParams = { ...params };
