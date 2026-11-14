import fs from 'node:fs';
import path from 'node:path';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const approvalsFile = process.env.ELIAN_E2E_APPROVALS ?? path.join(process.env.ELIAN_E2E_DIR ?? '/tmp', 'approvals.txt');
export const e2eDir = process.env.ELIAN_E2E_DIR ?? '/tmp';

/** Владелец «печатает» команду в консоль сервера (Termux). */
export function ownerTypes(command: 'y' | 'n' | 'list'): void {
  fs.appendFileSync(approvalsFile, `${command}\n`);
}

export function uniqueUser(prefix: string) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return {
    username: `${prefix}_${suffix}`,
    displayName: `${prefix === 'alice' ? 'Алиса' : 'Борис'} ${suffix}`,
    password: 'E2e-proverka-parol-2026',
  };
}

export async function registerAndApprove(page: Page, user: { username: string; displayName: string; password: string }) {
  await page.goto('/register');
  await expect(page.getByRole('heading', { name: 'Создать аккаунт' })).toBeVisible();
  await page.getByLabel('Отображаемое имя').fill(user.displayName);
  await page.getByLabel('Логин (@username)').fill(user.username);
  await page.getByLabel(/^Пароль/).first().fill(user.password);
  await page.getByLabel('Повторите пароль').fill(user.password);
  await page.getByRole('button', { name: 'Отправить заявку' }).click();

  await expect(page.getByRole('heading', { name: 'Ожидаем подтверждение' })).toBeVisible({ timeout: 15_000 });
  // Кода подтверждения клиент не видит никогда.
  await expect(page.locator('body')).not.toContainText(/[A-Z0-9]{4}-[A-Z0-9]{4}/);

  ownerTypes('y');
  await page.waitForURL((url) => !url.pathname.startsWith('/pending'), { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Чаты' })).toBeVisible({ timeout: 20_000 });
}

export async function newUserContext(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: process.env.ELIAN_E2E_BASE, viewport: { width: 1280, height: 900 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  const page = await context.newPage();
  if (process.env.ELIAN_E2E_DEBUG === '1') {
    page.on('pageerror', (error) => console.log('[pageerror]', error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') console.log(`[console.${message.type()}]`, message.text().slice(0, 400));
    });
  }
  return { context, page };
}

export async function openPrivateChat(page: Page, username: string) {
  await page.getByRole('button', { name: 'Поиск' }).first().click();
  const searchInput = page.getByPlaceholder('Люди, чаты, сообщения…');
  await searchInput.fill(username);
  await expect(page.getByText(`@${username}`)).toBeVisible({ timeout: 20_000 });
  await page.getByText(`@${username}`).first().click();
  await expect(page.getByPlaceholder('Написать сообщение…')).toBeVisible({ timeout: 20_000 });
}

export async function sendMessage(page: Page, text: string) {
  const composer = page.getByPlaceholder('Написать сообщение…');
  await composer.fill(text);
  await composer.press('Enter');
}
