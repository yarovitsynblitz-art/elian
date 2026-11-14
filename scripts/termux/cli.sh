#!/usr/bin/env bash
# elian — короткие команды для повседневного управления Элианом на телефоне.
#   elian start | stop | restart | status | url | logs [server|tunnel] [N] | console | backup | update | doctor | help
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Каталог с кодом: 1) из ~/.elian/repo-path (пишет bootstrap), 2) рядом со скриптом.
ROOT_DIR=""
if [[ -n "${ELIAN_HOME:-}" && -f "$ELIAN_HOME/repo-path" ]]; then
  ROOT_DIR="$(cat "$ELIAN_HOME/repo-path")"
elif [[ -f "$HOME/.elian/repo-path" ]]; then
  ROOT_DIR="$(cat "$HOME/.elian/repo-path")"
fi
if [[ -z "$ROOT_DIR" || ! -d "$ROOT_DIR/scripts/termux" ]]; then
  ROOT_DIR="$(cd "$SELF_DIR/../.." && pwd)"
fi


# Запуск CLI владельца в контексте конфигурации Элиана (локально, без HTTP).
owner_cli() {
  local env_file="${ELIAN_ENV_FILE:-$HOME/.elian/elian.env}"
  [[ -f "$env_file" ]] || { echo "нет конфигурации: $env_file" >&2; exit 1; }
  [[ -f "$ROOT_DIR/apps/server/dist/tools/owner-cli.js" ]] || { echo "сервер не собран: elian update" >&2; exit 1; }
  (
    cd "$ROOT_DIR" || exit 1
    set -a; . "$env_file"; set +a
    node apps/server/dist/tools/owner-cli.js "$@"
  )
}

S="$ROOT_DIR/scripts/termux"
CMD="${1:-help}"; shift || true

case "$CMD" in
  start|up)     bash "$S/start.sh" "$@" ;;
  stop|down)    bash "$S/stop.sh" "$@" ;;
  restart)      bash "$S/restart.sh" "$@" ;;
  status|st)    bash "$S/status.sh" "$@" ;;
  logs|log)     bash "$S/logs.sh" "$@" ;;
  url|addr)
    if [[ -f "$HOME/.elian/public-url.txt" ]]; then
      cat "$HOME/.elian/public-url.txt"
    else
      echo "публичный адрес ещё не определён — запустите: elian start, затем: elian logs tunnel 20"
    fi
    ;;
  console|owner)
    if command -v tmux >/dev/null 2>&1; then
      echo "tmux: list | show <код> | y | n | stats | help · выход: Ctrl-b, затем d"
      sleep 1
      exec tmux attach -t elian
    else
      echo "tmux не установлен: pkg install tmux" >&2
      exit 1
    fi
    ;;
  # ── подтверждение входов/регистраций без tmux ──
  pending|queue|list)
    owner_cli list
    ;;
  approve|a|yes|y)
    owner_cli y "${1:-}"
    ;;
  deny|reject|n|no)
    owner_cli n "${1:-}"
    ;;
  show)
    owner_cli show "${1:-}"
    ;;
  backup)       bash "$ROOT_DIR/scripts/backup/backup.sh" "$@" ;;
  restore)      bash "$ROOT_DIR/scripts/backup/restore.sh" "$@" ;;
  update)
    cd "$ROOT_DIR"
    git pull --ff-only
    bash "$S/bootstrap.sh"
    ;;
  doctor)
    bash "$S/status.sh"
    echo
    echo "── проверки ──"
    printf 'каталог кода: %s\n' "$ROOT_DIR"
    printf 'node: %s\n' "$(node -v 2>/dev/null || echo 'нет')"
    printf 'сборка сервера: %s\n' "$([[ -f "$ROOT_DIR/apps/server/dist/index.js" ]] && echo есть || echo НЕТ)"
    printf 'свободно на диске: %s\n' "$(df -h "$HOME" | awk 'NR==2 {print $4}')"
    printf 'секреты: %s\n' "$(ls "$HOME/.elian/secrets" 2>/dev/null | wc -l) файлов"
    ;;
  uninstall)
    cat <<'EOT'
Удаление (данные и переписка будут потеряны):
  bash scripts/termux/stop.sh
  rm -rf ~/.elian ~/elian-src
  rm -f "$PREFIX/bin/elian"
Сначала сделайте бэкап: elian backup
EOT
    ;;
  help|--help|-h|*)
    cat <<'EOT'
Элиан — управление сервером на телефоне

  elian start          запустить сервер и туннель
  elian stop           остановить
  elian restart        перезапустить
  elian status         состояние, публичный адрес, ресурсы
  elian url            только публичная ссылка
  elian logs [server|tunnel] [N]   последние N строк лога (по умолчанию 80)
  elian console        консоль владельца (подтверждение входов: y / n)
  elian pending        кто ждёт подтверждения (код, логин, тип)
  elian approve [код]  подтвердить регистрацию/вход (без кода — единственный запрос)
  elian deny [код]     отклонить запрос
  elian backup         зашифрованный бэкап в ~/.elian/backups
  elian update         git pull + пересборка (bootstrap)
  elian doctor         диагностика: процесс, сборка, диск, секреты
EOT
    ;;
esac
