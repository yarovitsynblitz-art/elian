#!/usr/bin/env bash
# elian — короткие команды для повседневного управления Элианом на телефоне.
#   elian start | stop | restart | status | url | qr | logs [server|tunnel] [N] | console | backup | update | doctor | help
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Каталог с кодом: 1) из ~/.elian/repo-path (пишет bootstrap), 2) рядом со скриптом.
ROOT_DIR=""
if [[ -n "${ELIAN_HOME:-}" && -f "$ELIAN_HOME/repo-path" ]]; then
  ROOT_DIR="$(cat "$ELIAN_HOME/repo-path")"
elif [[ -f "$HOME/.elian/repo-path" ]]; then
  ROOT_DIR="$(cat "$HOME/.elian/repo-path")"
fi
if [[ -z "$ROOT_DIR" || ! -d "$ROOT_DIR/scripts/termux" ]]; then
  ROOT_DIR="$(cd "$SELF_DIR/../.." && pwd)"
fi

# shellcheck source=./lib.sh
. "$ROOT_DIR/scripts/termux/lib.sh"


# Запуск CLI владельца в контексте конфигурации Элиана (локально, без HTTP).
owner_cli() {
  local env_file="${ELIAN_ENV_FILE:-$HOME/.elian/elian.env}"
  [[ -f "$env_file" ]] || { echo "нет конфигурации: $env_file" >&2; exit 1; }
  [[ -f "$ROOT_DIR/apps/server/dist/tools/owner-cli.js" ]] || { echo "сервер не собран: elian update" >&2; exit 1; }
  (
    cd "$ROOT_DIR" || exit 1
    set -a; . "$env_file"; set +a
    node apps/server/dist/tools/owner-cli.js "$@"
  )
}

S="$ROOT_DIR/scripts/termux"
CMD="${1:-help}"; shift || true

