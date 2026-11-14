#!/usr/bin/env bash
# Элиан / Elian — установка и запуск на Android в Termux.
#
# Идемпотентно: повторный запуск не удаляет базу и медиа, перед изменениями делает бэкап.
# Секреты (ключ БД, ключ медиа, pepper сессий, VAPID, токен туннеля) не печатаются в консоль.
#
# Использование (внутри распакованного проекта):
#   bash scripts/termux/bootstrap.sh
# Переменные:
#   ELIAN_TUNNEL_MODE=quick|named|none   (по умолчанию quick)
#   ELIAN_DOMAIN=example.com             (для named-туннеля)
#   ELIAN_PORT=3000                      (локальный порт, только 127.0.0.1)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=scripts/termux/lib.sh
. "$SCRIPT_DIR/lib.sh"

[[ -f "$ROOT_DIR/package.json" ]] || die "не найден package.json — запустите скрипт из каталога проекта"
cd "$ROOT_DIR"

step "1/9 Проверка окружения"
# Самовосстановление прав: при распаковке архива или переносе с Windows/Android бит x может потеряться.
find "$ROOT_DIR/scripts" -name "*.sh" -type f -exec chmod +x {} + 2>/dev/null || true
if is_termux; then
  log "Termux обнаружен ($(uname -m))"
  for pkg in nodejs-lts git tmux curl openssl tar clang make python; do
    if ! have "${pkg%%-*}" && [[ "$pkg" == nodejs-lts ]] && ! have node; then
      require_termux_pkg "$pkg"
    elif ! have "$pkg"; then
      require_termux_pkg "$pkg"
    fi
  done
  # clang/make/python нужны для сборки better-sqlite3-multiple-ciphers (SQLCipher).
  for bin in clang make python3; do
    have "$bin" || warn "не найден $bin — сборка нативного модуля БД может не удаться"
  done
  have termux-wake-lock && termux-wake-lock 2>/dev/null || true
else
  log "не Termux — проверяю только базовые команды (режим разработки)"
fi

for bin in node npm git curl; do
  have "$bin" || die "не найдено: $bin"
done
if ! have tmux; then
  if is_termux; then die "не удалось установить tmux (pkg install tmux)"; fi
  warn "tmux отсутствует — сервер будет запущен через nohup (годится для отладки, не для телефона)"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 20 )) || die "нужен Node.js 20+ (сейчас $(node -v))"
log "Node.js $(node -v), npm $(npm -v)"

step "2/9 Каталоги и права"
FIRST_RUN=0
[[ -f "$ELIAN_ENV_FILE" ]] || FIRST_RUN=1
ensure_layout
chmod 600 "$ELIAN_ENV_FILE" 2>/dev/null || true
log "данные: $ELIAN_DATA_DIR · секреты: $ELIAN_SECRETS_DIR (права 700)"

step "3/9 Конфигурация и секреты"
if (( FIRST_RUN )); then
  log "создаю $ELIAN_ENV_FILE"
  cp "$ROOT_DIR/.env.example" "$ELIAN_ENV_FILE"
  chmod 600 "$ELIAN_ENV_FILE"
  env_set NODE_ENV production
  env_set HOST 127.0.0.1
  env_set PORT "$ELIAN_PORT"
  env_set DATA_DIR "$ELIAN_DATA_DIR"
  env_set MEDIA_DIR "$ELIAN_DATA_DIR/media"
  env_set SECRETS_DIR "$ELIAN_SECRETS_DIR"
  env_set LOG_DIR "$ELIAN_LOG_DIR"
  env_set BACKUP_DIR "$ELIAN_BACKUP_DIR"
  env_set WEB_DIST_DIR "$ROOT_DIR/apps/web/dist"
  env_set DB_ENCRYPTION required
  env_set PUBLIC_DOMAIN "$ELIAN_DOMAIN"
  env_set PUBLIC_URL "https://$ELIAN_DOMAIN"
  env_set OWNER_CONSOLE true
  env_set ELIAN_TUNNEL_MODE "$ELIAN_TUNNEL_MODE"
  env_set TERMUX_NOTIFICATIONS true
