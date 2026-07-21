#!/usr/bin/env bash
set -euo pipefail

# templates/service/launchd/smoke-test.sh
#
# Real, end-to-end proof that a generated launchd LaunchAgent actually
# installs/runs/uninstalls on this machine -- the M3-4 verification this
# recipe exists to make copy-paste-repeatable for a product, the same way
# templates/packaging/{bun,sea}/smoke-test.sh do for the packaging recipes.
#
# Runs a harmless placeholder command (`node -e 'setInterval(() => {},
# 60000)'`) rather than the real `byok-agent start`, deliberately: this
# proves the SERVICE LIFECYCLE MECHANICS (plist generation, launchctl
# bootstrap/bootout, RunAtLoad + KeepAlive) in isolation from whether the
# daemon is actually paired to a server, which is a separate concern already
# covered by this repo's own daemon/*.test.ts suite. `byok-agent install`
# (the real CLI subcommand -- see `packages/client/src/bin/commands/service.ts`)
# points the SAME generator at the real `byok-agent start --config <path>`
# command by default; only this smoke substitutes a deterministic
# placeholder so "status reports running" never races against the daemon's
# own (expected, in this throwaway setup) pairing failure.
#
# Usage: templates/service/launchd/smoke-test.sh
#   Requires @byok/client already built (`pnpm --filter @byok/client build`).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CLIENT_DIST="$REPO_ROOT/packages/client/dist/index.js"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "SKIP: launchd is macOS-only (this host is $(uname -s))"
  exit 0
fi

if [ ! -f "$CLIENT_DIST" ]; then
  echo "FAIL: $CLIENT_DIST not found -- run 'pnpm --filter @byok/client build' first"
  exit 1
fi

LABEL="com.byok.smoketest.$$"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/byok-launchd-smoke.XXXXXX")"
LOG_DIR="$WORK_DIR/logs"
UID_NUM="$(id -u)"

cleanup() {
  # Best-effort: bootout the test label regardless of how far the script
  # got (a failed assertion mid-script must never leave a scratch
  # LaunchAgent loaded on the developer's real machine).
  launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true
  rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

RUNNER="$WORK_DIR/run.mjs"
cat > "$RUNNER" <<EOF
import { createServiceLifecycle } from '$CLIENT_DIST';

const lifecycle = createServiceLifecycle({
  name: '$LABEL',
  displayName: 'BYOK launchd smoke test',
  program: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 60000)'] },
  logDir: '$LOG_DIR',
});

const mode = process.argv[2];
if (mode === 'install') await lifecycle.install();
else if (mode === 'status') console.log(JSON.stringify(await lifecycle.status()));
else if (mode === 'start') await lifecycle.start();
else if (mode === 'stop') await lifecycle.stop();
else if (mode === 'uninstall') await lifecycle.uninstall();
else { console.error('unknown mode: ' + mode); process.exit(1); }
EOF

echo "==> installing scratch LaunchAgent (label=$LABEL)"
node "$RUNNER" install

echo "==> real launchctl print output right after install:"
launchctl print "gui/$UID_NUM/$LABEL"

echo "==> waiting for the placeholder process to report running..."
for _ in 1 2 3 4 5; do
  STATUS_JSON="$(node "$RUNNER" status)"
  echo "    status: $STATUS_JSON"
  if echo "$STATUS_JSON" | grep -q '"running":true'; then
    break
  fi
  sleep 1
done
if ! echo "$STATUS_JSON" | grep -q '"installed":true'; then
  echo "FAIL: expected installed:true, got: $STATUS_JSON"
  exit 1
fi
if ! echo "$STATUS_JSON" | grep -q '"running":true'; then
  echo "FAIL: expected running:true after install, got: $STATUS_JSON"
  exit 1
fi
echo "PASS: installed + running after install"

echo "==> stopping"
node "$RUNNER" stop
STATUS_JSON="$(node "$RUNNER" status)"
echo "    status: $STATUS_JSON"
if ! echo "$STATUS_JSON" | grep -q '"running":false'; then
  echo "FAIL: expected running:false after stop, got: $STATUS_JSON"
  exit 1
fi
echo "PASS: running:false after stop (plist still present: $(echo "$STATUS_JSON" | grep -o '"installed":[a-z]*'))"

echo "==> starting again"
node "$RUNNER" start
for _ in 1 2 3 4 5; do
  STATUS_JSON="$(node "$RUNNER" status)"
  if echo "$STATUS_JSON" | grep -q '"running":true'; then
    break
  fi
  sleep 1
done
if ! echo "$STATUS_JSON" | grep -q '"running":true'; then
  echo "FAIL: expected running:true after start, got: $STATUS_JSON"
  exit 1
fi
echo "PASS: running:true again after explicit start"

echo "==> uninstalling"
node "$RUNNER" uninstall
STATUS_JSON="$(node "$RUNNER" status)"
echo "    status: $STATUS_JSON"
if ! echo "$STATUS_JSON" | grep -q '"installed":false'; then
  echo "FAIL: expected installed:false after uninstall, got: $STATUS_JSON"
  exit 1
fi
if [ -f "$HOME/Library/LaunchAgents/$LABEL.plist" ]; then
  echo "FAIL: plist file still present after uninstall"
  exit 1
fi
echo "==> real launchctl print after uninstall (expected to fail -- service is gone):"
if launchctl print "gui/$UID_NUM/$LABEL" 2>&1; then
  echo "FAIL: launchctl print unexpectedly succeeded after uninstall"
  exit 1
fi

echo "==> launchd service lifecycle smoke: PASS"
