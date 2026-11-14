#!/usr/bin/env bash
# Остановка сервера и туннеля (данные не удаляются).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

if server_running; then
  if have tmux && tmux has-session -t "$ELIAN_SESSION" 2>/dev/null; then
    tmux send-keys -t "$ELIAN_SESSION:server" C-c 2>/dev/null || true
    sleep 2
    tmux kill-session -t "$ELIAN_SESSION" 2>/dev/null || true
  else
    kill "$(cat "$SERVER_PID_FILE")" 2>/dev/null || true
    sleep 1
    # Страховка: если обёртка/дочерний процесс остался — добиваем по признаку.
    pkill -f "apps/server/dist/index.js" 2>/dev/null || true
    rm -f "$SERVER_PID_FILE"
  fi
fi
if tunnel_running; then
  kill "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null || true
  rm -f "$TUNNEL_PID_FILE"
fi
pkill -f "cloudflared tunnel" 2>/dev/null || true
rm -f "$ELIAN_HOME/public-url.txt"
ok "остановлено. Данные и медиа сохранены в $ELIAN_DATA_DIR"
