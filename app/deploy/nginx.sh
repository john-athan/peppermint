#!/usr/bin/env bash
# Serve the app's host name on the home server: nginx on 127.0.0.1:$NGINX_PORT in front of the app on :$PORT.
# oss-kit owns this file (templates/shared/bun-app/).
#   deploy/nginx.sh             from the Mac: copies itself to kaleve-home and runs there
# Safe to run again. The site's location blocks are deploy/nginx.locations, with @PORT@ for the app's port.
#
#   Cloudflare ── tunnel kaleve-home (toolbox/home/cloudflared-home.yml) ── 127.0.0.1:$NGINX_PORT nginx ── app :$PORT
#
# TLS ends at Cloudflare and the tunnel only dials out, so this listener is plain HTTP on loopback: no certificate,
# no Cloudflare allow list, no PROXY protocol.
set -euo pipefail
cd "$(dirname "$0")"
. ./app.env

if [[ "${1:-}" != --here ]]; then
  H="${DEPLOY_HOST:-$SSH_HOST}"; D="/tmp/$NAME.nginx"
  ssh "$H" "rm -rf $D && mkdir -p $D"
  COPYFILE_DISABLE=1 tar --no-xattrs --exclude .DS_Store -cf - app.env nginx.sh nginx.locations | ssh "$H" "tar -C $D -xf -"
  ssh "$H" "bash $D/nginx.sh --here && rm -rf $D"
  exit
fi

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
command -v nginx >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx >/dev/null
rm -f /etc/nginx/sites-enabled/default
# a reload must not leave old workers serving long-lived connections with the old config for hours
grep -q worker_shutdown_timeout /etc/nginx/nginx.conf \
  || sed -i 's/^\(worker_processes.*\)$/\1\nworker_shutdown_timeout 60s;/' /etc/nginx/nginx.conf
{
  echo "# Reached only through cloudflared on loopback; TLS ends at Cloudflare."
  echo "server {"
  echo "    listen 127.0.0.1:$NGINX_PORT;"
  echo "    server_name $HOST_NAME;"
  echo
  sed "s/@PORT@/$PORT/g" nginx.locations
  echo "}"
} > "/etc/nginx/sites-available/$NAME"
ln -sf "/etc/nginx/sites-available/$NAME" "/etc/nginx/sites-enabled/$NAME"
nginx -t && systemctl reload nginx
echo "nginx: $NAME on 127.0.0.1:$NGINX_PORT"
