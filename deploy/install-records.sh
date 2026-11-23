#!/usr/bin/env bash
set -euo pipefail

deploy_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
site=/etc/nginx/sites-available/doroga
install -D -m 644 "$deploy_dir/../server/records.mjs" /usr/local/libexec/doroga-records.mjs
install -m 644 "$deploy_dir/systemd/doroga-records.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable doroga-records.service
systemctl restart doroga-records.service

curl --noproxy '*' --fail --silent --show-error --retry 5 --retry-connrefused \
  --max-time 10 http://127.0.0.1:8094/api/records >/dev/null

backup=$(mktemp)
cp -a -- "$site" "$backup"
trap 'rm -f -- "$backup"' EXIT
install -m 644 "$deploy_dir/nginx.conf" "$site"
if ! nginx -t || ! systemctl reload nginx; then
  cp -a -- "$backup" "$site"
  exit 1
fi

# Reload returns before the new Nginx workers are accepting connections.
curl --noproxy '*' --insecure --fail --silent --show-error --retry 5 --retry-all-errors --retry-delay 1 \
  --max-time 10 https://127.0.0.1:8093/api/records >/dev/null
