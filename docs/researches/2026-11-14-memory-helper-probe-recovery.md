# Memory-helper probe recovery evidence (#2200)

Original baseline: `bd193cf82`. Reviewed implementation heads: `267595c75` and `0542a7e1c`. Previous production correction: `0e38d205c`. The Linux CI correction below follows `6bd5fae17`. Local platform: macOS arm64, Node 24.18.0, Bun 1.4.2.

## Final lifecycle

The original implementation converted a helper timeout into permanently captured backend absence. The correction separates cheap configuration preflight from slow volume proof. Every start resolves/verifies the helper, checks executable access and canonical paths, and prepares a fresh candidate. A configured intent transport receives the original startup error for invalid configuration. The initial macOS helper full-sync probe runs in the background, so a stalled helper does not consume startup's ordinary budget. Native and other non-helper backends finish proof during startup before the first hello, preserving main's original capability snapshot and stderr behavior.

One run-owned scheduler initiates all helper volume proofs and capped retries. Intents and leftover-copy lease settlement only read readiness. Stop revokes proof; a later start revalidates even a previously proven or refused backend. Root entries are shared only while their subprocess is in flight, with an independent controller and deadline and separate waiter cancellation. The last waiter leaving cancels unfinished work; every completed entry is evicted. There is no completed success cache that can authorize a changed volume on restart.

The public helper signature and ordinary request behavior remain unchanged behind an explicit internal opener. There is no AsyncLocalStorage. The probe's absolute deadline and stop signal cover open, close and child reaping. Close acknowledgement alone cannot publish readiness.

`helperExitError` is the common exit factory for root-barrier and serve; their former separate classifiers were removed. It preserves bounded root failure causes and private outcome metadata without adding a public error type or field:

| Observed outcome | Proof result |
| --- | --- |
| Root operation succeeds; serve returns a normal close reply and exits 0 before the deadline | proven |
| Explicit nonzero child exit | refused, diagnostic includes `exit_code=<number>` |
| Own deadline expires | kill/reap, identifiable timeout, unproven |
| Own stop cancels work | cancel/reap and revoke readiness; never authoritative refusal |
| External signal terminates either subprocess | unproven, diagnostic includes `signal=<name>` |

## Regression proof

The original timeout/captured-backend regressions were run in an isolated checkout at `bd193cf82` and failed for the intended 10-second timeout and captured `filesystem_unavailable` behavior. They pass with the correction.

The final candidate was also copied into an isolated checkout based on `0542a7e1c`. Each condition below was reintroduced separately and restored before the next run. Every mutant failed its intended assertion; restoring all candidate files passed **46/46** controlled helper tests.

| Reintroduced condition | Test selector | Observed regression |
| --- | --- | --- |
| Skip cheap startup preflight | `configured intents preserve\|configured intents fail startup when a verified\|invalid canonical helper root` | 4 failures: startup resolves instead of rejecting the original resolver/access/path error |
| Retain stopped-run proof and reuse prepared state | `refused proof can recover\|previously proven run and root\|changed helper is revalidated` | 3 failures: stale refused/proven state or skipped helper revalidation |
| Retain completed root barrier | `previously proven run and root` | 1 failure: changed volume becomes proven instead of refused |
| Restore an unconditional 1-second post-close grace | `close reply without child exit` | 1 failure: helper is not killed at the original deadline |
| Ignore failed exit after close reply | `nonzero exit` | 2 failures: nonzero serve exit incorrectly becomes proven |
| Treat external signals as authoritative failures | `external SIG` | 4 failures: serve/root signal outcomes become refused instead of unproven |
| Remove stop listener before child reaping | `stop cancels child reaping` | 1 failure: stop fails to kill/reap the acknowledged-close child |
| Drop root-barrier signal metadata | `root-barrier external` | 2 failures: external root signals become refused |
| Drop root-barrier exit-code metadata | `root-barrier exit` | 2 failures: diagnostic loses the explicit exit code |

Each selector ran with:

```sh
cd packages/client
../../node_modules/.bin/vitest run src/__tests__/agent-memory-helper-protocol-four.test.ts -t '<selector>'
```

The controlled fixture covers missing/inaccessible helpers, actual startup composition, refused → stop → repair → start → proven, proven → stop → changed volume/helper → start, close reply followed by stalled or abnormal exit, and both subprocesses' numeric/signal outcomes. It also retains first-review coverage for shared-root waiter cancellation, last-waiter cleanup, close cancellation, no lease-triggered/post-stop probes, exact capped backoff, live lane recovery, hello refresh, and sanitized diagnostics. Ready gates from the controlled helper establish fake-clock boundaries without polling-induced clock drift; no test waits for a real 60-second deadline.

## Actual helper and integration checks

Build and test sequentially so a clean JS build cannot remove native assets during tests:

