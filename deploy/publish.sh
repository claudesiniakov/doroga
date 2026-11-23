#!/usr/bin/env bash
set -euo pipefail

repository=${DOROGA_REPOSITORY:-/root/doroga-bare.git}
document_root=${DOROGA_DOCUMENT_ROOT:-/var/www/doroga}
state=${STATE_DIRECTORY:-/var/lib/doroga-deploy}
preview_url=${DOROGA_PREVIEW_URL:-https://127.0.0.1:8093/proto.html}

mkdir -p "$state"
exec 9>"$state/deploy.lock"
flock 9

revision=$(git --git-dir="$repository" rev-parse --verify 'refs/heads/main^{commit}')
if [[ -f "$state/revision" && $(cat "$state/revision") == "$revision" ]]; then
  exit 0
fi

build=$(mktemp -d "$state/build.XXXXXXXX")
trap 'rm -rf -- "$build"' EXIT
git --git-dir="$repository" archive "$revision" | tar -xf - -C "$build"
cd "$build"
npm ci --no-audit --no-fund
npm run build
test -s dist/index.html
test -s dist/proto.html

# Сначала публикуем ассеты, чтобы все версии HTML могли загрузить свои файлы.
rsync -a --chmod=D755,F644 dist/assets/ "$document_root/assets/"
rsync -a --chmod=D755,F644 --exclude='/assets/' dist/ "$document_root/"
curl --noproxy '*' --insecure --fail --silent --show-error --max-time 15 \
  "$preview_url" --output served-proto.html
cmp dist/proto.html served-proto.html

printf '%s\n' "$revision" > "$state/revision.tmp"
mv -f "$state/revision.tmp" "$state/revision"
printf 'Doroga deployed %s\n' "$revision"
