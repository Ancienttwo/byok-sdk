> **Archived**: 2026-09-06 02:44
> **Related Plan**: plans/archive/plan-20260906-0130-win32-job-object-ownership.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260906-0244
> **Archive Projection V1**: `plans/plan-20260906-0130-win32-job-object-ownership.md` => `plans/archive/plan-20260906-0130-win32-job-object-ownership.md`
> **Archive Projection V1**: `tasks/notes/20260906-0130-win32-job-object-ownership.notes.md` => `tasks/archive/notes-20260906-0244-win32-job-object-ownership.md`
> **Archive Projection V1**: `tasks/contracts/20260906-0130-win32-job-object-ownership.contract.md` => `tasks/archive/contract-20260906-0244-win32-job-object-ownership.md`
> **Archive Projection V1**: `tasks/reviews/20260906-0130-win32-job-object-ownership.review.md` => `tasks/archive/review-20260906-0244-win32-job-object-ownership.md`

# Implementation Notes: win32-job-object-ownership

> **Status**: Active
> **Plan**: plans/archive/plan-20260906-0130-win32-job-object-ownership.md
> **Contract**: tasks/archive/contract-20260906-0244-win32-job-object-ownership.md
> **Review**: tasks/archive/review-20260906-0244-win32-job-object-ownership.md
> **Last Updated**: 2026-09-06 (gate round 1)
> **Lifecycle**: notes

## Per-File Changes

| File | Change |
|------|--------|
| `packages/client/src/adapters/win32-job-object.ts` | New. Lazy `koffi` bindings for the six kernel32 calls, the daemon-wide `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` job (created once, keyed by binding table, never closed on purpose), `assignOwnedProcessToJob(pid, { bindings? })`, the `JobObjectBindings` seam, and the `Win32JobObjectFailure` class. |
| `packages/client/src/adapters/process-tree.ts` | `KillFn` exported; new `AdoptOwnedProcessTreeOptions` / `adoptOwnedProcessTree`; module-level `hostExitTargets` registry, `terminateOwnedTreesForHostExit`, once-installed `process.prependListener('exit', …)`; `__hostExitBackstopForTests`; `disposeOwnedProcessTree`'s "job objects are out of scope" doc paragraph replaced with the now-in-scope statement plus the two remaining residuals. Nothing existing changed behaviourally. |
| `packages/client/src/adapters/claude/process-client.ts` | Options gain `platform?` / `jobObject?`; `adopted` promise + `adoptionFailure` fields; `adoptOwnedTree()` (terminate + rethrow on failure); `waitForInit()` awaits adoption first; `onClosed` reports the adoption failure in preference to the exit status of the kill it itself requested. |
| `packages/client/src/adapters/pi/rpc-client.ts` | Same shape; the first awaited operation is `send()`, which now awaits adoption before writing anything to stdin. |
| `packages/client/src/adapters/codex/process-runner.ts` | Same shape plus an event gate: parsed lines are held in `deferredEvents` until adoption settles and dropped if it fails, because this runner's caller reads the FIRST event as the authoritative thread id. `buildExitError` returns the adoption failure when there is one. |
| `packages/client/package.json` | `optionalDependencies: { "koffi": "3.2.0" }`. |
| `packages/client/tsup.config.ts` | `external: ['koffi']`. |
| `bun.lock` | koffi 3.2.0 plus its 16 per-platform `@koromix/koffi-*` optional addon packages. |
| `scripts/release/check-package-graph.mjs` | Invariant comment extended with the narrow `optionalDependencies` exception and its three conditions; new checks on `packages/client`: every optional dependency is an exact `x.y.z` version, none may also be a hard dependency or appear in tsup `noExternal`, and every optional dependency now runs through the same `auditPackagePurity` scan as the direct ones — install scripts and shipped `.node` addons — with violations tolerated only for `OPTIONAL_NATIVE_ALLOWLIST` entries, plus a dead-carve-out check that fails when an allowlisted name is no longer an optional dependency. |
| `packages/client/src/__tests__/win32-job-object.test.ts` | New: 12 cases (ABI payload, one-job-per-daemon, four fail-closed steps, handle hygiene, adoption routing, koffi isolation + control). |
| `packages/client/src/__tests__/host-exit-backstop.test.ts` | New: 6 cases (real subprocess readback + unadopted control, install-once, deregistration on close, group-signal shape and per-target isolation, win32 taskkill sweep). |
| `packages/client/src/__tests__/adapter-disposal-parity.test.ts` | Extended with three fail-closed cases (one per runtime client) alongside the existing structural guards. |
| `packages/client/src/__tests__/fixtures/ts-source-resolve-hook.mjs` | New: lets a plain Node process import this package's `.ts` source (type stripping + one `module.registerHooks` resolve hook), and optionally records every resolved specifier. |
| `packages/client/src/__tests__/fixtures/host-exit-backstop-helper.mjs` | New: daemon stand-in that spawns a real owned tree, optionally adopts it, then performs a real `process.exit(0)`. |
| `packages/client/src/__tests__/fixtures/koffi-isolation-helper.mjs` | New: runs a real adoption on a given platform and lets the recorder witness whether `koffi` is ever resolved. |
| `CHANGELOG.md` | One Unreleased bullet for `@byok-sdk/client`. |