```sh
bun run build
bun run --filter @byok-sdk/client build:agent-memory-helper
cd packages/client
../../node_modules/.bin/vitest run src/__tests__/agent-memory-helper-protocol-four.test.ts src/__tests__/agent-memory-intent.test.ts src/__tests__/agent-memory-commit.test.ts src/__tests__/agent-memory-fs-helper.test.ts src/__tests__/daemon-conn-hello-capabilities.test.ts
```

Result: **5 files passed, 227 tests passed, 26 skipped**. Real helper/filesystem tests ran locally only. A verified SDK helper copied to a test-owned directory and stripped of executable permission makes configured-intent startup fail with `EACCES` before any hello. Capability assertions wait for the newly proven background declaration and continue to reject authoritative failures. MCP reload selects the exact toolset snapshot because an independent memory readiness refresh may interleave another hello; its exact toolset/path-disclosure assertions remain intact.

Recovery uses existing `setHelloCapability` and `connection.refreshHello()`, refreshing the existing `conn.hello` array. The complete helper CI collection plus the controlled file was also run locally: **15 files passed, 293 tests passed, 34 skipped**. Two older integration cases had assumed the first hello already carried memory readiness. Their revised fixtures gate the real volume opener, assert the first hello omits the intent capability, release the gate, and assert a later refreshed hello includes it before continuing real copied-asset I/O and cursor/no-repeat-CAS checks. The gate never supplies a fake result or capability. The copied-asset observer follows the explicit internal opener so it still sees the daemon volume proof as well as consumer opens.

No message, protocol field, reason code, configuration option or public declaration was added. Refusal diagnostics contain a bounded code, class or numeric exit code; external signal diagnostics contain the signal name, without original messages/paths.

## Public surface and dependency graph

`bun run check:api-surface -- --update`, `git diff bd193cf82 --exit-code -- 'api-surface/*.d.ts'` and `bun run check:api-surface` pass with measured budgets. All nine declaration goldens, including client and protocol, are unchanged.

`node /tmp/2200-check-cycles.mjs` compares original/fixed `packages/client/src/index.ts` through esbuild (`bundle: true`, `packages: 'external'`, `platform: 'node'`, `format: 'esm'`, `target: 'es2022'`, `write: false`, `metafile: true`). Both workspace builds are present so private host imports resolve normally. It compares strongly connected components of non-external `metafile.inputs[*].imports` and emitted `= __esm(` initializers:

```json
{"baseCycleCount":0,"fixedCycleCount":0,"addedCycles":[],"privateProbeComponent":["packages/client/src/daemon/agent-memory-helper-probe.ts"],"esmInitializers":[12,12],"warnings":[0,0]}
```

The private implementation's reference to the public identity type is erased. There is no reverse runtime dependency or new initialization cycle.

## Normalized closure bytes

Budgets in `entries.json` and README equal measurements. The common exit factory replaced the separate classifiers; no outcome or diagnostic was cut to reduce size. For this correction t3 approved a ceiling of +7,014 B per main entry, +339 B beyond the previous +6,675 B. The final measurement is 28 B below that ceiling. Helper verification refusal diagnostics stay at preflight, and a helper without a strict candidate (Windows) schedules no background proof or new diagnostic.

| Entry | Original | Final | Growth |
| --- | ---: | ---: | ---: |
| `@byok-sdk/client` | 2,468,426 | 2,475,412 | +6,986 B |
| `bin:byok-agent` | 2,463,129 | 2,470,115 | +6,986 B |
| `@byok-sdk/bot-collaboration` | 2,799,661 | 2,806,647 | +6,986 B |
| `@byok-sdk/bot-collaboration/testing` | 3,251,254 | 3,258,240 | +6,986 B |
| `@byok-sdk/client/agent-memory` | 80,957 | 84,735 | +3,778 B |

## Linux CI correction after `6bd5fae17`

Main's original `openStartRun` ends with `const agentMemoryBackend = await provenAgentMemoryBackend()`. That function awaits `probeAgentMemoryStrictDirectorySync(hostStorageRoot)` for a native backend before returning it. Thus the original Linux startup is asynchronous but awaited before composing/publishing the first hello. It does not publish an unproven snapshot followed by a memory-capability refresh. Source evidence: `git show bd193cf82:packages/client/src/daemon/create-daemon/start-run.ts` and `git show bd193cf82:packages/client/src/daemon/create-daemon/services.ts`.

The correction proves non-helper backends in `initializeAgentMemoryBackend`, and the recovery entry installs lifecycle cancellation but schedules volume work only for a verified helper. Native success or refusal emits no new diagnostic and triggers no refresh. An initial helper success is also quiet; transitions to unproven, refused and recovered retain metadata-only diagnostics. Helper verification failure without configured intents is recorded as refused during preflight; configured intents still receive the original startup error.

