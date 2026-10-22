# #700: where each older undici copy loads

Date: 2026-10-22. Base: main `7c0bbebc`. Published release: `0.28.2` (tag
`v0.28.2`). Repo file and line numbers refer to the base commit. Numbers for
`dist/` files refer to the published `0.28.2` packages and to Pi 1.3.0. This note
records acceptance item 2 of #700: for each older undici copy, does a consumer
install reach it at run time, and how is it fixed or why is it not reachable.
The measurements in "P1", "P2" and "Reproduce" are from before the fix. The owner
chose options B and C on 2026-10-22, and the same change carries them. "P3" and
"After the change" record the fix. The change adds no dependency and changes no
manifest or lock file.

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
  shapes it does not own them. In a CommonJS bundle of the host it did, before
  the fix in this change (see "After the change"). A Host
  can build such a bundle from 0.28.2 (ESM first, then CJS, with an
  `import.meta.url` define). Main builds it in one pass and documents it (#709).
- The CJS result narrows an earlier #700 status comment. That comment says that
  the host and its single-file bundle keep Node's own dispatcher. This holds for
  ESM. It does not hold for a CJS bundle.
- A nested override of Pi's undici fixes the npm copy for a Host. It cannot fix
  the inlined copy.
- The probes ran on Node v24.22.1 (the 0.28.2 floor, `engines.node >=24.22.1`;
  built-in undici 7.30.1, the patched 7.x line), on v26.10.0 (inside the floor)
  and on v24.21.0 (below it). Every shape gives the same result on all three. On
  v24.22.1 an ESM Host that runs the SDK's Pi host keeps the patched built-in
  copy for `fetch`. A CJS bundle replaces it with Pi's unpatched 8.10.2.
- Node's own undici is in the advisory range on some builds that the floor
  admits. Node v26.10.0 carries 8.10.2. The v26.12.1 release notes list the
  patched 8.12.2.
- A downstream product ran its own two-pass CJS bundle (SDK 0.28.2, helper
  `pi-rpc`, Node v24.22.1). Node's copy owned both slots at exit. The product
  reports that its code touches `fetch` before the Pi host loads. So a CJS bundle
  is exposed only when nothing in the product loads Node's copy first. I did not
  reproduce this on the product's files. See "Reproduce".
- The CHANGELOG already lists all eight advisories (`CHANGELOG.md:44-52`).
- Owner decision, 2026-10-22: B and C. The SDK now reads `globalThis.Headers`
  before it imports the Pi host. Node's undici then owns the dispatcher in a CJS
  bundle, as it does in ESM. The client README and the CHANGELOG say so. See
  "P3" and "After the change".
- #700 stays open.

## Method

- Scratch installs of the published `0.28.2` packages: npm 11.19.0 with
  `--ignore-scripts` (all nine packages together, and `cloud-do` and
  `cloud-dataplane` alone), Bun 1.4.3 with the hoisted linker and with the
  isolated linker, and npm with an older `undici@7.28.0` at the Host root.
- `npm ls undici --all`, `bun pm ls --all`, and `grep` over the installed files.
- Run-time probes on Node v24.22.1 (Node's own undici 7.30.1), v26.10.0 (8.10.2)
  and v24.21.0 (7.29.1), from `process.versions.undici`. All ran on macOS arm64.
  The v24.22.1 binary is an existing local install of the official build, and its
  code signature verifies (Node.js Foundation). I downloaded nothing.
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
| Node's built-in undici | The Node runtime (`process.versions.undici`): 7.29.1 in v24.21.0, 7.30.1 in v24.22.1, 8.10.2 in v26.10.0, and 8.12.2 in v26.12.1 (release notes). | Not part of the install. Every process that runs the SDK holds it. | It loads on demand. In the SDK's ESM host shapes it serves global `fetch`. See "Who owns the global dispatcher". |

The repo tree (`bun pm ls --all`) shows the same three runtime copies: 8.12.3 at
the root, 8.10.2 under Pi, 7.29.0 under miniflare.

Each of the eight advisories of 2026-10-15 covers 8.0.0 up to 8.12.2 and 7.18.0
up to 7.30.1 (most start earlier). So 8.10.2 and 7.29.0 are both in range. So
are Node's built-in 7.29.1 (v24.21.0) and 8.10.2 (v26.10.0).

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
The built-in `fetch` of Node 24 (built-in undici 7.x) reads slot 1 for each
request. When an 8.x copy owns the slots, slot 1 holds a wrapper that forwards
to slot 2. The built-in `fetch` of v26.10.0 (built-in undici 8.10.2) reads
slot 2. The dispatch counts show both cases. So the first undici 8.x copy that
loads, with no earlier undici in slot 2, becomes the dispatcher of every global
`fetch` call in the process. `lib/global.js` is identical in 8.10.2 and 8.12.3.

Load order decides the owner. In an ESM graph, one static `import … from 'http'`
is enough. Node reads the lazy `WebSocket` export of `node:http` when it builds
the ESM wrapper for that built-in (trace on v24.21.0 and v24.22.1:
`get [as WebSocket] (node:http:237)`, `lazyUndici (node:http:129)`, no
JavaScript caller). The read loads Node's built-in undici, which writes both
slots. The published host imports `http` at
`dist/bin/pi-runtime-host.js:29`, after Pi at `:18`, and Node's copy still wins.
So Node builds that wrapper while it links the graph, before any module body
runs. A bare `await import('node:http')` shows the same effect; `node:https`
does not. On v26.10.0 the ESM rows show the same Node-internal writer. I did not
trace the trigger there.
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
  in CJS too (emulated with `Headers`; see "Fix checks"). A call to `fetch` does
  the same. A read of `globalThis.fetch` alone does not (v24.22.1). The same
  mechanism is open upstream as `earendil-works/pi` issue 9787.
- I ran one helper kind (`pi-subagent-print`). All helper kinds in the same bundle
  share the load order. I did not run the others. A downstream run used `pi-rpc`
  (see "Reproduce").

Node versions. The shapes above ran on three Node builds. Each result cell is
one real Pi print session: exit 0, one provider request. The slot writer comes
from the stack frames. A `node:internal/deps/undici` frame means Node's copy. On
v26.10.0 Node's copy and Pi's copy are both 8.10.2, so the version cannot tell
them apart.

| Node | Built-in undici | ESM shapes (0.28.2 unbundled and single file; main single file) | CJS shapes (0.28.2 ESM then CJS; 0.28.2 single pass with the #709 change; main single pass) |
| --- | --- | --- | --- |
| v24.22.1 (the floor) | 7.30.1 | Node's copy writes the slots and serves | Pi's nested 8.10.2 writes the slots and serves |
| v26.10.0 (inside the floor) | 8.10.2 | Node's copy writes the slots and serves | Pi's nested 8.10.2 writes the slots and serves |
| v24.21.0 (below the floor) | 7.29.1 | Node's copy writes the slots and serves | Pi's nested 8.10.2 writes the slots and serves |

On v24.22.1 an ESM Host that runs the SDK's Pi host keeps Node's 7.30.1 as the
`fetch` dispatcher. That is the patched 7.x line. In those rows the slot-2
`Agent` options keep a `tls` key, as the 8.12.3 copy does. Pi's 8.10.2 has no
such key, and the CJS rows show the shape without it. A CJS bundle replaces
Node's copy with Pi's unpatched 8.10.2. So the CJS shape matters most on the
version that the floor names.

Node's own copy is in the advisory range on some builds that the floor admits.
`engines.node >=24.22.1` admits v26.10.0 (8.10.2). The v26.12.1 release notes
list the patched 8.12.2. That is a Node runtime matter and not an SDK pin. This
note changes nothing about it.

Fix checks, on the same flow:

| Change | Result |
| --- | --- |
| npm `overrides` of `undici` to 8.12.3 under `@earendil-works/pi-coding-agent`, on 0.28.2 | One undici (8.12.3) in the tree. The CJS slot writer is `node_modules/undici/lib/global.js` (8.12.3). The print session completes. ESM is unchanged. |
| Emulated: the 0.28.2 host in a CJS bundle (#709 change applied in memory), with one `import` of the client's undici 8.12.3 placed before it | The slot writer is 8.12.3. |
| Emulated: the same bundle, with one read of `globalThis.Headers` placed before the host | The slot writer is Node's built-in undici, as in ESM. |

The override works because the frames name `pi-coding-agent/node_modules/undici`,
the npm copy that the bundler inlines. It does not reach the CLI chunk. On
v24.22.1 and v26.10.0 the CJS result of each of the three checks is the same.

### Pi CLI path

- `PiAdapter.detect()` runs `pi --version` unless `sdkHelperHost` is set
  (`packages/client/src/adapters/pi/pi-adapter.ts:225-250`). The command comes
  from `resolvePiBin()` (`resolve-bin.ts:143-155`): `BYOK_PI_BIN`, or the `pi` bin
  of the pinned package, which is `dist/bundle/cli.js`.
- Pi's `main()` calls `configureHttpDispatcher()` at `main.js:471`, before it
  prints the version at `main.js:503`. That call sets an `EnvHttpProxyAgent` and
  replaces `globalThis.fetch` (`http-dispatcher.js:73-96`). A probe of
  `cli.js --version` exited 0 and printed `1.3.0`. The slots ended as
  `EnvHttpProxyAgent`. The probe counted zero `dispatch()` calls. The same probe
  on v24.22.1 and v26.10.0 printed `1.3.0` and gave the same slots and the same
  count. So `detect()` loads the inlined 8.10.2 and sends no request.
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

A second probe needs no stack frames. It prints the source length of each slot's
constructor: `String(globalThis[Symbol.for('undici.globalDispatcher.1')].constructor).length`,
and the same for `.2`. The length names the writer. The npm lengths do not change
between Node builds.

| Writer | Slot 1 | Slot 2 |
| --- | --- | --- |
| npm undici 8.10.2 (Pi's copy) | `Dispatcher1Wrapper`, 1141 | `Agent`, 4546 |
| npm undici 8.12.3 (the client's pin) | `Dispatcher1Wrapper`, 1489 | `Agent`, 4630 |
| Node v24.22.1 built-in (7.30.1), after `fetch('data:,')` | `Agent`, 4572 | `Agent`, 4572 |
| Node v24.21.0 built-in (7.29.1), same call | `Agent`, 4476 | `Agent`, 4476 |
| Node v26.10.0 built-in (8.10.2), same call | `Dispatcher1Wrapper`, 1210 | `Agent`, 4700 |

A downstream product reported this probe on its own bundles. I did not reproduce
it on the product's files. The product used v24.22.1 and SDK 0.28.2, and it ran
the `pi-rpc` helper on its ESM payload and on its two-pass ESM-then-CJS single-file
main. The Pi host loaded fully in both runs. Both ended at a configuration
refusal, so no provider request was sent. At exit both slots held an `Agent` of
length 4572, which is Node's built-in copy. The product reads this as follows:
some of its code touches `fetch` before the Pi host loads, so Node's copy wins
even in its CJS bundle, and that order is incidental. I did not check which
touch it is. The reference lengths above
reproduce on this machine. The report agrees with the load-order rule and with
the emulated `Headers` check. It also shows that a CJS bundle is not always
exposed. The product's own order decides.

On v24.22.1, a read of `globalThis.Headers`, `Response`, `WebSocket` or `FormData`
loads Node's copy and fills both slots. So does a call to `fetch`. A read of
`globalThis.fetch` alone does not, and neither does `new AbortController()`.

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

## P3: Decision, status and options

Owner decision, 2026-10-22: B and C. This change carries both. A, D and E are
not part of it.

- B (code and test). `runSdkReservedHelperCommand()` reads `globalThis.Headers`
  with `Reflect.get` before each import of `#byok-pi-runtime-host`: for the
  `pi-subagent-runner` and `pi-subagent-print` kinds, and for the `pi-rpc`,
  `pi-prepared` and `pi-durable` kinds. The `byok-pi-rpc`, `byok-pi-prepared`
  and `byok-pi-durable` entries read it before their own import of the host.
  `byok-agent` reads it on its team operator path only.
  `pi-single-file-bundle.test.ts` checks, in the three CJS fixtures and
  for four more Pi helper kinds, that no npm undici claims the dispatcher slots.
- C (docs). The CJS recipe in `packages/client/README.md`, and one "Security
  (client)" entry under "Unreleased" in the CHANGELOG.

Acceptance of #700:

| Item | State |
| --- | --- |
| The SDK's own pins use a patched 8.12.x | Met. Published in 0.28.2. |
| Each older copy: reached at run time, and fixed or not reachable | Recorded here. In a CJS bundle that runs Pi through the SDK's helpers, Pi's npm 8.10.2 no longer owns the dispatcher (B). Pi's two copies are not fixed. The owner posts the record on the issue. |
| The CHANGELOG lists the advisories | Met (`CHANGELOG.md`, section "0.28.2"). The "Unreleased" entry records the load-order change. |

Stays open:

1. Pi's npm 8.10.2 and the inlined CLI copy, until a Pi release moves them (D).
   The npm copy still loads in every Pi host. It no longer owns the dispatcher in
   a CJS bundle of the SDK's helpers. A product that imports pi itself must make
   the same read, or its bundle keeps the old order. The inlined copy runs with
   the `pi` bin and the `./rpc-entry` export.
2. Node's own undici on the builds that the floor admits (E). Not decided.
3. The record on the issue itself.

Options. B and C are done in this change. The others are not.

- A. Host guidance now. A nested override replaces the npm copy (tested with npm;
  the syntax for pnpm, Yarn and Bun was not tested). It does not replace the
  inlined CLI copy. Pi 1.3.0 with undici 8.12.3 passed one print session here;
  Pi's own tests were not run. The client README documents it as optional Host
  guidance, with this limit.
- B. SDK change, small. Make the load order fixed before the Pi import. Either
  import the client's own `undici` (the patched copy owns the slots), or read a
  lazy web global (Node's copy owns the slots, as in ESM). Both worked in an
  emulated CJS bundle. The second keeps Node's fetch and dispatcher on one
  implementation. Pi's own comment at `http-dispatcher.js:86-89` warns about a
  mix of Node's fetch with an npm dispatcher on Node 26.0. Either option needs a
  guard in `pi-single-file-bundle.test.ts` that no npm undici owns the slots
  after load. Chosen: the second.
- C. Docs. Add the caution and the override to the CJS recipe in
  `packages/client/README.md`, and one CHANGELOG entry under "Unreleased".
- D. Wait for Pi. No date. A Pi release must also rebuild the CLI bundle.
- E. Node floor. `engines.node >=24.22.1` admits Node 26 builds whose built-in
  undici is in the advisory range (v26.10.0). The owner can narrow the range or
  accept it. A narrower range changes nine public manifests.

Not covered: Node on Linux and Windows (all probes ran on macOS arm64), Node 26
builds other than v26.10.0, pnpm and Yarn layouts, `bun build --compile`
products, and whether a given advisory applies to a given request. The probes
before the fix ran one helper kind, `pi-subagent-print`. The checks after the fix
cover all five Pi kinds.

## After the change

### What changed

- `packages/client/src/sdk-reserved-helper-host.ts`: a private function
  `loadNodeUndici()` calls `Reflect.get(globalThis, 'Headers')`. The
  `pi-subagent-runner` and `pi-subagent-print` branches call it before their
  import of the host. `runSdkReservedHelperCommand()` calls it before
  `runSdkReservedHelper()` for `pi-rpc`, `pi-prepared` and `pi-durable`, which
  import the host in `bin/sdk-reserved-helper-runners.ts`. The MCP helper kinds
  never load Pi, so they skip it.
- `bin/byok-pi-rpc.ts`, `byok-pi-prepared.ts`, `byok-pi-durable.ts` and, for its
  team operator command, `byok-agent.ts`: the same one-line read before the
  dynamic import of the host. These entries run as ESM. There the host's own
  `node:http` import makes Node load its undici before Pi evaluates, so the read
  changes no owner. A run of `byok-pi-rpc.js` on v24.22.1 with and without the
  line ended with Node's copy in both slots. The line makes every importer of the
  seam read first. The thin bins carry it inline, because a shared function does
  not fit their closure budgets (about 45 bytes of slack each).
- `pi-single-file-bundle.test.ts`: a preload records the stack frame that writes
  each dispatcher slot. A frame inside `node:internal/deps/undici` is Node's copy.
  Any other frame is an npm copy. The check reads no version string, because Node
  v26.10.0 and Pi's pin are both 8.10.2.

### Why the read sits at each call site

- A statement in the host module body runs after the host's hoisted static
  imports, so Pi has already evaluated.
- A side-effect import of a prelude module is dropped by a bundler when the
  package declares `"sideEffects": false`, as the client does.
- In a bundle, `import('#byok-pi-runtime-host')` becomes a lazy initializer. Code
  that runs before it runs before Pi evaluates.

### The read must be a call

Stand-in module with `sideEffects: false`, bundled to CommonJS with esbuild
0.28.1, rollup 4.62.2 and Bun 1.4.3, and run on v24.22.1. A cell says whether the
statement was still in the bundle: kept means Node's undici owned slot 2 after
the run, dropped means slot 2 was empty.

| Statement | esbuild | esbuild minify | esbuild syntax+whitespace | rollup 4.62.2 default | rollup smallest | Bun 1.4.3 minify |
| --- | --- | --- | --- | --- | --- | --- |
| `globalThis.Headers;` | kept | kept | kept | dropped | dropped | kept |
| `void new Headers()` | kept | kept | kept | kept | kept | dropped |
| `Reflect.get(globalThis, 'Headers')` | kept | kept | kept | kept | kept | kept |

Terser and webpack were not tested. On Bun 1.4.3, `Headers` is a plain property
and `process.versions.undici` is undefined. The read returns the class and
loads nothing: slot 2 stayed empty.

### Checks

| Check | Result |
| --- | --- |
| The new tests, before the fix, v24.22.1 | 7 of 7 fail: "slot 2 was claimed by an npm undici", frame `setGlobalDispatcher2` in the bundle |
| The same, before the fix, v26.10.0 | 7 of 7 fail with the same message. Both copies are 8.10.2 there, and the check still tells them apart |
| The new tests, after the fix | 7 of 7 pass on v24.22.1, v26.10.0 and v24.21.0 |
| Four more Pi kinds (`pi-rpc`, `pi-prepared`, `pi-durable`, `pi-subagent-runner`), before the fix | They reach their own refusal message and then fail the slot check |
| Real print session, single-pass CJS, after the fix, v24.22.1 | Exit 0, one provider request. Both slot writers are in `node:internal/deps/undici`. |
| Real print session, ESM then CJS, after the fix, v24.22.1 | The same |
| Single-pass CJS with esbuild `minify`, all five Pi kinds, after the fix, v24.22.1 | Both slot writers are in `node:internal/deps/undici` |

### Cost

Measured on v24.22.1, macOS arm64. The read loads Node's undici in the process
that makes it: the median start-up time of `node -e` rises from 32.0 ms to
50.3 ms (30 runs each), the load takes 16 ms, and the resident set grows from
42.2 MB to 59.8 MB. A Pi helper that sends a request loads Node's undici at its
first `fetch` anyway. The read moves that load to the start. A refusal path pays
it without a request.
