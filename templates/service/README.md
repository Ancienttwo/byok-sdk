# Running the agent daemon as a background service

The `@byok/client` lifecycle API (`createServiceLifecycle`) installs the daemon
as a real OS-supervised background service. Copy the platform recipe that fits
your target:

| Platform | Recipe | Mechanism |
|----------|--------|-----------|
| macOS | [`launchd/`](./launchd/) | `launchd` LaunchAgent (`KeepAlive` crash-restart) |
| Linux | [`systemd/`](./systemd/) | `systemd --user` unit (`Restart=on-failure`) |
| Windows | [`winsw/`](./winsw/) | [WinSW](https://github.com/winsw/winsw) service (SCM-integrated, `onfailure` restart) |

Crash-restart is delegated entirely to the OS supervisor — the daemon runs no
in-process supervisor of its own. Signing, notarization, and distribution of any
bundled binary (e.g. `WinSW.exe`) are the product's responsibility, not the
SDK's.

## Running multiple agents on one machine

The frozen wire reserves `task.claim.agentId` (optional) for a future
multiple-agents-under-one-daemon model, but that identity is not populated yet.
Today the supported way to run **N agents on one computer is N independent
daemons** — one service instance per agent, each with its own isolated config:

- **distinct `storeDir`** — device keypair, JWT, cursor, and session-workspace
  state live here; sharing it would collide two agents' device identities.
  (Defaults to a per-`productId` dir, so distinct `productId`s already separate;
  set `storeDir` explicitly to run two agents of the *same* product.)
- **distinct `workspaceRoot`** — so each agent's task workspaces stay separate.
- **distinct service `name`** — so `install`/`uninstall`/`status` target the
  right instance (e.g. `acme-agent-1`, `acme-agent-2`).
- a distinct `deviceName` is recommended so the SaaS dashboard can tell them
  apart.

Example — two agents of one product on one Mac:

```jsonc
// agent-1.json
{ "productId": "acme", "deviceName": "mac-mini-1", "serverUrl": "https://saas.example",
  "storeDir": "~/.acme/agent-1", "workspaceRoot": "~/acme-work/agent-1" }
// agent-2.json — same product, fully isolated state
{ "productId": "acme", "deviceName": "mac-mini-2", "serverUrl": "https://saas.example",
  "storeDir": "~/.acme/agent-2", "workspaceRoot": "~/acme-work/agent-2" }
```

```sh
byok-agent install --config agent-1.json --name acme-agent-1
byok-agent install --config agent-2.json --name acme-agent-2
```

When true single-daemon multi-agent support lands, it will populate the reserved
`agentId` field — an additive, non-breaking wire change (v1 stays frozen).
