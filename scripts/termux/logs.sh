#!/usr/bin/env bash
# Просмотр логов: bash scripts/termux/logs.sh [server|tunnel] [строк]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib.sh"
WHICH="${1:-server}"
LINES="${2:-80}"
FILE="$ELIAN_LOG_DIR/$WHICH.log"
[[ -f "$FILE" ]] || die "нет лога $FILE"
printf '%s\n' "── $FILE (последние $LINES строк) ──"
tail -n "$LINES" "$FILE"