The nine Linux failures are accounted for individually:

| CI failure | Cause and correction | Preserved assertion |
| --- | --- | --- |
| `agent-memory-entry-constraints` exact module graph | The unchanged public facade now reaches its private helper implementation and probe outcome/budget leaf. Add exactly `daemon/agent-memory-fs-helper-internal.ts` and `daemon/agent-memory-helper-probe.ts`, both inside memory filesystem authority. | Exact equality, forbidden composition/transport and public exports remain enforced. |
| `agent-memory-helper-p1-regressions` EPIPE | The serve fixture assigned `exitCode = 0` without emitting `exit`; `closeAndWait` correctly awaited its constructor-registered exit promise. Emit the actual exit event in the fixture. | EPIPE rejection, no uncaught exception, bounded request and base64 content assertions remain unchanged; no timeout increase. |
| `agent-memory-intent` Linux native advertised | Native proof finishes before the first hello again. | Original capability, applied/completed/ACK and cursor assertions unchanged. |
| `daemon-reconnect` restart cursor | The extra first-run capability hello no longer occupies the restart hello slot. | Original two-hello count and persisted cursor assertion unchanged. |
| `real-server-longpoll-only` cold start | No extra native capability refresh. | Original single hello, default hold and open timing unchanged. |
| `real-server-longpoll-only` reconnect | Only the actual reconnect adds a hello. | Original two-hello count and fresh handshake/POST ordering unchanged. |
| `daemon-task-loop` untyped start failure | No normal-success error diagnostic. | Original single error and failure projection unchanged. |
| `task-runner-runtime-failure` untyped run throw | Same diagnostic correction. | Original single error and typed/non-retryable projection unchanged. |
| `task-runner-runtime-failure` completion without authority | Same diagnostic correction. | Original single error and failure projection unchanged. |

EPIPE reproduction on macOS: running its existing file at `6bd5fae17` timed out after 10 seconds. A temporary probe immediately before `close()` printed `exitCode=0 assigned without emitting exit; close now waits for exit`, followed by the same timeout. The corrected fixture passes 2/2. The real child listener is installed immediately after `spawn`, before the open request; setting the mock property alone cannot settle that listener. This is a fixture lifecycle defect, with no product close-path modification.

Both requested independent rollback checks ran against the final correction:

| Reverted correction | Actual command | Red result | Restored result |
| --- | --- | --- | --- |
| Native awaited proof and scheduler exclusion, keeping quiet diagnostics | Linux Secret Service wrapper, `vitest run --maxWorkers=1 src/__tests__/daemon-reconnect.test.ts` | 1 failed / 1 passed: second hello has commit capability but no persisted `cursor: 1`. | 2 passed. |
| Initial helper-success silence, keeping native startup correction | macOS `vitest run src/__tests__/agent-memory-helper-protocol-four.test.ts -t 'keeps initial success quiet'` | 1 failed: expected `[]`, received the `agent memory backend proven` error line. | 1 passed / 45 unselected. |

Final local verification in this correction:

- macOS helper CI collection plus controlled helper file: **15 files, 294 passed / 34 skipped**. All 47 controlled helper tests pass, retaining initial withheld capability, later refresh, restart and subprocess outcome cases. The additional case pins the Windows helper's lack of strict proof: no subprocess, readiness callback, diagnostic or timer is introduced. Removing only that scheduler guard makes this case fail; restoring it passes.
- Linux Colima arm64, Node 24.22.1 / Bun 1.4.2: own `byok-2201-linux-t3px` container, read-only source replica copied into private `/work`, fresh dependencies and successful workspace build. Secret Service wrapper, `NODE_OPTIONS=--max-old-space-size=768`, seven original failing files with `--maxWorkers=1`: **7 files, 175 passed / 7 skipped**. No Linux behavior assertion was edited.
- The subsequent `bun run --cwd packages/client typecheck` was killed by VM OOM (exit 137; cgroup `oom_kill` increased from 1 to 2), so the chained full client test did not run. The first workspace build also suffered OOM; a clean second build succeeded. Per t3's explicit instruction, local Linux execution then stopped; complete Linux workspace tests/typecheck are delegated to PR CI. No other container or VM setting was changed. The owned container, image and source replica were removed.
- Local workspace build/typecheck, API-surface check/update, version authority and upgrade manifest checks pass. All nine declaration goldens remain unchanged from `bd193cf82`. Current esbuild output has 0 cycles, 12 `__esm` initializers and 0 warnings; comparing to the prior seat's retained original metafile adds no cycles. Changed-file LSP probe reports no type errors; auxiliary warnings concern existing nested ternary/logging and test mock construction.

Remote evidence and final-head CI state are recorded in the PR body, so this file does not predict a result for a head that has not yet been pushed.
