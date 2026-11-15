#!/usr/bin/env bash
# Полная диагностика одной командой: elian diag
# Собирает всё, что нужно, чтобы понять, почему туннель не поднимается,
# и не печатает секретов (токены, пароли, ключи).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

CLOUDFLARED="${ELIAN_BIN_DIR}/cloudflared"
URL="$(cat "$ELIAN_HOME/public-url.txt" 2>/dev/null || true)"
HOST="${URL#https://}"; HOST="${HOST%%/*}"

tcp_probe() { # tcp_probe host port timeout
  timeout "${3:-5}" bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null && echo "открыт" || echo "НЕ открывается"
}

printf '=== Элиан: диагностика %s ===\n\n' "$(date '+%Y-%m-%d %H:%M:%S')"

printf -- '-- окружение --\n'
printf 'node: %s\n' "$(node -v 2>/dev/null || echo нет)"
printf 'cloudflared: %s\n' "$("$CLOUDFLARED" --version 2>&1 | head -1 || echo 'не установлен')"
printf 'режим туннеля: %s\n' "${ELIAN_TUNNEL_MODE:-quick}"
printf 'транспорт (запрошен): %s\n' "${ELIAN_TUNNEL_PROTOCOL:-http2}"
printf 'таймаут регистрации: %s с\n' "${ELIAN_TUNNEL_REG_TIMEOUT:-25}"
printf 'порт сервера: %s\n\n' "$ELIAN_PORT"

printf -- '-- сеть --\n'
printf 'VPN-интерфейсы: '
if ip -o link show 2>/dev/null | grep -qE '\b(tun|ppp|wg)[0-9]*'; then
  ip -o link show 2>/dev/null | awk -F': ' '/tun|ppp|wg/ {print $2}' | tr '\n' ' '
  printf '(VPN включён — он может резать туннель)\n'
else
  printf 'нет\n'
fi
printf 'DNS для %s: %s\n' "${HOST:-—}" "$(getent hosts "$HOST" 2>/dev/null | head -1 | awk '{print $1}' || true)"
printf 'TCP 7844 до edge Cloudflare: %s\n' "$(tcp_probe 198.41.192.1 7844 5)"
printf 'TCP 7844 до второго edge:   %s\n' "$(tcp_probe 198.41.200.1 7844 5)"
printf 'TCP 443 до cloudflare.com:  %s\n\n' "$(tcp_probe 1.1.1.1 443 5)"

printf -- '-- сервер --\n'
printf 'процесс: %s\n' "$([[ -f "$SERVER_PID_FILE" ]] && kill -0 "$(cat "$SERVER_PID_FILE" 2>/dev/null)" 2>/dev/null && echo "запущен ($(cat "$SERVER_PID_FILE"))" || echo 'не запущен')"
printf 'health: %s\n\n' "$(curl -s --max-time 3 "http://127.0.0.1:${ELIAN_PORT}/api/v1/health" 2>/dev/null || echo 'не отвечает')"

printf -- '-- туннель --\n'
printf 'процесс: %s\n' "$(tunnel_running && echo "запущен ($(cat "$TUNNEL_PID_FILE" 2>/dev/null))" || echo 'не запущен')"
printf 'зарегистрирован: %s\n' "$(cat "$ELIAN_HOME/tunnel.registered" 2>/dev/null || echo 'нет подтверждения от Cloudflare')"
printf 'адрес: %s\n' "${URL:-—}"
printf 'статус адреса: %s\n\n' "$(cat "$ELIAN_HOME/public-url.status" 2>/dev/null || echo 'не проверялся')"

LOG="$ELIAN_LOG_DIR/tunnel.log"
if [[ -f "$LOG" ]]; then
  printf -- '-- важные строки лога туннеля (последние) --\n'
  grep -E "Registered tunnel connection|Failed to dial|Initial protocol|Retrying connection|ERR |WRN |Requesting new quick Tunnel|pubличный|публичный адрес|не поднялся|QUIC" "$LOG" 2>/dev/null \
    | tail -20 | cut -c1-200 || true
  printf '\n'
else
  printf -- '-- лог туннеля отсутствует (%s) --\n\n' "$LOG"
fi

printf -- '-- доступность снаружи --\n'
if [[ -n "$URL" ]]; then
  CODE="$(curl -s -o /dev/null -m 12 -w '%{http_code}' "$URL/api/v1/health" 2>/dev/null)" || true
  [[ -z "$CODE" ]] && CODE=000
  printf 'GET %s/api/v1/health → %s\n' "$URL" "$CODE"
else
  printf 'адреса нет\n'
fi
printf '\n=== конец диагностики ===\n'
