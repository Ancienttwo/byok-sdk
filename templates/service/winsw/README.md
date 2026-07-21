# Service recipe: Windows Service via WinSW

Node has no native Windows Service Control Manager (SCM) control-handler in
core, so a plain `node byok-agent.js start` cannot register itself as a real
Windows Service on its own. This recipe uses
[WinSW](https://github.com/winsw/winsw) — the standard, widely-used .NET
service wrapper that runs any exe/command as a genuine Windows Service, with
full SCM integration: crash-restart, logging, boot autostart, `sc.exe`
queryability. This is a **reference recipe**: `@byok/client` is an npm
library (Decision-6 boundary — see the repo root docs).

## Decision-6 boundary: you bundle WinSW, the SDK generates the config

**This SDK never bundles or downloads the WinSW binary itself.** Your
product supplies it (download the self-contained `WinSW-x64.exe` — no .NET
runtime install needed — from
[WinSW's GitHub releases](https://github.com/winsw/winsw/releases), or pin a
specific version for reproducible builds) and passes its path to
`byok-agent install --winsw-bin <path>`. The SDK's job is generating the
correct WinSW XML service descriptor and driving install/start/stop/
uninstall correctly around it — not distributing, signing, or updating that
binary.

## Quick start

```powershell
byok-agent install --config C:\path\to\your\config.json --winsw-bin C:\path\to\WinSW-x64.exe
```

This copies `WinSW-x64.exe` into
`~/.byok/<productId>/service-logs/<productId>.exe` (WinSW's own convention:
the exe and its XML config must share a basename in the same directory — see
"What the CLI does" below for why this SDK copies rather than invokes the
product's binary in place), writes `<productId>.xml` beside it, then runs
`<productId>.exe install` followed by `<productId>.exe start`. Check on it
any time:

```powershell
byok-agent service-status --config C:\path\to\your\config.json
byok-agent service-stop    --config C:\path\to\your\config.json   # stop without uninstalling
byok-agent service-start   --config C:\path\to\your\config.json   # start again
byok-agent uninstall       --config C:\path\to\your\config.json   # stop + remove entirely
```

`--name <svc>` overrides the derived service id (default: your config's
`productId`); `--winsw-install-dir <path>` overrides where the renamed exe +
XML land (default: alongside the service's own logs). See
`packages/client/src/bin/commands/service.ts` for every flag.

## What gets generated

A WinSW XML descriptor along these lines (see
`packages/client/src/lifecycle/winsw.ts`'s `generateWinswXml` for the exact,
unit-tested template):

```xml
<service>
  <id>your-product-id</id>
  <name>Your Product Name</name>
  <description>Your Product Name (managed by byok-agent; see templates/service/winsw/README.md)</description>
  <executable>C:\Program Files\nodejs\node.exe</executable>
  <argument>C:\path\to\byok-agent.js</argument>
  <argument>start</argument>
  <argument>--config</argument>
  <argument>C:\absolute\path\to\config.json</argument>
  <logpath>C:\Users\you\.byok\your-product-id\service-logs</logpath>
  <log mode="roll"></log>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <resetfailure>1 hour</resetfailure>
</service>
```

- **`<onfailure>`** is the crash-restart mechanism, delegated entirely to
  WinSW/the SCM — the SDK never runs its own in-process supervisor. Two
  entries give an escalating backoff (10s, then 30s on repeated failures);
  `<resetfailure>1 hour</resetfailure>` forgets past failures after an hour
  of healthy running so a single old crash doesn't count against a
  since-recovered service forever.
- **One `<argument>` element per token**, not a single `<arguments>` string —
  this sidesteps shell-style quoting entirely for a config path containing
  spaces. WinSW launches `<executable>` directly with no shell involved
  (the same reasoning the pi adapter's own `execFile`-without-`shell`
  Windows note describes — see "A note on how the service invokes node"
  below), so one argument per element has no ambiguity about where a path
  boundary falls.
- **`<startmode>Automatic</startmode>`** mirrors launchd's `RunAtLoad` /
  systemd's `WantedBy=default.target`: the service also starts automatically
  on the next machine boot, not just right now.

## What the CLI does under the hood

| CLI command | What happens |
|---|---|
| `install` | copy `--winsw-bin` to `<id>.exe` + write `<id>.xml` alongside it -> `<id>.exe install` -> `<id>.exe start` |
| `uninstall` | `<id>.exe stop` (best-effort) -> `<id>.exe uninstall` (best-effort) -> delete the copied exe + xml |
| `service-start` | `<id>.exe start` |
| `service-stop` | `<id>.exe stop` (best-effort) |
| `service-status` | `sc.exe query <id>` — the real Windows SCM query tool, always present, used as authoritative ground truth rather than parsing WinSW's own `status` subcommand text |

WinSW's exe/XML-share-a-basename convention is why `install()` copies the
product-supplied binary into place under the service's own id, rather than
invoking your original `WinSW-x64.exe` directly — this is the
version-agnostic approach documented across WinSW v2/v3, rather than relying
on a `--config`-style flag that may differ between major versions.

### A note on how the service invokes node

Unrelated to WinSW itself, but worth knowing: this SDK's pi adapter's
`detect()` calls `child_process.execFile(bin.command, ['--version'])` with
no `shell: true`. Windows can't `CreateProcess` a `.cmd`/`.bat` file
directly without a shell, so if your own `node`/`byok-agent` entry ever ends
up being a `.cmd`/`.bat` wrapper rather than a real `.exe`/`.js`, detection
would silently degrade — see `templates/packaging/sea/README.md`'s "Windows
note" for the full empirically-confirmed writeup. WinSW itself has the exact
same characteristic (it launches `<executable>` directly, no shell), which
is part of why this recipe emits one `<argument>` element per token instead
of a single shell-quoted string — see above.

## Talking to the running service (M4 Phase 2: the control socket)

Once installed, the service is reachable through a local control socket — on
Windows this is a named pipe (`\\.\pipe\byok-<hash of productId+storeDir+
user>`, deterministically derived so the CLI computes the identical name
independently, no path/file involved the way a Unix socket has), authenticated
by a per-run token still written to a real file at
`<storeDir>\control.token` (mode 0600 — never transmitted over the pipe
itself, only used to compute an HMAC proof each side shows the other).
`byok-agent status`, `tasks --follow`, `unpair`, `approve`, and `reject` all
talk to the running service through this pipe automatically — no separate
flag needed — falling back to a persisted-state view (or, for `unpair`, the
`sc.exe`-based service-state check described above) whenever it isn't
reachable (the service isn't running, or predates this feature).

## Verifying it yourself

```powershell
$env:WINSW_BIN = "C:\path\to\WinSW-x64.exe"
node templates/service/winsw/smoke-test.mjs
```

Installs a scratch, PID-suffixed, throwaway service running a harmless
placeholder command, asserts `sc.exe query` reports `RUNNING`, cross-checks
`lifecycle.status()` agrees, stops it (`sc.exe query` -> `STOPPED`), starts
it again (`RUNNING`), uninstalls it, and asserts `sc.exe query` reports it
gone — cleaning up unconditionally even on failure. This is exactly what CI
runs on every push (`.github/workflows/ci.yml`'s `windows-service-smoke`
job) on a real `windows-latest` runner — this SDK's own macOS/Linux
development machines cannot execute WinSW at all, so that CI job (not a
local run) is the real proof this recipe works. It then additionally
installs a SECOND scratch service running the real `byok-agent start`
(paired against a real, ephemeral `@byok/server`) and confirms `byok-agent
status` reaches its control socket live over a Windows named pipe (M4
Phase 2 — see `packages/client/scripts/control-socket-check.mjs`), before
uninstalling that one too.

## What's explicitly out of scope

Per Decision-6, this SDK ships **only the npm library**. This recipe (and
the SDK) do not cover, and never will: bundling, downloading, code-signing,
or auto-updating the WinSW binary itself, or your own launcher's
distribution. Those are your product's responsibility.