## Design Decisions

- **Failure class: a module-local `Win32JobObjectFailure`, not `RuntimeExecutionFailure`.** `RuntimeExecutionFailure` is `Object.freeze`d in its constructor and its shape is the adapter boundary's terminal control value (`phase`/`category`/`retry`); it cannot carry `win32Code`, and the win32 assignment is a transport-level precondition, not yet an adapter-boundary verdict. `Win32JobObjectFailure` carries `step` and `win32Code`, has a stable `name`, and is folded into each client's OWN existing exit-error channel — which is exactly what the adapter boundary already classifies into a `RuntimeExecutionFailure`. No new export from `src/index.ts` or `src/adapters/index.ts`.
- **One job per binding table, not one module variable.** The job's lifetime is the lifetime of the handles its table owns, so a different table is a different job by construction. In production exactly one table is ever cached, hence exactly one job. It also means an injected fake cannot leak a job into the real path.
- **A job whose limit could not be set is closed and never cached.** Caching an unlimited job would be a silent downgrade to no backstop; the next attempt starts over. Covered by a test.
- **The `platform` DI field on the three clients is scoped to ADOPTION only.** It is not forwarded to `processTreeOptions()`: disposal keeps `process.platform` as its own authority so a POSIX test using `platform: 'win32'` cannot reroute the real taskkill sweep, and so the windows-latest leg's existing adapter tests (which pass mock `spawnFn`s) are untouched.
- **codex needs an event gate; claude and pi do not.** claude gates on `waitForInit()` and pi on the first `send()`. `CodexProcessRunner` has no first awaited operation of its own — `codex-adapter.ts` reads the FIRST event as the authoritative thread id — and `codex-adapter.ts` is outside this contract's allowed paths, so the gate lives in the runner: lines are buffered until adoption settles and dropped if it fails. The parity test proves it by rejecting the assignment 250 ms AFTER the fake runtime has already emitted `thread.started`.
- **Test-only surface is one export, `__hostExitBackstopForTests`.** `process-tree.ts` is internal to the package, and a single object (run / registeredPids / listenerCount) is smaller than either a reset function plus a factory or an injectable registry.

## Deviations From Plan Or Spec

- **`killFn` / `spawnSyncFn` were NOT threaded onto the three clients' option interfaces.** They are on `AdoptOwnedProcessTreeOptions`, where `host-exit-backstop.test.ts` consumes them. Adding them to the clients would have created options with no consumer, and `spawnSyncFn` would additionally have tripped the existing structural guard in `adapter-disposal-parity.test.ts` (`expect(code).not.toMatch(/spawnSync/)`) — weakening that guard to accommodate a passthrough field nothing reads was the worse trade. `platform` and `jobObject` are threaded, because the fail-closed parity cases need them.
- **koffi 3.2.0 does not ship prebuilt `.node` files inside its own tarball; it resolves them from sibling per-platform packages** (`@koromix/koffi-<platform>-<arch>`, sixteen of them, `os`/`cpu`-constrained optional dependencies). Measured footprint on this host: 1.8 MB for `koffi` + 1.2 MB for `@koromix/koffi-darwin-arm64` ≈ **3 MB**, not the ~28 MB the plan's risk table estimated. The CHANGELOG records the measured number. Its `install` script (`cnoke.cjs --prebuild`) is still a prebuild check and Bun did not run it, as expected.
- **The host-exit test reaches the `.ts` source from a plain Node subprocess via a resolve hook fixture, not the built module.** `bun run test` does not build, and Node's ESM resolver never guesses extensions while this package imports extensionless. Node 22.18+/24 type stripping plus a ten-line `module.registerHooks` resolve hook covers it with no new dependency. Verified working on Node 24.18 locally; `.node-version` pins 22.22 for CI, which has both features.

