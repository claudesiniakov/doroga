#!/usr/bin/env bash
set -euo pipefail

deploy_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
hook=/root/doroga-bare.git/hooks/post-receive
backup="$hook.legacy"

if [[ -e "$hook" && -e "$backup" ]]; then
  printf 'Cannot archive existing hook: %s already exists\n' "$backup" >&2
  exit 1
fi

install -D -m 755 "$deploy_dir/publish.sh" /usr/local/libexec/doroga-publish
install -m 644 "$deploy_dir"/systemd/doroga-deploy.* /etc/systemd/system/
systemctl daemon-reload

# Отключаем старую выкладку после первой успешной проверки новой службы.
systemctl start doroga-deploy.service
if [[ -e "$hook" ]]; then
  mv -- "$hook" "$backup"
fi
systemctl enable --now doroga-deploy.path doroga-deploy.timer
