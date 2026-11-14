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
        if [[ "$line" =~ https://[a-z0-9-]+\.trycloudflare\.com ]]; then
          local_url="${BASH_REMATCH[0]}"
          printf '%s\n' "$local_url" > "$URL_FILE"
          chmod 600 "$URL_FILE"
          printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M')" "$local_url" >> "$HISTORY_FILE"
          ok "публичный адрес: ${local_url}"
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
    DOMAIN="${ELIAN_DOMAIN:-$(env_get PUBLIC_DOMAIN)}"
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
