# WP1: Real released FFF/Pi compatibility proof

WP1 disposable proof completed. Production integration is not implemented or accepted. The raw extension searches successfully and does not widen Pi's tested allow/deny/empty policy. It has a compile-time schema compatibility defect and a reproduced restored-mode authority gap that WP3 must resolve before acceptance.

## Boundary and fixture

- Evidence root: `/tmp/byok-fff-probe.NystnG` (canonical macOS path `/private/tmp/byok-fff-probe.NystnG`). Only this disposable directory and this note were written by WP1; repository source, dependencies, lock, plan and contract were untouched.
- Host: macOS (`darwin`) arm64, Node `v26.10.0`. Other operating systems, architectures, Bun runtime and minimum Node version are unverified.
- Exact top-level packages: `@ff-labs/pi-fff@0.11.0`, `@earendil-works/pi-coding-agent@0.99.1`, `@earendil-works/pi-tui@0.99.1`, `@sinclair/typebox@0.34.41`; probe build tooling `esbuild@0.25.11`, `typescript@5.9.3`.
- npm installed Pi's private shrinkwrapped dependencies under coding-agent; installed Pi schema authority is `typebox@1.3.27`. `npm ls` verified the released extension resolves exactly Pi/TUI `0.99.1` and the pinned old TypeBox peer.
- A real temporary git repository has `src/alpha-search.ts` and `src/beta-model.ts`, both containing `FFF_PROBE_TOKEN`; `.gitignore` excludes `ignored/secret.ts` containing `FFF_IGNORED_TOKEN`. `git init --quiet` and `git add .` run in the fixture.
- Isolated `PI_CODING_AGENT_DIR`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, explicit `agentDir`, and in-memory `SessionManager` keep user Pi settings/auth/history unchanged. `pi-fff.json` sets tools-only, no root/home scanning, no symlink following, and explicit temporary frecency/history DB directories.
- No LLM, provider credentials or model request was used. Actual Pi factories, tool registry, argument validator, bundled upstream extension and released native bindings were executed.

## P1 / P2 / P3 evidence

P1: `@ff-labs/pi-fff/src/index.ts` is the published extension entry; its dependencies are `fff-node` and `fff-bun`, both `0.11.0`. `src/sdk.ts` chooses Node before Bun on Node and imports native packages dynamically. Pi `createAgentSessionServices` loads an explicit factory under `noExtensions:true`; `createAgentSession` creates the authoritative filtered tool registry.

P2: known git fixture -> isolated services/resource loader -> real extension factory -> `session.bindExtensions({mode:'rpc'})` -> real `session_start` -> `session.agent.state.tools` -> Pi `validateToolArguments` -> wrapped registered tool `execute` -> FFF native finder -> expected file/content text -> explicit `session_shutdown` -> `session.dispose()` -> later session reopening the same databases. Two concurrent sessions followed this same path with shared database paths.

P3: disposable evidence supports bundled extension execution with native packages external. It does not establish a safe SDK wrapper. Preserve Pi's allow/deny authority and resolve the demonstrated restored-mode/global-config boundaries before source integration. Compiled source and runtime schema compatibility have different results, documented below; a runtime pass does not erase compile failures.

## Commands and actual outcomes

Run from the evidence root unless otherwise noted. Full command logs and runnable probe files remain there.

| Command | Exit | Evidence |
| --- | --- | --- |
| `npm view @ff-labs/pi-fff@0.11.0 --json` and `npm pack @ff-labs/pi-fff@0.11.0 --silent` | 0 | `pi-fff-metadata.json`, released `.tgz`, unpacked `package/` |
| `npm install --save-exact @ff-labs/pi-fff@0.11.0 @earendil-works/pi-coding-agent@0.99.1 @earendil-works/pi-tui@0.99.1 @sinclair/typebox@0.34.41 esbuild@0.25.11 typescript@5.9.3` | 0 | `install.log`; 160 packages installed; exact dependencies read back by `npm ls` |
| `node_modules/.bin/esbuild node_modules/@ff-labs/pi-fff/src/index.ts --bundle --platform=node --format=esm --target=node22 --packages=external --external:@ff-labs/fff-node --external:@ff-labs/fff-bun --outfile=fff-bundled.mjs --metafile=bundle-meta.json` | 0 | `bundle.log`: 53.4 KB; metafile retains both native imports external |
| `node node_modules/typescript/bin/tsc --project tsconfig.json` | 2 | `typecheck.log`: 10 upstream errors, mainly required `params.pattern` inferred `string \| undefined` |
| `node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --moduleResolution bundler --module esnext --target ES2022 schema-compat.ts` | 2 | `schema-compat.log`: one isolated `TS2322`; old TypeBox `Static` yields required string, Pi's new TypeBox `Static` yields string-or-undefined for the same old schema |
| `node probe.mjs` with isolated env below | 0 | `probe.log`: `PROBE_PASS`, real search, schema rejection, empty/deny policy, repeated DB reopening |
| `node bounded-run.mjs concurrent.mjs` with isolated env | 0 | `concurrent.log`: `CONCURRENT_PASS`, `BOUNDED_EXIT` code 0, no timeout |
| `node bounded-run.mjs restored-mode.mjs` with isolated env | 0 | `restored-mode.log`: `RESTORED_OVERRIDE_CONFIRMED`; expected unsafe raw behavior reproduced |
| `node_modules/.bin/esbuild extension-entry.ts --bundle --platform=node --format=esm --target=node22 --packages=external --outfile=external-only.mjs` | 0 | Produces 124-byte entry retaining upstream TS import |
| `node --input-type=module -e 'await import("./external-only.mjs")'` with isolated agent env | 1 | `external-only-import.log`: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` proves ordinary Node cannot consume unbundled published TS entry |
| `npm ls ffi-rs @ff-labs/fff-bin-darwin-arm64 --json` | 0 | native platform package `0.11.0`, `ffi-rs@1.3.7` |

The exact runtime environment prefix was:

```sh
PI_CODING_AGENT_DIR=/private/tmp/byok-fff-probe.NystnG/isolated/agent \
XDG_CACHE_HOME=/private/tmp/byok-fff-probe.NystnG/isolated/cache \
XDG_DATA_HOME=/private/tmp/byok-fff-probe.NystnG/isolated/xdg-data \
node probe.mjs
```

An initial probe-command mistake ran the esbuild native executable through `node` and returned exit 1. It was corrected to `node_modules/.bin/esbuild`; both corrected builds above returned 0. An initial isolated schema proof imported uninstalled root `typebox` and returned TS2307/exit 2; corrected proof imports Pi's actual private `typebox/build/index.mjs` and reproduces only the intended TS2322. Neither setup error is treated as an upstream failure.

## Real runtime outputs

```text
ffgrep {pattern:"FFF_PROBE_TOKEN"}:
src/alpha-search.ts  [staged_new in git]
 1: export const needle = "FFF_PROBE_TOKEN";

