# Элиан / Elian — «Общение без лишнего»

Самостоятельный мессенджер, который живёт на вашем Android-телефоне: сервер в Termux,
доступ из интернета через Cloudflare Tunnel, клиент — устанавливаемая PWA.
Это **не Telegram** и не форк Telegram: свой брендинг, свой код, свой сервер.

```
Android + Termux  ──►  Fastify + Socket.IO (127.0.0.1:3000)
                       SQLite (WAL, SQLCipher) + медиа AES-256-GCM
        │
        └──►  cloudflared  ──►  https://<ваш-домен>  (HTTPS/WSS)
                                 └──  React PWA (тот же origin, /api/v1)
```

## Что умеет

- Личные чаты, группы, каналы; роли и права, инвайты, заявки на вступление, баны, slow mode, темы, журнал действий.
- Сообщения: форматирование, ответы, треды, правки с историей, удаление, пересылка, закрепления, реакции, опросы,
  отложенные и «тихие» сообщения, черновики, статусы доставки/прочтения, «печатает…», офлайн-очередь отправки.
- Медиа: фото/видео/аудио/голосовые с волновой формой, файлы, стикеры, геолокация, контакты; шифрование на диске,
  превью, чанковая загрузка с прогрессом.
- Поиск: FTS5 по сообщениям, люди, публичные чаты; фильтры по типам и датам.
- Истории (24 ч), папки чатов, уведомления (Web Push, VAPID), i18n RU/EN, темы light/dark/system, акценты, размеры текста.
- Звонки 1:1 (WebRTC + Socket.IO-сигнализация), групповые — требуют внешнего SFU (см. `docs/LIMITATIONS.md`).
- Владелец сервера подтверждает вход/регистрацию/сброс пароля вручную в консоли Termux — коды никогда не уходят клиенту.

Полная матрица функций с честными статусами: **[`docs/FEATURES.md`](docs/FEATURES.md)**.

## Один шаг до запуска (Termux)

Репозиторий публикуется один раз (см. `docs/PUBLISH.md`), после чего установка — одна строка:

```bash
# прямо из git
cd $HOME && pkg install -y git && git clone --depth 1 https://github.com/yarovitsynblitz-art/elian.git elian-src && bash elian-src/scripts/termux/bootstrap.sh

# или из приложенного к релизу архива (с проверкой контрольной суммы)
cd $HOME && pkg install -y curl tar && curl -fsSLO https://github.com/yarovitsynblitz-art/elian/releases/download/v1.0.0/elian-1.0.0.tar.gz && echo "$(curl -fsSL https://github.com/yarovitsynblitz-art/elian/releases/download/v1.0.0/elian-1.0.0.tar.gz.sha256)  elian-1.0.0.tar.gz" | sha256sum -c - && tar xzf elian-1.0.0.tar.gz && bash elian-1.0.0/scripts/termux/bootstrap.sh
```

> Принципиально: **никаких `curl | bash`** — сначала скачивание и проверка контрольной суммы, потом запуск скрипта.
> Без публикации репозитория можно поставить из уже готового архива: скачайте `elian-1.0.0.tar.gz` из рабочей папки
> на телефон и выполните `cd ~ && tar xzf ~/storage/downloads/elian-1.0.0.tar.gz && bash elian-1.0.0/scripts/termux/bootstrap.sh`.

Bootstrap идемпотентен: повторный запуск не удаляет базу и медиа, перед изменениями делает шифрованный бэкап,
создаёт недостающие секреты, пересобирает клиент и перезапускает сервис. Он печатает публичный HTTPS-адрес,
состояние процессов и команды управления.

Подробно: [`docs/TERMUX.md`](docs/TERMUX.md) · [`docs/CLOUDFLARE.md`](docs/CLOUDFLARE.md) · [`docs/ADMIN.md`](docs/ADMIN.md).

## Управление после установки

```bash
bash scripts/termux/status.sh          # состояние, публичный адрес, размеры БД/медиа
bash scripts/termux/logs.sh server     # логи (без секретов и паролей)
bash scripts/termux/restart.sh
bash scripts/termux/stop.sh
tmux attach -t elian                   # консоль владельца: list / show <код> / y / n
bash scripts/backup/backup.sh          # шифрованный бэкап (БД + медиа + манифест)
bash scripts/backup/restore.sh <архив.elnb>
```

## Разработка

```bash
npm install
npm run build:shared
npm run dev            # сервер (tsx --watch) + vite dev-сервер с прокси
npm test               # vitest: unit + интеграционные (64 теста)
npm run test:e2e       # Playwright, два браузера, настоящий сервер (scripts/e2e/run-e2e.mjs)
npm run lint           # tsc --noEmit по всем пакетам
node scripts/smoke/live-smoke.mjs   # пакет живых проверок production-сборки (39 проверок)
```

Структура:

```
apps/server   Fastify 5 · Socket.IO · SQLite WAL + SQLCipher · Argon2id · Zod · миграции · консоль владельца
apps/web      React 18 · Vite 6 · Tailwind · Zustand · TanStack Query · Dexie · PWA + Web Push
packages/shared  типы, события Socket.IO, брендинг, лимиты, утилиты
scripts/{termux,cloudflare,backup,e2e,smoke}
docs/{TERMUX,CLOUDFLARE,ADMIN,SECURITY,LIMITATIONS,FEATURES,TEST-REPORT}.md
```

## Безопасность — коротко

- Пароли — Argon2id (memory 19 MiB, t=2, p=1), параметры проверяются на старте.
- База — SQLCipher; медиа — AES-256-GCM по чанкам; ключи (`DB_KEY`, `MEDIA_KEY`, `SESSION_PEPPER`) генерируются
  криптостойко и лежат **вне** репозитория и **вне** каталога данных, с правами 600.
- Сессии и approval-секреты хранятся только как хэши; cookie `HttpOnly` + `SameSite=Lax`, CSRF double-submit.
- Коды подтверждения видны только владельцу в консоли Termux (и опционально в `termux-notification`).
- **Нет E2E-шифрования**: сервер видит содержимое сообщений. Это осознанное решение — см. `docs/SECURITY.md`.
- Бэкапы шифруются отдельной парольной фразой; фраза не хранится в архиве.

## Лицензия

MIT (см. `LICENSE`). Использованные сторонние библиотеки — под своими лицензиями; брендинг, иконки и тексты — собственные.
