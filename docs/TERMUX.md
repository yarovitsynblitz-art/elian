# Элиан на Android в Termux

## 1. Что понадобится

- Android 9+ (лучше 11+), Termux **из F-Droid** (версия из Google Play устарела и не поддерживается).
- Node.js 20+ (пакет `nodejs-lts`), `git`, `tmux`, `curl`, `openssl`.
- 1.5–2 ГБ свободного места: `node_modules` + сборка занимают ~600 МБ, запас нужен для бэкапов.
- Стабильный интернет (Wi-Fi или мобильный) — телефон будет отдавать трафик мессенджера.
- Аккаунт Cloudflare с доменом — только если нужен постоянный адрес (Quick Tunnel работает без аккаунта).

## 2. Установка одной командой

```bash
cd $HOME && pkg install -y curl tar && curl -fsSLO <URL_АРХИВА> && curl -fsSLO <URL_АРХИВА>.sha256 && sha256sum -c <имя_архива>.sha256 && tar xzf <имя_архива> && bash <каталог>/scripts/termux/bootstrap.sh

# рабочий пример (репозиторий проекта):
cd $HOME && pkg install -y curl tar && curl -fsSLO https://github.com/yarovitsynblitz-art/elian/releases/download/v1.0.0/elian-1.0.0.tar.gz && curl -fsSLO https://github.com/yarovitsynblitz-art/elian/releases/download/v1.0.0/elian-1.0.0.tar.gz.sha256 && sha256sum -c elian-1.0.0.tar.gz.sha256 && tar xzf elian-1.0.0.tar.gz && bash elian-1.0.0/scripts/termux/bootstrap.sh
```

Скрипт `scripts/termux/bootstrap.sh` выполняет 9 шагов и **идемпотентен**:

| Шаг | Что делает |
|---|---|
| 1 | Проверяет Termux/Node 20+, ставит недостающие пакеты, включает `termux-wake-lock` |
| 2 | Создаёт `~/.elian/{data,secrets,logs,backups,bin}` с правами `700` |
| 3 | Пишет `~/.elian/elian.env` (600) из `.env.example`, генерирует `db_key`, `media_key`, `session_pepper` |
| 4 | Делает страховочный бэкап (если данные уже есть) и ставит зависимости (`npm ci`, пропускается, если lock не менялся) |
| 5 | Собирает сервер и клиент (`npm run build`) |
| 6 | Генерирует VAPID-ключи для Web Push |
| 7 | Применяет миграции, проверяет, что база **действительно** зашифрована (иначе падает) |
| 8 | Ставит `cloudflared` и настраивает туннель (`quick` или `named`) |
| 9 | Запускает сервер в tmux, поднимает туннель, ждёт health, печатает публичный адрес |

Повторный запуск: ничего не удаляет, конфиг и ключи сохраняет, база и медиа не трогаются, сервис перезапускается.

## 3. Где что лежит

```
~/.elian/elian.env              конфигурация (600)
~/.elian/secrets/db_key.key     ключ SQLCipher (600, вне каталога данных)
~/.elian/secrets/media_key.key  ключ AES-256-GCM для медиа (600)
~/.elian/secrets/session_pepper.key   pepper для хэшей сессий (600)
~/.elian/secrets/vapid-*.key    ключи Web Push (в elian.env)
~/.elian/secrets/backup-passphrase.key  парольная фраза бэкапов (600)
~/.elian/secrets/cloudflare-tunnel.token  токен именованного туннеля (600)
~/.elian/data/elian.db          зашифрованная база (WAL-файлы рядом)
~/.elian/data/media/{files,thumbs}  зашифрованные медиа и превью
~/.elian/logs/{server,tunnel}.log   логи (секреты редактируются)
~/.elian/backups/*.elnb         шифрованные бэкапы
```

Скопируйте `secrets/` и `backups/` на отдельный носитель: **без ключей база не восстанавливается**.

## 4. Telegram-подобные привычки, которых здесь нет

- Нет SMS/email-подтверждений: входы подтверждает владелец в консоли (`tmux attach -t elian`).
- Нет облака: всё на телефоне. Пропал телефон без бэкапа — данных нет.
- Нет E2E: сервер (то есть вы) технически может прочитать сообщения.

## 5. Жизнь на телефоне

- Держите Termux в шторке уведомлений и разрешите «без ограничений» в настройках батареи (Xiaomi/Samsung особенно строгие).
- `termux-wake-lock` включается bootstrap-скриптом; после перезагрузки телефона запустите `bash scripts/termux/start.sh`
  (или добавьте `~/.termux/boot/`-скрипт, если используете плагин Termux:Boot).
- При сворачивании Termux Android может «усыпить» процесс — сервер станет недоступен до возврата. Питание от сети обязательно.
- Мониторьте: `bash scripts/termux/status.sh` (health, размер БД/медиа, последний бэкап, батарея).

## 6. Обновление версии

```bash
cd $HOME/elian-1.0.0 && git pull        # или распакуйте новый архив рядом
npm run build && bash scripts/termux/restart.sh
```
Либо просто повторите bootstrap из нового архива — он сделает бэкап и переиспользует данные/секреты.

## 7. Бэкапы

```bash
bash scripts/backup/backup.sh            # создать + проверить (ротация: 7 последних)
bash scripts/backup/restore.sh <файл.elnb>   # восстановить (сервер будет остановлен)
```
Парольная фраза по умолчанию лежит в `~/.elian/secrets/backup-passphrase.key`. Если хотите защиту от кражи
телефона — перенесите эту фразу на бумагу/менеджер паролей и удалите файл с устройства.

## 8. Диагностика

| Симптом | Что проверить |
|---|---|
| `health` не отвечает | `bash scripts/termux/logs.sh server`, порт занят: `pkill -f dist/index.js` и запуск заново |
| нет публичного адреса | `bash scripts/termux/logs.sh tunnel`; Quick Tunnel может быть недоступен — повторите `restart.sh` |
| «БАЗА НЕ ЗАШИФРОВАНА» | в `elian.env` должен быть `DB_ENCRYPTION=required`, ключ — `~/.elian/secrets/db_key.key` |
| клиент открывается, но API 500 | чаще всего не хватает прав: `chmod 700 ~/.elian ~/.elian/secrets` |
| телефон разряжается | это ожидаемо: сервер + туннель держат сеть. Используйте зарядку |

## Повседневные команды: `elian`

После `bootstrap.sh` в Termux появляется короткая команда (симлинк в `$PREFIX/bin/elian`):

| Команда | Что делает |
|---|---|
| `elian start` | запустить сервер и туннель (если уже работает — ничего не делает) |
| `elian stop` | остановить всё (данные сохраняются) |
| `elian restart` | перезапустить |
| `elian status` | процесс, health, публичный адрес, размер БД, последний бэкап |
| `elian url` | только публичная ссылка |
| `elian logs [server\|tunnel] [N]` | последние N строк лога |
| `elian console` | консоль владельца: `list`, `show <код>`, `y`, `n`, выход `Ctrl-b` затем `d` |
| `elian backup` | зашифрованный бэкап в `~/.elian/backups` |
| `elian update` | `git pull` + пересборка (`bootstrap.sh`) |
| `elian doctor` | диагностика: сборка, диск, секреты, health |

Без команды то же самое: `bash scripts/termux/{start,stop,restart,status,logs}.sh`.

**Телефон перезагрузился** → `elian start`. Чтобы запускалось само, поставьте
[Termux:Boot](https://f-droid.org/packages/com.termux.boot/) и запустите `elian update`
(или `bootstrap.sh`) ещё раз — он положит `~/.termux/boot/elian-autostart.sh`.
