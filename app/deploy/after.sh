#!/usr/bin/env bash
# peppermint's helper commands, written by the template's install.sh before the restart. HOST_NAME comes from app.env.
# The accounts module's commands (docs/accounts.md) run against the live database as the service's own dynamic user,
# through systemd-run, so they never leave root-owned database files behind:
#   peppermint-invite <name> [--admin]    a new reader and the link for their first passkey
#   peppermint-reset-passkeys [name]      a one-hour link that replaces that reader's passkeys (a lost phone)
#   peppermint-members                    who is here, their role, and open links
set -euo pipefail
for cmd in invite reset-passkeys members; do
  cat > "/usr/local/bin/peppermint-$cmd" <<WRAP
#!/usr/bin/env bash
[ \$EUID -eq 0 ] || { echo "run as root" >&2; exit 1; }
exec systemd-run --quiet --pipe --wait --collect -p DynamicUser=yes -p User=peppermint -p StateDirectory=peppermint \
  -p EnvironmentFile=-/etc/peppermint.env -E PEPPERMINT_ORIGIN=https://$HOST_NAME -E PEPPERMINT_DB=/var/lib/peppermint/peppermint.db \
  -E PEPPERMINT_DIST=/usr/local/lib/peppermint/dist -E PEPPERMINT_NO_SCHEDULER=1 -E HOME=/var/lib/peppermint \
  /usr/local/lib/peppermint/peppermint $cmd "\$@"
WRAP
  chmod 755 "/usr/local/bin/peppermint-$cmd"
done