src/beta-model.ts  [staged_new in git]
 1: export const gamma = "FFF_PROBE_TOKEN";

fffind {pattern:"alpha search"}:
src/alpha-search.ts  [staged_new in git]

ffgrep {pattern:"FFF_IGNORED_TOKEN",mode:"plain"}:
No matches found
```

Pi's argument validator rejected `{}` for `ffgrep` (missing required `pattern`) before any native execution. Runtime JSON Schema validation is compatible despite the compile-time `Static` mismatch.

| Session options | Active before `session_start` | Active after `session_start` |
| --- | --- | --- |
| Default | read, bash, edit, write, fffgrep, fffind | Same |
| `tools:[]` | Empty | Empty |
| `noTools:'all'` | Empty | Empty |
| `tools:['read','fffind'], excludeTools:['ffgrep']` | read, fffind | Same; denied fffgrep absent from registry |

Sequential explicit shutdown/dispose and reopening passed. Two concurrently started sessions using the same DB paths both returned correct grep/find results and both shut down without timeout. This bounds the proof to two sessions in one process and one fixture; it is not a scalability benchmark or a multi-process contention proof.

## Reproduced admission/configuration risks

1. **Restored mode supersedes startup mode.** A real `SessionManager.inMemory(cwd)` with `appendCustomEntry('fff-mode',{mode:'override'})` changes active names on startup from `ffgrep/fffind` to `grep/find`, even though isolated JSON is `mode:'tools-only'`. Upstream `src/index.ts:786-792` reads persisted modes from `ctx.sessionManager.getEntries()` after resolving flags/env/config. A SDK-owned wrapper must neutralize this authority gap. This note does not decide that wrapper.
2. **Two schema families differ at compile time.** Upstream imports `@sinclair/typebox`; Pi 0.99.1 `ToolDefinition` imports `typebox`. Runtime JSON Schema passes, but upstream source is not directly strict-typecheck clean against this Pi version. Source TS must not silently expand the SDK's typecheck surface without handling this demonstrated mismatch.
3. **Extra tool activation is configurable.** Default 0.11.0 registers two tools. Upstream `src/index.ts:1299-1301` gates `fff-multi-grep` behind `PI_FFF_MULTIGREP=1`; do not assume the raw factory always exposes exactly two names.
4. **Global file load remains authority.** Upstream factory calls `loadConfig()` at factory creation (`src/index.ts:315`), before applying flags/env at session startup. It consults `PI_CODING_AGENT_DIR` rather than the services `agentDir` parameter directly. Config isolation in this probe uses a disposable process environment; safe production isolation and invalid-personal-config handling are unresolved.
5. **Shutdown event matters.** Native cleanup is registered on `session_shutdown`. Raw `AgentSession.dispose()` invalidates runner/listeners and does not emit it. Pi `AgentSessionRuntime.teardownCurrent` explicitly emits shutdown before disposal; the probe followed that lifecycle. Plain-dispose native cleanup was not claimed.

## Installed native bytes observed

Read from the disposable installation after successful actual searches:

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `node_modules/@ff-labs/fff-bin-darwin-arm64/libfff_c.dylib` | 5,404,416 | `d052aae92b8d89f4734399aa53f80a327c4931f1b5dea0a7d96f9c488229ba43` |
| `node_modules/@yuuang/ffi-rs-darwin-arm64/ffi-rs.darwin-arm64.node` | 721,896 | `50158069dfc4fcef50af699b84f41b746eeeda076b43950c51828e1eb62f9bc7` |

Both Node/Bun FFF packages depend on platform binary package 0.11.0. Node additionally uses `ffi-rs` and its platform addon. SDK implementation identity admission remains WP2/WP3 work; the installed disposable package is not a packed SDK distribution proof.

## Handoff limits

- Production source remains unchanged. Root build/typecheck/test/release-pack were not run because WP1 owns only disposable proof and this note.
- No claim for final SDK configuration freezing, resumed-mode safety, read-only mapping, sealed/Prepared exposure, clean SDK tarball installation, startup failure behavior, other OS/CPU targets or performance gains.
- Runtime/API/native loading falsifier is resolved positively on the tested host. Restored-mode authority and compile-time source boundary have concrete evidence and remain integration gates for the parent.
