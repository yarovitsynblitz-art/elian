# Как выложить Элиан на GitHub (один раз, ~2 минуты)

Репозиторий уже инициализирован и закоммичен (`git log` покажет коммит «Элиан / Elian 1.0.0»).
Нужен только ваш аккаунт GitHub: создать пустой репозиторий и запушить.

## Вариант A. С компьютера/телефона, где есть git

1. Создайте на GitHub **пустой** репозиторий `elian` (без README/.gitignore/license).
2. В каталоге проекта:

```bash
git remote add origin https://github.com/<ВАШ_ЛОГИН>/elian.git
git branch -M main
git push -u origin main
```

## Вариант B. Только телефон, без git

1. Создайте пустой репозиторий `elian` на GitHub.
2. На странице репозитория: **Add file → Upload files** → перетащите `elian-1.0.0.tar.gz`
   (GitHub принимает до 25 МБ на файл, архив ~0.7 МБ) → **Commit changes**.
3. Установка идёт прямо с архива (см. ниже) — git на телефоне не нужен.

## Что получится в итоге

После публикации любой человек (и вы на новом телефоне) ставит Элиан одной командой:

```bash
# архив в репозитории (Вариант B)
cd $HOME && pkg install -y curl tar && curl -fsSLO https://github.com/<ВАШ_ЛОГИН>/elian/raw/main/elian-1.0.0.tar.gz && tar xzf elian-1.0.0.tar.gz && bash elian-1.0.0/scripts/termux/bootstrap.sh

# или прямо из git (Вариант A)
cd $HOME && pkg install -y git && git clone --depth 1 https://github.com/<ВАШ_ЛОГИН>/elian.git elian-src && bash elian-src/scripts/termux/bootstrap.sh
```

Хотите контрольную сумму — положите рядом файл `elian-1.0.0.tar.gz.sha256` и добавьте перед `tar`:
`echo "$(curl -fsSL https://github.com/<ВАШ_ЛОГИН>/elian/raw/main/elian-1.0.0.tar.gz.sha256)  elian-1.0.0.tar.gz" | sha256sum -c -`

## Обновления

Каждый релиз: соберите архив (`bash scripts/release/make-release.sh`), закоммитьте, создайте
**Releases → Draft a new release** с тегом `v1.0.0` и приложите архив. Тогда постоянная ссылка:

```
https://github.com/<ВАШ_ЛОГИН>/elian/releases/download/v1.0.0/elian-1.0.0.tar.gz
```
