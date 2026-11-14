import argon2 from 'argon2';
import { env } from '../config/env.js';
import { errors } from './errors.js';

const options: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: env.argon2.memoryCost,
  timeCost: env.argon2.timeCost,
  parallelism: env.argon2.parallelism,
  hashLength: 32,
};

/** Фиктивный хэш для выравнивания времени ответа при несуществующем пользователе. */
const dummyHashPromise = argon2.hash('elian-dummy-password-for-timing-equalization', options);

export async function hashPassword(password: string): Promise<string> {
  try {
    return await argon2.hash(password, options);
  } catch {
    throw errors.internal('Не удалось обработать пароль');
  }
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Выполняет verify по фиктивному хэшу, чтобы не раскрывать существование аккаунта по времени. */
export async function dummyVerify(password: string): Promise<false> {
  const hash = await dummyHashPromise;
  await verifyPassword(hash, password);
  return false;
}

export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, options);
  } catch {
    return true;
  }
}
