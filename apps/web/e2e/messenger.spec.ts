import { expect, test } from '@playwright/test';
import { newUserContext, openPrivateChat, ownerTypes, registerAndApprove, sendMessage, uniqueUser } from './helpers';

test.describe('Элиан: два браузера, настоящий сервер', () => {
  test('регистрация с подтверждением владельцем, переписка, реакции, правки, поиск', async ({ browser }) => {
    const alice = uniqueUser('alice');
    const bob = uniqueUser('bob');

    const first = await newUserContext(browser);
    await registerAndApprove(first.page, alice);

    const second = await newUserContext(browser);
    await registerAndApprove(second.page, bob);

    // Алиса находит Бориса по @username и пишет ему.
    await openPrivateChat(first.page, bob.username);
    await sendMessage(first.page, 'Привет, это Элиан! **жирный** текст');
    await expect(first.page.getByText('жирный')).toBeVisible();

    // Борис видит новый чат в списке без перезагрузки (Socket.IO) и открывает его.
    const aliceRow = second.page.getByRole('button', { name: new RegExp(alice.displayName) }).first();
    await expect(aliceRow).toBeVisible({ timeout: 25_000 });
    await aliceRow.click();
    await expect(second.page.getByPlaceholder('Написать сообщение…')).toBeVisible({ timeout: 15_000 });
    await expect(second.page.getByText('Привет, это Элиан!')).toBeVisible({ timeout: 20_000 });

    // Ответ Бориса.
    await second.page.getByText('Привет, это Элиан!').first().click();
    await sendMessage(second.page, 'Привет, Алиса! Вижу сообщение');
    await expect(first.page.getByText('Привет, Алиса! Вижу сообщение')).toBeVisible({ timeout: 25_000 });

    // Реакция через контекстное меню сообщения.
    await first.page.getByText('Привет, Алиса! Вижу сообщение').hover();
    await first.page.getByRole('button', { name: 'Реакция', exact: true }).first().click();
    await first.page.getByRole('button', { name: '❤️', exact: true }).first().click();
    await expect(first.page.getByRole('button', { name: /^Реакция 1$/ }).first()).toBeVisible({ timeout: 15_000 });
    await expect(second.page.getByRole('button', { name: /^Реакция 1$/ }).first()).toBeVisible({ timeout: 20_000 });

    // Редактирование своего сообщения.
    await first.page.getByText('Привет, это Элиан!').hover();
    await first.page.getByRole('button', { name: 'Ещё' }).first().click();
    await first.page.getByRole('button', { name: 'Изменить' }).click();
    const composer = first.page.getByPlaceholder('Написать сообщение…');
    await composer.fill('Привет, это Элиан! (изменено)');
    await composer.press('Enter');
    await expect(second.page.getByText('(изменено)')).toBeVisible({ timeout: 20_000 });

    // Поиск внутри чата.
    await first.page.getByRole('button', { name: 'Поиск в чате' }).click();
    await first.page.getByPlaceholder('Поиск в этом чате').fill('Алиса');
    await expect(first.page.getByText('Привет, Алиса! Вижу сообщение').first()).toBeVisible({ timeout: 15_000 });

    // Мобильная раскладка: список ↔ чат.
    await first.page.setViewportSize({ width: 390, height: 844 });
    await first.page.getByRole('button', { name: 'Назад' }).first().click();
    await expect(first.page.getByRole('heading', { name: 'Чаты' })).toBeVisible();

    await first.context.close();
    await second.context.close();
  });

  test('заявка отклоняется командой n, вход невозможен', async ({ browser }) => {
    const user = uniqueUser('alice');
    const { context, page } = await newUserContext(browser);
    await page.goto('/register');
    await page.getByLabel('Отображаемое имя').fill(user.displayName);
    await page.getByLabel('Логин (@username)').fill(user.username);
    await page.getByLabel(/^Пароль/).first().fill(user.password);
    await page.getByLabel('Повторите пароль').fill(user.password);
    await page.getByRole('button', { name: 'Отправить заявку' }).click();
    await expect(page.getByRole('heading', { name: 'Ожидаем подтверждение' })).toBeVisible({ timeout: 15_000 });
    ownerTypes('n');
    await expect(page.getByRole('heading', { name: 'Владелец отклонил запрос' })).toBeVisible({ timeout: 25_000 });

    await page.goto('/login');
    await page.getByLabel('Логин (@username)').fill(user.username);
    await page.getByLabel(/^Пароль/).first().fill(user.password);
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page.getByText('Неверный логин или пароль')).toBeVisible({ timeout: 20_000 });
    await context.close();
  });

  test('настройки: тема, приватность и сессии сохраняются на сервере', async ({ browser }) => {
    const user = uniqueUser('alice');
    const { context, page } = await newUserContext(browser);
    await registerAndApprove(page, user);

    await page.goto('/settings');
    await expect(page.getByRole('button', { name: 'Оформление' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Оформление' }).first().click();
    await page.getByRole('combobox').first().selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.getByRole('button', { name: 'Приватность' }).first().click();
    const lastSeen = page.getByRole('combobox').first();
    await lastSeen.selectOption('nobody');
    await page.waitForTimeout(800);
    await page.reload();
    await page.getByRole('button', { name: 'Приватность' }).first().click();
    await expect(page.getByRole('combobox').first()).toHaveValue('nobody');

    await page.getByRole('button', { name: 'Безопасность' }).first().click();
    await expect(page.getByText('это устройство')).toBeVisible();

    await context.close();
  });
});
