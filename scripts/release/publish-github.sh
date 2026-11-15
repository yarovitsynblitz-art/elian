#!/usr/bin/env bash
# Публикация репозитория Элиан на GitHub.
#
#   GITHUB_TOKEN=ghp_xxx bash scripts/release/publish-github.sh [имя-репозитория] [private|public]
#
# Токен нужен один раз: Settings → Developer settings → Personal access tokens →
# Tokens (classic) → Generate new token → галочка "repo" (+ "delete_repo" не нужна).
# После публикации токен сразу отзовите: та же страница → Delete.
# Скрипт не сохраняет токен ни в git config, ни в файлы.
set -euo pipefail

TOKEN="${GITHUB_TOKEN:-}"
REPO="${1:-elian}"
VISIBILITY="${2:-public}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

[ -n "$TOKEN" ] || { echo "ОШИБКА: задайте GITHUB_TOKEN"; exit 1; }
command -v curl >/dev/null || { echo "ОШИБКА: нужен curl"; exit 1; }
command -v git  >/dev/null || { echo "ОШИБКА: нужен git";  exit 1; }

api() { # api <method> <path> [json]
  local method="$1" path="$2" data="${3:-}"
  if [ -n "$data" ]; then
    curl -fsS -X "$method" -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" \
      -d "$data" "https://api.github.com$path"
  else
    curl -fsS -X "$method" -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com$path"
  fi
}

ME=""
ME=$(api GET /user 2>/dev/null) || { echo "ОШИБКА: GitHub отклонил токен (401/403). Проверьте, что он действует и имеет право repo."; exit 1; }
LOGIN=$(printf '%s' "$ME" | sed -n 's/.*"login": *"\([^"]*\)".*/\1/p' | head -1)
[ -n "$LOGIN" ] || { echo "ОШИБКА: не удалось определить логин по токену"; exit 1; }
echo "▶ аккаунт: $LOGIN"

if api GET "/repos/$LOGIN/$REPO" >/dev/null 2>&1; then
  echo "▶ репозиторий $LOGIN/$REPO уже существует — обновляю"
else
  echo "▶ создаю репозиторий $LOGIN/$REPO ($VISIBILITY)"
  api POST /user/repos "{\"name\":\"$REPO\",\"private\":$([ "$VISIBILITY" = private ] && echo true || echo false),\"description\":\"Элиан — self-hosted мессенджер для Termux + PWA\",\"has_issues\":true}" >/dev/null
fi

cd "$ROOT_DIR"
git rev-parse --git-dir >/dev/null 2>&1 || {
  git init -q
  git -c user.email=owner@elian.local -c user.name="Elian" add -A
  git -c user.email=owner@elian.local -c user.name="Elian" commit -q -m "Элиан / Elian 1.0.0"
}
git branch -M main 2>/dev/null || true
echo "▶ push main"
git push -q "https://x-access-token:$TOKEN@github.com/$LOGIN/$REPO.git" main --force

BRANCH="main"
echo
echo "ГОТОВО: https://github.com/$LOGIN/$REPO"
echo
echo "Установка на телефоне (одна строка):"
echo
echo "cd \$HOME && pkg install -y git && git clone --depth 1 https://github.com/$LOGIN/$REPO.git elian-src && bash elian-src/scripts/termux/bootstrap.sh"
echo
echo "Не забудьте отозвать токен: https://github.com/settings/tokens"
