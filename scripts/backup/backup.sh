#!/usr/bin/env bash
# Резервное копирование Элиана: шифрованный архив БД + медиа + манифест.
# Ключ бэкапа (парольная фраза) лежит отдельно от архива и не попадает в него.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREFIX="${ELIAN_PREFIX:-$HOME/.elian}"
ENV_FILE="${ELIAN_ENV_FILE:-$PREFIX/elian.env}"
SECRETS_DIR="${SECRETS_DIR:-$PREFIX/secrets}"
BACKUP_DIR="${BACKUP_DIR:-$PREFIX/backups}"
KEEP="${BACKUP_KEEP:-7}"
PASSPHRASE_FILE="${ELIAN_BACKUP_PASSPHRASE_FILE:-$SECRETS_DIR/backup-passphrase.key}"

log() { printf '[backup] %s\n' "$*"; }
fail() { printf '[backup] ОШИБКА: %s\n' "$*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || fail "не найден $ENV_FILE (сначала запустите scripts/termux/bootstrap.sh)"
[[ -f "$ROOT_DIR/apps/server/dist/tools/backup.js" ]] || fail "сервер не собран: npm run build"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

export ELIAN_BACKUP_PASSPHRASE_FILE="$PASSPHRASE_FILE"
if [[ ! -f "$PASSPHRASE_FILE" ]]; then
  log "создаю парольную фразу бэкапа (держите её вне телефона, если хотите защититься от кражи устройства)"
  node "$ROOT_DIR/apps/server/dist/tools/backup.js" key --file "$PASSPHRASE_FILE" >/dev/null
  chmod 600 "$PASSPHRASE_FILE"
fi

log "создаю бэкап в $BACKUP_DIR"
OUTPUT="$(node "$ROOT_DIR/apps/server/dist/tools/backup.js" create --out "$BACKUP_DIR")"
printf '%s\n' "$OUTPUT"

FILE="$(printf '%s' "$OUTPUT" | sed -n 's/.*"file": "\([^"]*\)".*/\1/p' | head -1)"
[[ -n "$FILE" && -f "$FILE" ]] || fail "архив не создан"

log "проверяю целостность архива"
node "$ROOT_DIR/apps/server/dist/tools/backup.js" verify --file "$FILE" >/dev/null || fail "архив не прошёл проверку"

log "готово: $FILE ($(du -h "$FILE" | cut -f1))"

# Ротация: оставляем KEEP последних архивов.
mapfile -t ARCHIVES < <(ls -1t "$BACKUP_DIR"/*.elnb 2>/dev/null || true)
if (( ${#ARCHIVES[@]} > KEEP )); then
  for old in "${ARCHIVES[@]:$KEEP}"; do
    log "удаляю старый архив $(basename "$old")"
    rm -f "$old"
  done
fi
