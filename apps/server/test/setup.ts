import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Тестовое окружение: отдельная БД и каталог секретов на каждый файл тестов.
 * env.ts читает переменные при импорте, поэтому setup-файл выполняется раньше.
 */
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'elian-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = path.join(base, 'data');
process.env.SECRETS_DIR = path.join(base, 'secrets');
process.env.BACKUP_DIR = path.join(base, 'backups');
process.env.DB_ENCRYPTION = 'required';
process.env.OWNER_CONSOLE = 'false';
process.env.TERMUX_NOTIFICATIONS = 'false';
process.env.OWNER_NOTIFICATION_SHOW_CODE = 'true';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.MEDIA_MAX_BYTES = String(5 * 1024 * 1024);
process.env.LOG_LEVEL = 'silent';
process.env.SESSION_TTL_DAYS = '7';
process.env.ARGON2_MEMORY_KIB = '19456';
process.env.ARGON2_TIME_COST = '2';
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';
process.env.ELIAN_TEST_DIR = base;
process.env.ELIAN_TEST_SECRET = crypto.randomBytes(8).toString('hex');
