#!/usr/bin/env bash
# Восстановление из шифрованного архива. Сервер должен быть остановлен.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREFIX="${ELIAN_PREFIX:-$HOME/.elian}"
ENV_FILE="${ELIAN_ENV_FILE:-$PREFIX/elian.env}"
SECRETS_DIR="${SECRETS_DIR:-$PREFIX/secrets}"
PASSPHRASE_FILE="${ELIAN_BACKUP_PASSPHRASE_FILE:-$SECRETS_DIR/backup-passphrase.key}"

log() { printf '[restore] %s\n' "$*"; }
fail() { printf '[restore] ОШИБКА: %s\n' "$*" >&2; exit 1; }

ARCHIVE="${1:-}"
[[ -n "$ARCHIVE" ]] || fail "использование: scripts/backup/restore.sh <архив.elb>"
[[ -f "$ARCHIVE" ]] || fail "архив не найден: $ARCHIVE"
[[ -f "$ENV_FILE" ]] || fail "не найден $ENV_FILE"
[[ -f "$PASSPHRASE_FILE" ]] || fail "не найден файл парольной фразы: $PASSPHRASE_FILE"

if tmux has-session -t elian 2>/dev/null; then
  log "останавливаю сервер в tmux (сессия elian)"
  tmux send-keys -t elian C-c 2>/dev/null || true
  sleep 2
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
export ELIAN_BACKUP_PASSPHRASE_FILE="$PASSPHRASE_FILE"

log "проверяю архив перед восстановлением"
node "$ROOT_DIR/apps/server/dist/tools/backup.js" verify --file "$ARCHIVE" >/dev/null || fail "архив повреждён или пароль неверен"

log "восстанавливаю (текущая БД будет сохранена как elian.db.before-restore-*)"
node "$ROOT_DIR/apps/server/dist/tools/backup.js" restore --file "$ARCHIVE"

log "готово. Запустите сервер: bash scripts/termux/start.sh"
