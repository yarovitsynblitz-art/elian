import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { maskIp, parseEntities, passwordProblem, ulid, normalizeUsername, isValidUsername, formatBytes } from '@elian/shared';
import { CHUNK_SIZE, decryptAll, decryptRange, encryptedSize, encryptBufferToFile, encryptFileToFile } from '../src/lib/media-crypto.js';
import { approvalCode, totpCode, verifyTotp, base32Encode } from '../src/lib/tokens.js';

describe('Утилиты', () => {
  it('ULID: 26 символов, уникальность, монотонность', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i++) ids.add(ulid());
    expect(ids.size).toBe(2000);
    const a = ulid(1700000000000);
    const b = ulid(1700000000000);
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
  });

  it('нормализация и валидация username', () => {
    expect(normalizeUsername('  @Alice_99 ')).toBe('alice_99');
    expect(isValidUsername('alice_99')).toBe(true);
    expect(isValidUsername('1alice')).toBe(false);
    expect(isValidUsername('ab')).toBe(false);
  });

  it('маскирование IP', () => {
    expect(maskIp('203.0.113.42')).toBe('203.0.113.*');
    expect(maskIp('::ffff:10.1.2.3')).toBe('10.1.2.*');
    expect(maskIp('2001:db8:85a3:1:2:3:4:5')).toBe('2001:db8:85a3::*');
    expect(maskIp(null)).toBeNull();
  });

  it('политика паролей', () => {
    expect(passwordProblem('short')).toMatch(/10 символов/);
    // Длинная парольная фраза из одного класса допустима (>=16 символов).
    expect(passwordProblem('alllowercaseonly')).toBeNull();
    expect(passwordProblem('aaaaaaaaaaaa')).toMatch(/простой/);
    expect(passwordProblem('Correct-Horse-9')).toBeNull();
    expect(passwordProblem('MyPassword-99')).toMatch(/распространённую/);
  });

  it('форматирование размера', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('Разбор форматирования сообщений', () => {
  it('извлекает bold/italic/spoiler/код и убирает маркеры', () => {
    const { text, entities } = parseEntities('Привет **мир** и ||секрет||, *курсив*, `code`');
    expect(text).toBe('Привет мир и секрет, курсив, code');
    const types = entities.map((e) => e.type).sort();
    expect(types).toContain('bold');
    expect(types).toContain('spoiler');
    expect(types).toContain('italic');
    expect(types).toContain('code');
    const bold = entities.find((e) => e.type === 'bold')!;
    expect(text.slice(bold.offset, bold.offset + bold.length)).toBe('мир');
  });

  it('находит упоминания, хэштеги и ссылки', () => {
    const { entities } = parseEntities('привет @alice_99 #новости https://example.com/x');
    expect(entities.some((e) => e.type === 'mention')).toBe(true);
    expect(entities.some((e) => e.type === 'hashtag')).toBe(true);
    const link = entities.find((e) => e.type === 'text_link')!;
    expect(link.url).toBe('https://example.com/x');
  });

  it('экранирование спецсимволов', () => {
    const { text } = parseEntities('a \\* b \\_ c');
    expect(text).toBe('a * b _ c');
  });
});

describe('Коды и TOTP', () => {
  it('код подтверждения читаемый и случайный', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 500; i++) codes.add(approvalCode());
    expect(codes.size).toBe(500);
    expect([...codes][0]).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('TOTP проверяется в окне', () => {
    const secret = crypto.randomBytes(20).toString('hex');
    const code = totpCode(Buffer.from(secret, 'hex'));
    expect(verifyTotp(secret, code)).toBe(true);
    expect(verifyTotp(secret, '000000')).toBe(false);
    expect(base32Encode(Buffer.from(secret, 'hex'))).toMatch(/^[A-Z2-7]+$/);
  });
});

describe('Шифрование медиа (AES-256-GCM по чанкам)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elian-media-'));

  it('шифрует и расшифровывает файл любого размера', async () => {
    for (const size of [0, 1, 1000, CHUNK_SIZE, CHUNK_SIZE + 1, 3 * CHUNK_SIZE + 777]) {
      const source = path.join(tmp, `src-${size}.bin`);
      const target = path.join(tmp, `enc-${size}.eln`);
      const data = crypto.randomBytes(size);
      fs.writeFileSync(source, data);
      const result = await encryptFileToFile(source, target);
      expect(result.size).toBe(size);
      expect(fs.statSync(target).size).toBe(encryptedSize(size));
      const restored = await decryptAll(target, size);
      expect(restored.equals(data)).toBe(true);
      // В шифротексте нет открытых данных.
      if (size > 64) {
        const cipherText = fs.readFileSync(target);
        expect(cipherText.includes(data.subarray(0, 32))).toBe(false);
      }
    }
  });

  it('поддерживает Range-выборку без полной расшифровки', async () => {
    const size = 5 * CHUNK_SIZE + 123;
    const data = crypto.randomBytes(size);
    const source = path.join(tmp, 'range.bin');
    const target = path.join(tmp, 'range.eln');
    fs.writeFileSync(source, data);
    await encryptFileToFile(source, target);
    for (const [start, end] of [[0, 99], [CHUNK_SIZE - 10, CHUNK_SIZE + 10], [size - 50, size - 1]] as const) {
      const slice = await decryptRange(target, size, start, end);
      expect(slice.equals(data.subarray(start, end + 1))).toBe(true);
    }
  });

  it('обнаруживает повреждение контейнера', async () => {
    const source = path.join(tmp, 'tamper.bin');
    const target = path.join(tmp, 'tamper.eln');
    fs.writeFileSync(source, crypto.randomBytes(5000));
    await encryptFileToFile(source, target);
    const bytes = fs.readFileSync(target);
    bytes[bytes.length - 30] ^= 0xff;
    fs.writeFileSync(target, bytes);
    await expect(decryptAll(target, 5000)).rejects.toThrow();
  });

  it('шифрует буферы превью', async () => {
    const target = path.join(tmp, 'thumb.eln');
    const data = Buffer.from('thumbnail-bytes');
    await encryptBufferToFile(data, target);
    expect((await decryptAll(target, data.length)).equals(data)).toBe(true);
  });
});
