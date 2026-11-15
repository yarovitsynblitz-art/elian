#!/usr/bin/env node
/**
 * UI-аудит: проходит по всем экранам, собирает ошибки консоли, падения страницы,
 * неудачные запросы и ответы >= 400. Используется для поиска багов интерфейса.
 *
 *   node scripts/audit/ui-audit.mjs --base http://127.0.0.1:4888 \
 *        --session <cookie сессии> --csrf <cookie csrf> [--chat <id>] [--mobile]
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const BASE = arg('base', 'http://127.0.0.1:4888');
const SESSION = arg('session');
const CSRF = arg('csrf');
const CHAT = arg('chat');
const MOBILE = process.argv.includes('--mobile');
const USERNAME = arg('username', 'alisa');
const OUT = arg('out', '/tmp/ui-audit');

if (!SESSION || !CSRF) {
  console.error('нужны --session и --csrf');
  process.exit(2);
}

fs.mkdirSync(OUT, { recursive: true });
const host = new URL(BASE).hostname;
const issues = [];
const note = (kind, detail) => {
  issues.push(`${kind}: ${detail}`);
  console.log('  ✖', kind, detail);
};

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: MOBILE ? { width: 390, height: 844 } : { width: 1280, height: 900 },
  locale: 'ru-RU',
  ...(MOBILE ? { isMobile: true, hasTouch: true } : {}),
});
await context.addCookies([
  { name: 'elian_session', value: SESSION, domain: host, path: '/', secure: BASE.startsWith('https'), sameSite: 'Lax' },
  { name: 'elian_csrf', value: CSRF, domain: host, path: '/', secure: BASE.startsWith('https'), sameSite: 'Lax' },
]);

const page = await context.newPage();
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  if (text.includes('favicon')) return;
  note('console', text.slice(0, 180));
});
page.on('pageerror', (error) => note('pageerror', String(error).slice(0, 200)));
page.on('response', (response) => {
  const status = response.status();
  if (status < 400) return;
  const url = response.url().replace(BASE, '');
  if (url.includes('/api/v1/auth/me') && status === 401) return;
  note(`http ${status}`, `${response.request().method()} ${url}`);
});
page.on('requestfailed', (request) => {
  const failure = request.failure()?.errorText ?? '';
  if (failure.includes('ERR_ABORTED')) return;
  note('requestfailed', `${request.method()} ${request.url().replace(BASE, '')} ${failure}`);
});

async function shot(name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
}

async function visit(name, url, readyText) {
  console.log(`→ ${name} (${url})`);
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  if (readyText) {
    const bodyText = await page.locator('body').innerText();
    if (!bodyText.includes(readyText)) note('empty', `${name}: не найден текст «${readyText}» (на экране: ${bodyText.slice(0, 90).replace(/\n/g, ' ')})`);
  }
  await shot(name);
}

await visit('chats', '/', 'Чаты');
await visit('contacts', '/contacts', null);
await visit('stories', '/stories', null);
await visit('archive', '/archive', null);
await visit('profile', `/u/${USERNAME}`, null);
await visit('settings', '/settings', 'Профиль');

// Все разделы настроек
const sections = ['Приватность', 'Безопасность', 'Уведомления', 'Оформление', 'Чаты и папки', 'Устройства', 'Данные и память', 'Язык', 'Дополнительно'];
for (const section of sections) {
  const tab = page.getByRole('button', { name: new RegExp(`^${section}$`, 'i') }).locator('visible=true').first();
  if ((await tab.count()) === 0) {
    note('missing', `раздел настроек «${section}» не найден`);
    continue;
  }
  await tab.click().catch(() => note('click', `не удалось открыть раздел «${section}»`));
  await page.waitForTimeout(500);
  const text = await page.locator('body').innerText();
  if (text.trim().length < 40) note('empty', `раздел «${section}» пустой`);
  await shot(`settings-${section}`);
}

if (CHAT) {
  console.log(`→ чат ${CHAT}`);
  await page.goto(`${BASE}/chat/${CHAT}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await shot('chat');
  const composer = page.locator('textarea, [contenteditable="true"]').first();
  if ((await composer.count()) > 0) {
    await composer.click();
    await composer.fill('Проверка аудита интерфейса');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    const body = await page.locator('body').innerText();
    if (!body.includes('Проверка аудита интерфейса')) note('chat', 'отправленное сообщение не появилось в чате');
  } else {
    note('chat', 'поле ввода сообщения не найдено');
  }
  await shot('chat-after-send');
}


// Дополнительные сценарии: поиск, новый чат, реакции, просмотр истории, смена темы
async function step(name, action) {
  console.log(`→ ${name}`);
  try {
    await action();
  } catch (error) {
    note('interaction', `${name}: ${String(error).slice(0, 160)}`);
  }
  await page.waitForTimeout(600);
}

await step('поиск (Ctrl+K / кнопка)', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const searchButton = page.getByRole('button', { name: /Поиск/i }).locator('visible=true').first();
  if ((await searchButton.count()) === 0) throw new Error('кнопка поиска не найдена');
  await searchButton.click();
  await page.locator('input:visible').last().fill('алиса');
  await page.waitForTimeout(1200);
  await shot('search');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
});

await step('новый чат', async () => {
  const plus = page.getByRole('button', { name: /Новый чат/i }).locator('visible=true').first();
  if ((await plus.count()) === 0) throw new Error('кнопка «Новый чат» не найдена');
  await plus.click();
  await page.waitForTimeout(700);
  const text = await page.locator('body').innerText();
  if (!/Новый чат|Группа|Канал/i.test(text)) throw new Error('модалка нового чата не открылась');
  await shot('new-chat');
  await page.keyboard.press('Escape');
});

await step('просмотр своей истории', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const circles = page.locator('button').filter({ hasText: /Моя история|Алиса/ });
  if ((await circles.count()) === 0) throw new Error('кружки историй не найдены');
  await page.getByText('Моя история').locator('visible=true').first().click();
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
});

await step('смена темы в настройках', async () => {
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const appearance = page.getByRole('button', { name: /^Оформление$/i }).locator('visible=true').first();
  if ((await appearance.count()) === 0) throw new Error('раздел «Оформление» не найден');
  await appearance.click();
  await page.waitForTimeout(600);
  const dark = page.getByRole('button', { name: /Тёмная|Темная/i }).locator('visible=true').first();
  if ((await dark.count()) > 0) {
    await dark.click();
    await page.waitForTimeout(700);
  }
  await shot('theme');
});

await browser.close();

console.log(`\nВсего замечаний: ${issues.length}`);
if (issues.length) {
  console.log(issues.map((line) => ` - ${line}`).join('\n'));
  process.exit(1);
}
console.log('Аудит чистый');
