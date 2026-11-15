#!/usr/bin/env bash
# Собирает релизный архив и печатает его SHA-256 — это то, что публикуется вместе с однострочником установки.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="${1:-$(node -p "require('$ROOT_DIR/package.json').version")}"
NAME="elian-$VERSION"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/dist-release}"
mkdir -p "$OUT_DIR"

BASE="$(basename "$ROOT_DIR")"
# Все скрипты должны быть исполняемыми внутри архива (Termux после распаковки).
find "$ROOT_DIR/scripts" -name "*.sh" -type f -exec chmod 755 {} + 2>/dev/null || true
cd "$(dirname "$ROOT_DIR")"
tar --transform "s,^${BASE},${NAME}," --exclude='node_modules' --exclude='.git' --exclude='*/dist' --exclude='.elian' --exclude='data' \
    --exclude='*.elnb' --exclude='test-results' --exclude='playwright-report' \
    -czf "$OUT_DIR/$NAME.tar.gz" "$BASE"

SHA="$(sha256sum "$OUT_DIR/$NAME.tar.gz" | cut -d' ' -f1)"
printf 'Архив: %s\nSHA-256: %s\n\n' "$OUT_DIR/$NAME.tar.gz" "$SHA"
printf 'Однострочник (замените URL на свой):\n'
printf 'cd $HOME && pkg install -y curl tar && curl -fsSLO https://example.com/releases/%s.tar.gz && echo "%s  %s.tar.gz" | sha256sum -c - && tar xzf %s.tar.gz && bash %s/scripts/termux/bootstrap.sh\n' "$NAME" "$SHA" "$NAME" "$NAME" "$NAME"