## Residual Boundaries

- **Assignment window.** The job assignment happens after `spawn` returns. A grandchild forked inside that window is outside the job. Recorded in `adoptOwnedProcessTree`'s doc comment.
- **Daemon SIGKILL / OOM on POSIX.** No in-process `exit` listener can run, and POSIX has no job object to fall back on. The win32 job object is the only backstop that survives this class, and it is win32-only by nature.
- **The real koffi path was NOT exercised on this machine (macOS).** What was proven locally: `koffi@3.2.0` loads, and `koffi.load('kernel32.dll')` is genuinely reached and fails only with `dlopen(kernel32.dll)` — i.e. the module and its native addon work, and only the Windows library is missing. The six kernel32 bindings, the ABI payload against the real `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`, and the kill-on-close behaviour itself can only be confirmed by the **windows-latest CI leg** (contract Stop Condition).
- **The kill-on-close semantics are asserted against a fake binding table**, not the kernel. The payload asserted (class 9, 144 bytes, `0x00002000` at offset 16, everything else zero) matches the constants deepseek-harness verified against real Windows headers with its own ABI probe.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| `RuntimeExecutionFailure` for the assignment failure | Reject | Frozen and phase/category/retry-shaped; cannot carry `win32Code`, and this is a transport precondition, not a boundary verdict |
| Flat `killFn`/`spawnSyncFn` on the client options (as dispatched) | Reject | No consumer, and `spawnSyncFn` collides with an existing structural guard that is worth more than the passthrough |
| Forward the adoption `platform` to `processTreeOptions()` too | Reject | Would let a POSIX test reroute the real taskkill sweep and would change behaviour for the windows-latest leg's mock-`spawnFn` adapter tests |
| In-process invocation of the exit listener as the only host-exit proof | Reject as sole evidence | Kept as a supporting case; the primary proof is a real subprocess `process.exit(0)` plus an unadopted control run |
| Bundle koffi (`noExternal`) | Reject | A native addon cannot be inlined; the release-graph check now enforces this |

## Open Questions

- **`bun run check:api-surface` fails, and its remedy is outside `allowed_paths`.** The golden `api-surface/client.d.ts` drifts because `ClaudeProcessClient` / `PiRpcClient` / `CodexProcessRunner` and their option interfaces are part of the built public `.d.ts`, and `tsc` emits `private` members into it. The drift is **purely additive** and contains no new export, no removal and no changed signature:
  - `platform?: NodeJS.Platform` and `jobObject?: { assign(pid: number): Promise<void> }` on the three option interfaces
  - `private readonly adopted` / `private adoptionFailure` / `private adoptOwnedTree` on all three, plus `private adoption` / `private readonly deferredEvents` / `private deliver` on the codex runner
  (verified by running `--update`, diffing, and restoring the golden: 102 insertions, 2 deletions, the two deletions being doc-comment relocation.)
  There is no way to avoid this: any private field on those classes drifts the golden. The remedy is one command — `bun run check:api-surface -- --update`.
  **CLOSED (gate round 1).** `api-surface/client.d.ts` is listed in this contract's `allowed_paths`, so the regeneration belongs here: the golden was regenerated and `bun run check:api-surface` now exits 0 (`api-surface: 9 package golden(s) match the built declarations`). No owner decision outstanding.

## Verification

Run at repo root on macOS (Darwin 25.5.0), Node 24.18.0 under vitest, bun 1.4.0.

