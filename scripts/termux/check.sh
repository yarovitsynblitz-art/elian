#!/usr/bin/env bash
# Проверка «а оно вообще работает?» — от локального сервера до внешней ссылки.
#
#   elian check
#
# Печатает понятный вердикт вместо догадок: сервер жив, туннель подключён,
# ссылка открывается снаружи. Если что-то не так — говорит, что именно.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

PROBLEMS=0
problem() { warn "$*"; PROBLEMS=$((PROBLEMS + 1)); }

URL="$(cat "$ELIAN_HOME/public-url.txt" 2>/dev/null || true)"
HOST="${URL#https://}"; HOST="${HOST%%/*}"

step "1. Сервер на телефоне"
if health_ok; then
  ok "http://127.0.0.1:${ELIAN_PORT}/api/v1/health отвечает"
else
  problem "сервер не отвечает локально — без этого не заработает и снаружи. Запустите: elian start"
fi

step "2. Процесс туннеля"
if tunnel_running; then
  ok "туннель запущен (pid $(cat "$TUNNEL_PID_FILE" 2>/dev/null))"
else
  problem "процесс туннеля не запущен. Запустите: elian start"
fi
printf '  транспорт: %s (QUIC/UDP 7844 в мобильных сетях часто заблокирован)\n' "${ELIAN_TUNNEL_PROTOCOL:-http2}"

step "3. Подключение к Cloudflare (по логу)"
LOG="$ELIAN_LOG_DIR/tunnel.log"
if [[ -f "$LOG" ]]; then
  RECENT="$(tail -80 "$LOG" 2>/dev/null || true)"
  MARK="$ELIAN_HOME/tunnel.registered"
  if [[ -s "$MARK" ]]; then
    ok "коннектор подключён: $(cut -d' ' -f2- "$MARK") (зарегистрирован $(cut -d' ' -f1 "$MARK"))"
  elif grep -q "Registered tunnel connection" <<<"$RECENT"; then
    PROTO_LINE="$(grep -o "protocol=[a-z0-9]*" <<<"$RECENT" | tail -1)"
    ok "коннектор подключён (${PROTO_LINE:-protocol=?})"
  elif grep -q "Failed to dial to edge with quic" <<<"$RECENT" && [[ "${ELIAN_TUNNEL_PROTOCOL:-http2}" == "quic" ]]; then
    problem "QUIC не проходит. Переключите транспорт: ELIAN_TUNNEL_PROTOCOL=http2 в ~/.elian/elian.env, затем elian restart"
  elif grep -q "Failed to dial" <<<"$RECENT"; then
    problem "коннектор не может подключиться. Последние ошибки:"
    grep -E "ERR|WRN" <<<"$RECENT" | tail -3 | sed 's/^/    /'
  else
    warn "в логе пока нет подтверждения подключения — туннель только стартовал, подождите 15–30 секунд"
  fi
else
  warn "лога туннеля нет — запускался ли он? elian start"
fi

step "4. Публичная ссылка"
if [[ -z "$URL" ]]; then
  problem "адрес ещё не получен — подождите и повторите, или: elian logs tunnel 20"
elif ! valid_public_url "$URL"; then
  problem "в файле адреса служебное значение: $URL — восстановить: elian restart"
else
  printf '  адрес: %s\n' "$URL"
  DNS_OK=1
  if command -v getent >/dev/null 2>&1 && ! getent hosts "$HOST" >/dev/null 2>&1; then DNS_OK=0; fi
  if (( DNS_OK == 0 )); then
    problem "имя $HOST не разрешается в DNS — Cloudflare ещё не подхватил туннель (дайте 30–60 с)"
  else
  CODE=""
  for attempt in 1 2 3; do
    CODE="$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$URL/api/v1/health" 2>/dev/null)" || true
    [[ -z "$CODE" ]] && CODE=000
    [[ "$CODE" == "200" ]] && break
    (( attempt < 3 )) && { log "попытка ${attempt}/3: код ${CODE}, ждём 10 с (Cloudflare публикует имя не мгновенно)"; sleep 10; }
  done
  case "$CODE" in
    200) ok "ссылка открывается снаружи (200) — можно пользоваться" ;;
    000) problem "снаружи не отвечает: нет соединения или DNS. Если так больше минуты — сеть режет порт 7844, попробуйте без VPN" ;;
    530|1033) problem "Cloudflare отвечает $CODE: коннектор не подключён к edge. Смотрите пункт 3 и: elian logs tunnel 30" ;;
    502|503|504) problem "Cloudflare отвечает $CODE: коннектор есть, но сервер не отвечает — смотрите пункт 1" ;;
    *) problem "снаружи вернулся код $CODE" ;;
  esac
  fi
fi

printf '\n'
if (( PROBLEMS == 0 )); then
  ok "Всё работает: сервер, туннель и внешняя ссылка."
else
  warn "Проблем: $PROBLEMS. Подробности — выше."
  exit 1
fi
