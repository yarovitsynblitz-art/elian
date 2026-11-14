#!/usr/bin/env bash
# Диагностика именованного туннеля Cloudflare: проверяет токен, домен, DNS и живое подключение.
#
#   bash scripts/cloudflare/check-tunnel.sh            # быстрые проверки (без запуска туннеля)
#   bash scripts/cloudflare/check-tunnel.sh --live     # + реально поднять cloudflared на 25 секунд
#
# Токен нигде не печатается: из него берётся только структура и ID туннеля.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/../termux/lib.sh"

LIVE=0
[[ "${1:-}" == "--live" ]] && LIVE=1

CLOUDFLARED="${ELIAN_BIN_DIR}/cloudflared"
TOKEN_FILE="$ELIAN_TUNNEL_TOKEN_FILE"
MODE="${ELIAN_TUNNEL_MODE:-quick}"
DOMAIN="$(resolve_domain)"
PROBLEMS=0
problem() { warn "$*"; PROBLEMS=$((PROBLEMS + 1)); }

doh() { # doh <name> <type> → JSON
  curl -fsS --max-time 8 -H 'accept: application/dns-json' \
    "https://cloudflare-dns.com/dns-query?name=$1&type=$2" 2>/dev/null || true
}
json_field() { # json_field <json> <python-выражение над d>
  python3 -c "import json,sys;d=json.loads(sys.argv[1] or '{}');print($2)" "$1" 2>/dev/null || true
}

step "1. Режим туннеля"
printf '  режим: %s\n' "$MODE"
printf '  порт сервера: %s\n' "$ELIAN_PORT"
if [[ "$MODE" != "named" ]]; then
  problem "в конфигурации ELIAN_TUNNEL_MODE=$MODE — именованный туннель не включён. Нужно: ELIAN_TUNNEL_MODE=named (это делает setup-named-tunnel.sh), затем restart."
fi

step "2. Токен туннеля"
if [[ ! -s "$TOKEN_FILE" ]]; then
  problem "нет файла токена: $TOKEN_FILE — запустите: bash scripts/cloudflare/setup-named-tunnel.sh"
  TOKEN_TUNNEL_ID=""
else
  PERMS="$(stat -c '%a' "$TOKEN_FILE" 2>/dev/null || echo '?')"
  [[ "$PERMS" == "600" ]] && ok "файл токена на месте, права 600" || problem "права на файл токена: $PERMS (должно быть 600)"
  READ="$(node -e '
    const fs = require("fs");
    let token = fs.readFileSync(process.argv[1], "utf8").trim();
    if (token.includes("--token")) token = token.split("--token")[1].trim().replace(/^["\x27]|["\x27]$/g, "");
    let payload;
    try {
      payload = JSON.parse(Buffer.from(token.split("").reverse().join(""), "base64").split("").reverse().join(""));
    } catch { payload = null; }
    if (!payload) {
      const padded = token.replace(/-/g, "+").replace(/_/g, "/");
      try { payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8")); } catch { payload = null; }
    }
    if (!payload || typeof payload !== "object") { console.log("BAD|"); process.exit(0); }
    const id = payload.t || "";
    const okShape = Boolean(payload.a && payload.t && payload.s);
    console.log((okShape ? "OK|" : "PART|") + id);
  ' "$TOKEN_FILE" 2>/dev/null || echo "BAD|")"
  KIND="${READ%%|*}"
  TOKEN_TUNNEL_ID="${READ#*|}"
  case "$KIND" in
    OK) ok "токен разбирается: есть account-id, tunnel-id, секрет" ;;
    PART) problem "токен похож на усечённый: не хватает account-id/tunnel-id/секрета. Скопируйте токен заново из команды установки в Cloudflare" ;;
    *) problem "это не токен туннеля Cloudflare (не декодируется в JSON). Скорее всего вставлен ID туннеля, UUID или обрезанная строка — токен начинается с 'eyJ' и длиной 150+ символов" ;;
  esac
  [[ -n "$TOKEN_TUNNEL_ID" ]] && printf '  ID туннеля: %s\n' "$TOKEN_TUNNEL_ID"
fi

step "3. Домен"
if [[ -z "$DOMAIN" || "$DOMAIN" == "PUBLIC_DOMAIN" ]]; then
  problem "домен не задан (PUBLIC_DOMAIN в ~/.elian/elian.env)"
  DOMAIN=""