```
$ bun install
Checked 505 installs across 682 packages (no changes) [30.00ms]
EXIT=0

$ bun run --filter @byok-sdk/client typecheck
@byok-sdk/client typecheck: Exited with code 0
EXIT=0

$ bun run --filter @byok-sdk/client build
@byok-sdk/client build: ESM ⚡️ Build success in 822ms
@byok-sdk/client build: {"adapterEntryBytes":150063,"packageRoot":"/Users/kito/Projects/byok-sdk/packages/client/","status":"passed"}
@byok-sdk/client build: {"agentMemoryEntryBytes":39086,"agentMemoryEntryCeiling":49152,"rootEntryBytes":942394,"status":"passed"}
@byok-sdk/client build: Exited with code 0
EXIT=0

$ bun run --filter @byok-sdk/client test
@byok-sdk/client test:  Test Files  167 passed | 2 skipped (169)
@byok-sdk/client test:       Tests  1635 passed | 11 skipped (1646)
@byok-sdk/client test:    Duration  21.07s (transform 6.24s, setup 0ms, import 25.06s, tests 179.91s, environment 9ms)
@byok-sdk/client test: Exited with code 0
EXIT=0

$ bun run check:release-graph
[release-graph] OK: 9 aligned manifests at 0.13.0, keys at 0.3.10; umbrella has 7 dispatch namespaces and no keys edge
EXIT=0

$ bun run check:api-surface
api-surface: 9 package golden(s) match the built declarations
EXIT=0

$ bun run test:scripts
ℹ tests 20
ℹ pass 20
ℹ fail 0
EXIT=0

$ git diff --check
EXIT=0
```

New-file suites, run individually:

```
$ bun run --filter @byok-sdk/client test -- src/__tests__/win32-job-object.test.ts
 Test Files  1 passed (1)
      Tests  12 passed (12)
EXIT=0

$ bun run --filter @byok-sdk/client test -- src/__tests__/host-exit-backstop.test.ts
 Test Files  1 passed (1)
      Tests  6 passed (6)
EXIT=0

$ bun run --filter @byok-sdk/client test -- src/__tests__/adapter-disposal-parity.test.ts
 Test Files  1 passed (1)
      Tests  9 passed (9)
EXIT=0
```

Negative tests of the exact-pin and `noExternal` release-graph checks (mutation applied, then reverted); the optional-dependency purity audit added in gate round 1 has its own mutation evidence below:

```
$ node scripts/release/check-package-graph.mjs   # koffi loosened to ^3.2.0 and added to noExternal
[release-graph] packages/client/package.json: optional dependency koffi must be pinned to an exact x.y.z version
[release-graph] packages/client/tsup.config.ts: optional dependency koffi must not be inlined by noExternal; it has to stay a runtime resolution
EXIT=1
```

Bundle readback (`packages/client/dist/index.js` after build): `import('koffi')` survives as a runtime dynamic import, and esbuild wrapped the job-object module in a lazy `__esm` init reached only from the win32 branch (`await Promise.resolve().then(() => (init_win32_job_object(), win32_job_object_exports))`), so importing the client never evaluates it.

## Gate Round 1

Three findings from the acceptance gate, and what each one changed.

1. **The `optionalDependencies` carve-out was asserted in prose but never audited.** The comment claimed the two new checks kept the exception from widening, but neither of them looked at install scripts or shipped `.node` addons for optional entries — only direct dependencies got `auditPackagePurity`. A second native optional entry would have passed silently, and koffi itself was never held to the rule it was the stated exception to (koffi 3.2.0 declares `install: node ./cnoke.cjs -P . -D src/koffi --prebuild --release`). Fix in `scripts/release/check-package-graph.mjs`: every `optionalDependencies` entry is resolved with the existing `resolvePackageDir` and run through `auditPackagePurity`; violations are accepted only for names in the new `OPTIONAL_NATIVE_ALLOWLIST` constant, whose one entry is koffi with its written justification (per-platform prebuilt from `@koromix/koffi-*` makes the install script a no-op, bun never runs it, POSIX never loads the module); an allowlisted name that is not actually in `optionalDependencies` is itself an error, so the carve-out cannot outlive the dependency. The invariant comment now states all of this, including that koffi carries an install script and why that is acceptable.
2. **Notes recorded a failing `check:api-surface` and an open owner question that were both already resolved.** `api-surface/client.d.ts` is in this contract's `allowed_paths` and the golden was regenerated; the run block, the "NOT fixed here" deviation bullet, and the Open Question have been updated to the passing state.
3. **The contract's regression-risk line still carried the plan's `+28 MB` estimate.** Replaced with the measured `~3 MB` (koffi 1.8 MB + one `@koromix/koffi-<os>-<arch>` prebuilt 1.2 MB) in `tasks/archive/contract-20260906-0244-win32-job-object-ownership.md`.

