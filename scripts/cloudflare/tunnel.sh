#!/usr/bin/env bash
# Туннель Cloudflare: Quick (временный *.trycloudflare.com) или именованный (свой домен).
#
# Токен именованного туннеля НИКОГДА не передаётся аргументом и не печатается:
# он читается из файла 600 и экспортируется как TUNNEL_TOKEN (cloudflared читает его сам).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/../termux/lib.sh"

CLOUDFLARED="${ELIAN_BIN_DIR}/cloudflared"
[[ -x "$CLOUDFLARED" ]] || die "cloudflared не установлен: bash scripts/cloudflare/install-cloudflared.sh"

MODE="${ELIAN_TUNNEL_MODE:-quick}"
mkdir -p "$ELIAN_LOG_DIR"
URL_FILE="$ELIAN_HOME/public-url.txt"
STATUS_FILE="$ELIAN_HOME/public-url.status"
PIDFILE="$ELIAN_HOME/tunnel.pid"

# Один туннель на установку. Иначе после нескольких restart'ов параллельно живут
# несколько cloudflared, каждый получает свой адрес и перетирает public-url.txt —
# открываешь ссылку, а Cloudflare отвечает 1033, потому что её коннектор уже мёртв.
if [[ -f "$PIDFILE" ]]; then
  OTHER_PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "$OTHER_PID" && "$OTHER_PID" != "$$" ]] && kill -0 "$OTHER_PID" 2>/dev/null \
     && ps -p "$OTHER_PID" -o args= 2>/dev/null | grep -q "tunnel.sh"; then
    warn "туннель уже запущен (pid $OTHER_PID) — второй экземпляр не нужен"
    exit 0
  fi
fi
printf '%s\n' "$$" > "$PIDFILE"
trap '[[ "$(cat "$PIDFILE" 2>/dev/null || true)" == "$$" ]] && rm -f "$PIDFILE"' EXIT

# Проверяем, что адрес реально открывается через Cloudflare: свежий Quick Tunnel
# иногда существует в логе, но ещё не резолвится — тогда честно помечаем это.
self_check() {
  local url="$1" attempt code=""
  for attempt in 1 2 3 4 5; do
    code="$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$url/api/v1/health" 2>/dev/null || echo 000)"
    if [[ "$code" == "200" ]]; then
      printf 'ok %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" > "$STATUS_FILE"
      return 0
    fi
    sleep 6
  done
  printf 'unreachable %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${code:-000}" > "$STATUS_FILE"
  warn "адрес $url пока не открывается снаружи (код ${code:-000}) — Cloudflare ещё не подхватил туннель"
}

case "$MODE" in
  quick)
    # Временный адрес *.trycloudflare.com живёт только пока живёт процесс cloudflared:
    # после перезапуска, пробуждения телефона или сбоя сети Cloudflare отдаёт
    # «Error 1033» на старую ссылку. Поэтому держим туннель под супервизором:
    # он поднимается сам, а новый адрес сразу пишется в файл, историю и уведомление.
    PREV_URL="$(cat "$URL_FILE" 2>/dev/null || true)"
    HISTORY_FILE="$ELIAN_HOME/public-url.history"
    backoff=5
    while true; do
      rm -f "$URL_FILE"
      log "запускаю Quick Tunnel → http://127.0.0.1:${ELIAN_PORT}"
      # --url печатает адрес в stderr; вытаскиваем его в файл, лог и уведомление.
      # set +e: падение cloudflared — штатная ситуация для супервизора, а не конец скрипта.
      set +e
      "$CLOUDFLARED" tunnel --no-autoupdate --url "http://127.0.0.1:${ELIAN_PORT}" 2>&1 | while IFS= read -r line; do
        printf '%s\n' "$line"
        # В логах cloudflared бывают служебные хосты (api.trycloudflare.com и т.п.) —
        # адресом туннеля считаем только настоящий, вида a-b-c.trycloudflare.com.
        if [[ "$line" =~ https://[a-z0-9-]+\.trycloudflare\.com ]] && valid_public_url "${BASH_REMATCH[0]}"; then
          local_url="${BASH_REMATCH[0]}"
          printf '%s\n' "$local_url" > "$URL_FILE"
          chmod 600 "$URL_FILE"
          printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M')" "$local_url" >> "$HISTORY_FILE"
          ok "публичный адрес: ${local_url}"
          rm -f "$STATUS_FILE"
          ( self_check "$local_url" ) >/dev/null 2>&1 &
          if [[ -n "$PREV_URL" && "$local_url" != "$PREV_URL" ]]; then
            warn "ВНИМАНИЕ: адрес изменился. Старая ссылка (${PREV_URL}) больше не работает — на телефоне будет «Error 1033»."
            warn "Новая ссылка: ${local_url} — обновите закладку / ярлык на экране «Домой»."
            notify "Элиан: адрес изменился" "$local_url"
          fi
        fi
      done
      status=${PIPESTATUS[0]:-0}
      set -e
      warn "туннель завершился (код $status) — перезапуск через ${backoff} с"
      sleep "$backoff"
      PREV_URL="$(cat "$URL_FILE" 2>/dev/null || printf '%s' "$PREV_URL")"
      # Постепенно увеличиваем паузу, чтобы не долбить Cloudflare при сбоях сети.
      if (( backoff < 60 )); then backoff=$(( backoff * 2 )); fi
    done
    ;;
  named)
    TOKEN_FILE="$ELIAN_TUNNEL_TOKEN_FILE"
    [[ -s "$TOKEN_FILE" ]] || die "нет токена туннеля ($TOKEN_FILE). Запустите: bash scripts/cloudflare/setup-named-tunnel.sh"
    DOMAIN="$(resolve_domain)"
    export TUNNEL_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
    log "запускаю именованный туннель для домена $DOMAIN (токен из файла, не из argv)"
    "$CLOUDFLARED" tunnel --no-autoupdate run 2>&1 | while IFS= read -r line; do
      printf '%s\n' "$line"
      if [[ "$line" == *"Registered tunnel connection"* ]]; then
        if [[ -n "$DOMAIN" && "$DOMAIN" != "PUBLIC_DOMAIN" ]]; then
          printf 'https://%s\n' "$DOMAIN" > "$URL_FILE"; chmod 600 "$URL_FILE"
        fi
      fi
    done
    ;;
  none)
    log "туннель отключён"
    ;;
  *)
    die "неизвестный ELIAN_TUNNEL_MODE=$MODE (quick|named|none)"
    ;;
esac