else
  # Зона (registrable domain) для проверки NS: последние две метки, с учётом зон вида co.uk.
  IFS='.' read -r -a D_PARTS <<< "$DOMAIN"
  D_N=${#D_PARTS[@]}
  if (( D_N >= 2 )); then
    ZONE="${D_PARTS[D_N-2]}.${D_PARTS[D_N-1]}"
    if (( D_N >= 3 )); then
      case "${D_PARTS[D_N-2]}" in
        co|com|org|net|ac|gov|edu) ZONE="${D_PARTS[D_N-3]}.$ZONE" ;;
      esac
    fi
    SUB="${DOMAIN%.$ZONE}"
  else
    ZONE="$DOMAIN"; SUB=""
  fi
  printf '  домен: %s (зона %s)\n' "$DOMAIN" "$ZONE"
  NS_JSON="$(doh "$ZONE" NS)"
  NS_LIST="$(json_field "$NS_JSON" "','.join(a['data'] for a in d.get('Answer',[]))")"
  if [[ -z "$NS_LIST" ]]; then
    problem "не удалось получить NS зоны $ZONE (домен не делегирован?)"
  elif [[ "$NS_LIST" == *cloudflare.com* ]]; then
    ok "DNS домена обслуживает Cloudflare: $NS_LIST"
    CLOUDFLARE_NS=1
  else
    problem "DNS домена обслуживает НЕ Cloudflare: $NS_LIST"
    warn "  Именованный туннель работает только с доменом, добавленным в Cloudflare:"
    warn "  1) dash.cloudflare.com → Add a site → $ZONE (план Free)"
    warn "  2) Cloudflare покажет 2 своих NS (вида xxx.ns.cloudflare.com)"
    warn "  3) у регистратора домена замените текущие NS на эти два и подождите 5–60 минут"
    CLOUDFLARE_NS=0
  fi
  HOST_JSON="$(doh "$DOMAIN" CNAME)"
  HOST_TARGET="$(json_field "$HOST_JSON" "','.join(a['data'] for a in d.get('Answer',[]))")"
  if [[ -n "$HOST_TARGET" ]]; then
    ok "запись для $DOMAIN: CNAME → $HOST_TARGET"
    if [[ -n "$TOKEN_TUNNEL_ID" && "$HOST_TARGET" != *"$TOKEN_TUNNEL_ID"* ]]; then
      problem "CNAME ведёт на другой туннель. Публичный хостнейм в Cloudflare должен указывать на сервис http://127.0.0.1:${ELIAN_PORT} этого туннеля"
    fi
  else
    STATUS="$(json_field "$HOST_JSON" "d.get('Status')")"
    if [[ "$STATUS" == "3" ]]; then
      problem "записи $DOMAIN нет в DNS (NXDOMAIN) — Public Hostname в Cloudflare не создан"
      warn "  Zero Trust → Networks → Tunnels → ваш туннель → Public Hostname → Add:"
      warn "  subdomain = ${SUB}, domain = ${ZONE}, path пусто, service = http://127.0.0.1:${ELIAN_PORT}"
    else
      problem "не удалось проверить CNAME для $DOMAIN"
    fi
  fi
fi

step "4. Локальный сервер"
if health_ok; then
  ok "127.0.0.1:${ELIAN_PORT}/api/v1/health отвечает"
else
  problem "локальный сервер не отвечает на 127.0.0.1:${ELIAN_PORT}. Запустите: elian start"
fi

if (( LIVE )); then
  step "5. Живое подключение туннеля (25 с)"
  if [[ ! -x "$CLOUDFLARED" ]]; then
    problem "cloudflared не установлен: bash scripts/cloudflare/install-cloudflared.sh"
  elif [[ ! -s "$TOKEN_FILE" ]]; then
    problem "без токена живая проверка невозможна"
  else
    set +e
    OUT="$(ELIAN_TUNNEL_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")" timeout 25 "$CLOUDFLARED" tunnel --no-autoupdate run 2>&1)"
    set -e
    if grep -q "Registered tunnel connection" <<<"$OUT"; then
      ok "туннель подключился к Cloudflare (Registered tunnel connection)"
    else
      problem "туннель не подключился. Ответ Cloudflare:"
      grep -iE "error|failed|invalid|unauthor|token" <<<"$OUT" | head -5 | sed 's/^/    /' || true
      grep -qi "invalid tunnel token\|failed to unmarshal\|Unauthorized" <<<"$OUT" && \
        warn "  Это признак неверного токена — пересоздайте туннель в Cloudflare и вставьте токен заново."
    fi
  fi
fi

step "6. Публичная проверка"
if [[ -n "$DOMAIN" && "${CLOUDFLARE_NS:-0}" == "1" ]]; then
  CODE="$(curl -s -o /dev/null -m 12 -w '%{http_code}' "https://$DOMAIN/api/v1/health" || true)"
  case "$CODE" in
    200) ok "https://$DOMAIN/api/v1/health → 200" ;;
    000) problem "https://$DOMAIN не отвечает (нет соединения/DNS)" ;;
    502|503|504) problem "Cloudflare отвечает $CODE — туннель не подключён к серверу (проверьте, что сервис в Public Hostname = http://127.0.0.1:${ELIAN_PORT})" ;;
    *) problem "https://$DOMAIN/api/v1/health → $CODE" ;;
  esac
else
  log "публичную проверку пропускаю: домен должен сначала заработать через Cloudflare"
fi

printf '\n'
if (( PROBLEMS == 0 )); then
  ok "Проверки пройдены: туннель настроен верно."
else
  warn "Найдено проблем: $PROBLEMS. Смотрите пункты выше — там же написано, что именно сделать."
  exit 1
fi
