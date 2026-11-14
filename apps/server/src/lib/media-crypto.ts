import crypto from 'node:crypto';
import fs from 'node:fs';
import { mediaKey } from '../config/secrets.js';

/**
 * Файловое шифрование медиа: AES-256-GCM по чанкам 64 КБ.
 * Формат: "ELNM1" (5) + fileNonce (8) + повторяющиеся записи [nonce(12) | tag(16) | ciphertext].
 * Чанковая схема позволяет отдавать файл по HTTP Range без расшифровки целиком.
 */
export const CHUNK_SIZE = 64 * 1024;
const MAGIC = Buffer.from('ELNM1', 'ascii');
const HEADER_SIZE = MAGIC.length + 8;
const TAG_SIZE = 16;
const NONCE_SIZE = 12;
const RECORD_OVERHEAD = NONCE_SIZE + TAG_SIZE;

export function encryptedSize(plainSize: number, chunkSize = CHUNK_SIZE): number {
  const chunks = Math.max(1, Math.ceil(plainSize / chunkSize));
  return HEADER_SIZE + plainSize + chunks * RECORD_OVERHEAD;
}

function cipherFor(nonce: Buffer): crypto.CipherGCM {
  return crypto.createCipheriv('aes-256-gcm', mediaKey(), nonce);
}

function decipherFor(nonce: Buffer): crypto.DecipherGCM {
  return crypto.createDecipheriv('aes-256-gcm', mediaKey(), nonce);
}

function makeNonce(fileNonce: Buffer, index: number): Buffer {
  const nonce = Buffer.alloc(NONCE_SIZE);
  fileNonce.copy(nonce, 0);
  nonce.writeUInt32BE(index, 8);
  return nonce;
}

export interface EncryptResult {
  size: number;
  sha256: string;
  storedSize: number;
}

/** Шифрует файл из источника в целевой путь потоково (память O(chunk)). */
export async function encryptFileToFile(
  sourcePath: string,
  targetPath: string,
  onProgress?: (bytes: number) => void,
): Promise<EncryptResult> {
  const fileNonce = crypto.randomBytes(8);
  const out = await fs.promises.open(targetPath, 'wx', 0o600);
  const hash = crypto.createHash('sha256');
  let index = 0;
  let plainSize = 0;
  try {
    await out.write(MAGIC);
    await out.write(fileNonce);
    const input = fs.createReadStream(sourcePath, { highWaterMark: CHUNK_SIZE });
    let pending = Buffer.alloc(0);
    for await (const raw of input) {
      pending = Buffer.concat([pending, raw as Buffer]);
      while (pending.length >= CHUNK_SIZE) {
        const chunk = pending.subarray(0, CHUNK_SIZE);
        pending = pending.subarray(CHUNK_SIZE);
        await writeChunk(out, chunk, fileNonce, index++);
        hash.update(chunk);
        plainSize += chunk.length;
        onProgress?.(plainSize);
      }
    }
    if (pending.length > 0) {
      await writeChunk(out, pending, fileNonce, index++);
      hash.update(pending);
      plainSize += pending.length;
      onProgress?.(plainSize);
    } else if (plainSize === 0) {
      // Пустой файл: записываем один пустой чанк, чтобы размер контейнера был предсказуем.
      await writeChunk(out, Buffer.alloc(0), fileNonce, index++);
    }
  } finally {
    await out.close();
  }
  return { size: plainSize, sha256: hash.digest('hex'), storedSize: encryptedSize(plainSize) };
}

async function writeChunk(out: fs.promises.FileHandle, chunk: Buffer, fileNonce: Buffer, index: number): Promise<void> {
  const nonce = makeNonce(fileNonce, index);
  const cipher = cipherFor(nonce);
  cipher.setAAD(fileNonce);
  const encrypted = Buffer.concat([cipher.update(chunk), cipher.final()]);
  await out.write(Buffer.concat([nonce, cipher.getAuthTag(), encrypted]));
}

/** Расшифровывает диапазон [start, end] (в байтах plaintext) в массив буферов-чанков. */
export async function decryptRange(
  filePath: string,
  plainSize: number,
  start = 0,
  end = plainSize - 1,
): Promise<Buffer> {
  const safeStart = Math.max(0, Math.min(start, Math.max(0, plainSize - 1)));
  const safeEnd = Math.max(safeStart, Math.min(end, plainSize - 1));
  const firstChunk = Math.floor(safeStart / CHUNK_SIZE);
  const lastChunk = Math.floor(safeEnd / CHUNK_SIZE);
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const header = Buffer.alloc(HEADER_SIZE);
    await fh.read(header, 0, HEADER_SIZE, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Файл не является контейнером Elian');
    const fileNonce = header.subarray(MAGIC.length, HEADER_SIZE);
    const parts: Buffer[] = [];
    for (let index = firstChunk; index <= lastChunk; index++) {
      const chunkPlainStart = index * CHUNK_SIZE;
      const chunkPlainLen = Math.min(CHUNK_SIZE, plainSize - chunkPlainStart);
      const recordOffset = HEADER_SIZE + index * (CHUNK_SIZE + RECORD_OVERHEAD);
      const recordLen = NONCE_SIZE + TAG_SIZE + chunkPlainLen;
      const record = Buffer.alloc(recordLen);
      const { bytesRead } = await fh.read(record, 0, recordLen, recordOffset);
      if (bytesRead !== recordLen) throw new Error('Повреждённый контейнер медиа');
      const nonce = record.subarray(0, NONCE_SIZE);
      const tag = record.subarray(NONCE_SIZE, NONCE_SIZE + TAG_SIZE);
      const body = record.subarray(NONCE_SIZE + TAG_SIZE);
      const decipher = decipherFor(nonce);
      decipher.setAAD(fileNonce);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(body), decipher.final()]);
      const from = Math.max(0, safeStart - chunkPlainStart);
      const to = Math.min(plain.length, safeEnd - chunkPlainStart + 1);
      parts.push(plain.subarray(from, to));
    }
    return Buffer.concat(parts);
  } finally {
    await fh.close();
  }
}

/** Полная расшифровка в буфер (для небольших файлов: превью, стикеры). */
export async function decryptAll(filePath: string, plainSize: number): Promise<Buffer> {
  return decryptRange(filePath, plainSize, 0, plainSize - 1);
}

/** Запись маленького буфера (превью/стикер) в зашифрованный контейнер. */
export async function encryptBufferToFile(data: Buffer, targetPath: string): Promise<EncryptResult> {
  const fileNonce = crypto.randomBytes(8);
  const chunks: Buffer[] = [MAGIC, fileNonce];
  let index = 0;
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    const chunk = data.subarray(offset, Math.min(offset + CHUNK_SIZE, data.length));
    const nonce = makeNonce(fileNonce, index++);
    const cipher = cipherFor(nonce);
    cipher.setAAD(fileNonce);
    const encrypted = Buffer.concat([cipher.update(chunk), cipher.final()]);
    chunks.push(nonce, cipher.getAuthTag(), encrypted);
  }
  if (data.length === 0) {
    const nonce = makeNonce(fileNonce, 0);
    const cipher = cipherFor(nonce);
    cipher.setAAD(fileNonce);
    const encrypted = cipher.final();
    chunks.push(nonce, cipher.getAuthTag(), encrypted);
  }
  const payload = Buffer.concat(chunks);
  await fs.promises.writeFile(targetPath, payload, { mode: 0o600 });
  return {
    size: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    storedSize: payload.length,
  };
}
