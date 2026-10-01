# WP3 — public API configuration / mode feasibility

Status: bounded feasibility PASS; production implementation has not started.

## P1: observed boundaries

- Pinned artifact: `/tmp/byok-fff-probe.NystnG/package/src/index.ts`, `config.ts`, `paths.ts`, `file-picker.ts`, `aux-finders.ts` from released `@ff-labs/pi-fff@0.11.0`; real runtime `@earendil-works/pi-coding-agent@0.99.1`.
- Factory is synchronous and calls `loadConfig()` at index.ts:315, before flags are resolved. `loadConfig()` defaults to `piDataDir()`, whose documented `PI_CODING_AGENT_DIR` override is read dynamically. An invalid global JSON throws even when every desired flag is set. Config injection alone therefore needs this read isolated.
- Startup configuration is resolved through public `ExtensionAPI.getFlag()` before env / JSON / defaults (index.ts:324–420). Mode restoration separately reads the public readonly `ctx.sessionManager.getEntries()` (index.ts:786–798). `/fff-mode` can persist and select a different mode (index.ts:1405–1446).
- Public composition points exist in Pi `dist/core/extensions/types.d.ts`: ExtensionAPI `getFlag`, `on`, `registerTool`, `registerFlag`, `registerCommand`, and ExtensionContext readonly SessionManager. No private AgentSession field mutation, runtime patch, or upstream fork is needed for the proof wrapper.
- SDK assembly: `pi-rpc-host.ts:157` supplies factories; `pi-session-runtime.ts:42` assembles services, rejects loader diagnostics, then creates sessions. Ordinary runtime disposal emits `session_shutdown` before session disposal (`dist/core/agent-session-runtime.js:296`); plain `AgentSession.dispose()` alone does not emit it (`agent-session.js:968`).

## P2: real path exercised

Released bundled factory -> SDK-style public API view -> real Pi services -> real SessionManager with historical `fff-mode: override` -> real bindExtensions -> registered tools -> real native find / grep -> explicit shutdown event -> owned DB directory deletion.

Proof files (disposable, not repository production files):

- `/tmp/byok-fff-probe.NystnG/wp3-feasibility.mjs`
- `/tmp/byok-fff-probe.NystnG/wp3-feasibility.log`
- reused WP1's released-source `fff-bundled.mjs` and exact npm install; no native mock.

Command, executed this turn:

```sh
cd /tmp/byok-fff-probe.NystnG
node bounded-run.mjs wp3-feasibility.mjs > wp3-feasibility.log 2>&1
```

Final exit code: **0**. Exact terminal markers:

```json
{"event":"CONCURRENT_OWNED_DB_PASS","a":"/var/folders/nz/1kt960ns5kq331c5qw2sh6sc0000gn/T/byok-fff-wp3-Fk5VCm/owned-7s6MFr","b":"/var/folders/nz/1kt960ns5kq331c5qw2sh6sc0000gn/T/byok-fff-wp3-Fk5VCm/owned-bpEBps"}
{"event":"WP3_PUBLIC_API_FEASIBILITY_PASS","root":"/var/folders/nz/1kt960ns5kq331c5qw2sh6sc0000gn/T/byok-fff-wp3-Fk5VCm","platform":"darwin","arch":"arm64","node":"v26.10.0","globalJsonUnchanged":true,"poisonEnvRestored":true,"poisonDbAbsent":true}
{"event":"BOUNDED_EXIT","code":0,"signal":null,"timedOut":false}
```

Assertions and observations:

