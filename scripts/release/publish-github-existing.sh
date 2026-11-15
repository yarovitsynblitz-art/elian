#!/usr/bin/env bash
# Публикация в УЖЕ СОЗДАННЫЙ пустой репозиторий (для fine-grained токенов).
#   GITHUB_TOKEN=... bash scripts/release/publish-github-existing.sh [owner/repo]
set -euo pipefail
TOKEN="${GITHUB_TOKEN:-}"; FULL="${1:-}"
[ -n "$TOKEN" ] || { echo "нет GITHUB_TOKEN"; exit 1; }
[ -n "$FULL" ] || { echo "укажите owner/repo"; exit 1; }
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
code=$(curl -s -o /tmp/r.json -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$FULL")
[ "$code" = 200 ] || { echo "репозиторий $FULL недоступен токену (HTTP $code)"; cat /tmp/r.json; exit 1; }
echo "▶ репозиторий найден: $FULL"
cd "$ROOT_DIR"; git rev-parse --git-dir >/dev/null 2>&1 || git init -q
git branch -M main 2>/dev/null || true
git push -q "https://x-access-token:$TOKEN@github.com/$FULL.git" main --force
echo "ГОТОВО: https://github.com/$FULL"
echo
echo "cd \$HOME && pkg install -y git && git clone --depth 1 https://github.com/$FULL.git elian-src && bash elian-src/scripts/termux/bootstrap.sh"
