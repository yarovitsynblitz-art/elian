#!/usr/bin/env bash
# Запуск сервера и туннеля в tmux. Идемпотентно: уже запущенное не перезапускается.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
. "$SCRIPT_DIR/lib.sh"
cd "$ROOT_DIR"

have tmux || warn "tmux не найден — использую nohup (для Termux установите tmux: pkg install tmux)"
[[ -f "$ELIAN_ENV_FILE" ]] || die "нет конфигурации: запустите scripts/termux/bootstrap.sh"
[[ -f apps/server/dist/index.js ]] || die "сервер не собран: npm run build"

# Переменные читаем из файла (он не исполняется как shell-скрипт).
# Явно заданные в окружении значения имеют приоритет над файлом.
CALLER_TUNNEL_MODE="${ELIAN_TUNNEL_MODE:-}"
CALLER_PORT="${ELIAN_PORT:-}"
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  export "$key=$value"
done < "$ELIAN_ENV_FILE"
[[ -n "$CALLER_TUNNEL_MODE" ]] && ELIAN_TUNNEL_MODE="$CALLER_TUNNEL_MODE"
[[ -n "$CALLER_PORT" ]] && ELIAN_PORT="$CALLER_PORT"

if server_running; then
  if health_ok; then
    ok "сервер уже работает"
    exit 0
  fi
  warn "процесс есть, но health не отвечает — перезапускаю"
  bash "$SCRIPT_DIR/stop.sh" >/dev/null 2>&1 || true
  sleep 1
fi

mkdir -p "$ELIAN_LOG_DIR"
umask 077

if have tmux; then
  tmux new-session -d -s "$ELIAN_SESSION" -n server \
    "cd '$ROOT_DIR' && set -a && . '$ELIAN_ENV_FILE' && set +a && node apps/server/dist/index.js 2>&1 | tee -a '$ELIAN_LOG_DIR/server.log'"
else
  # exec: PID-файл должен содержать pid самого node, иначе stop.sh убьёт обёртку.
  ( cd "$ROOT_DIR" && set -a && . "$ELIAN_ENV_FILE" && set +a && \
    exec nohup node apps/server/dist/index.js >> "$ELIAN_LOG_DIR/server.log" 2>&1 < /dev/null ) & \
    echo $! > "$SERVER_PID_FILE"
  chmod 600 "$SERVER_PID_FILE"
fi

if ! wait_health 45 1; then
  warn "сервер не ответил за 45 с — последние строки лога:"
  tail -25 "$ELIAN_LOG_DIR/server.log" 2>/dev/null || true
  die "запуск не удался"
fi
ok "сервер слушает 127.0.0.1:${ELIAN_PORT}"

MODE="${ELIAN_TUNNEL_MODE:-quick}"
if [[ "$MODE" != "none" ]]; then
  if have tmux; then
    tmux new-window -t "$ELIAN_SESSION" -n tunnel \
      "bash '$ROOT_DIR/scripts/cloudflare/tunnel.sh' 2>&1 | tee -a '$ELIAN_LOG_DIR/tunnel.log'"
  else
    ( ELIAN_TUNNEL_MODE="$MODE" exec nohup bash "$ROOT_DIR/scripts/cloudflare/tunnel.sh" >> "$ELIAN_LOG_DIR/tunnel.log" 2>&1 < /dev/null ) & \
      echo $! > "$TUNNEL_PID_FILE"
    chmod 600 "$TUNNEL_PID_FILE"
  fi
fi

# Ждём публичный адрес (Quick Tunnel печатает его в лог).
for _ in $(seq 1 40); do
  if [[ -s "$ELIAN_HOME/public-url.txt" ]]; then break; fi
  sleep 1
done
URL="$(cat "$ELIAN_HOME/public-url.txt" 2>/dev/null || true)"
if [[ -n "$URL" ]]; then ok "публичный адрес: $URL"; else warn "адрес ещё не получен: bash scripts/termux/logs.sh tunnel"; fi

if have termux-notification; then
  termux-notification --title "Элиан запущен" --content "${URL:-локальный режим}" --id elian-status >/dev/null 2>&1 || true
fi
