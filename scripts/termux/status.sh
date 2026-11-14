#!/usr/bin/env bash
# Состояние Элиана: процесс, health, публичный адрес, ресурсы, размер БД. Без секретов.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

printf '%s\n' "── Элиан: состояние ──"
if server_running; then
  if have tmux && tmux has-session -t "$ELIAN_SESSION" 2>/dev/null; then
    ok "процесс: запущен (tmux: $ELIAN_SESSION)"
  else
    ok "процесс: запущен (nohup, pid $(cat "$SERVER_PID_FILE" 2>/dev/null || echo '?'))"
  fi
else
  warn "процесс: не запущен"
fi

if health_ok; then
  HEALTH="$(curl -fsS --max-time 3 "http://127.0.0.1:${ELIAN_PORT}/api/v1/health" || true)"
  ok "health: $HEALTH"
else
  warn "health: не отвечает на 127.0.0.1:${ELIAN_PORT}"
fi

URL="$(cat "$ELIAN_HOME/public-url.txt" 2>/dev/null || true)"
printf '  публичный адрес: %s\n' "${URL:-—}"

if [[ -f "$ELIAN_DATA_DIR/elian.db" ]]; then
  printf '  база: %s (%s)\n' "$ELIAN_DATA_DIR/elian.db" "$(du -h "$ELIAN_DATA_DIR/elian.db" | cut -f1)"
fi
if [[ -d "$ELIAN_DATA_DIR/media" ]]; then
  printf '  медиа: %s\n' "$(du -sh "$ELIAN_DATA_DIR/media" | cut -f1)"
fi
LATEST="$(ls -1t "$ELIAN_BACKUP_DIR"/*.elnb 2>/dev/null | head -1 || true)"
printf '  последний бэкап: %s\n' "${LATEST:-нет}"

if have termux-battery-status; then
  printf '  батарея: %s\n' "$(termux-battery-status 2>/dev/null | tr -d '\n' | head -c 120)"
fi

printf '\nКонсоль владельца: tmux attach -t %s (окно server)\n' "$ELIAN_SESSION"
