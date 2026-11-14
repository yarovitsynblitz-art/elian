import { defineConfig, devices } from '@playwright/test';

/**
 * E2E запускается через scripts/e2e/run-e2e.mjs: он поднимает сервер и передаёт ELIAN_E2E_BASE.
 * Отдельного webServer здесь нет — приложение и API живут на одном origin.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.ELIAN_E2E_BASE ?? 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 900 },
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