Residual the gate named (codex only, accepted): if the fail-closed teardown itself cannot kill a freshly spawned child, `CodexProcessRunner.waitClosed()` never resolves while parsed events stay dropped, so the adapter race hangs instead of erroring. Likelihood is very low — it needs the kill to fail on a process that has just spawned — and claude and pi are unaffected because they reject from `adopted` directly rather than through an event gate.

Mutation evidence for the new optional-dependency audit. The script and the manifests were copied into a scratchpad mirror (`<scratchpad>/mutation`, everything else symlinked back to the real tree); no tracked file was mutated.

```
$ node <mirror>/scripts/release/check-package-graph.mjs   # unmutated mirror
[release-graph] OK: 9 aligned manifests at 0.13.0, keys at 0.3.10; umbrella has 7 dispatch namespaces and no keys edge
EXIT=0

$ node <mirror>/scripts/release/check-package-graph.mjs   # + optionalDependencies esbuild 0.28.2 (postinstall script, from the bun cache)
[release-graph] packages/client/package.json: optional dependency esbuild declares a postinstall script — optionalDependencies is not a free pass for native packages; add esbuild to OPTIONAL_NATIVE_ALLOWLIST in this script with a written justification, or drop the dependency
EXIT=1

$ node <mirror>/scripts/release/check-package-graph.mjs   # + optionalDependencies fsevents 2.3.3 (ships fsevents.node, from the bun cache)
[release-graph] packages/client/package.json: optional dependency fsevents ships a native addon (fsevents.node) — optionalDependencies is not a free pass for native packages; add fsevents to OPTIONAL_NATIVE_ALLOWLIST in this script with a written justification, or drop the dependency
EXIT=1

$ node <mirror>/scripts/release/check-package-graph.mjs   # koffi removed from optionalDependencies (dead carve-out)
[release-graph] scripts/release/check-package-graph.mjs: OPTIONAL_NATIVE_ALLOWLIST carves out koffi, which is no longer an optionalDependency of packages/client — remove the dead carve-out
EXIT=1
```

The allowlist is load-bearing rather than decorative — koffi fails the audit on its own:

```
$ node scripts/release/check-package-graph.mjs --self-test packages/client/node_modules/koffi
[release-graph] self-test /Users/kito/Projects/byok-sdk/packages/client/node_modules/koffi declares a install script
EXIT=1
```

Re-run after the three fixes:

```
$ bun run check:release-graph
[release-graph] OK: 9 aligned manifests at 0.13.0, keys at 0.3.10; umbrella has 7 dispatch namespaces and no keys edge
EXIT=0

$ bun run test:scripts
ℹ tests 20
ℹ pass 20
ℹ fail 0
EXIT=0

$ bun run --filter @byok-sdk/client typecheck
@byok-sdk/client typecheck: Exited with code 0
EXIT=0

$ git diff --check
EXIT=0
```

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Candidate for `docs/researches/`: a plain Node subprocess can import this repo's `.ts` sources with type stripping plus a ten-line `module.registerHooks` resolve hook (`fixtures/ts-source-resolve-hook.mjs`). It removes the usual "build first, or fake it in-process" choice for any test that needs a real second process. Hold until a second task reuses it.
- Not promotable yet: the koffi 3.x per-platform addon layout (1.8 MB + ~1.2 MB, not one 28 MB tarball) is a fact about one dependency version, recorded above and in the CHANGELOG.
