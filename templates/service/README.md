# Running the agent daemon as a background service

The `@byok-sdk/client` lifecycle API (`createServiceLifecycle`) installs the daemon
as a real OS-supervised background service. Copy the platform recipe that fits
your target:

| Platform | Recipe | Mechanism |
|----------|--------|-----------|
| macOS | [`launchd/`](./launchd/) | `launchd` LaunchAgent (`KeepAlive` crash-restart) |
| Linux | [`systemd/`](./systemd/) | `systemd --user` unit (`Restart=always`, `RestartPreventExitStatus=0`) |
| Windows | [`winsw/`](./winsw/) | [WinSW](https://github.com/winsw/winsw) service (SCM-integrated, `onfailure` restart) |

Crash-restart is delegated entirely to the OS supervisor — the daemon runs no
in-process supervisor of its own. The generated program runs `byok-agent start
--service`, whose exit code tells the supervisor what happened: 1 is a crash
(restarted), 0 is a normal stop or a halt (a revoked device, an unpaired
store, a rejected handshake, an invalid config: conditions a restart cannot
fix, so the service stays stopped). `byok-agent service-status` and `doctor`
show the halt reason and its remedy. Network outages never end the process:
the daemon reconnects on its own. A service installed before this
`--service` argument existed keeps restarting on a halt until `byok-agent
install` is run again. Signing, notarization, and distribution of any
bundled binary (e.g. `WinSW.exe`) are the product's responsibility, not the
SDK's.

## Environment and runtime observations

The generated `start --service` argument is shared by launchd, systemd and
WinSW. macOS/Linux capture the passwd login shell (sh/bash/zsh/ksh/dash/fish)
once before daemon startup; Windows keeps the inherited service-account
environment. The authenticated daemon status and the `environment-resolved`
event expose only closed source/failure values, shell basename and duration.
Online `status`/`doctor`/support bundles use daemon startup runtime observations;
`runtimes` remains an explicit local probe. Offline `status` uses timestamped
audit observations, while offline diagnostics label probes `local-shell`.

## Running multiple agents on one machine

The frozen wire reserves `task.claim.agentId` (optional) for a future
multiple-agents-under-one-daemon model, but that identity is not populated yet.
Today the supported way to run **N agents on one computer is N independent
daemons** — one service instance per agent, each with its own isolated config:

- **distinct `storeDir`** — device keypair, JWT, cursor, and journal state
  live here; sharing it would collide two agents' device identities.
  (Defaults to a per-`productId` dir, so distinct `productId`s already separate;
  set `storeDir` explicitly to run two agents of the *same* product.)
- **distinct `agentHome.hostStorageRoot`** (an absolute path) — so each
  agent's Agent homes stay separate.
- **distinct service `name`** — so `install`/`uninstall`/`status` target the
  right instance (e.g. `acme-agent-1`, `acme-agent-2`).
- a distinct `deviceName` is recommended so the SaaS dashboard can tell them
  apart.

Example — two agents of one product on one Mac:

```jsonc
// agent-1.json
{ "productId": "acme", "deviceName": "mac-mini-1", "serverUrl": "https://saas.example",
  "storeDir": "~/.acme/agent-1", "agentHome": { "hostStorageRoot": "/Users/alice/acme-home/agent-1" } }
// agent-2.json — same product, fully isolated state
{ "productId": "acme", "deviceName": "mac-mini-2", "serverUrl": "https://saas.example",
  "storeDir": "~/.acme/agent-2", "agentHome": { "hostStorageRoot": "/Users/alice/acme-home/agent-2" } }
```

```sh
byok-agent install --config agent-1.json --name acme-agent-1
byok-agent install --config agent-2.json --name acme-agent-2
```

When true single-daemon multi-agent support lands, it will populate the reserved
`agentId` field — an additive, non-breaking wire change (v1 stays frozen).
