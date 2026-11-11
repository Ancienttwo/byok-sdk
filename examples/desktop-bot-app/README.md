# Desktop Bot app (private example)

A desktop reference app that SaaS teams fork: an Electron shell that supervises a
BYOK Host child process. It is private and never published. Design: #1499.

The shell and bridge (#1804) supervise a composed Host child (#1805): the embedded
server on loopback and the daemon paired to it. K8 and the Host store arrive with
#1806, the conversation UI with #1807.

## Run

```sh
bun install
bun run --filter @byok-sdk/example-desktop-bot-app dev
```

The first run downloads the Electron binary (Electron 45 fetches it on first use,
not at install). Set `electron_config_cache` to keep the download cache off a small disk.

## Processes

| Process | Code | Loads |
| --- | --- | --- |
| Electron main | `src/main/` | Electron and the bridge client only; no SDK code |
| Preload | `src/preload/index.cts` | Electron only (sandboxed preload); exposes the raw IPC as `window.byokIpc` |
| Renderer | `src/renderer/` | no Node, no SDK code; served from `app://renderer/` |
| Host child | `src/host/` | the SDK; runs under the `node` on `PATH` in dev, never under Electron |

## Bridge

`src/bridge/protocol.ts` is shared by all three processes. Main talks to the Host over
the child's stdin and stdout, one JSON message per line; the Host writes diagnostics
to stderr only.

- `hello` is the first call. Shell and Host ship in one app version, so `BRIDGE_VERSION`
  must match exactly: the Host replies `bridge_version_mismatch` and exits 1, and main
  kills a Host that answers with another version. There is no negotiation.
- Main forwards a renderer call only from the main frame of its own window on
  `app://renderer`, and only for methods in `RENDERER_METHODS`. `hello` and
  `shutdown` are main's alone. Params are validated once, by the handler that answers
  the method: the Host's, or main's for a `main` domain method.
- A refusal reaches the renderer with its code. `ipcRenderer.invoke` and the context
  bridge both keep only an error's message, so main resolves every call to
  `{ ok: true, value }` or `{ ok: false, code, message }` (`settleCall`). The renderer root
  (`src/renderer/bridge.ts`) builds `window.byok`, whose `call` rejects with a
  `BridgeCallError` carrying that `code`: a `BridgeError` code, or a custody or keys code.
  An error without a code is `method_failed`. Renderer code branches on `code`, never on
  the message.
- The Host pushes `{ "event": "state" }` lines (no id) after every change: `starting`,
  `running` with its active work count, or `stopped` with a reason. It pushes the same
  state again when a domain's views changed (`HostContext.changed`), so each domain's
  view is read again after the hint.
- Main turns those pushes, and its own `restarting`/`failed` view, into a bare hint on
  `byok:state-changed`, at most one per 50 ms burst, sent only to its own window's main
  frame on `app://renderer`. The hint carries nothing; the renderer subscribes with
  `window.byok.onStateChanged(listener)` and pulls the state with `status`. While main
  restarts the Host, that pull rejects with `host_exited`: it means the Host is restarting,
  and the next hint follows once it answers again.
- Domains add methods without editing the bridge. A domain declares its methods
  (`<domain>.<verb>`) and its renderer allowlist in `src/bridge/domains/<domain>.ts`, and
  its Host handlers in `src/host/<domain>/domain.ts`. `protocol.ts` composes the method
  types and the allowlist, and `src/host/domains.ts` composes the handlers. A method a
  domain lists as `main` is answered by main (`src/main/domains.ts`) and never reaches
  the Host. Handlers validate their own params and refuse them with `invalid_params`;
  that error, or a failing handler (`method_failed`), answers only the one call. Domain
  methods exist only while the Host runs; before that, and once shutdown begins, they are
  `unknown_method`. Shutdown waits for domain calls in flight before the domains close.
  Methods are named `<domain>.<verb>` by type, and a method two handlers answer refuses
  the composition.
- On quit, main sends `shutdown`. The app exits 0 only when the Host acknowledged it
  and exited 0; a Host still running after 10 s is killed and the app exits 1.

## Host

`src/host/supervise.ts` is the Host entry. It calls `runSdkReservedHelperCommand()`
first, so the SDK can re-enter the same executable for its helpers, then serves the
bridge and composes the Host after main's hello (`src/host/compose.ts`):

- Before any store opens, `src/host/precheck.ts` runs `inspectDaemonStores`,
  `inspectSqliteStore` and `inspectProviderProfileStore`. A keys store that reports
  `migration-required` is migrated with `migrateProviderProfileStore`; any other
  verdict than `accepted` or `absent` stops the Host with the store and its reason.
  Nothing is repaired automatically, and a refusal migrates nothing.
- The embedded server runs on SQLite (`<hostStorageRoot>/host/server.sqlite`) behind
  `listenLoopback`; its port is claimed once in `<hostStorageRoot>/host/loopback-port`.
- The daemon comes from `createDaemonWithAdapters` with `createRuntimeAdapters`. Each
  runtime takes `runtimes.<id>.runtimeEnvironment` from the login shell, because a
  desktop app starts without it; Pi gets no `PI_PACKAGE_DIR`.
- The SDK hosting values (helper re-entry, Pi package, native and Agent memory helper
  assets) come from `resolveSdkHosting` on the directory of the Host executable, where
  `scripts/package/bundle-host.mjs` writes the SDK assets in dev and in a package. A
  missing asset stops the Host with the missing paths.
- Pairing is `daemon.pairEmbedded(server)` before every start: a fresh store pairs
  against an empty server, a paired store whose device the server lists goes on, and any
  other state stops the Host with the refusal reason, as does a halt at start.
- Wakes and Agent messages the server delivers before the conversation opens wait for
  it; one still waiting when the Host closes is refused and retried on the next run.
- K8's model catalog is the `brand.config.ts` entries, then one Pi entry `pi:<profile_ref>`
  per keys profile that has `pi_model`, pinned to that profile (`catalogEntryFor`, lane
  `byok-profile`). The enabled profile is not read as a default. The catalog is built from
  the keys store at Host start and rebuilt after every custody receipt; a profile edited
  since is refused by the Pi launcher until then.

A stopped Host keeps answering `status` with its reason and is not restarted. A Host
that exits unasked is restarted with backoff (1 s, doubling to 30 s; back to 1 s after
a minute of running). While the Host reports active work, main holds
`powerSaveBlocker.start('prevent-app-suspension')`.

The app stays in the tray when its last window closes; the tray menu shows the window,
the Host's active tasks or why it is not running, and quits (which stops the Host). The
login item is the OS's own setting: main answers `settings.loginItem` and
`settings.setLoginItem` from it, and Linux has none (`supported: false`). The tray icons
in `assets/tray/` are drawn for this app; macOS uses the `Template` images.

The Settings section (`src/renderer/settings/`) shows the device, runtimes, clock skew
and the SDK doctor as the Host projects them, and runs the doctor on open and on
Refresh only. It edits the dreaming switch and model order (applied when the Host next
starts), the login item, and exports the diagnostics bundle to a file the Host names.

## Security baseline

- Windows run with `contextIsolation`, `sandbox` and no `nodeIntegration`. Navigation,
  `<webview>` and new windows are refused; a link opens in the system browser only
  when its https origin is in `brand.config.ts` `externalOrigins`. Permission requests are denied.
- The `app://` handler serves only files under the renderer directory, with a CSP that
  allows packaged resources only (`default-src 'none'`, no inline script, no network).
- Fuses (`src/main/fuses.ts`): RunAsNode, `NODE_OPTIONS` and inspect arguments off;
  asar-only loading, asar integrity and cookie encryption on. Packaging (#1811) flips
  them on the shipped binary; the CI `desktop` lane flips a copy and reads them back.

## White label

`brand.config.ts` is the only white-label entry: the product name and the external
link origins.