else
  log "конфигурация уже есть — сохраняю как есть ($ELIAN_ENV_FILE)"
  env_set PORT "$ELIAN_PORT"
fi

# Ключи: создаются один раз, лежат вне каталога данных и вне репозитория.
for key in db_key media_key session_pepper; do
  if [[ ! -s "$ELIAN_SECRETS_DIR/$key.key" ]]; then
    ( umask 077; gen_secret > "$ELIAN_SECRETS_DIR/$key.key" )
    log "сгенерирован секрет: $key (значение не показывается)"
  fi
  chmod 600 "$ELIAN_SECRETS_DIR/$key.key"
done

# VAPID для Web Push (генерируется Node-скриптом, если web-push доступен после установки).
step "4/9 Зависимости"
if (( FIRST_RUN == 0 )) && [[ -f "$ELIAN_DATA_DIR/elian.db" ]]; then
  log "данные уже есть — делаю страховочный бэкап перед установкой зависимостей"
  ELIAN_PREFIX="$ELIAN_HOME" ELIAN_ENV_FILE="$ELIAN_ENV_FILE" bash "$ROOT_DIR/scripts/backup/backup.sh" >/dev/null 2>&1 \
    || warn "бэкап не удался (продолжаю: вероятно, первый запуск)"
fi

export npm_config_update_notifier=false
DEPS_HASH_FILE="$ELIAN_HOME/.deps-hash"
LOCK_HASH="$( (sha256sum package-lock.json 2>/dev/null || sha256sum package.json) | cut -d' ' -f1 )"
if [[ -d node_modules ]] && [[ -f "$DEPS_HASH_FILE" ]] && [[ "$(cat "$DEPS_HASH_FILE")" == "$LOCK_HASH" ]]; then
  log "зависимости уже установлены под этот lock-файл — пропускаю npm ci"
else
  # node-gyp на Termux не должен тянуть заголовки Node из интернета: они лежат в $PREFIX/include/node.
  if [[ -z "${npm_config_nodedir:-}" ]] && [[ -n "${PREFIX:-}" ]] && [[ -d "$PREFIX/include/node" ]]; then
    export npm_config_nodedir="$PREFIX"
    log "node-gyp: локальные заголовки Node ($PREFIX/include/node)"
  fi

  deps_install() {
    if [[ -f package-lock.json ]]; then
      npm_config_update_notifier=false npm ci --no-audit --no-fund >"$ELIAN_LOG_DIR/deps.log" 2>&1
    else
      npm_config_update_notifier=false npm install --no-audit --no-fund >"$ELIAN_LOG_DIR/deps.log" 2>&1
    fi
  }
  log "npm ci (по lock-файлу, лог: $ELIAN_LOG_DIR/deps.log)"
  if ! deps_install; then
    warn "установка зависимостей не удалась — повторяю через 3 секунды"
    sleep 3
    if ! deps_install; then
      tail -25 "$ELIAN_LOG_DIR/deps.log" >&2 || true
      die "не удалось установить зависимости. На Termux: pkg install -y python make clang nodejs-lts, затем повторите bootstrap"
    fi
  fi
  log "зависимости установлены"
  printf '%s\n' "$LOCK_HASH" > "$DEPS_HASH_FILE"
  chmod 600 "$DEPS_HASH_FILE"
fi

step "5/9 Сборка"
npm run build 2>&1 | tail -8
[[ -f apps/server/dist/index.js ]] || die "сборка сервера не дала dist/index.js"
[[ -f apps/web/dist/index.html ]] || die "сборка клиента не дала dist/index.html"

