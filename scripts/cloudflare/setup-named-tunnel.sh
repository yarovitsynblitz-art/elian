#!/usr/bin/env bash
# Постоянный домен через именованный туннель Cloudflare.
#
# Что нужно от владельца (Cloudflare не даёт это автоматизировать без входа в аккаунт):
#   1) аккаунт Cloudflare и домен, добавленный в него (NS переключены на Cloudflare);
#   2) в Zero Trust → Networks → Tunnels создать туннель, добавить Public Hostname
#      (например elian.example.com → http://127.0.0.1:3000);
#   3) скопировать токен туннеля (начинается с eyJ…) и вставить его сюда — ввод скрытый.
# Токен сохраняется в файл с правами 600 и в командную строку не попадает.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/../termux/lib.sh"

mkdir -p "$ELIAN_SECRETS_DIR"; chmod 700 "$ELIAN_SECRETS_DIR"

printf '%s\n' "Именованный туннель Cloudflare" "" \
  "1. Откройте https://one.dash.cloudflare.com → Networks → Tunnels → Create a tunnel" \
  "2. Тип: Cloudflared. Скопируйте токен из команды установки (после --token)." \
  "3. В Public Hostname укажите домен и сервис  http://127.0.0.1:${ELIAN_PORT}" ""

if [[ -s "$ELIAN_TUNNEL_TOKEN_FILE" ]]; then
  log "токен уже сохранён: $ELIAN_TUNNEL_TOKEN_FILE"
  read -r -p "Заменить токен? [y/N] " replace
  [[ "${replace,,}" == "y" ]] || exit 0
fi

if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
  TOKEN="$CLOUDFLARE_TUNNEL_TOKEN"           # можно передать через окружение (не через argv)
  log "использую токен из переменной окружения CLOUDFLARE_TUNNEL_TOKEN"
else
  printf '%s\n' "Вставьте токен туннеля (ввод не отображается)." \
    "Можно вставить всю команду из Cloudflare целиком — например:" \
    "  cloudflared.exe service install eyJhIjoi..." \
    "токен из неё будет извлечён автоматически."
  read -r -s -p "Токен (или команда): " TOKEN; printf '\n'
fi

# Из дашборда Cloudflare люди копируют целую команду установки, а не голый токен.
# Достаём последнее слово, похожее на токен (eyJ…), и снимаем кавычки.
if [[ "$TOKEN" == *[[:space:]]* ]]; then
  read -r -a WORDS <<< "$TOKEN"
  for ((w = ${#WORDS[@]} - 1; w >= 0; w--)); do
    if [[ "${WORDS[w]}" == ey* ]]; then TOKEN="${WORDS[w]}"; break; fi
    TOKEN="${WORDS[w]}"
  done
fi
TOKEN="${TOKEN%\"}"; TOKEN="${TOKEN#\"}"; TOKEN="${TOKEN%\'}"; TOKEN="${TOKEN#\'}"

[[ -n "$TOKEN" ]] || die "токен пуст"
[[ ${#TOKEN} -ge 40 ]] || die "токен слишком короткий — похоже, скопирован не полностью"
[[ "$TOKEN" == ey* ]] || warn "токен не начинается с 'ey' — проверьте, что это токен туннеля"

( umask 077; printf '%s\n' "$TOKEN" > "$ELIAN_TUNNEL_TOKEN_FILE" )
chmod 600 "$ELIAN_TUNNEL_TOKEN_FILE"
unset TOKEN
ok "токен сохранён (600): $ELIAN_TUNNEL_TOKEN_FILE"

DOMAIN="$(env_get PUBLIC_DOMAIN)"
if [[ -z "$DOMAIN" || "$DOMAIN" == "PUBLIC_DOMAIN" ]]; then
  read -r -p "Публичный домен (например elian.example.com): " DOMAIN
  [[ -n "$DOMAIN" ]] || die "домен обязателен для именованного туннеля"
  env_set PUBLIC_DOMAIN "$DOMAIN"
fi
env_set PUBLIC_URL "https://$DOMAIN"
env_set ALLOWED_ORIGINS "https://$DOMAIN"
env_set ELIAN_TUNNEL_MODE named
ok "домен: https://$DOMAIN (не забудьте Public Hostname в Cloudflare)"

# Сразу проверяем то, что чаще всего ломается: сам токен и делегирование домена
# на Cloudflare. Без этого туннель молча не поднимется, а ссылка будет отдавать 1033.
printf '\n'
ELIAN_TUNNEL_MODE=named bash "$SCRIPT_DIR/check-tunnel.sh" || true

printf '\n'
log "дальше: bash scripts/termux/restart.sh  (и проверка: bash scripts/cloudflare/check-tunnel.sh --live)"
