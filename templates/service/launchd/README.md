# Service recipe: macOS launchd LaunchAgent

Run a BYOK SDK-based daemon as a background macOS service using a per-user
[launchd](https://www.launchd.info) **LaunchAgent** — the OS restarts it on
crash, starts it at login, and gives you `launchctl print`/log files for
observability. This is a **reference recipe**: `@byok/client` is an npm
library (Decision-6 boundary — see the repo root docs), and the SDK itself
never installs a service on your behalf outside of what `byok-agent install`
does when you run it.

## Quick start

```bash
byok-agent install --config /path/to/your/config.json
```

That's it — this generates
`~/Library/LaunchAgents/<productId>.plist` (pointing at
`node <byok-agent entry> start --config <absolute path>`), loads it via
`launchctl bootstrap`, enables it, and kickstarts it. Check on it any time:

```bash
byok-agent service-status --config /path/to/your/config.json
byok-agent service-stop    --config /path/to/your/config.json   # stop without uninstalling
byok-agent service-start   --config /path/to/your/config.json   # start again
byok-agent uninstall       --config /path/to/your/config.json   # stop + remove entirely
```

`--name <svc>` overrides the derived label (default: your config's
`productId`) if you need something else, e.g. to run multiple installs side
by side. See `packages/client/src/bin/commands/service.ts` for every flag
(`--agent-bin`/`--node-bin` overrides for a custom install layout).

## What gets generated

A plist along these lines (see `packages/client/src/lifecycle/launchd.ts`'s
`generateLaunchdPlist` for the exact, unit-tested template):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>your-product-id</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/node</string>
    <string>/path/to/byok-agent.js</string>
    <string>start</string>
    <string>--config</string>
    <string>/absolute/path/to/config.json</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/you</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>~/.byok/<productId>/service-logs/your-product-id.out.log</string>
  <key>StandardErrorPath</key>
  <string>~/.byok/<productId>/service-logs/your-product-id.err.log</string>
</dict>
</plist>
```

- **`KeepAlive.SuccessfulExit: false`** is the crash-restart mechanism: launchd
  restarts the job only when it exits non-zero/is killed, not after a clean
  `exit(0)`. This is delegated entirely to launchd — the SDK never runs its
  own in-process supervisor.
- **`RunAtLoad`** starts it immediately on `launchctl bootstrap`, and again on
  every login.
- Logs land under `~/.byok/<productId>/service-logs/` alongside the daemon's
  own `~/.byok/<productId>/audit.jsonl` — tail them with `tail -f`.

## What the CLI does under the hood

`launchctl`'s modern subcommand interface, targeting the per-user GUI domain
(`gui/<uid>`) rather than the legacy `load`/`unload`:

| CLI command | launchctl calls |
|---|---|
| `install` | write plist -> `bootout` (best-effort) -> `bootstrap` -> `enable` -> `kickstart -k` |
| `uninstall` | `bootout` (best-effort) -> remove plist file |
| `service-start` | `bootstrap` (best-effort, "already loaded" is fine) -> `kickstart -k` |
| `service-stop` | `bootout` (best-effort) |
| `service-status` | `launchctl print gui/<uid>/<label>` |

`service-stop`/`service-start` are implemented as `bootout`/`bootstrap`
(full unload/reload), not a signal `kill` — killing the process directly
would just have `KeepAlive` restart it immediately, since that's the same
mechanism as the crash-restart guarantee working as designed.

## Verifying it yourself

```bash
templates/service/launchd/smoke-test.sh
```

Installs a scratch-labeled (`com.byok.smoketest.$$`), throwaway LaunchAgent
running a harmless placeholder command, asserts real `launchctl print`
output shows it loaded and running, stops it, starts it again, uninstalls
it, and asserts it's really gone — then cleans up unconditionally (even on
failure). This is the same script used to verify this recipe on a real
macOS machine during M3-4's own development.

## What's explicitly out of scope

Per Decision-6, this SDK ships **only the npm library**. This recipe (and
the SDK) do not cover, and never will: code signing/notarization of your own
launcher, distribution, or auto-update. Those are your product's
responsibility.