step "6/9 Ключи VAPID (push-уведомления)"
if [[ -z "$(env_get VAPID_PUBLIC_KEY)" ]]; then
  VAPID_JSON="$(node -e '
    const webpush = require("web-push");
    const keys = webpush.generateVAPIDKeys();
    process.stdout.write(JSON.stringify(keys));
  ' 2>/dev/null || true)"
  if [[ -n "$VAPID_JSON" ]]; then
    VAPID_PUBLIC="$(printf '%s' "$VAPID_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).publicKey))')"
    VAPID_PRIVATE="$(printf '%s' "$VAPID_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).privateKey))')"
    env_set VAPID_PUBLIC_KEY "$VAPID_PUBLIC"
    env_set VAPID_PRIVATE_KEY "$VAPID_PRIVATE"
    ok "VAPID-ключи созданы (значения не выводятся)"
  else
    warn "web-push недоступен — Web Push будет выключен (это не ошибка установки)"
  fi
else
  log "VAPID-ключи уже есть"
fi

step "7/9 База данных и миграции (шифрование обязательно)"
CALLER_TUNNEL_MODE="$ELIAN_TUNNEL_MODE"
set -a; # shellcheck disable=SC1090
. "$ELIAN_ENV_FILE"; set +a
# Явно заданный при запуске режим туннеля важнее значения из файла.
ELIAN_TUNNEL_MODE="$CALLER_TUNNEL_MODE"
node apps/server/dist/tools/migrate.js || die "миграции не применились"
DB_HEAD="$(head -c 16 "$ELIAN_DATA_DIR/elian.db" 2>/dev/null | tr -d '\0' || true)"
if printf '%s' "$DB_HEAD" | grep -q "SQLite format 3"; then
  die "БАЗА НЕ ЗАШИФРОВАНА — остановка. Проверьте DB_ENCRYPTION и ключ DB_KEY."
fi
ok "база на месте и зашифрована"

step "8/9 Cloudflare Tunnel"
bash "$SCRIPT_DIR/../cloudflare/install-cloudflared.sh" || die "не удалось установить cloudflared"
case "$ELIAN_TUNNEL_MODE" in
  none)
    warn "туннель отключён (ELIAN_TUNNEL_MODE=none) — сервер будет доступен только локально"
    ;;
  named)
    bash "$SCRIPT_DIR/../cloudflare/setup-named-tunnel.sh" || die "не удалось настроить именованный туннель"
    ;;
  quick|*)
    log "будет использован Quick Tunnel (временный адрес *.trycloudflare.com)"
    ;;
esac

step "9/9 Запуск сервера и туннеля"
bash "$SCRIPT_DIR/start.sh"

PUBLIC_URL="$(cat "$ELIAN_HOME/public-url.txt" 2>/dev/null || true)"
if [[ -n "$PUBLIC_URL" ]]; then
  env_set PUBLIC_URL "$PUBLIC_URL"
  ok "Публичный адрес: $PUBLIC_URL"
else
  warn "публичный адрес пока не получен — смотрите: bash scripts/termux/logs.sh tunnel"
fi

cat <<SUMMARY_DONE

$(printf '%s' "$C_B")Элиан установлен и запущен$(printf '%s' "$C_RESET")

  Публичный адрес:   ${PUBLIC_URL:-см. bash scripts/termux/logs.sh tunnel}
  Данные и медиа:    $ELIAN_DATA_DIR   (шифрование: SQLCipher + AES-256-GCM для файлов)
  Секреты:           $ELIAN_SECRETS_DIR (права 600, вне каталога данных)
  Логи:              $ELIAN_LOG_DIR
  Бэкапы:            $ELIAN_BACKUP_DIR

  Консоль владельца (подтверждение входов и регистраций) — в окне "server":
      tmux attach -t $ELIAN_SESSION        # выход из консоли: Ctrl-b затем d
  Команды консоли: list · show <код> · y [код] · n [код]

  Управление:
      bash scripts/termux/status.sh        # состояние
      bash scripts/termux/logs.sh [server|tunnel]
      bash scripts/termux/restart.sh
      bash scripts/termux/stop.sh
      bash scripts/backup/backup.sh        # шифрованный бэкап

  Важно: телефон должен быть подключён к сети и не «усыпляться». Termux держите
  в уведомлениях (wake-lock). Подробности: docs/TERMUX.md, docs/CLOUDFLARE.md.
SUMMARY_DONE
