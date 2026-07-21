# Service recipe: Linux systemd user unit

Run a BYOK SDK-based daemon as a background Linux service using a
[systemd](https://www.freedesktop.org/software/systemd/man/systemd.html)
**user unit** (`~/.config/systemd/user/`) — no root required, matching
macOS's per-user LaunchAgent and Windows' per-machine Windows Service each
doing the idiomatic "run this in the background for me" thing for their own
platform. This is a **reference recipe**: `@byok/client` is an npm library
(Decision-6 boundary — see the repo root docs).

## Quick start

```bash
byok-agent install --config /path/to/your/config.json
```

This generates `~/.config/systemd/user/<productId>.service` (pointing at
`node <byok-agent entry> start --config <absolute path>`), runs
`systemctl --user daemon-reload`, then `systemctl --user enable --now` (both
enables it to survive logout/reboot and starts it immediately). Check on it
any time:

```bash
byok-agent service-status --config /path/to/your/config.json
byok-agent service-stop    --config /path/to/your/config.json   # stop without uninstalling
byok-agent service-start   --config /path/to/your/config.json   # start again
byok-agent uninstall       --config /path/to/your/config.json   # stop + remove entirely
```

`--name <svc>` overrides the derived unit name (default: your config's
`productId`). See `packages/client/src/bin/commands/service.ts` for every
flag.

### Headless boxes: enable lingering first

A systemd **user** instance normally only runs while you're logged in. On a
headless server, enable lingering once (as root, or via sudo) so your user
unit survives logout and starts on boot:

```bash
sudo loginctl enable-linger "$USER"
```

Without this, `systemctl --user ...` may fail outright with something like
`Failed to connect to bus: No such file or directory` — that is an
environmental precondition, not something this SDK can paper over.

## What gets generated

A unit file along these lines (see
`packages/client/src/lifecycle/systemd.ts`'s `generateSystemdUnit` for the
exact, unit-tested template):

```ini
[Unit]
Description=Your Product Name

[Service]
Type=simple
ExecStart="/path/to/node" "/path/to/byok-agent.js" "start" "--config" "/absolute/path/to/config.json"
WorkingDirectory=/home/you
Restart=on-failure
RestartSec=10
StandardOutput=append:/home/you/.byok/<productId>/service-logs/<productId>.out.log
StandardError=append:/home/you/.byok/<productId>/service-logs/<productId>.err.log

[Install]
WantedBy=default.target
```

- **`Restart=on-failure` + `RestartSec=10`** is the crash-restart mechanism,
  delegated entirely to systemd — the SDK never runs its own in-process
  supervisor.
- Every `ExecStart=` token is double-quoted (with embedded quotes/backslashes
  escaped) unconditionally, so a config path containing spaces is never
  misparsed.
- `StandardOutput`/`StandardError` are pointed at append-mode files under
  `~/.byok/<productId>/service-logs/` for parity with the launchd/WinSW
  recipes and easy `tail -f`ing. systemd's own native mechanism — the
  journal — still works unconditionally alongside this:
  `journalctl --user -u <productId> -f`.

## What the CLI does under the hood

| CLI command | systemctl calls |
|---|---|
| `install` | write unit file -> `daemon-reload` -> `enable --now` |
| `uninstall` | `disable --now` (tolerates already-absent; a **real** failure aborts and leaves the unit file intact so the service is never orphaned) -> remove unit file -> `daemon-reload` (best-effort) |
| `service-start` | `start` |
| `service-stop` | `stop` (best-effort) |
| `service-status` | `is-active` (exit code + stdout drive `running`); the unit file's presence on disk drives `installed` |

## Verifying it yourself

Unit-test the exact generated content
(`packages/client/src/__tests__/lifecycle-systemd.test.ts`) run on every
push regardless of host OS. If you have systemd tooling available locally
(any Linux desktop, or WSL with systemd enabled), you can additionally lint
a generated unit with systemd's own validator:

```bash
systemd-analyze verify /path/to/generated-unit.service
```

This SDK's own CI does not run a dedicated Linux systemd install job today
(unlike the Windows WinSW job — see `templates/service/winsw/`) — the
generated-content unit tests plus this manual `systemd-analyze verify` step
are the verification path for this recipe.

## What's explicitly out of scope

Per Decision-6, this SDK ships **only the npm library**. This recipe (and
the SDK) do not cover, and never will: packaging/distribution of your own
launcher, or auto-update. Those are your product's responsibility.
