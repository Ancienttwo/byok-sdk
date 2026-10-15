#!/usr/bin/env bash
set -euo pipefail

if (( $# == 0 )); then
  printf 'usage: with-secret-service.sh command [args...]\n' >&2
  exit 64
fi

# Each Linux CI job owns a fresh runner. Keep its native credential provider
# inside this command's private D-Bus session, and preserve the command's exit.
exec dbus-run-session -- bash -euo pipefail -c '
  printf "%s" "byok-ci-ephemeral" | gnome-keyring-daemon --unlock >/dev/null
  gnome-keyring-daemon --start --components=secrets >/dev/null
  exec "$@"
' byok-ci-secret-service "$@"
