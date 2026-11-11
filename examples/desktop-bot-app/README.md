# Desktop Bot app (private example)

A desktop reference app that SaaS teams fork: an Electron shell that supervises a
BYOK Host child process. It is private and never published. Design: #1499.

This is the shell and bridge skeleton (#1804). The Host child is a stub that answers
`hello`, `status` and `shutdown`; the composed Host arrives with #1805 and the
conversation UI with #1807.

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
| Host child | `src/bridge/stub-host.ts` (dev) | runs under the `node` on `PATH`, never under Electron |

## Bridge

`src/bridge/protocol.ts` is shared by all three processes. Main talks to the Host over
the child's stdin and stdout, one JSON message per line; the Host writes diagnostics
to stderr only.

- `hello` is the first call. Shell and Host ship in one app version, so `BRIDGE_VERSION`
  must match exactly: the Host replies `bridge_version_mismatch` and exits 1, and main
  kills a Host that answers with another version. There is no negotiation.
- Main forwards a renderer call only from the main frame of its own window on
  `app://renderer`, and only for methods in `RENDERER_METHODS`. `hello` and
  `shutdown` are main's alone. Params are validated once, in the Host.
- On quit, main sends `shutdown` and kills the Host if it has not exited within 5 s.

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
