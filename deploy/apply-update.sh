#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE="slaboetelo"
APP_DIR="/opt/slaboetelo/releases/20261022"
DATA_DIR="/var/lib/slaboetelo"
ARCHIVE="${1:-/root/slaboetelo-update-2026-10-23-coach-telegram.zip}"
BACKUP_ROOT="/var/backups/slaboetelo"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$BACKUP_ROOT/$STAMP"
STOPPED=0
UPDATE_STARTED=0
TEMP_DIR=""

fail() {
  printf 'ОШИБКА: %s\n' "$1" >&2
  exit 1
}

restore_and_start() {
  local status=$?
  if [[ "$status" -ne 0 && "$STOPPED" -eq 1 ]]; then
    if [[ "$UPDATE_STARTED" -eq 1 ]]; then
      printf 'Обновление не прошло проверку. Восстанавливаю предыдущие файлы…\n' >&2
      tar -xzf "$BACKUP_DIR/app-before.tar.gz" -C "$APP_DIR" || printf 'Не удалось автоматически восстановить код из %s\n' "$BACKUP_DIR/app-before.tar.gz" >&2
      tar -xzf "$BACKUP_DIR/data-before.tar.gz" -C "$DATA_DIR" || printf 'Не удалось автоматически восстановить данные из %s\n' "$BACKUP_DIR/data-before.tar.gz" >&2
    fi
    systemctl start "$SERVICE" || printf 'Сервис не запустился автоматически. Проверь systemctl status %s\n' "$SERVICE" >&2
  fi
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then rm -rf -- "$TEMP_DIR"; fi
  return "$status"
}
trap restore_and_start EXIT

[[ "$EUID" -eq 0 ]] || fail 'Запусти скрипт от root.'
[[ -f "$ARCHIVE" ]] || fail "Не найден архив: $ARCHIVE"
[[ -d "$APP_DIR" ]] || fail "Не найден каталог приложения: $APP_DIR"
[[ -f "$DATA_DIR/accounts.json" ]] || fail "Не найдена база аккаунтов: $DATA_DIR/accounts.json. Остановился без изменений."
command -v unzip >/dev/null || fail 'На сервере не найден unzip.'
command -v tar >/dev/null || fail 'На сервере не найден tar.'
command -v curl >/dev/null || fail 'На сервере не найден curl.'
command -v sha256sum >/dev/null || fail 'На сервере не найден sha256sum.'

actual_workdir="$(systemctl show --property=WorkingDirectory --value "$SERVICE")"
[[ "$actual_workdir" == "$APP_DIR" ]] || fail "WorkingDirectory сервиса сейчас '$actual_workdir', ожидался '$APP_DIR'. Ничего не менял."
service_environment="$(systemctl show --property=Environment --value "$SERVICE")"
[[ "$service_environment" == *"RITM_DATA_DIR=$DATA_DIR"* ]] || fail "В окружении сервиса не найден RITM_DATA_DIR=$DATA_DIR. Ничего не менял."

# Avoid overwriting a remote checkout that differs from the last supplied release.
require_baseline_hash() {
  local relative_path="$1"
  local expected_hash="$2"
  [[ -f "$APP_DIR/$relative_path" ]] || fail "Не найден исходный файл $relative_path. Ничего не менял."
  local actual_hash
  actual_hash="$(sha256sum "$APP_DIR/$relative_path" | awk '{print $1}')"
  [[ "$actual_hash" == "$expected_hash" ]] || fail "Файл $relative_path отличается от исходного релиза; остановился без изменений."
}
require_baseline_hash index.html 15bee11b7b6dd54f0233ba34529412c52275bf61b8296a52002f94bd312b2599
require_baseline_hash server.mjs 181719d0290efb3dca5e2dfcec22ea9d121d1c568647b6fec104e80e9d18076d
require_baseline_hash coach.js 55c79d67dd7f2cb06d4b35c910c936e62b5cb73b13f7afd379ab23ec1a3ac86e
require_baseline_hash privacy.html 4158f31dde973948dae5ede7c891a57fb49cc4e878b835865cd23119a4535788
unzip -tqq "$ARCHIVE" || fail 'Архив повреждён или не читается.'

TEMP_DIR="$(mktemp -d /tmp/slaboetelo-update.XXXXXX)"
unzip -q "$ARCHIVE" -d "$TEMP_DIR"
UPDATE_FILES=(
  index.html
  server.mjs
  coach.js
  privacy.html
  deploy/configure-telegram-webhook.mjs
  deploy/TELEGRAM-SETUP.txt
)
for relative_path in "${UPDATE_FILES[@]}"; do
  [[ -f "$TEMP_DIR/$relative_path" ]] || fail "В архиве отсутствует обязательный файл: $relative_path"
done
umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_ROOT" "$BACKUP_DIR"
APP_BACKUP_PATHS=()
for relative_path in "${UPDATE_FILES[@]}"; do
  [[ -e "$APP_DIR/$relative_path" ]] && APP_BACKUP_PATHS+=("$relative_path")
done
tar -czf "$BACKUP_DIR/app-before.tar.gz" -C "$APP_DIR" "${APP_BACKUP_PATHS[@]}"
chmod 600 "$BACKUP_DIR/app-before.tar.gz"

systemctl stop "$SERVICE"
STOPPED=1
DATA_BACKUP_PATHS=(accounts.json)
[[ -d "$DATA_DIR/avatars" ]] && DATA_BACKUP_PATHS+=(avatars)
tar -czf "$BACKUP_DIR/data-before.tar.gz" -C "$DATA_DIR" "${DATA_BACKUP_PATHS[@]}"
chmod 600 "$BACKUP_DIR/data-before.tar.gz"

UPDATE_STARTED=1
for relative_path in "${UPDATE_FILES[@]}"; do
  install -D -m 0644 "$TEMP_DIR/$relative_path" "$APP_DIR/$relative_path"
done

node --check "$APP_DIR/server.mjs"
node --check "$APP_DIR/deploy/configure-telegram-webhook.mjs"
nginx -t
systemctl start "$SERVICE"
STOPPED=0
sleep 2
if ! systemctl is-active --quiet "$SERVICE"; then
  systemctl stop "$SERVICE" || true
  STOPPED=1
  fail 'Сервис не перешёл в active; начинаю откат.'
fi
if ! curl --fail --silent --show-error --max-time 10 -o /dev/null http://127.0.0.1:8766/; then
  systemctl stop "$SERVICE" || true
  STOPPED=1
  fail 'Локальная проверка HTTP на 127.0.0.1:8766 не прошла; начинаю откат.'
fi
for route in /privacy /privacy-policy; do
  if ! curl --fail --silent --show-error --max-time 10 -o /dev/null "http://127.0.0.1:8766$route"; then
    systemctl stop "$SERVICE" || true
    STOPPED=1
    fail "Локальная проверка $route не прошла; начинаю откат."
  fi
done
api_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 http://127.0.0.1:8766/api/telegram/settings || true)"
if [[ "$api_status" != "401" ]]; then
  systemctl stop "$SERVICE" || true
  STOPPED=1
  fail "Проверка маршрута Telegram API вернула HTTP $api_status вместо ожидаемого 401 без сессии; начинаю откат."
fi

STOPPED=0
printf 'Обновление завершено. Сервис %s активен; HTTP-проверка пройдена.\n' "$SERVICE"
printf 'Защищённая резервная копия перед обновлением: %s\n' "$BACKUP_DIR"
printf 'Для отката сохрани эту папку и сообщи мне её путь.\n'
