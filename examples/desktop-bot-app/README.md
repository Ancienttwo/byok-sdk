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
| Preload | `src/preload/index.cts` | Electron only (sandboxed preload); exposes `window.byok.call` |
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
- The Host pushes `{ "event": "state" }` lines (no id) after every change: `starting`,
  `running` with its active work count, or `stopped` with a reason.
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
- Pairing happens once, in process. Whether the device is paired is the daemon's own
  enrollment authority: when `start()` halts with `unpaired`, the Host mints a code with
  `server.pairing.createPairingCode()`, calls `daemon.pair(code)` and starts again. Any
  other halt stops the Host with its reason.

A stopped Host keeps answering `status` with its reason and is not restarted. A Host
that exits unasked is restarted with backoff (1 s, doubling to 30 s; back to 1 s after
a minute of running). While the Host reports active work, main holds
`powerSaveBlocker.start('prevent-app-suspension')`.

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
