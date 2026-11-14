import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, env, paths } from './config/env.js';
import { openDatabase, runMigrations, closeDatabase, isEncryptionActive, setMeta } from './db/index.js';
import { buildApp } from './app.js';
import { startOwnerConsole } from './owner/console.js';
import { startScheduler } from './jobs/scheduler.js';
import { error as logError, info, warn } from './lib/log.js';
import { getSecret } from './config/secrets.js';

async function main(): Promise<void> {
  ensureDirs();
  // Секреты создаются при первом запуске и лежат вне каталога данных.
  getSecret('DB_KEY');
  getSecret('MEDIA_KEY');
  getSecret('SESSION_PEPPER');

  const db = openDatabase();
  runMigrations({ silent: false });
  setMeta('schema_version', '3');
  if (env.dbEncryption !== 'off' && !isEncryptionActive()) {
    throw new Error('Шифрование базы не подтверждено — запуск остановлен');
  }

  const { app, io } = await buildApp();
  await app.listen({ host: env.host, port: env.port });
  info(`Элиан слушает http://${env.host}:${env.port}`);
  info(`Публичный адрес: ${env.publicUrl}`);
  info(`База: ${paths.dbFile} (шифрование: ${env.dbEncryption !== 'off' ? 'SQLCipher' : 'ВЫКЛЮЧЕНО — только dev'})`);
  info(`Медиа: ${paths.mediaDir} · Логи: ${paths.logDir} · Бэкапы: ${paths.backupDir}`);

  const stopScheduler = startScheduler(15_000);
  const stopConsole = startOwnerConsole();

  const shutdown = async (signal: string) => {
    info(`Получен ${signal}, останавливаемся…`);
    stopScheduler();
    stopConsole();
    try {
      await app.close();
      io.close();
      closeDatabase();
    } catch (err) {
      warn('ошибка при остановке', { message: (err as Error).message });
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logError('unhandledRejection', { reason: String(reason) }));
  process.on('uncaughtException', (err) => {
    logError('uncaughtException', { message: err.message });
  });

  // Проверка целостности бэкап-каталога (не секретов).
  if (!fs.existsSync(paths.backupDir)) fs.mkdirSync(paths.backupDir, { recursive: true, mode: 0o700 });
  void db;
}

main().catch((err) => {
  logError('Не удалось запустить сервер', { message: (err as Error).message });
  console.error(err);
  process.exit(1);
});
