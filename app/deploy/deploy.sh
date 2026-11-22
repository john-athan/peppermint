#!/usr/bin/env bash
# Build the app for Linux and install it on the home server. oss-kit owns this file (templates/shared/bun-app/):
# what differs between apps is in deploy/app.env and the files next to it, see deploy/README.md.
#   deploy/deploy.sh            build, copy, restart, check
set -euo pipefail
cd "$(dirname "$0")/.."
. deploy/app.env
H="${DEPLOY_HOST:-$SSH_HOST}"   # ssh alias in ~/.ssh/config; toolbox/home/README.md says how it is reached
OUT=build-linux
D="/tmp/$NAME.deploy"
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
remote() { ssh "$H" "NAME=$NAME bash $D/install.sh $1"; }

say "build"
bun run build.ts
rm -rf "$OUT" && mkdir -p "$OUT"
bun build --compile --minify --target=bun-linux-x64 server/main.ts --outfile "$OUT/$NAME"
cp -R dist "$OUT/dist"
rm -f "$OUT/dist/$NAME"   # `bun run compile` leaves a macOS binary there
COPYFILE_DISABLE=1 tar --no-xattrs -C "$OUT" -czf "$OUT.tgz" "$NAME" dist

say "copy"
ssh "$H" "rm -rf $D && mkdir -p $D"
COPYFILE_DISABLE=1 tar --no-xattrs -C deploy --exclude .DS_Store -cf - . | ssh "$H" "tar -C $D -xf -"
scp -q "$OUT.tgz" "$H:$D/"

# packages, the service user and its folders come first: the synced files below land in them
say "prepare"
remote setup

for pair in ${SYNC:-}; do   # SYNC="models:/var/lib/monet/models": a local folder, rsynced before the restart so the new server finds it
  [[ -d "${pair%%:*}" ]] || continue
  say "sync ${pair%%:*}"
  rsync -a --partial --exclude '.*' --exclude '*.log' "${pair%%:*}/" "$H:${pair#*:}/"
  [[ -z "${SERVICE_USER:-}" ]] || ssh "$H" "id $SERVICE_USER >/dev/null 2>&1 && chown -R $SERVICE_USER:$SERVICE_USER ${pair#*:} || true"
done

say "install"
remote install

say "public check"
code=$(curl -sS -o /dev/null -w "%{http_code}" "$PUBLIC_URL")
echo "$PUBLIC_URL -> $code (expected $PUBLIC_EXPECT${PUBLIC_NOTE:+, $PUBLIC_NOTE})"
[[ "$code" == "$PUBLIC_EXPECT" ]] || { echo "the public check failed" >&2; exit 1; }