- User `pi-fff.json` contains malformed JSON. It remains unchanged and cannot break loading because the synchronous factory read is directed at an SDK-owned empty directory.
- Poisoned `PI_FFF_MODE=override`, `PI_FFF_MULTIGREP=1`, DB env paths, home-scan and symlink env values do not change names or selected config. Every env value is exactly restored after registration; poison DB paths do not exist.
- Only `ffgrep` and `fffind` register. Global malformed JSON and historical override do not register builtin-named FFF tools. Explicit native `grep/find` schemas remain identical before / after bind. The real session history still contains its original `fff-mode: override` entry.
- `fffind` typo-style query `alpha search` returns `alpha-search.ts`. `ffgrep` finds a unique real file-content token.
- Real FFF `ffgrep`, native Pi `grep`, and native Pi `find` can all search an explicitly supplied absolute sibling directory outside cwd. This wrapper imposes no new filesystem sandbox.
- Two sessions create different LMDB directories, both have real `data.mdb` files, search concurrently, close one, and the other continues to search. Every started instance's directory is absent after shutdown.
- Default active names are `read,bash,edit,write,ffgrep,fffind`; Pi default itself does not activate optional builtin `grep/find`. An early probe incorrectly assumed default native grep was active (exit 1, `AssertionError: active grep`); the corrected proof explicitly grants both native search tools for the comparison and separately verifies default behavior.
- `tools:[]` and `noTools:'all'` remain empty after upstream activation. Explicit `read,fffind,ffgrep` with `excludeTools:['ffgrep']` leaves `read,fffind`. A readonly-equivalent exact `read,grep,find,ls` list admits no FFF tools. Existing SDK readonly mapping is not changed.

## P3: bounded implementation hypothesis for parent approval

Use the pinned upstream factory through an SDK-owned public ExtensionAPI facade:

1. During the synchronous released factory call only, redirect documented `PI_CODING_AGENT_DIR` to a freshly owned empty config directory and disable `PI_FFF_MULTIGREP`. Restore exact previous env values in `finally`, with no `await` inside this section. Assert / reject an unexpectedly asynchronous factory; pinning plus real proof is essential. The shared process event loop cannot interleave another JS factory inside this synchronous section.
2. Return fixed `getFlag` values for all seven upstream settings: tools-only, per-instance frecency / history DB paths, root-scan false, home-scan true, warn-home false, follow-symlinks true. These match upstream scanning defaults except the UI warning flag; preserve external-path capability. No user flag, env or JSON is a configuration authority.
3. Wrap FFF event callbacks with a readonly SessionManager view that filters only `fff-mode` custom entries from `getEntries()`. Do not edit stored history or alter other extensions' contexts. Suppress FFF's mode-switching command / registered configuration flags in this RPC-only factory. Reject unexpected registered tool names so an upstream package change fails closed.
4. Keep native policy enforcement in Pi's registry. The host can omit the FFF factory when neither frozen FFF name survives its already-verified `tools/excludeTools/noTools` projection; this avoids native indexing when tools are denied without adding grants or changing the readonly list.
5. Production lifecycle must improve on this minimal proof: the empty config directory can be removed immediately after synchronous registration; allocate DB directories lazily for a started/admitted instance, clean on factory failure, and wrap shutdown so it waits for any started async FFF callbacks / tool executions before invoking upstream teardown and deleting DB paths. This prevents an unbound/no-model startup from leaving an eager temp directory. Use public lifecycle hooks; do not mutate runtime internals.

At 10x sessions, duplicated indexing and per-session temp DB consumption precede search CPU. Independent ephemeral DBs avoid cross-session LMDB ownership contention at the cost of retaining no cross-session search-ranking history. No shared indexing service is proposed.

## Remaining verification boundary

- This is configuration/mode/native feasibility, not installed-client acceptance or full implementation. Build, typecheck, full repo tests, release-pack, and Node 22.22 runtime acceptance have not run for an implementation candidate.
- Minimal proof closes settled-session shutdown only. Production still needs failure-before-bind, native initialization failure, and shutdown while an operation is pending coverage. Upstream `session_start` catches init failures and sends `ui.notify`; native DB open failure retries without DB and explicitly notifies. Do not claim startup failure is a thrown host admission failure or suppress these errors.
- Keep Prepared/compiler/implementation-identity excluded. Native artifacts are ordinary installation dependencies; this proof is not implementation-identity attestation.
- Parent must explicitly read back and authorize the facade/env composition and ephemeral DB tradeoff before WP3 production edits.
