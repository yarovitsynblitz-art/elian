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
    rm -f "$URL_FILE"
    log "запускаю Quick Tunnel → http://127.0.0.1:${ELIAN_PORT}"
    # --url печатает адрес в stderr; вытаскиваем его в файл и в лог.
    "$CLOUDFLARED" tunnel --no-autoupdate --url "http://127.0.0.1:${ELIAN_PORT}" 2>&1 | while IFS= read -r line; do
      printf '%s\n' "$line"
      if [[ "$line" =~ https://[a-z0-9-]+\.trycloudflare\.com ]]; then
        printf '%s\n' "${BASH_REMATCH[0]}" > "$URL_FILE"
        chmod 600 "$URL_FILE"
        ok "публичный адрес: ${BASH_REMATCH[0]}"
      fi
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
