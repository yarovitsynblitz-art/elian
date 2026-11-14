#!/usr/bin/env node
/**
 * E2E-обвязка: поднимает настоящий production-сервер Элиана с управляемым stdin
 * (это консоль владельца в Termux), затем запускает Playwright в двух браузерных контекстах.
 *
 * Владелец «печатает» y/n в консоль — тесты делают это, дописывая строки в approvals.txt,
 * которые обвязка пересылает в stdin сервера. Сам сервер ничего тестового не знает.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elian-e2e-'));
const dataDir = path.join(workDir, 'data');
const secretsDir = path.join(workDir, 'secrets');
const controlDir = path.join(workDir, 'control');
const approvalsFile = path.join(controlDir, 'approvals.txt');
for (const dir of [dataDir, secretsDir, controlDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(approvalsFile, '');
fs.chmodSync(approvalsFile, 0o600);

const port = 4311 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, [path.join(root, 'apps/server/dist/index.js')], {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: dataDir,
    SECRETS_DIR: secretsDir,
    PUBLIC_DOMAIN: 'e2e.test',
    PUBLIC_URL: base,
    WEB_DIST_DIR: path.join(root, 'apps/web/dist'),
    LOG_LEVEL: 'warn',
    TERMUX_NOTIFICATIONS: 'false',
    RATE_LIMIT_ENABLED: 'false',
    ARGON2_MEMORY_KIB: '19456',
    ARGON2_TIME_COST: '2',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
server.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));

// Пересылка «печати владельца» из файла в stdin консоли сервера.
let offset = 0;
const watcher = setInterval(() => {
  const content = fs.readFileSync(approvalsFile, 'utf8');
  if (content.length <= offset) return;
  const fresh = content.slice(offset);
  offset = content.length;
  for (const line of fresh.split('\n')) {
    const command = line.trim();
    if (command) server.stdin.write(`${command}\n`);
  }
}, 120);

async function waitHealthy(timeoutMs = 40_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${base}/api/v1/health`);
      if (response.ok) return true;
    } catch { /* поднимается */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

let exitCode = 1;
try {
  const ok = await waitHealthy();
  if (!ok) throw new Error(`сервер не поднялся:\n${serverLog.join('')}`);
  console.log(`E2E: сервер запущен на ${base}`);

  const playwright = spawn(
    'npx',
    ['playwright', 'test', '--reporter=list', ...process.argv.slice(2)],
    {
      cwd: path.join(root, 'apps/web'),
      env: { ...process.env, ELIAN_E2E_BASE: base, ELIAN_E2E_DIR: controlDir, ELIAN_E2E_APPROVALS: approvalsFile },
      stdio: 'inherit',
    },
  );
  exitCode = await new Promise((resolve) => playwright.on('exit', (code) => resolve(code ?? 1)));
} catch (error) {
  console.error('E2E обвязка упала:', error.message);
  console.error(serverLog.join('').split('\n').slice(-30).join('\n'));
} finally {
  clearInterval(watcher);
  server.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const log = serverLog.join('');
  const leaked = /(пароль|password)/i.test(log) && /proverka|e2e-password/i.test(log);
  console.log(leaked ? 'ВНИМАНИЕ: в логе сервера найден маркер пароля!' : 'Лог сервера не содержит паролей тестовых пользователей.');
  console.log(`Каталог E2E: ${workDir}`);
  if (process.env.ELIAN_E2E_KEEP === '1') console.log('Сохранён по ELIAN_E2E_KEEP=1');
  process.exit(exitCode === 0 && !leaked ? 0 : 1);
}
