#!/usr/bin/env bash
# Устанавливает cloudflared в $ELIAN_BIN_DIR (по умолчанию ~/.elian/bin).
# Скачивает официальный бинарник с GitHub Releases и проверяет SHA-256 (если задан ожидаемый).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/../termux/lib.sh"

TARGET="$ELIAN_BIN_DIR/cloudflared"
if [[ -x "$TARGET" ]]; then
  log "cloudflared уже установлен: $("$TARGET" --version 2>/dev/null | head -1)"
  exit 0
fi

case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  armv7l|armv8l|arm) ARCH=arm ;;
  x86_64|amd64) ARCH=amd64 ;;
  *) die "неизвестная архитектура: $(uname -m)" ;;
esac

# Пакет из репозитория Termux, если доступен — самый простой путь.
if is_termux && pkg install -y cloudflared >/dev/null 2>&1 && have cloudflared; then
  ln -sf "$(command -v cloudflared)" "$TARGET"
  ok "cloudflared установлен из репозитория Termux"
  exit 0
fi

mkdir -p "$ELIAN_BIN_DIR"
URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}"
EXPECTED_SHA="${CLOUDFLARED_SHA256:-}"
TMP="$(mktemp)"
log "скачиваю cloudflared ($ARCH)…"
curl -fsSL --retry 3 -o "$TMP" "$URL" || die "не удалось скачать $URL"

ACTUAL_SHA="$(sha256sum "$TMP" | cut -d' ' -f1)"
if [[ -n "$EXPECTED_SHA" ]]; then
  [[ "$ACTUAL_SHA" == "$EXPECTED_SHA" ]] || die "SHA-256 не совпал: ожидался $EXPECTED_SHA, получен $ACTUAL_SHA"
  ok "контрольная сумма cloudflared совпала"
else
  warn "CLOUDFLARED_SHA256 не задан — проверка ограничена HTTPS. Для строгой проверки:"
  warn "  CLOUDFLARED_SHA256=$ACTUAL_SHA bash scripts/cloudflare/install-cloudflared.sh"
fi

install -m 700 "$TMP" "$TARGET"
rm -f "$TMP"
ok "cloudflared: $("$TARGET" --version 2>/dev/null | head -1)"
