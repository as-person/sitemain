#!/bin/bash
# Ежедневный бэкап данных somov.org в закрытый репозиторий GitLab (туда же, где бэкапы ботов).
# Один скрипт на оба сервера: каждый кладёт только свою папку (dl3/ или vpsdl/), поэтому они друг другу не мешают.
#   dl3 (vdsinaRU): статистика счётчика скачиваний  -> dl3/counts.sql, dl3/counter-keys.json
#   VpsDl         : чат сайта (переписки и файлы)    -> vpsdl/chat.sql, vpsdl/files/
# Базы сохраняются SQL-текстом: git хранит только изменения за день, и можно вернуться к любому дню.
# Секреты (.env: токен бота, пароль Gmail, ключи уведомлений, ключ владельца) лежат в папках secrets/ и в GitLab
# зашифрованы git-crypt (.gitattributes). Ключ: /root/.ssh/git-crypt-key.bin на обоих серверах и копия у владельца.
# Доступ к GitLab: обычный ключ сервера (/root/.ssh/id_rsa), тот же, что у бэкапа ботов.
# Запуск: somov-backup.sh dl3|vpsdl      (cron, раз в сутки)
set -euo pipefail

PART="${1:?dl3 или vpsdl}"
REPO="${SOMOV_BACKUP_REPO:-git@gitlab.com:as-backup/somov-data.git}"
WORK=/root/somov-backup

dump() {   # целостная копия работающей базы SQLite в виде SQL-текста
  python3 - "$1" "$2" <<'EOF'
import sqlite3, sys
source = sqlite3.connect(f'file:{sys.argv[1]}?mode=ro', uri=True)
copy = sqlite3.connect(':memory:')
source.backup(copy)   # штатное копирование SQLite: безопасно, даже когда служба пишет в базу
with open(sys.argv[2], 'w', encoding='utf-8') as out:
    for line in copy.iterdump():
        out.write(line + '\n')
EOF
}

if [ ! -d "$WORK/.git" ]; then
  git clone -q "$REPO" "$WORK"
fi
cd "$WORK"
git config user.name "somov-backup ($PART)"
git config user.email "backup@somov.org"
git pull -q --rebase origin main 2>/dev/null || true   # у пустого репозитория ветки ещё нет

git-crypt unlock /root/.ssh/git-crypt-key.bin 2>/dev/null || true   # после свежего clone

# Секреты кладём, только если git-crypt на этом сервере включён: иначе они ушли бы в GitLab открытым текстом
secrets_ok() {
  git config --get filter.git-crypt.clean >/dev/null && grep -q 'secrets/\*\* filter=git-crypt' .gitattributes
}

mkdir -p "$PART"
case "$PART" in
  dl3)
    dump /var/lib/private/somov-counter/counts.db dl3/counts.sql
    cp /var/lib/private/somov-counter/counter-keys.json dl3/ 2>/dev/null || true
    SECRETS=(/etc/somov-counter.env)
    ;;
  vpsdl)
    dump /var/lib/private/somov-chat/chat.db vpsdl/chat.sql
    mkdir -p vpsdl/files
    rsync -a --delete /var/lib/private/somov-chat/files/ vpsdl/files/ 2>/dev/null \
      || cp -a /var/lib/private/somov-chat/files/. vpsdl/files/
    SECRETS=(/etc/somov-chat.env)
    ;;
  *) echo "неизвестная часть: $PART" >&2; exit 2 ;;
esac

if secrets_ok; then
  mkdir -p "$PART/secrets"
  for f in "${SECRETS[@]}"; do [ -f "$f" ] && cp "$f" "$PART/secrets/"; done
else
  echo "$(date +'%F %T') $PART: git-crypt не включён, секреты НЕ отправлены" >&2
fi

git add -A "$PART"
# Последняя проверка: ни один файл из secrets/ не должен уйти незашифрованным
if git-crypt status -e 2>/dev/null | grep -q 'not encrypted'; then
  echo "$(date +'%F %T') $PART: найден незашифрованный секрет, отправка отменена" >&2
  git reset -q
  exit 1
fi
if git diff --cached --quiet; then
  echo "$(date +'%F %T') $PART: изменений нет"
  exit 0
fi
git commit -q -m "$PART: $(date +'%F %T')"
for attempt in 1 2 3; do   # второй сервер мог отправить своё за секунду до нас
  if git push -q origin HEAD:main; then
    echo "$(date +'%F %T') $PART: отправлено"
    exit 0
  fi
  git pull -q --rebase origin main
done
echo "$(date +'%F %T') $PART: отправить не удалось" >&2
exit 1
