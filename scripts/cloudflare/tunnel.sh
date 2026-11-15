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
# Транспорт до Cloudflare. QUIC ходит по UDP 7844, и мобильные операторы/VPN его часто
# режут — тогда в логе «failed to dial to edge with quic», а браузер показывает 1033.
# HTTP/2 идёт по TCP и работает почти всегда; при желании можно вернуть quic:
#   ELIAN_TUNNEL_PROTOCOL=quic  (в ~/.elian/elian.env)
PROTOCOL="${ELIAN_TUNNEL_PROTOCOL:-http2}"
mkdir -p "$ELIAN_LOG_DIR"
URL_FILE="$ELIAN_HOME/public-url.txt"
STATUS_FILE="$ELIAN_HOME/public-url.status"
PIDFILE="$ELIAN_HOME/tunnel.pid"

# Один туннель на установку. Иначе после нескольких restart'ов параллельно живут
# несколько cloudflared, каждый получает свой адрес и перетирает public-url.txt —
# открываешь ссылку, а Cloudflare отвечает 1033, потому что её коннектор уже мёртв.
if [[ -f "$PIDFILE" ]]; then
  OTHER_PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  PID_AGE=$(( $(date +%s) - $(stat -c %Y "$PIDFILE" 2>/dev/null || date +%s) ))
  # Свежий pid-файл + живой процесс именно этого скрипта (а не переиспользованный pid).
  if [[ -n "$OTHER_PID" && "$OTHER_PID" != "$$" ]] && (( PID_AGE < 21600 )) \
     && kill -0 "$OTHER_PID" 2>/dev/null \
     && ps -p "$OTHER_PID" -o args= 2>/dev/null | grep -q "cloudflare/tunnel.sh"; then
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
    MARK_FILE="$ELIAN_HOME/tunnel.registered"
    # Сколько ждём регистрации коннектора, прежде чем сменить транспорт.
    REG_TIMEOUT="${ELIAN_TUNNEL_REG_TIMEOUT:-25}"
    backoff=5
    PROTO_FAILS=0
    while true; do
      # Файл с прошлым адресом не стираем: пока Cloudflare выдаёт новый, лучше
      # показывать «последний известный», чем пустоту.
      log "запускаю Quick Tunnel → http://127.0.0.1:${ELIAN_PORT} (протокол ${PROTOCOL})"
      rm -f "$MARK_FILE"
      # set +e: падение cloudflared — штатная ситуация для супервизора, а не конец скрипта.
      set +e
      "$CLOUDFLARED" tunnel --no-autoupdate --protocol "$PROTOCOL" --url "http://127.0.0.1:${ELIAN_PORT}" 2>&1 | while IFS= read -r line; do
        printf '%s\n' "$line"
        # Подтверждение, что коннектор реально встал на edge Cloudflare.
        if [[ "$line" == *"Registered tunnel connection"* ]]; then
          printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$PROTOCOL" > "$MARK_FILE"
        fi
        # Диагностика транспорта: такие ошибки объясняют 1033 лучше любых догадок.
        if [[ "$line" == *"Failed to dial"* ]]; then
          warn "не удалось подключиться по ${PROTOCOL}: $(printf '%s' "$line" | sed 's/.*error=//' | cut -c1-90)"
        fi
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
      done &
      PIPE_PID=$!

      # Ждём регистрации коннектора. Если сеть режет выбранный транспорт,
      # через REG_TIMEOUT секунд переключаемся на другой и пробуем снова.
      registered=0
      for _ in $(seq 1 "$REG_TIMEOUT"); do
        if [[ -f "$MARK_FILE" ]]; then registered=1; break; fi
        kill -0 "$PIPE_PID" 2>/dev/null || break
        sleep 1
      done

      if (( registered == 1 )); then
        PROTO_FAILS=0
        # Всё хорошо: ждём, пока туннель живёт. Упадёт — супервизор перезапустит.
        wait "$PIPE_PID" 2>/dev/null
        status=$?
        set -e
        warn "туннель завершился (код $status) — перезапуск через ${backoff} с"
      else
        # Регистрации нет: значит этот транспорт не проходит через сеть.
        warn "по ${PROTOCOL} коннектор не поднялся за ${REG_TIMEOUT} с — пробую другой транспорт"
        pkill -f "cloudflared tunnel" 2>/dev/null || true
        kill "$PIPE_PID" 2>/dev/null || true
        for _ in 1 2 3 4 5 6; do
          kill -0 "$PIPE_PID" 2>/dev/null || break
          sleep 0.5
        done
        kill -9 "$PIPE_PID" 2>/dev/null || true
        set -e
        PROTO_FAILS=$(( PROTO_FAILS + 1 ))
        if (( PROTO_FAILS == 2 )); then
          warn "=================================================================="
          warn "Сеть не пропускает туннель ни по http2 (TCP), ни по quic (UDP 7844)."
          warn "Обычно это VPN или мобильный оператор. Что сделать:"
          warn "  1) выключить VPN и подождать минуту;"
          warn "  2) попробовать другую сеть (Wi-Fi вместо мобильной и наоборот);"
          warn "  3) прислать мне вывод: elian diag"
          warn "Пока туннель не поднялся, мессенджер доступен локально: elian local-open"
          notify "Элиан: туннель не проходит через сеть" "Проверьте VPN или сеть. Локально всё работает: elian local-open"
          warn "=================================================================="
        elif (( PROTO_FAILS % 6 == 0 )); then
          warn "туннель всё ещё не проходит через сеть (попыток: ${PROTO_FAILS}) — elian diag"
        fi
        if [[ "$PROTOCOL" == "http2" ]]; then PROTOCOL="quic"; else PROTOCOL="http2"; fi
        rm -f "$URL_FILE"
        backoff=5
        sleep 5
        continue
      fi

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
    "$CLOUDFLARED" tunnel --no-autoupdate --protocol "$PROTOCOL" run 2>&1 | while IFS= read -r line; do
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
