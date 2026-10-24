#!/bin/sh
# Простой secret-scan без внешних зависимостей: ловит ключи в рабочем дереве.
# Полноценный gitleaks прогоняется в воротах R7 перед публикацией.
set -eu
cd "$(dirname "$0")/.."

PATTERNS='srz_live_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|tvly-[A-Za-z0-9]{10,}|xoxb-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----'

if grep -rInE "$PATTERNS" --exclude-dir=.git --exclude-dir=node_modules --exclude=LICENSE .; then
  echo "secret-scan: найдены подозрительные строки (см. выше)" >&2
  exit 1
fi
echo "secret-scan: чисто"
