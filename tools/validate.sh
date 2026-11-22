#!/bin/sh
# Every check peppermint has, by part. Run it directly, through `oss check peppermint`, or let CI call it, one part
# per job. The app's tests hold the conventions and the dependency rule too (app/tests/conventions.test.ts,
# app/tests/deps.test.ts).
#   tools/validate.sh              every part
#   tools/validate.sh app          only the server and the web app
#   tools/validate.sh android      only the Android app
set -eu
cd "$(dirname "$0")/.."

parts="${*:-app android}"
fail=0
step() { printf '\n== %s\n' "$1"; }
check() { if "$@"; then echo "ok"; else echo "FAILED: $*"; fail=1; fi; }

for part in $parts; do
  case "$part" in
    app)
      step "app: svelte, exactly as bun.lock pins it"
      check sh -c 'cd app && bun install --frozen-lockfile --silent'
      step "app: bun test --isolate"
      check sh -c 'cd app && bun test --isolate'
      step "app: the client builds"
      check sh -c 'cd app && bun run build.ts' ;;
    android)
      step "android: lint and unit tests"
      check android/tools/validate.sh ;;
    *) echo "unknown part: $part (app, android)"; exit 2 ;;
  esac
done

if [ "$fail" -ne 0 ]; then printf '\nvalidate: FAILED\n'; exit 1; fi
printf '\nvalidate: everything passes\n'
