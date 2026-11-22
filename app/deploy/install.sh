#!/usr/bin/env bash
# The server half of deploy.sh, run as root on the home server from the folder deploy.sh copied there.
# oss-kit owns this file (templates/shared/bun-app/).
#   install.sh setup      packages, service user, folders (deploy/setup.sh, when the app has one)
#   install.sh install    swap the build in, install the unit, create the env file, restart, wait for /healthz
set -euo pipefail
cd "$(dirname "$0")"
. ./app.env
export NAME HOST_NAME PORT
LIB="/usr/local/lib/$NAME"
TOKEN_VAR="$(echo "$NAME" | tr a-z A-Z)_SETUP_TOKEN"
export DEBIAN_FRONTEND=noninteractive

case "${1:-}" in
setup)
  [ ! -f setup.sh ] || bash ./setup.sh
  ;;
install)
  mkdir -p "$LIB.new" && tar -C "$LIB.new" -xzf build-linux.tgz
  rm -rf "$LIB.prev"; [ -d "$LIB" ] && mv "$LIB" "$LIB.prev"
  mv "$LIB.new" "$LIB"
  install -m644 "$NAME.service" "/etc/systemd/system/$NAME.service"
  [ ! -f after.sh ] || bash ./after.sh
  # An app with passkeys (PASSKEYS=yes in app.env) gets a fresh setup token on its first run; later runs leave the
  # file alone. An app without a login gets neither: anzeiger's first deploy printed a passkey link for a page
  # that has no accounts.
  FRESH=0
  if [ "${PASSKEYS:-}" = yes ] && [ ! -f "/etc/$NAME.env" ]; then
    umask 077; printf "%s=%s\n" "$TOKEN_VAR" "$(head -c 18 /dev/urandom | base64 | tr "+/" "-_" | tr -d "=")" > "/etc/$NAME.env"; FRESH=1
  fi
  systemctl daemon-reload && systemctl enable --quiet "$NAME" && systemctl restart "$NAME"
  for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null && echo "healthz ok" || { journalctl -u "$NAME" -n 30 --no-pager; exit 1; }
  if [ "$FRESH" = 1 ]; then echo; echo "first run. Register your passkey at:"; echo "  https://$HOST_NAME/setup#$(sed -n "s/^$TOKEN_VAR=//p" "/etc/$NAME.env")"; fi
  rm -rf "$PWD"
  ;;
*) echo "usage: install.sh setup|install" >&2; exit 2 ;;
esac
