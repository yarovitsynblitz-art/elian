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
if have tmux; then
  tmux kill-window -t "$ELIAN_SESSION:tunnel" 2>/dev/null || true
fi
if tunnel_running; then
  kill "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null || true
  rm -f "$TUNNEL_PID_FILE"
fi
# Страховка от накопившихся экземпляров: супервизор, cloudflared и «хвост» tee.
pkill -f "scripts/cloudflare/tunnel.sh" 2>/dev/null || true
pkill -f "cloudflared tunnel" 2>/dev/null || true
pkill -f "cloudflared --no-autoupdate" 2>/dev/null || true
sleep 1
pkill -9 -f "cloudflared tunnel" 2>/dev/null || true
rm -f "$ELIAN_HOME/public-url.txt" "$ELIAN_HOME/public-url.status" "$ELIAN_HOME/tunnel.pid"
ok "остановлено. Данные и медиа сохранены в $ELIAN_DATA_DIR"