case "$CMD" in
  start|up)     bash "$S/start.sh" "$@" ;;
  stop|down)    bash "$S/stop.sh" "$@" ;;
  restart)      bash "$S/restart.sh" "$@" ;;
  status|st)    bash "$S/status.sh" "$@" ;;
  logs|log)     bash "$S/logs.sh" "$@" ;;
  url|addr)
    ELIAN_HOME="${ELIAN_HOME:-$HOME/.elian}"
    URL_FILE="$ELIAN_HOME/public-url.txt"
    if [[ -s "$URL_FILE" ]]; then
      cat "$URL_FILE"
      if [[ ! -f "$ELIAN_HOME/tunnel.pid" ]] || ! kill -0 "$(cat "$ELIAN_HOME/tunnel.pid" 2>/dev/null)" 2>/dev/null; then
        echo "(!) процесс туннеля не найден — ссылка может не открываться (Error 1033). Запустите: elian start" >&2
      fi
      if [[ "${ELIAN_TUNNEL_MODE:-quick}" == "quick" ]]; then
        echo "(временный адрес *.trycloudflare.com: меняется после перезапуска и пробуждения телефона; постоянный — bash scripts/cloudflare/setup-named-tunnel.sh)" >&2
      fi
      # На телефоне удобнее сразу вставить ссылку в браузер, а не перепечатывать её.
      if command -v termux-clipboard-set >/dev/null 2>&1; then
        termux-clipboard-set "$(cat "$URL_FILE")" >/dev/null 2>&1 && echo "(ссылка скопирована в буфер обмена)" >&2
      fi
    else
      echo "публичный адрес ещё не определён — запустите: elian start, затем: elian logs tunnel 20" >&2
      exit 1
    fi
    ;;
  open|открыть)
    ELIAN_HOME="${ELIAN_HOME:-$HOME/.elian}"
    URL="$(cat "$ELIAN_HOME/public-url.txt" 2>/dev/null || true)"
    [[ -n "$URL" ]] || { echo "публичный адрес ещё не определён — elian start" >&2; exit 1; }
    echo "$URL"
    if command -v termux-open-url >/dev/null 2>&1; then
      termux-open-url "$URL" >/dev/null 2>&1 && echo "(открыл в браузере)" >&2
    elif command -v xdg-open >/dev/null 2>&1 && xdg-open "$URL" >/dev/null 2>&1; then
      echo "(открыл в браузере)" >&2
    else
      echo "(открыть нечем: pkg install -y termux-tools — или скопируйте ссылку выше)" >&2
    fi
    ;;
  local|локально|local-open|локально-открыть)
    ELIAN_HOME="${ELIAN_HOME:-$HOME/.elian}"
    mkdir -p "$ELIAN_HOME"
    ENV_FILE="${ELIAN_ENV_FILE:-$ELIAN_HOME/elian.env}"
    PORT_NOW="$(sed -n 's/^PORT=//p' "$ENV_FILE" 2>/dev/null | tail -1)"
    PORT_NOW="${PORT_NOW:-3000}"
    LOCAL_URL="http://127.0.0.1:${PORT_NOW}"
    IP="$(lan_ip)"
    printf 'на телефоне (интернет не нужен): %s\n' "$LOCAL_URL"
    if [[ -n "$IP" ]]; then
      if [[ "$(sed -n 's/^HOST=//p' "$ENV_FILE" 2>/dev/null | tail -1)" == "0.0.0.0" ]]; then
        printf 'в домашней сети (другие устройства): http://%s:%s\n' "$IP" "$PORT_NOW"
      else
        printf 'в домашней сети: выключено — включить: elian lan on\n'
      fi
    fi
    if [[ "$CMD" == local-open* || "$CMD" == локально-открыть ]]; then
      if command -v termux-open-url >/dev/null 2>&1; then
        termux-open-url "$LOCAL_URL" >/dev/null 2>&1 && echo "(открыл $LOCAL_URL в браузере)" >&2
      elif command -v termux-open >/dev/null 2>&1; then
        : # нет браузера — останется только напечатанный адрес
      fi
    elif command -v termux-clipboard-set >/dev/null 2>&1; then
      termux-clipboard-set "$LOCAL_URL" >/dev/null 2>&1 && echo "(адрес $LOCAL_URL скопирован в буфер)" >&2
    fi
    ;;
  lan|сеть)
    ELIAN_HOME="${ELIAN_HOME:-$HOME/.elian}"
    mkdir -p "$ELIAN_HOME"
    ENV_FILE="${ELIAN_ENV_FILE:-$ELIAN_HOME/elian.env}"
    ACTION="${1:-status}"
    case "$ACTION" in
      on|вкл)
        sed -i 's/^HOST=.*/HOST=0.0.0.0/' "$ENV_FILE" 2>/dev/null || printf 'HOST=0.0.0.0\n' >> "$ENV_FILE"
        grep -q '^HOST=' "$ENV_FILE" || printf 'HOST=0.0.0.0\n' >> "$ENV_FILE"
        echo "доступ из домашней сети включён. Перезапускаю…"
        bash "$S/restart.sh" >/dev/null 2>&1 || true
        IP="$(lan_ip)"; PORT_NOW="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -1)"
        echo "открывайте с других устройств: http://${IP:-<ip-телефона>}:${PORT_NOW:-3000}"
        echo "важно: это доступ без интернета, но и без туннеля — только внутри вашей Wi-Fi. Вход по паролю обязателен."
        ;;
      off|выкл)
        sed -i 's/^HOST=.*/HOST=127.0.0.1/' "$ENV_FILE" 2>/dev/null || true
        echo "доступ из домашней сети выключен (только сам телефон). Перезапускаю…"
        bash "$S/restart.sh" >/dev/null 2>&1 || true
        ;;
      *)
        if [[ "$(sed -n 's/^HOST=//p' "$ENV_FILE" 2>/dev/null | tail -1)" == "0.0.0.0" ]]; then
          echo "доступ из домашней сети: включён ($(lan_ip):$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -1))"
        else
          echo "доступ из домашней сети: выключен (включить: elian lan on)"
        fi
        ;;
    esac
    ;;
  qr|код)
    ELIAN_HOME="${ELIAN_HOME:-$HOME/.elian}"
    URL="$(cat "$ELIAN_HOME/public-url.txt" 2>/dev/null || true)"
    [[ -n "$URL" ]] || { echo "публичный адрес ещё не определён — elian start" >&2; exit 1; }
    if have qrencode 2>/dev/null || command -v qrencode >/dev/null 2>&1; then
      printf '%s' "$URL" | qrencode -t ANSIUTF8 -m 2
      printf '\n%s\n' "$URL"
    else
      printf '%s\n\n' "$URL"
      echo "QR-код: pkg install -y qrencode && elian qr" >&2
    fi
    ;;
  tunnel|туннель|check-tunnel)
    bash "$ROOT_DIR/scripts/cloudflare/check-tunnel.sh" "$@"
    ;;
  console|owner)
    if command -v tmux >/dev/null 2>&1; then
      echo "tmux: list | show <код> | y | n | stats | help · выход: Ctrl-b, затем d"
      sleep 1
      exec tmux attach -t elian
    else
      echo "tmux не установлен: pkg install tmux" >&2
      exit 1
    fi
    ;;
  # ── подтверждение входов/регистраций без tmux ──
  pending|queue|list)
    owner_cli list
    ;;
  approve|a|yes|y)
    owner_cli y "${1:-}"
    ;;
  deny|reject|n|no)
    owner_cli n "${1:-}"
    ;;
  show)
    owner_cli show "${1:-}"
    ;;
  backup)       bash "$ROOT_DIR/scripts/backup/backup.sh" "$@" ;;
  restore)      bash "$ROOT_DIR/scripts/backup/restore.sh" "$@" ;;
  update)
    cd "$ROOT_DIR"
    # Клон ставится с --depth 1, поэтому обычный pull иногда не может свести истории:
    # тянем последний main и сбрасываем рабочую копию на него.
    git fetch --depth 1 origin main && git reset --hard origin/main || git pull --ff-only
    bash "$S/bootstrap.sh"
    ;;
  doctor)
    bash "$S/status.sh"
    echo
    echo "── проверки ──"
    printf 'каталог кода: %s\n' "$ROOT_DIR"
    printf 'node: %s\n' "$(node -v 2>/dev/null || echo 'нет')"
    printf 'сборка сервера: %s\n' "$([[ -f "$ROOT_DIR/apps/server/dist/index.js" ]] && echo есть || echo НЕТ)"
    printf 'свободно на диске: %s\n' "$(df -h "$HOME" | awk 'NR==2 {print $4}')"
    printf 'секреты: %s\n' "$(ls "$HOME/.elian/secrets" 2>/dev/null | wc -l) файлов"
    ;;
  uninstall)
    cat <<'EOT'
