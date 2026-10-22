# #700: where each older undici copy loads

Date: 2026-10-22. Base: main `7c0bbebc`. Published release: `0.28.2` (tag
`v0.28.2`). Repo file and line numbers refer to the base commit. Numbers for
`dist/` files refer to the published `0.28.2` packages and to Pi 1.3.0. This note
records acceptance item 2 of #700: for each older undici copy, does a consumer
install reach it at run time, and how is it fixed or why is it not reachable. It
changes no code, manifest or lock file.

## Summary

- The SDK pins are patched. `@byok-sdk/client` 0.28.2 depends on undici 8.12.3
  (`packages/client/package.json:104`). The cloud-dataplane test dependency also
  uses 8.12.3 (`packages/cloud-dataplane/package.json:62`).
- A consumer install of `@byok-sdk/client` holds two older copies. Both come
  from `@earendil-works/pi-coding-agent` 1.3.0: an exact undici 8.10.2
  dependency, and a copy inlined in the Pi CLI bundle. Pi 1.4.0 (latest) and
  upstream main still pin 8.10.2.
- The undici 7.29.0 copy comes from miniflare. No published package installs it.
- The `openai` 7.19.0 peer `undici` follows the Host tree. No SDK code path
  loads it.
- Pi's nested 8.10.2 loads in every SDK Pi host. It serves requests only when it
  owns the process-wide dispatcher slots. Load order decides that. In the ESM
  shapes it does not own them. In a CommonJS bundle of the host it does. A Host
  can build such a bundle from 0.28.2 (ESM first, then CJS, with an
  `import.meta.url` define). Main builds it in one pass and documents it (#709).
- The CJS result narrows an earlier #700 status comment. That comment says that
  the host and its single-file bundle keep Node's own dispatcher. This holds for
  ESM. It does not hold for a CJS bundle.
- A nested override of Pi's undici fixes the npm copy for a Host. It cannot fix
  the inlined copy.
- The CHANGELOG already lists all eight advisories (`CHANGELOG.md:44-52`).
- #700 stays open.

## Method

- Scratch installs of the published `0.28.2` packages: npm 11.19.0 with
  `--ignore-scripts` (all nine packages together, and `cloud-do` and
  `cloud-dataplane` alone), Bun 1.4.3 with the hoisted linker and with the
  isolated linker, and npm with an older `undici@7.28.0` at the Host root.
- `npm ls undici --all`, `bun pm ls --all`, and `grep` over the installed files.
- Run-time probes on Node v24.21.0. Node 24.22.1 was not available. Node's own
  undici in v24.21.0 is 7.29.1 (`process.versions.undici`).
- Most run-time rows below ran one real Pi print session. It used
  `runSdkReservedHelperCommand` with `pi-subagent-print` against a loopback
  provider, as in `pi-single-file-bundle.test.ts`. The provider got one request
  in each of those rows. The "Pi alone" row and the two "Emulated" rows made one
  plain `fetch()` call to a loopback server instead.

## P1: Map of the copies

| Copy | Pulled by | In a consumer install? | SDK code that loads it |
| --- | --- | --- | --- |
| undici 8.12.3 | `@byok-sdk/client` dependency, exact pin (`packages/client/package.json:104`; `bun.lock:183`) | Yes. Hoisted at the root, or nested under `@byok-sdk/client/node_modules` when the Host root holds another version. | `dist/bin/pi-runtime-host.js:8722-8744` and the sealed host (same lines): `await import('undici')` for the Gemini Web fetch. It builds its own `EnvHttpProxyAgent` and never calls `setGlobalDispatcher`. |
| undici 8.12.3 (test) | `@byok-sdk/cloud-dataplane` devDependency (`packages/cloud-dataplane/package.json:62`; `bun.lock:222`) | No. A solo install of the package holds no undici. | None. |
| undici 8.10.2 (npm) | `@earendil-works/pi-coding-agent` 1.3.0 exact dependency (`bun.lock:440`, `:1504`). The client depends on Pi exactly (`packages/client/package.json:95`). | Yes. `node_modules/@earendil-works/pi-coding-agent/node_modules/undici` in npm and in Bun hoisted. `.bun/undici@8.10.2` in Bun isolated. | Loaded, not called. See "Imports" below. |
| undici inlined in the Pi CLI bundle | Pi 1.3.0 build: `dist/bundle/chunks/chunk-66G7ITPS.js` (imported by `dist/bundle/index.js`, `cli-runtime.js`, `rpc-entry.js`) | Yes. It is a file in the Pi package. | Only when something runs the Pi `pi` bin or its `./rpc-entry` export. The SDK does that in two cases. See "Pi CLI path" below. |
| undici 7.29.0 | `miniflare` 5.20260811.1-alpha exact dependency (`bun.lock:1196`, `:1532`). `@byok-sdk/cloud-do` has `miniflare` and `wrangler` in devDependencies (`packages/cloud-do/package.json:22,24`). `@byok-sdk/cloud-dataplane` has `wrangler` in devDependencies (`packages/cloud-dataplane/package.json:63`). `wrangler` 4.123.0 depends on `miniflare`. | No. Solo installs of `cloud-do` and `cloud-dataplane` hold no undici, miniflare, wrangler or workerd. | None. Development only. |
| `openai` 7.19.0 optional peer `undici` `>=5 <9` | `@earendil-works/pi-ai` 1.3.0 depends on `openai`. `pi-ai` is a dependency of `client` and `cloud-do`. | The SDK does not install the peer. The package manager and the Host tree choose the copy. See "The openai peer". | None. See "The openai peer". |
| `undici` `^8.9.0` range | `pi-web-access` 0.24.1 (`packages/client/package.json:97`; `bun.lock:1280`) | The package installs. The SDK never imports it: `tsup.config.ts:42` inlines it, and the published dist has no import of it. | The inlined code is the Gemini Web fetch in row 1. It resolves the client's pin. |
| `undici-types`, `@google/genai`, `eventsource` | Types only; `@google/genai@2.21.0` and `eventsource@3.0.7` name undici in `devDependencies` only. | No run-time edge (`npm ls undici --all` shows none). | None. |

The repo tree (`bun pm ls --all`) shows the same three runtime copies: 8.12.3 at
the root, 8.10.2 under Pi, 7.29.0 under miniflare.

Each of the eight advisories of 2026-10-15 covers 8.0.0 up to 8.12.2 and 7.18.0
up to 7.30.1 (most start earlier). So 8.10.2 and 7.29.0 are both in range.

Pi's inlined copy has the pre-8.12.2 `Agent` shape
(`this[kOptions]={...util.deepClone(options),maxOrigins,connect}` in
`chunk-66G7ITPS.js`; no `tls`). That matches 8.10.2
(`lib/dispatcher/agent.js:44`) and not 8.12.3 (`:44-48`).

## P2: Run-time trace

### Imports

Evidence from `@byok-sdk/client@0.28.2` and `@earendil-works/pi-coding-agent@1.3.0`:

- `dist/bin/pi-runtime-host.js:18` and `pi-runtime-host-sealed.js:18` import
  `runRpcMode` and other names from `@earendil-works/pi-coding-agent`. Source:
  `packages/client/src/bin/pi-session-runtime.ts:4-6,121`,
  `pi-prepared-host.ts:18-20,903`.
- Pi `dist/index.js:24` re-exports `SettingsManager`. `dist/core/settings-manager.js:8`
  imports `./http-dispatcher.js`. `dist/index.js:39` re-exports `main` from
  `dist/main.js`, and `main.js:27` imports the same file.
- `dist/core/http-dispatcher.js:2` has `import * as undici from "undici"`. It
  resolves to Pi's nested 8.10.2. So every SDK Pi host loads 8.10.2.
- `configureHttpDispatcher()` is the only function that sets a dispatcher in
  Pi. It has these call sites: `dist/main.js:471,711`, `dist/rpc-entry.js:9`,
  `dist/cli/setup.js:10`, `dist/modes/interactive/interactive-mode.js:1562,4138`.
  The published client dist has none of `configureHttpDispatcher`, `rpc-entry`,
  `setupCli` or `InteractiveMode`.
- Result: the SDK hosts load 8.10.2 and never configure it. A probe that imports
  the published host module loads only Pi's 8.10.2. The client's 8.12.3 does not
  load at start.

### Who owns the global dispatcher

undici 8.x runs `if (getGlobalDispatcher() === undefined) setGlobalDispatcher(new Agent())`
when it loads (`lib/global.js:14-16`). `getGlobalDispatcher()` reads only slot
`Symbol.for('undici.globalDispatcher.2')`. `setGlobalDispatcher()` writes slot 2
and also overwrites slot 1 with a `Dispatcher1Wrapper` (`lib/global.js:18-55`).
Node's built-in `fetch` reads slot 1 for each request. So the first undici 8.x
copy that loads, with no earlier undici in slot 2, becomes the dispatcher of
every global `fetch` call in the process. `lib/global.js` is identical in 8.10.2
and 8.12.3.

Load order decides the owner. In an ESM graph, one static `import … from 'http'`
is enough. Node reads the lazy `WebSocket` export of `node:http` when it builds
the ESM wrapper for that built-in (trace: `get [as WebSocket] (node:http:237)`,
`lazyUndici (node:http:129)`, no JavaScript caller). The read loads Node's
built-in undici, which writes both slots. The published host imports `http` at
`dist/bin/pi-runtime-host.js:29`, after Pi at `:18`, and Node's copy still wins.
So Node builds that wrapper while it links the graph, before any module body
runs. A bare `await import('node:http')` shows the same effect; `node:https`
does not.
In CommonJS, `require('http')` does not read that export. The first undici to
evaluate wins.

| Package build | Shape | Slot writer | Request served by |
| --- | --- | --- | --- |
| 0.28.2 | ESM, unbundled | Node built-in undici | Node built-in undici |
| 0.28.2 | ESM, single file (esbuild) | Node built-in undici | Node built-in undici |
| 0.28.2 | CJS, single pass (esbuild) | Build fails: "Top-level await is currently not supported" at `dist/bin/pi-runtime-host.js:90388:80` | None |
| 0.28.2 | CJS, ESM first then CJS (the SEA template order), with an `import.meta.url` define | Pi's nested undici 8.10.2 (`lib/global.js`) | 8.10.2 `Agent` through `Dispatcher1Wrapper` |
| 0.28.2 | Same, without the define | The bundle fails at start: `fileURLToPath(undefined)` in Pi `dist/config.js` | None |
| 0.28.2 with the #709 change applied in memory | CJS, single pass | Pi's nested undici 8.10.2 (`lib/global.js`) | 8.10.2 `Agent` through `Dispatcher1Wrapper` |
| main `7c0bbebc`, client built in this checkout | ESM, unbundled and single file | Node built-in undici | Node built-in undici |
| main `7c0bbebc`, client built in this checkout | CJS, single pass, no patch | Pi's nested undici 8.10.2 (`lib/global.js`) | 8.10.2 `Agent` through `Dispatcher1Wrapper` |
| Pi `dist/index.js` alone | ESM | Pi's nested undici 8.10.2 | 8.10.2 `Agent` (a plain `fetch`) |

What this means:

- The exposure is not new on main. 0.28.2 already shows it, for a Host that
  bundles ESM first and converts to CJS second and that defines `import.meta.url`.
  `templates/packaging/sea/build.sh` at `v0.28.2` (lines 69-72) uses that order but
  has no define, and its README (lines 92-96) says that a direct CJS bundle
  rejects top-level await. Main (#709) builds the single-pass bundle and documents
  the define (`packages/client/README.md:133-138`). So main makes the shape easy
  to reach.
- In the CJS rows, Node's `fetch` layer still builds the request and reads the
  response. The 8.10.2 `Agent` handles the connection, TLS and the HTTP wire
  protocol. The probe counts `dispatch()` calls. It does not measure which
  advisory a given request meets.
- The result depends on order, not on the bundle format. A product that reads
  `Headers`, `Response` or `WebSocket` before the host loads lets Node's copy win
  in CJS too (emulated with `Headers`; see "Fix checks"). The same mechanism is
  open upstream as `earendil-works/pi` issue 9787.
- I ran one helper kind (`pi-subagent-print`). All helper kinds in the same bundle
  share the load order. I did not run them.

Fix checks, on the same flow:

| Change | Result |
| --- | --- |
| npm `overrides` of `undici` to 8.12.3 under `@earendil-works/pi-coding-agent`, on 0.28.2 | One undici (8.12.3) in the tree. The CJS slot writer is `node_modules/undici/lib/global.js` (8.12.3). The print session completes. ESM is unchanged. |
| Emulated: the 0.28.2 host in a CJS bundle (#709 change applied in memory), with one `import` of the client's undici 8.12.3 placed before it | The slot writer is 8.12.3. |
| Emulated: the same bundle, with one read of `globalThis.Headers` placed before the host | The slot writer is Node's built-in undici, as in ESM. |

The override works because the frames name `pi-coding-agent/node_modules/undici`,
the npm copy that the bundler inlines. It does not reach the CLI chunk.

### Pi CLI path

- `PiAdapter.detect()` runs `pi --version` unless `sdkHelperHost` is set
  (`packages/client/src/adapters/pi/pi-adapter.ts:225-250`). The command comes
  from `resolvePiBin()` (`resolve-bin.ts:143-155`): `BYOK_PI_BIN`, or the `pi` bin
  of the pinned package, which is `dist/bundle/cli.js`.
- Pi's `main()` calls `configureHttpDispatcher()` at `main.js:471`, before it
  prints the version at `main.js:503`. That call sets an `EnvHttpProxyAgent` and
  replaces `globalThis.fetch` (`http-dispatcher.js:73-96`). A probe of
  `cli.js --version` exited 0 and printed `1.3.0`. The slots ended as
  `EnvHttpProxyAgent`. The probe counted zero `dispatch()` calls. So `detect()`
  loads the inlined 8.10.2 and sends no request.
- A task runs the Pi CLI only when `PiAdapterOptions.resolveBin` is set
  (`pi-adapter.ts:84`, `:390-392`). Otherwise it runs the SDK entry
  `dist/bin/byok-pi-rpc.js`. `resolveBin` is documented as a test seam.
- A Host that runs `pi`, imports `@earendil-works/pi-coding-agent/rpc-entry`, or
  calls Pi's `main()` uses 8.10.2 for all `fetch` traffic of that process. Hosts
  that import `main()` from the package index get the npm copy. The `pi` bin and
  `./rpc-entry` use the inlined copy.

### The openai peer

Only two files of `openai` 7.19.0 require `undici`: `auth/x509-transport.js:12`
and `internal/auth/x509-transport-capability.js:9`. `openai/client.js` does not.
Nothing requires `auth/x509-transport` except a caller that imports the
`openai/auth/*` subpath. `pi-ai` 1.3.0 has no reference to x509 or workload
identity. The SDK has none. So no SDK path loads the peer. The probe that
imports the published host agrees: no undici copy loads except Pi's 8.10.2.

Which copy the peer resolves to, if a Host does use it:

| Layout (`@byok-sdk/client` 0.28.2) | `openai` resolves `undici` to |
| --- | --- |
| npm, empty Host root | 8.12.3 (the client's pin, hoisted) |
| npm, Host root holds `undici@7.28.0` | 7.28.0 (the Host's copy). The client's pin nests under the client. |
| npm, Host has `miniflare` 5.20260811.1-alpha | 7.29.0 (miniflare's copy, hoisted to the root). The client's pin nests under the client. Resolved with `--package-lock-only`; nothing was downloaded. |
| Bun, hoisted | 8.12.3 |
| Bun, isolated | Two `openai` instances. The one under Pi's `pi-ai` links 8.10.2. The one under the client's `pi-ai` links 8.12.3. |
| npm, `@byok-sdk/cloud-do` alone | None. The peer is unmet. |
| npm, nested Pi override | 8.12.3 |

This agrees with a downstream Host report: a clean npm install of the client gives
the peer the client's 8.12.3, and a Host gets an older copy only when its own tree
already holds a root `undici` (there, 7.28.0 through miniflare). The Bun isolated
layout is the exception: it can link Pi's 8.10.2 to one `openai` instance even in
a clean install.

pnpm and Yarn were not run.

### Reproduce

The key probe prints who writes each slot while a module graph loads:

```js
// trace.mjs — node trace.mjs <file URL of a module graph entry>
const slots = [Symbol.for('undici.globalDispatcher.1'), Symbol.for('undici.globalDispatcher.2')];
const define = Object.defineProperty;
Object.defineProperty = (obj, key, desc) => {
  if (obj === globalThis && slots.includes(key)) {
    console.log(key.description, desc.value?.constructor?.name,
      new Error().stack.split('\n').slice(2, 4).join(' | '));
  }
  return define(obj, key, desc);
};
await import(process.argv[2]);
```

Run it on `node_modules/@byok-sdk/client/dist/bin/pi-runtime-host.js` of a scratch
`npm install --ignore-scripts @byok-sdk/client@0.28.2`. A CJS bundle uses the
`esbuild` options of `pi-single-file-bundle.test.ts` (`format: 'cjs'`, the
`import.meta.url` define and banner).

## Pi upstream (checked 2026-10-22)

- `npm view @earendil-works/pi-coding-agent`: latest is 1.4.0 (published
  2026-10-21T22:48:58Z). Versions 1.3.0 and 1.4.0 both depend on `undici`
  `8.10.2`. The other Pi packages (`pi-ai`, `pi-agent-core`, `pi-mcp`,
  `pi-codemode`, `pi-tui`, `pi-durable`, `chord`, `pi-telemetry`) list no undici.
- `earendil-works/pi` main: `packages/coding-agent/package.json:64` still has
  `"undici": "8.10.2"`. The newest commit that names security advisories
  (`2685de7a`, 2026-10-22) changes `vitest` and an example extension only.
- Issue 11208 (bump the pin to 8.12.3) was auto-closed as "not planned" on
  2026-10-21 by the repository's new-contributor rule. The rule says that
  maintainers review auto-closed issues and reopen some. No maintainer reply.
- Issue 9787 (open): importing the Pi package installs the nested undici as the
  process-wide dispatcher. A contributor offered a fix. No maintainer reply.

No Pi release carries a patched undici. Pi was not upgraded.

## Advisories and the CHANGELOG

`CHANGELOG.md:44-52` (section "0.28.2") lists eight advisories. Their ids, the
severities and the dates match `nodejs/undici` security advisories: GHSA-qrxm-fqhp-jwvm,
GHSA-2m5v-pch6-74hx, GHSA-4w7w-5xrc-9h26 and GHSA-xjj6-f33q-929c (high);
GHSA-55wc-3pg8-jfw6, GHSA-f72v-6w45-q472, GHSA-4qv8-2p9j-2685 and
GHSA-9fm3-97px-rjf6 (medium). All were published on 2026-10-15 and are fixed in
8.12.2 (7.30.1, 6.29.1). One more advisory from the day before,
GHSA-qq8j-7v2v-3rwp (2026-10-14, high), covers `>=8.11.0 <8.11.2` only. It
touches none of the older copies. So the CHANGELOG needs no new entry for
acceptance item 3. The 0.28.2 section is frozen.

## P3: Status and options

Acceptance of #700:

| Item | State |
| --- | --- |
| The SDK's own pins use a patched 8.12.x | Met. Published in 0.28.2. |
| Each older copy: reached at run time, and fixed or not reachable | Recorded here. Not met for Pi's two copies: they are reachable in some shapes and not fixed. The owner posts the record on the issue. |
| The CHANGELOG lists the advisories | Met (`CHANGELOG.md:44-52`). |

Stays open:

1. Pi's npm 8.10.2 and the inlined CLI copy, until a Pi release moves them.
2. CJS bundles of the Pi host: Pi's 8.10.2 owns the process-wide dispatcher unless
   the Host or the SDK changes the load order. This exists in 0.28.2 (ESM then
   CJS, with a define) and on main (single pass, documented).
3. The record on the issue itself.

Options for the owner. None is done in this change.

- A. Host guidance now. A nested override replaces the npm copy (tested with npm;
  the syntax for pnpm, Yarn and Bun was not tested). It does not replace the
  inlined CLI copy. Pi 1.3.0 with undici 8.12.3 passed one print session here;
  Pi's own tests were not run.
- B. SDK change, small. Make the load order fixed in the Pi host entry, before the
  Pi import. Either import the client's own `undici` (the patched copy owns the
  slots), or read a lazy web global (Node's copy owns the slots, as in ESM).
  Both worked in an emulated CJS bundle. The second keeps Node's fetch and
  dispatcher on one implementation. Pi's own comment at `http-dispatcher.js:86-89`
  warns about a mix of Node's fetch with an npm dispatcher on Node 26.0. Either
  option needs a guard in `pi-single-file-bundle.test.ts` that no npm undici
  owns the slots after load.
- C. Docs only. Add the caution and the override to the CJS recipe in
  `packages/client/README.md:133-138`, and one CHANGELOG sentence under
  "Unreleased".
- D. Wait for Pi. No date. A Pi release must also rebuild the CLI bundle.

Not covered: Node 24.22.1 and Node 26 runs, pnpm and Yarn layouts, `bun build
--compile` products, helper kinds other than `pi-subagent-print`, and whether a
given advisory applies to a given request.
