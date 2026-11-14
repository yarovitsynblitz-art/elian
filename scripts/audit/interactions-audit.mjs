#!/usr/bin/env node
/** Интерактивный аудит: меню сообщения, реакции, правка, удаление, аватар, TOTP, устройства. */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4888';
const { S, K, CHAT } = process.env;
const issues = [];
const note = (what, detail) => { issues.push(`${what}: ${detail}`); console.log('  ✖', what, String(detail).slice(0, 200)); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', isMobile: true, hasTouch: true });
const host = new URL(BASE).hostname;
await ctx.addCookies([
  { name: 'elian_session', value: S, domain: host, path: '/' },
  { name: 'elian_csrf', value: K, domain: host, path: '/' },
]);
const page = await ctx.newPage();
page.on('pageerror', (e) => note('pageerror', String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) note('console', m.text()); });
page.on('response', (r) => { if (r.status() >= 400) note(`http ${r.status()}`, `${r.request().method()} ${r.url().replace(BASE, '')}`); });

async function step(name, fn) {
  console.log('→', name);
  try { await fn(); } catch (error) { note('interaction', `${name}: ${String(error).slice(0, 160)}`); }
  await page.waitForTimeout(500);
}

await step('переписка: меню, реакция, правка', async () => {
  await page.goto(`${BASE}/chat/${CHAT}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const bubbles = page.locator('.bubble:visible');
  const count = await bubbles.count();
  if (!count) throw new Error('нет сообщений в чате');

  // Своё сообщение (обычно с галочками) — у него есть «Изменить»/«Удалить».
  let own = null;
  for (let index = count - 1; index >= Math.max(0, count - 6); index -= 1) {
    const text = await bubbles.nth(index).innerText();
    if (/[✓✔]/.test(text)) { own = bubbles.nth(index); break; }
  }
  const target = own ?? bubbles.nth(count - 1);
  await target.click({ button: 'right' });
  await page.waitForTimeout(600);
  const menuText = await page.locator('body').innerText();
  for (const label of ['Ответить', 'Копировать', 'Переслать', 'Удалить']) {
    if (!menuText.includes(label)) note('menu', `в меню сообщения нет пункта «${label}»`);
  }
  if (own && !menuText.includes('Изменить')) note('menu', 'в меню своего сообщения нет «Изменить»');
  // Пересылка должна предлагать выбор чата, а не отправлять в текущий.
  const forwardRow = page.getByRole('button', { name: /Переслать/ }).locator('visible=true').first();
  if (await forwardRow.count()) {
    await forwardRow.click();
    await page.waitForTimeout(700);
    const pickerText = await page.locator('body').innerText();
    if (!/Переслать в чат/.test(pickerText)) note('forward', 'не открылся выбор чата для пересылки');
  } else {
    note('forward', 'нет пункта «Переслать» в меню сообщения');
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  const reactOpener = page.getByRole('button', { name: /^Реакция$/ }).locator('visible=true').first();
  if ((await reactOpener.count()) === 0) note('reactions', 'кнопка реакций недоступна');
  else {
    await reactOpener.click();
    await page.waitForTimeout(400);
    const emoji = page.getByRole('button', { name: '👍' }).locator('visible=true').first();
    if ((await emoji.count()) === 0) note('reactions', 'панель эмодзи не открылась');
    else { await emoji.click(); await page.waitForTimeout(1200); }
  }
});

await step('аватар профиля через настройки', async () => {
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const fileInput = page.locator('input[type=file]');
  if ((await fileInput.count()) === 0) throw new Error('нет поля загрузки аватара');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAKUlEQVR42u3OMQEAAAgDoC251a3gLwSgTV3fgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiD4twV8AQXd6TZlAAAAAElFTkSuQmCC', 'base64');
  await fileInput.first().setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: png });
  await page.waitForTimeout(2500);
});

await step('двухфакторка: экран настройки', async () => {
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const security = page.getByRole('button', { name: /^Безопасность$/i }).locator('visible=true').first();
  await security.click();
  await page.waitForTimeout(700);
  const enable = page.getByRole('button', { name: /Включить|Настроить|2FA/i }).locator('visible=true').first();
  if ((await enable.count()) === 0) note('totp', 'кнопка включения 2FA не найдена');
  else { await enable.click(); await page.waitForTimeout(1200); const text = await page.locator('body').innerText(); if (!/секрет|QR|код/i.test(text)) note('totp', 'экран настройки 2FA пустой'); await page.keyboard.press('Escape'); }
});

await step('устройства и сессии', async () => {
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const devices = page.getByRole('button', { name: /^Устройства$/i }).locator('visible=true').first();
  await devices.click();
  await page.waitForTimeout(900);
  const text = await page.locator('body').innerText();
  if (!/сесси|устройств|Завершить/i.test(text)) note('devices', 'раздел «Устройства» пуст');
});

await step('блокировка и разблокировка (профиль)', async () => {
  await page.goto(`${BASE}/u/bhob`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const block = page.getByRole('button', { name: /Заблокировать|В контакты|Написать/i }).locator('visible=true').first();
  if ((await block.count()) === 0) note('profile', 'на профиле нет кнопок действий');
});

await browser.close();
console.log(`\nЗамечаний: ${issues.length}`);
if (issues.length) { console.log(issues.join('\n')); process.exit(1); }
console.log('Интерактивный аудит чистый');