Удаление (данные и переписка будут потеряны):
  bash scripts/termux/stop.sh
  rm -rf ~/.elian ~/elian-src
  rm -f "$PREFIX/bin/elian"
Сначала сделайте бэкап: elian backup
EOT
    ;;
  help|--help|-h|*)
    cat <<'EOT'
Элиан — управление сервером на телефоне

  elian start          запустить сервер и туннель
  elian stop           остановить
  elian restart        перезапустить
  elian status         состояние, публичный адрес, ресурсы
  elian url            публичная ссылка (и копирует её в буфер обмена на телефоне)
  elian open           открыть публичную ссылку в браузере телефона
  elian local          адрес на самом телефоне — работает без интернета и без туннеля
  elian local-open     открыть этот адрес в браузере телефона
  elian lan on|off     доступ с других устройств в домашней Wi-Fi (без интернета)
  elian tunnel [--live] диагностика туннеля: токен, домен, DNS, подключение (--live — поднять на 25 с)
  elian qr             QR-код со ссылкой (pkg install qrencode) — показать другу с телефона
  elian logs [server|tunnel] [N]   последние N строк лога (по умолчанию 80)
  elian console        консоль владельца (подтверждение входов: y / n)
  elian pending        кто ждёт подтверждения (код, логин, тип)
  elian approve [код]  подтвердить регистрацию/вход (без кода — единственный запрос)
  elian deny [код]     отклонить запрос
  elian backup         зашифрованный бэкап в ~/.elian/backups
  elian update         git pull + пересборка (bootstrap)
  elian doctor         диагностика: процесс, сборка, диск, секреты
EOT
    ;;
esac
