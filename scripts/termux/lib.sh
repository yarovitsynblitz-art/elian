#!/usr/bin/env bash
# Общие функции для скриптов Элиана в Termux. Подключается через `source`.
# Ничего не печатает секретов; все пути можно переопределить переменными окружения.

ELIAN_HOME="${ELIAN_HOME:-$HOME/.elian}"
ELIAN_ENV_FILE="${ELIAN_ENV_FILE:-$ELIAN_HOME/elian.env}"
ELIAN_SECRETS_DIR="${ELIAN_SECRETS_DIR:-$ELIAN_HOME/secrets}"
ELIAN_DATA_DIR="${ELIAN_DATA_DIR:-$ELIAN_HOME/data}"
ELIAN_LOG_DIR="${ELIAN_LOG_DIR:-$ELIAN_HOME/logs}"
ELIAN_BACKUP_DIR="${ELIAN_BACKUP_DIR:-$ELIAN_HOME/backups}"
ELIAN_BIN_DIR="${ELIAN_BIN_DIR:-$ELIAN_HOME/bin}"
ELIAN_SESSION="${ELIAN_SESSION:-elian}"
_ELIAN_PORT_EXPLICIT="${ELIAN_PORT:-}"
ELIAN_PORT="${ELIAN_PORT:-3000}"
ELIAN_TUNNEL_MODE="${ELIAN_TUNNEL_MODE:-quick}"   # quick | named | none
ELIAN_TUNNEL_TOKEN_FILE="${ELIAN_TUNNEL_TOKEN_FILE:-$ELIAN_SECRETS_DIR/cloudflare-tunnel.token}"
ELIAN_DOMAIN="${ELIAN_DOMAIN:-PUBLIC_DOMAIN}"

# Порт берём из конфигурации, если он не задан явно в окружении.
if [[ -z "$_ELIAN_PORT_EXPLICIT" && -f "$ELIAN_ENV_FILE" ]]; then
  _PORT_FROM_FILE="$(sed -n 's/^PORT=//p' "$ELIAN_ENV_FILE" | tail -1)"
  [[ -n "$_PORT_FROM_FILE" ]] && ELIAN_PORT="$_PORT_FROM_FILE"
fi

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_B=$'\033[1m'
else
  C_RESET=""; C_DIM=""; C_OK=""; C_WARN=""; C_ERR=""; C_B=""
fi

log()  { printf '%s[elian]%s %s\n' "$C_DIM" "$C_RESET" "$*"; }
ok()   { printf '%s[elian]%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '%s[elian]%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
die()  { printf '%s[elian] ОШИБКА:%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; exit 1; }
step() { printf '\n%s▶ %s%s\n' "$C_B" "$*" "$C_RESET"; }

have() { command -v "$1" >/dev/null 2>&1; }

is_termux() { [[ -n "${TERMUX_VERSION:-}" || -d /data/data/com.termux ]]; }

require_termux_pkg() {
  local pkg="$1"
  if is_termux; then
    pkg install -y "$pkg" >/dev/null 2>&1 || die "не удалось установить пакет $pkg (pkg install $pkg)"
  fi
}

# Каталоги с жёсткими правами: данные и секреты не должны читаться другими приложениями.
ensure_layout() {
  local dir
  for dir in "$ELIAN_HOME" "$ELIAN_SECRETS_DIR" "$ELIAN_DATA_DIR" "$ELIAN_LOG_DIR" "$ELIAN_BACKUP_DIR" "$ELIAN_BIN_DIR" \
             "$ELIAN_DATA_DIR/media" "$ELIAN_DATA_DIR/media/files" "$ELIAN_DATA_DIR/media/thumbs"; do
    mkdir -p "$dir"
    chmod 700 "$dir" 2>/dev/null || true
  done
}

# Чтение значения из elian.env без выполнения файла (безопасно для секретов).
env_get() {
  local key="$1"
  [[ -f "$ELIAN_ENV_FILE" ]] || return 0
  sed -n "s/^${key}=//p" "$ELIAN_ENV_FILE" | tail -1
}

env_set() {
  local key="$1" value="$2"
  touch "$ELIAN_ENV_FILE"; chmod 600 "$ELIAN_ENV_FILE"
  if grep -q "^${key}=" "$ELIAN_ENV_FILE"; then
    # Значение может содержать / и & — используем python-подобную замену через awk.
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' "$ELIAN_ENV_FILE" > "$ELIAN_ENV_FILE.tmp"
    mv "$ELIAN_ENV_FILE.tmp" "$ELIAN_ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ELIAN_ENV_FILE"
  fi
  chmod 600 "$ELIAN_ENV_FILE"
}

# Публичный домен именованного туннеля: аргумент окружения → ~/.elian/elian.env.
# Возвращает пустую строку, если домен реально не настроен (плейсхолдер PUBLIC_DOMAIN).
resolve_domain() {
  local d="${ELIAN_DOMAIN:-}"
  if [[ -z "$d" || "$d" == "PUBLIC_DOMAIN" ]]; then d="$(env_get PUBLIC_DOMAIN)"; fi
  [[ "$d" == "PUBLIC_DOMAIN" ]] && d=""
  printf '%s' "$d"
}

gen_secret() {
  # 32 случайных байта в hex — криптостойко, без внешних зависимостей.
  if have openssl; then openssl rand -hex 32; else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

SERVER_PID_FILE="${ELIAN_HOME}/server.pid"
TUNNEL_PID_FILE="${ELIAN_HOME}/tunnel.pid"

# Сервер живёт в tmux (Termux). Если tmux недоступен (например, при отладке на ПК) —
# используется nohup + PID-файл, чтобы поведение скриптов оставалось одинаковым.
server_running() {
  if have tmux && tmux has-session -t "$ELIAN_SESSION" 2>/dev/null; then return 0; fi
  [[ -f "$SERVER_PID_FILE" ]] && kill -0 "$(cat "$SERVER_PID_FILE")" 2>/dev/null
}

tunnel_running() {
  [[ -f "$TUNNEL_PID_FILE" ]] && kill -0 "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null
}

# Уведомление в шторку Android (Termux:API). На ПК и без termux-api — молча ничего.
notify() {
  local title="${1:-Элиан}" body="${2:-}"
  have termux-notification || return 0
  termux-notification --title "$title" --content "$body" --priority high >/dev/null 2>&1 || true
}

# IP телефона в домашней сети (для доступа с других устройств без интернета).
lan_ip() {
  local ip=""
  if have ip; then
    ip="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -E '^(192\.168|10\.|172\.(1[6-9]|2[0-9]|3[01]))' | head -1)"
  fi
  if [[ -z "$ip" ]] && have ifconfig; then
    ip="$(ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -E '^(192\.168|10\.|172\.)' | head -1)"
  fi
  printf '%s' "${ip:-}"
}

nohup_mode() { ! have tmux; }

health_ok() {
  curl -fsS --max-time 3 "http://127.0.0.1:${ELIAN_PORT}/api/v1/health" >/dev/null 2>&1
}

wait_health() {
  local attempts="${1:-40}" delay="${2:-1}" i
  for ((i = 1; i <= attempts; i++)); do
    if health_ok; then return 0; fi
    sleep "$delay"
  done
  return 1
}
