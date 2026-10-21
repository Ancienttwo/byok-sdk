# WO-05 validation

## Explicit retention / issue #602

Date: 2026-10-21. Baseline: `ad0d2d2591d8b5eb6ebb4c7f47cfc5463ca5f779`.
Environment: macOS arm64, Node `v24.18.0`, Bun `1.4.3`. Branch: `fix/602-host-retention`.
Only synthetic temporary databases were compacted. No user database was opened or cleaned up.

`src/fixtures/retention-benchmark.ts` creates settled, acknowledged records through the real
`enqueue`/`settle` transitions and measures the real SQLite ledger. It removes its temporary
databases on completion. The baseline ledger module is extracted without editing either checkout:

```sh
git show ad0d2d2591d8b5eb6ebb4c7f47cfc5463ca5f779:examples/host-execution-core/src/ledger.ts > /tmp/byok602-baseline-ledger.ts
cd examples/host-execution-core
node --import tsx src/fixtures/retention-benchmark.ts file:///tmp/byok602-baseline-ledger.ts
node --import tsx src/fixtures/retention-benchmark.ts
```

The benchmark inserts each fixture in one transaction, then times three counter-only transactions
that rewrite the unchanged history. It measures JSON bytes, not filesystem/WAL writes or end-to-end
Agent throughput. The 1k/10k cases deliberately use reduced payloads to avoid a gigabyte allocation.
All benchmark records are ordinary user intents; this is not a routine-calendar load measurement.
The ten-record case uses the downstream 48 KiB instruction / 64 KiB JSON document sizes; instruction
is stored in both intent and execution. These runs are observations on one machine, not capacity
limits or statistically established latency targets.

| Turns | Instruction / document bytes | Baseline JSON bytes | Baseline rewrite ms (three runs) | Compacted JSON bytes | Compaction ms | Post-compaction rewrite ms |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 49152 / 65536 | 1660311 | 2.328, 2.206, 3.130 | 173 | 2.603 | 0.090, 0.099, 0.094 |
| 1000 | 128 / 256 | 2689955 | 10.149, 11.197, 11.686 | 175 | 18.490 | 0.108, 0.110, 0.105 |
| 10000 | 128 / 256 | 26917957 | 122.354, 105.838, 104.612 | 176 | 195.367 | 0.093, 0.054, 0.052 |

The patched ledger before compaction had identical JSON byte counts; corresponding rewrite times
were 2.156/2.983/5.105, 15.078/9.532/9.663, and 117.997/111.011/108.529 ms. The compacted hot body
contains empty history maps plus monotonic counters; counter digit lengths explain the small size
differences. Permanent intent hashes remain in an indexed table that grows with historical count.
Application values, routines/audits and all outbox data have independent growth; no total database
size bound or disk space reclamation is claimed. Earlier issue-comment measurements used a simpler
synthetic JSON shape; the table here uses the committed reproducible transition fixture.

Focused coverage: acknowledged selection and repeated selection; all retry generations; preservation
of unsettled/unacknowledged evidence, custom outbox and business values; whole-batch rollback on
invalid selection and injected SQL failure; reopening and tenant isolation; exact seven-day boundary;
permanent identity rejection after expiry, including the pure transition path; invalid time/overflow
and non-array arguments; bounded hot body; actual SDK/daemon routine replay before and after expiry
without reapplying the retained SDK terminal. The real-SDK test uses the repository's runtime stub,
not a model/provider call. One initial sandboxed real-SDK run timed out; with localhost/subprocess
access the test executed and exposed a fixture clock mismatch. Aligning the injected Host clock
with the delivered SDK slot fixed the fixture; no assertions or timeout budgets were weakened.

Root build, root typecheck, API surface and version authority passed. The final affected K4 suite
passed: 79 tests, 8 files, 44.27 seconds, including all 13 retention tests and the version-1 additive
migration/exclusive occurrence ownership regressions. Six existing Linux-only tests were skipped
by their existing platform condition on macOS (one file); no skip condition was changed. The final
affected package typecheck and `git diff --check` also passed.

The single required `bun run test` attempt exited 1 after 247.27 seconds in the first (client)
package: 4185 passed, 67 skipped, one failed. The failing case was
`agent-home-single-writer.test.ts > keeps the home busy when disposal fails, and says so in status`,
with `timed out waiting for envelope` from `fixtures/test-server.ts:302`. Because the root command
is sequential, subsequent packages did not run. An independent reviewer ran that exact focused
case on baseline `ad0d2d2591d8b5eb6ebb4c7f47cfc5463ca5f779` and this patch under comparable Node/Bun
and local-socket permissions: both passed (431 ms and 416 ms). That does not establish a baseline
bug or resource-contention cause; the broader-run failure remains unclassified. No test deadline,
assertion, CI configuration or skip was changed to conceal it. No full-workspace pass is claimed.

Logs: `/tmp/byok-602-root-test.log`, `/tmp/byok-602-disposal-baseline.log`,
`/tmp/byok-602-disposal-patched.log`, and other `/tmp/byok-602-*` files. Independent source, test,
README and measurement review found no actionable issue. The patch remains Draft because the full
workspace gate failed as described above; this record does not turn the isolated passes into a
passing full gate.
The existing built-adapter Windows job now also runs the new retention suite after its normal
install/build. This adds platform qualification without changing any assertions, skips or existing
gates. Windows execution is pending CI; it was not run on this Mac. PR #619 separately adds other
K4 Windows suites and may require an ordinary merge resolution in this workflow insertion area.

Date: 2026-10-18. Baseline: `8e8839a3`.
Branch: `codex/bot-k4-host-execution-core`.
Environment: macOS, Node `v24.21.0`, Bun `1.4.3`.

## Coalescing observation repair on 260570ae

Date: 2026-10-19. Baseline: `260570ae`, including the owner's ordinary merge of `origin/main@2e06fa91`.
CI run `39212142718`, Node 26 job `117928000884`, failed the exact one-queued assertion at `src/routines.test.ts:44`.
It reported 37/38 passing tests. The downloaded job log is `coalesce-ci-node26.log` under `_ops/wo-05/`.

P1: `recordOccurrence` creates the replacement queued occurrence. The independent Host scan expires an old queued intent at `retryUntil`.
P2: At the next 100 ms slot, scan can supersede the old queued occurrence before SDK delivery creates its replacement.
Three committed occurrences and one in-flight execution can therefore coexist with zero queued intents during that window.
A temporary real-SDK probe held the fourth wake before the Host consume call and ran the normal Host scan.
The original one-queued assertion then failed with the same empty-array result. The three-occurrence and one-in-flight assertions passed.
The probe source and failure log are retained only in ignored `_ops/wo-05/coalesce-gap.probe.test.ts` and `coalesce-gap-red.log`.

P3: Control the shared wall clock with `vi.setSystemTime`, without fake timers.
Advance two slots explicitly and wait for each occurrence commit through the real SDK wake path.
Hold the clock before the next cutoff while checking the original one-running, one-queued and superseded assertions.
Also check that the queued intent belongs to the latest slot.
After pause, cross later slots and wait for a public SDK wake completion before checking no new occurrences.
The existing pending-wake, current-terminal, lifecycle and cannot-resume assertions remain unchanged.
There is no fixed sleep, test retry, timeout increase, Host change or SDK change.

### Coalescing repair checks

All five complete K4 runs used `44b5287c`, in sequence, with no edits between runs.

| Command | Exit | Evidence |
| --- | --- | --- |
| `bun ci` | 0 | Merged lockfile installed; `coalesce-install.log`. |
| `bun run build` | 0 | Workspace build completed; `coalesce-build.log`. |
| `bun run typecheck` | 0 | Workspace typechecks completed; `coalesce-typecheck.log`. |
| `bun run --cwd examples/host-execution-core test src/routines.test.ts -t 'keeps one running occurrence'` | 0 | Focused case passed; `coalesce-focused.log`. |
| `bun run --cwd examples/host-execution-core test`, run 1 | 0 | 38/38 in 62.18 seconds; `coalesce-k4-1.log`. |
| `bun run --cwd examples/host-execution-core test`, run 2 | 0 | 38/38 in 59.68 seconds; `coalesce-k4-2.log`. |
| `bun run --cwd examples/host-execution-core test`, run 3 | 0 | 38/38 in 61.82 seconds; `coalesce-k4-3.log`. |
| `bun run --cwd examples/host-execution-core test`, run 4 | 0 | 38/38 in 62.60 seconds; `coalesce-k4-4.log`. |
| `bun run --cwd examples/host-execution-core test`, run 5 | 0 | 38/38 in 60.45 seconds; `coalesce-k4-5.log`. |
| `bun run check:api-surface` | 0 | All 9 package goldens match; `coalesce-api-surface.log`. |
| `bun run check:version-authority` | 0 | Dispatch 0.27.0 and keys 0.12.0 agree; `coalesce-version-authority.log`. |
| `git diff --check` | 0 | No whitespace errors. |

Logs and sequential exit receipts are in ignored `_ops/wo-05/`.
The temporary diagnostic exited 1 at the original one-queued assertion, as intended. It is not part of the final suite.
This test-only follow-up reruns the requested K4 suite and typecheck. It does not claim a new whole-workspace test pass.
The previous interrupted workspace run remains recorded below.
The read-only gatekeeper checked `260570ae..44b5287c` and returned PASS for the original semantics and assertion integrity.
It did not run tests or edit files. This local check does not replace p1G's requested hunk re-check.
The only changed tracked files are this record and `src/routines.test.ts`. Production code and SDK packages are unchanged.

## Merge-train repair for PR 532

Date: 2026-10-19. Prior head: `e5afad26`.
CI run `39201151933` failed the same rollback assertion in both baseline and Node 26 jobs.
An ordinary merge at `f85a80f5` brings in `origin/main@5b988a6e`. No rebase or force push is used.
The merge completed without conflicts. Package changes come from main; this repair adds none.

P1: The Host precheck and the rollback test shared a local 366-day constant.
Main now exports `WAKE_MAX_FUTURE_MS` and admits wakes up to 368 days.
P2: A wake 366 days ahead is still valid after a one-hour clock rollback: its delay is 366 days plus one hour, below 368 days.
The real SDK therefore accepts it, so the Host stays `ok`. The focused test reproduced the CI failure after merge and build.
P3: Use the SDK's public constant for the Host precheck. Build test candidates from that same public contract directly.
At the SDK boundary, a one-hour rollback again makes the real SDK reject the wake.
All error-state, pending-wake, outbox, persisted-error and successful-recovery assertions remain unchanged.
The exact-boundary test still requires acceptance at the limit and deferral at limit plus one millisecond.
The guide and README now describe the current public constant. The prior SDK export nit is closed by main's PR 523.

### Merge-train checks

| Command | Exit | Evidence |
| --- | --- | --- |
| `bun ci` | 0 | Frozen dependencies match the merged lockfile; `merge-train-install.log`. |
| `bun run build` | 0 | All workspace builds completed; `merge-train-build.log`. |
| `bun run typecheck` | 0 | All workspace typechecks completed; `merge-train-typecheck.log`. |
| `bun run --cwd examples/host-execution-core test src/scheduling-recovery.test.ts` | 0 | 9/9 passed; `merge-train-focused.log`. |
| `bun run --cwd examples/host-execution-core test` | 0 | 5 files, 38/38 passed in 44.30 seconds; `merge-train-k4.log`. |
| `bun run test` | 130 | Interrupted after multiple client-suite failures; no complete root-suite pass is claimed. See `merge-train-full-test.log`. |
| `bun run check:api-surface` | 0 | Built declarations match all 9 package goldens; `merge-train-api-surface.log`. |
| `bun run check:version-authority` | 0 | Dispatch 0.27.0 and keys 0.12.0 agree; `merge-train-version-authority.log`. |
| `git diff --check` | 0 | No whitespace errors. |

Logs are in this worktree's ignored `_ops/wo-05/` directory.
The old-source rollback probe exited 1 after merge and build (`merge-train-red.log`).
CI logs for baseline and Node 26 show the same failure (`merge-train-ci-baseline.log`, `merge-train-ci-node26.log`).
The read-only gatekeeper reviewed only `f85a80f5..a6adaad2` and returned PASS with no weakened assertion.
It did not review main's changes, run tests or modify files.
The additional root run reported failures in client admission, journal, daemon, approval and other SDK tests before interruption.
Their causes are not diagnosed by this K4 repair. The SDK package diff against `origin/main@5b988a6e` is empty.
The requested K4 suite and typecheck completed successfully. No source or test changes followed `a6adaad2`.

## V4 patch: preserve SDK schedule errors

This patch starts at `5c86a4b8` and implements the owner's follow-up request.
The pause observation fix (`135580c8`) and calendar recovery documentation (`35dcd82a`) already exist.
They remain unchanged. The pause test polls the public SDK pending state with its original empty-set assertion.
It does not retry the test or insert a fixed sleep. The original occurrence count and lifecycle assertions remain.

P1: `flushWakes` catches a real SDK `WAKE_AVAILABLE_AT_INVALID` rejection and defers the routine.
P2: That transaction removes the schedule outbox row. Previously, it did not copy the SDK error into the routine ledger.
The added assertion fails on the old implementation after a real wall-clock rollback and ledger reopen.
P3: Add optional `routine.lastError = { code, message }` in the same transaction as `schedule_retrying`.
Keep the original SDK values. Retain the last rejection after recovery for inspection.
A Host-only horizon precheck does not invent an SDK error. No scheduler or retry policy changes.

The first complete run passed. The second failed in the existing `unclaimed-expiry.test.ts` claim-before-cancel case.
The SDK returned `cancelled` with no `claimedRuntime`, instead of the expected `cancel_requested` with `pi`.
The test had observed runtime creation, not the SDK's durable claim.
`packages/client/src/daemon/task-runner.ts:2675` sends claim without awaiting its receipt, then starts the runtime at `:2879`.
SQLite cancellation selects its status from the persisted owner at `packages/server/src/stores/sqlite/index.ts:975`.
The probe now observes `tasks.attempt` owner and claimed runtime before its one cancel call.
Its original immediate cancellation assertions remain. This is a precondition barrier, not a test retry or fixed sleep.
The five-run sequence starts again on that fixed artifact. The failed sequence remains in the logs.

The next sequence also passed once, then exposed the same missing claim precondition in `core.test.ts`.
Its claimed-cancellation case had settled through the valid unclaimed-cancel path while the test expected `inflight`.
That test now observes the same public owner/runtime receipt before its single Host cancel call.
The hidden-terminal barrier, unsettled conclusion, generation and final cancellation assertions remain unchanged.
Both failed sequences remain recorded. The final five-run sequence uses both claim barriers.

### V4 patch checks

Verification date: 2026-10-19. The final five-run sequence used `472964dd` without edits between runs.
Each run executed the complete example suite. No test retry setting, filtered run or fixed sleep was added.

| Command | Exit | Evidence |
| --- | --- | --- |
| `bun run --cwd examples/host-execution-core test`, final run 1 | 0 | 38/38 in 45.29 seconds; `v4-patch-final-example-1.log`. |
| `bun run --cwd examples/host-execution-core test`, final run 2 | 0 | 38/38 in 39.18 seconds; `v4-patch-final-example-2.log`. |
| `bun run --cwd examples/host-execution-core test`, final run 3 | 0 | 38/38 in 34.67 seconds; `v4-patch-final-example-3.log`. |
| `bun run --cwd examples/host-execution-core test`, final run 4 | 0 | 38/38 in 35.86 seconds; `v4-patch-final-example-4.log`. |
| `bun run --cwd examples/host-execution-core test`, final run 5 | 0 | 38/38 in 32.56 seconds; `v4-patch-final-example-5.log`. |
| `bun run typecheck` | 0 | Final source and tests compile; `v4-patch-final-typecheck.log`. |
| `bun run build` | 0 | All workspace builds completed; `v4-patch-build.log`. |
| `bun run test` | 0 | Vitest: 9,326 passed, 200 skipped. Node tests: 10 passed, 0 failed; `v4-patch-full-test.log`. |
| `bun run check:api-surface` | 0 | 9 package goldens match; `v4-patch-api-surface.log`. |
| `bun run check:version-authority` | 0 | Dispatch 0.27.0 and keys 0.12.0 agree; `v4-patch-version-authority.log`. |
| `git diff --check` and `git diff 5c86a4b8..HEAD --check` | 0 | No whitespace errors. |

All logs are in this worktree's ignored `_ops/wo-05/` directory.
The root run also passed all 38 example tests on the final source in 32.24 seconds.
Skipped tests were in client (30), cloud-dataplane (139), keys (12), and server (19).
The optional Docker dataplane substrate was not started.
Source and tests did not change after `472964dd`. No `packages/` file changed.
No push or PR was made. The main checkout was not changed.
The final sequence receipts are in `v4-patch-final-example-exits.log`.
The first sequence exited 0, then 1 (`v4-patch-example-1.log`, `-2.log`).
The second sequence also exited 0, then 1 (`v4-patch-stable-example-1.log`, `-2.log`).
Each sequence stopped at its failure. The corresponding claim precondition was then fixed before a new sequence began.
The new error assertion first failed on the old implementation, then passed after the fix (`v4-patch-red.log`, `v4-patch-green.log`).
One example typecheck ran while build was replacing the SDK dist declarations and exited 1 with missing client imports.
After build finished, the same command exited 0 (`v4-patch-example-typecheck-during-build.log`, `v4-patch-example-typecheck.log`).

The read-only gatekeeper reviewed `5c86a4b8..6851d161` and `6851d161..1e2a2ddb`.
Both reviews returned PASS for test integrity and the scoped implementation. They ran no tests and made no edits.
The final `core.test.ts` claim barrier received a self-review. It uses the same public receipt and preserves every original assertion.

## V4 review closure

V4 starts at `ed992795`. The final external review returned PASS_WITH_NITS.
The read-only report is `/Users/chris/Projects/byok-sdk/_ops/bot-wo/REV-05-round2-result.md`.
This revision changes only the pause test's observation point and calendar recovery documentation.

P1: The test reads SDK `wakes.pending()` after the Host commits a routine pause.
P2: The SDK invalidates the active delivery before its queued complete write commits
(`packages/server/src/wakes/scheduler.ts:90`, `:101`). During that window, pending can report the row as queued (`:130`).
The external review observed this failure once. Its unmodified full rerun passed.
P3: Keep the exact empty-set assertion, routine filter and occurrence count checks.
Wait for the real SDK row to leave pending. Do not change cancellation or production code.

The guide and README now describe the existing `calendar_error` recovery entrypoint.
After the calendar is fixed, pause and then activate the routine to recalculate its next time.
`recover()` and same-definition `addRoutine()` do not recover that stored state.
This follows `setLifecycle` in `src/routines.ts:128`; it adds no recovery behavior.

### V4 checks

All three complete example runs used the same test source at `135580c8`.
They ran in sequence. No edit or filtered test run occurred between them.

| Command | Exit | Evidence |
| --- | --- | --- |
| `bun run --cwd examples/host-execution-core test`, run 1 | 0 | 5 files, 38 tests passed in 38.83 seconds; `v4-example-1.log`. |
| `bun run --cwd examples/host-execution-core test`, run 2 | 0 | 5 files, 38 tests passed in 43.84 seconds; `v4-example-2.log`. |
| `bun run --cwd examples/host-execution-core test`, run 3 | 0 | 5 files, 38 tests passed in 52.57 seconds; `v4-example-3.log`. |
| `bun run build` | 0 | All workspace builds completed; `v4-build.log`. |
| `bun run typecheck` | 0 | All workspace typechecks completed; `v4-typecheck.log`. |
| `bun run test` | 0 | Vitest: 9,326 passed, 200 skipped. Node tests: 10 passed, 0 failed; `v4-full-test.log`. |
| `bun run check:api-surface` | 0 | 9 package goldens match; `v4-api-surface.log`. |
| `bun run check:version-authority` | 0 | Dispatch 0.27.0 and keys 0.12.0 agree; `v4-version-authority.log`. |
| `git diff --check` and `git diff ed992795..HEAD --check` | 0 | No whitespace errors. |

Logs and the three sequential exit receipts are in this worktree's ignored `_ops/wo-05/` directory.
The root run also passed all 38 example tests in 34.07 seconds.
Skipped tests were in client (30), cloud-dataplane (139), keys (12), and server (19).
The optional Docker dataplane substrate was not started.
Test code did not change after `135580c8`. This revision changes no production code or `packages/` file.
No push or PR was made. The main checkout was not changed.

### V4 residual items

- The initial v4 left SDK error retention for K8a. The owner's v4 patch request above closes that P3 here.
- The occurrence hash includes the trigger, and the outbox has no persistent operation sequence number.
  These remain WO-03 alignment records. This revision does not change either storage contract.
- SDK nit: export the wake horizon constant from `@byok-sdk/server` for Host prechecks.
  The current private constant and 366/368-day synchronization rule remain as recorded below.

## V3 scope ruling and chat acceptance

V3 starts at `ae7acb2c`. Aimpact made these scope decisions on 2026-10-18:

- Platform PRD section 14.1's service rows belong to the downstream Host service after K2 and A2.
  They cover routine sync with the browser closed, `sync_failed`, 409, `device_offline`, `missed`, security and cost.
  This reference covers the device-local Topology L execution rows.
- Same-routine-ID version changes belong to K8a with `update_routine`.
  This includes current/pending versions, scheduling generation and the in-flight limit.
  K4 keeps definitions immutable. A changed definition needs a new ID.

Both decisions are recorded in the Host guide and example README.

The WO-03 follow-up keeps `WAKE_HORIZON_MS` at 366 days for the current SDK.
`src/routines.ts:6` now states the synchronization rule. The guide and README state the same rule.
After K8-S raises the running SDK limit to 368 days, the Host constant must change with it.
Until then, candidates more than 366 and up to 368 days ahead use `schedule_retrying` backoff.
They do not add a schedule outbox row or block other work. Existing horizon tests retain all assertions.

SDK nit: export the wake horizon constant from `@byok-sdk/server` for Host prechecks.
The current `MAX_FUTURE_MS` is private at `packages/server/src/wakes/types.ts:42`.
Validation uses it at `:48`. The public server entrypoint and built declarations expose no horizon constant.
No private SDK import or `packages/` change is made. This nit does not block K4.

P1: The test boundary is the existing embedded server, daemon and fake runtime.
P2: A routine and a Bot chat pass through the same core `executions.submit` path.
The runtime publishes a message and submits a result. The SDK stores the exact message decision and device terminal.
The Host reads that terminal and commits the opaque outcome, applied marker and result projections.
P3: Add one acceptance test and an optional message consumer in test support. Keep production code unchanged.

The new `src/core.test.ts:56` chat test covers Bot PRD section 5.8's first item.
It holds the consumer decision to observe a pending disposition, no terminal and no applied marker.
It checks the exact task/device identity, frozen context, message body, byte count and SHA-256 hash.
After acceptance it reads `tasks.messageDisposition(taskId, deviceId, payload).outcome === 'accepted'`.
The exact readback assertion is at `src/core.test.ts:100`, with a second read at `:120` after settlement and reopen.
It reads `task.complete` with the expected result document and compares it with the Host's stored terminal.
It proves FIFO order behind a routine and uses one injected outcome handler for both sources.
After ledger reopen, both conclusions, outcome markers and projections remain, with exactly two applications.
The same immutable accepted disposition remains readable after terminal settlement.

### V3 independent test review

The read-only gatekeeper reviewed only `ae7acb2c..30979bb7` for v3 test integrity and scope.
It returned PASS with no new defect or weakened assertion.
It confirmed real SDK submit and message readback, the pending decision barrier, shared FIFO,
and one outcome transaction path for both sources. It did not run tests or edit files.
The execution owner records the full checks separately below.

### V3 item map

| Item | Commit | Evidence |
| --- | --- | --- |
| One Bot chat turn | `384ee416` | `src/core.test.ts:56`; exact accepted disposition at `:100`, successful terminal at `:102`, durable outcomes at `:109`. |
| Downstream service rows after K2 and A2 | `30979bb7` | `docs/host-execution-core.md:306`, example `README.md:119`. |
| Same-ID version changes belong to K8a | `30979bb7` | `docs/host-execution-core.md:239`, example `README.md:124`. |
| Keep 366 days until the running SDK changes | `16286bd3` | `src/routines.ts:6`, `docs/host-execution-core.md:68`, example `README.md:111`; SDK export nit above. |

### V3 checks

| Command | Exit | Evidence |
| --- | --- | --- |
| `bun run build` | 0 | All workspace builds completed; `v3-build.log`. |
| `bun run typecheck` | 0 | All workspace typechecks completed; `v3-typecheck.log`. |
| `bun run test` | 0 | Vitest: 9,326 passed, 200 skipped. Node tests: 10 passed, 0 failed; `v3-full-test.log`. |
| `bun run check:api-surface` | 0 | 9 package goldens match; `v3-api-surface.log`. |
| `bun run check:version-authority` | 0 | Dispatch 0.27.0 and keys 0.12.0 agree; `v3-version-authority.log`. |
| `bun run --cwd examples/host-execution-core typecheck` | 0 | Includes the final horizon comment; `v3-example-typecheck.log`. |
| `bun run --cwd examples/host-execution-core test` | 0 | 5 files, 38 tests passed in 38.13 seconds; `v3-example-tests.log`. |
| `bun run --cwd examples/host-execution-core test src/core.test.ts -t 'accepts one Bot chat turn'` | 1, then 0 | Initial new-test row lookup corrected as described below; final focused pass in `v3-chat-test.log`. |
| `bun run --cwd examples/host-execution-core test src/scheduling-recovery.test.ts` | 0 | After the WO-03 comment and documentation addition: 9 tests passed; `v3-horizon-followup.log`. |
| `git diff --check` and `git diff ae7acb2c..HEAD --check` | 0 | No whitespace errors. |

The full root run also passed all 38 example tests in 36.74 seconds.
Skipped tests were in client (30), cloud-dataplane (139), keys (12), and server (19).
The optional Docker dataplane substrate was not started. Logs are in this worktree's ignored `_ops/wo-05/` directory.
Executable code and test assertions did not change after `384ee416`.
The later WO-03 addition changes one source comment and documentation only; the constant remains 366 days.
No `packages/` file changed. No push or PR was made. The main checkout was not changed.

## V2 review response

V2 starts at `49512593`. The read-only source review is
`/Users/chris/Projects/byok-sdk/_ops/bot-wo/REV-05-round1.md`.
All listed v2 items are implemented. Historical v1 checks are labelled separately below.

P1: The affected boundary is Host wake planning, outbox dispatch and occurrence policy.
P2: A failed wake dispatch currently exits scan before any Agent queue runs.
The same routine path treats a calendar null as completion and keeps stale retry cutoffs after pause.
P3: Keep the ledger and FIFO design. Isolate dispatch errors, add explicit scheduling status,
and use one process-local backoff timer only for out-of-horizon routine candidates.
Keep same-id definitions immutable. Do not add K8 version switching or SDK code.
Commit key alignment, scheduling fixes, pause policy, stronger evidence, and documentation separately.

### V2 item map

Locations are relative to this example unless prefixed with `docs/`.

| Review item | Commit | Location | Test or verification |
| --- | --- | --- | --- |
| P1-1: isolate wake failures and enforce horizon | `e6c275a4` | `src/core.ts:128`, `src/routines.ts:20` | `src/scheduling-recovery.test.ts:11`, `:25`, `:44`, `:60`; two Agents submit and settle, boundary and process retry verified. |
| P2-1: paused queued occurrence | `08fbdb97` | `src/routines.ts:113` | `src/routines.test.ts:98`; queued occurrence crosses the cancelled successor time and finishes. |
| P2-2: storage growth and tuning | `c5d85e5f` | `README.md:84`, `:88`, `:102` | Read-only source/document check. No retention code or default interval change. |
| P2-3: shared test clock | `c5d85e5f`, `fd032563` | `docs/host-execution-core.md:61`, `src/core.test.ts:168` | Claimed-race test uses one fake Date clock and a durable SDK claim receipt. |
| P2-4: crash evidence | `c1b59e52`, `fd032563` | `src/fixtures/crash-host.ts:39`, `:51`, `src/crash-recovery.test.ts:75` | Exact wake, SDK delivery 2, slots replay 0 to 1, same SDK task/device and original execution assertions. |
| P2-5: retry assertions | `08fbdb97` | `src/routines.test.ts:72` | Read after drain; exactly two attempts, generation 1, no third SDK offer. |
| P2-6: null calendar | `e6c275a4` | `src/routines.ts:22`, `src/core.ts:104` | `src/scheduling-recovery.test.ts:78`, `:92`, `:105`; startup, refresh, immutable definition and default endAt. |
| P2-7: calendar error audit | `e6c275a4` | `src/routines.ts:52`, `:83` | `src/scheduling-recovery.test.ts:112`, `:137`; real hook resolves once and Bot work remains usable. |
| Document 1: wall-clock wording | `c5d85e5f` | `docs/host-execution-core.md:175` | Matches the SDK's maximum 60-second timer wait. |
| Document 2: horizon behavior | `c5d85e5f` | `docs/host-execution-core.md:67` | Matches the horizon and rollback regressions above. |
| Document 3: paused work | `c5d85e5f` | `docs/host-execution-core.md:240` | Matches the pause regression and preserves the waiting bound. |
| Document 4: HostOptions.now | `c5d85e5f` | `docs/host-execution-core.md:61` | Test-only shared wall clock is explicit. |
| PRD 5.5 key alignment | `080dbf15`, `c5d85e5f` | `src/routines.ts:10`, `:27`, `docs/host-execution-core.md:162` | `src/routines.test.ts:204`; colon IDs, canonical numbers, no payload and exact armed key. |
| Nit: client test dependency | `c5d85e5f` | `package.json:15`, root `bun.lock` | Manifest and lockfile agree; root typecheck and example tests pass. |

### V2 checks

| Command | Exit | Evidence |
| --- | --- | --- |
| `bun run build` | 0 | All workspace builds completed; `v2-build.log`. |
| `bun run typecheck` | 0 | Final test fixtures compile; `v2-final-typecheck.log`. |
| `bun run test` | 0 | Vitest: 9,325 passed, 200 skipped. Node tests: 10 passed, 0 failed; `v2-full-test.log`. |
| `bun run check:api-surface` | 0 | 9 package goldens match; `v2-final-api-surface.log`. |
| `bun run check:version-authority` | 0 | Dispatch 0.27.0 and keys 0.12.0 agree; `v2-final-version-authority.log`. |
| `bun run --cwd examples/host-execution-core typecheck` | 0 | Final example source and fixtures compile. |
| `bun run --cwd examples/host-execution-core test` | 0 | 5 files, 37 tests passed in 29.39 seconds; `v2-final-example-tests.log`. |
| `git diff --check` | 0 | No whitespace errors. |

The final root test completed all workspace scripts. The example again passed all 37 tests in 29.20 seconds.
Skipped tests were in client (30), cloud-dataplane (139), keys (12), and server (19).
The optional Docker dataplane substrate was not started.
Logs are under this worktree's ignored `_ops/wo-05/` directory.
An earlier example rerun exited 1 at the old claimed-race precondition.
The durable-receipt and shared-clock correction is described under Test changes and reasons.

### V2 independent review

The read-only gatekeeper reviewed `49512593..c5d85e5f` against the supplied external review and v2 work order.
It found the listed fixes implemented and no P1/P2, with final checks still pending.
The second round reviewed only `c5d85e5f..fd032563` test and validation hunks.
It returned PASS for test integrity and checkpoint fidelity, with no weakened assertions.
It did not run tests. The execution owner closed the final root-check condition with exit 0.
No further code or test changes followed `fd032563`.
The source, manifest and lockfile diff from that reviewed commit was empty after the full run.
No listed v2 item remains open. Routine current/pending version switching and scheduling generations remain K8a work, as instructed.

## Owner ruling

The initial blocker report at `36ed2137` is superseded.
The owner permits `tasks.attempt` and `tasks.get` and accepts the deadline/claim race.
The core cancels, reads attempt, expires unclaimed work, and waits for a device terminal for claimed work.
No SDK source change is required or made.

## Scope and evidence

The focused suite uses embedded SQLite, real HTTP, a daemon and the existing fake runtime contract.
The fake runtime calls the real reserved result helper. No model provider is called.
The SIGKILL test kills the Host process during wake delivery while the daemon runs in the parent process.
Restart uses the same Host ledger, SDK database and port.
The test observes one occurrence, one execution, identical input and one committed outcome marker.

| Requirement | Evidence |
| --- | --- |
| Routine schedule, due delivery, execution and result | `core.test.ts`: real wake and result-document path. |
| Routine and Bot share FIFO | `core.test.ts`: routine, Bot and user execute in order across a profile revision change. |
| Separate Agents can progress | `core.test.ts`: two concurrent Agent executions. |
| Complete input survives lost submit response | `core.test.ts`: exact offer readback and same taskId after ledger reopen. |
| Failure before SDK admission | `core.test.ts`: absent offer, durable uncertain input, ledger reopen and byte-equivalent resubmit with one attempt and one execution. |
| Immutable input mismatch fails closed | `core.test.ts`: even a later successful terminal cannot authorize the wrong input. |
| Busy generation needs terminal | `core.test.ts`: hide a real busy terminal from the Host, then expose it. No generation changes before readback. |
| Retry policy and cap | `core.test.ts`: typed retryable failure, non-retryable failure, untyped decline and bounded busy retries. |
| Waiting bound | `core.test.ts`: queued expiry, offline pre-claim expiry, and claimed cancellation that holds FIFO until terminal. |
| Atomic outcome and upload record | `core.test.ts`: throw after business mutation, verify rollback, reopen, apply once, and replay stable upload ID. |
| Three-day sleep | `routines.test.ts`: injected wall clock, one catch-up, original slot, first future interval and one execution. |
| Rejection and timeout | `routines.test.ts`: actual SDK wake retry, abort, stale hook and second-routine progress. |
| Occurrence cap and lifecycle | `routines.test.ts`: one running, one queued, superseded history, pause and completed state. |
| Quiet hours | `routines.test.ts`: shared pure UTC calendar defers a midnight-crossing slot. |
| Future deferred slot | `routines.test.ts`: creation during same-day or midnight-crossing quiet hours preserves the pending deferred time, including 1 ms intervals. |
| Wake dispatch failure | `routines.test.ts`: initial call rejects with a durable outbox; successor routine/scan scheduling failures reject the current hook and recover through SDK redelivery. |
| SIGKILL recovery | `crash-recovery.test.ts`: kill after SDK enqueue while the wake is delivering, restart and finish without another execution. |
| Cancel classification | `unclaimed-expiry.test.ts`: real cancelled/unclaimed attempt, claimed cancel_requested state, then task.cancelled terminal. |

## Test changes and reasons

Coalescing observation repair:

- `routines.test.ts` now advances the same wall clock used by the Host and SDK one slot at a time.
  It waits for exact occurrence counts at each slot, then preserves all original queue assertions before advancing time again.
  The newest-slot assertion strengthens the existing coalescing check.
- The paused phase advances beyond multiple future slots and observes an SDK completion before the original unchanged count check.
  This preserves the no-new-occurrence guarantee even though the wall clock is controlled.
- Only `vi.setSystemTime` is used. Enabling fake timers would make Vitest's `vi.waitFor` advance the clock automatically.
  The first diagnostic setup exposed that behavior; its log is `coalesce-gap-auto-clock.log`.
  The final diagnostic reproduced the reported empty-queue failure without automatic clock advancement.

Merge-train repair:

- `scheduling-recovery.test.ts` now takes its boundary and rollback timestamps directly from the public SDK constant.
  This keeps the test independent of the Host's local alias and checks the current SDK admission contract.
  The boundary test name no longer embeds the old 366-day limit. No assertion, timeout or rollback amount is relaxed.
  The focused old-source test failed after the main merge with expected `schedule_retrying`, actual `ok`.

V4 patch changes:

- `scheduling-recovery.test.ts` adds a ledger reopen and one exact `lastError` assertion to the existing real-SDK rollback test.
  This proves that both SDK error fields persist after the schedule outbox row is removed and the Host restarts.
  The original status, empty pending set, absent outbox row and successful reschedule assertions remain.
  The new assertion failed with `undefined` before the implementation change. No error or receipt is mocked.
- `routines.test.ts` remains unchanged from `135580c8`. Five complete sequential suite runs verify the existing public completion observation.
- `unclaimed-expiry.test.ts` adds a public SDK claim receipt barrier before cancellation after the observed full-suite failure.
  It requires both the paired device owner and `claimedRuntime: 'pi'`. Session creation alone does not prove either value.
  Every original offer, stale submit snapshot, interruption, cancellation status and device terminal assertion remains.
  The cancel action still runs once, and its intermediate `cancel_requested` assertion is immediate.
- `core.test.ts` adds the same owner/runtime precondition to its claimed-cancellation case after the second observed failure.
  The Host must still hold the FIFO with no conclusion while terminal readback is hidden, then settle without a generation change.
  All original assertions remain. The change waits for the required input state, not for a failed result to turn green.

V4 changes:

- `routines.test.ts` wraps the existing empty pending-set assertion in `vi.waitFor` with a five-second bound.
  This waits for SDK completion instead of assuming the pause call includes that asynchronous write.
  The routine filter and empty-set assertion are unchanged. The occurrence count is still captured immediately after pause.
  The current execution must still succeed, the count must remain unchanged, and the lifecycle must remain paused.
  No assertion is removed or relaxed. No production code changes.

V3 changes:

- `test-support.ts` accepts an optional public `agentMessage` consumer and passes it to the embedded server.
  Existing callers keep their existing configuration. This lets the chat test use the real SDK message path.
- `core.test.ts` adds one Bot chat acceptance test. Existing assertions are unchanged.
  A gated consumer separates pending from accepted evidence. SDK reads establish acceptance and success.
  The new projection assertion checks the stored row's public ID and value.
  The first focused run exited 1 because the test looked up that ID as an internal outbox key.
  The correction preserves the assertion and uses the row value, since the ledger hashes outbox keys.

V2 changes:

- P2-3 fixture correction: a final v2 run observed an unclaimed cancellation in the
  existing claimed-race test. Session creation is not a durable SDK claim receipt
  (`packages/client/src/daemon/task-runner.ts:2675` sends claim before starting the runtime, without waiting for its receipt).
  The test now waits for `tasks.attempt().claimedRuntime`, uses one fake Date clock
  for Host and SDK, and sets a test-only reconciliation interval after its waiting deadline.
  This makes the intended precondition deterministic. All original cancellation,
  generation and FIFO assertions remain. Production `reconcileMs` stays 1,000 ms.
  The crash fixture uses the same durable-receipt barrier before exposing its kill
  checkpoint. That checkpoint still lies after SDK admission and before Host
  delivered persistence, with the exact routine wake in delivering state.
- P2-4: the crash fixture now binds `delivering` to the current occurrence's exact
  dedupKey. It reports SDK delivery 2 on restart, the committed slots replay counter
  transition from 0 to 1, the SDK pending wake with deliveries 2, and the canonical
  TaskAttempt for the same task and device. All original ledger, input, outcome and
  adapter-start assertions remain. The replay counter records the actual dedup branch.
- P2-1: a new pause test leaves an occurrence behind a real running Bot, crosses
  the cancelled successor time, then proves that the queued occurrence executes.
  It also proves that pause does not extend the independent `waitUntil` budget.
- P2-5: the old occurrence is now read after `drain`. The weak `attempts <= 2`
  assertion is replaced with exactly two attempts, one generation advance, and no third SDK offer.
  The tautological retry cutoff comparison is removed as requested. A longer wait budget
  and an injected next-slot clock isolate the next-slot policy from waiting expiry and wall-time races.
- P1-1: new real-SDK regressions verify that a 400-day routine adds no schedule row
  and that Bot and other-Agent intents still submit. Another test keeps a wake row
  permanently failing and checks that both intents also settle before scan reports its error.
  Boundary/backoff tests check 366 days, 366 days plus 1 ms, and an actual SDK rejection
  after a wall-clock rollback. Existing schedule-failure assertions are retained.
- P2-6: new tests distinguish initial and successor calendar null from completion.
  Startup and same-definition refresh recover an available slot. Same-ID changes still fail.
  A separate assertion keeps the default `endAt` completion behavior.
- P2-7: new tests observe a real hook resolving after a calendar exception, one durable
  audit, one delivery, and no redelivery after the SDK retry interval. A startup error
  also leaves Bot dispatch usable. The current occurrence can finish.
- Key alignment: routine wake filters now identify the same named routine through
  `<routineId>:<version>:<t>`. The rejection, retry count and execution assertions remain.
  A new test checks right-to-left parsing, colon-containing IDs, canonical numbers,
  absent payload and exact rejection of an unarmed version.

- The existing expiry probe retains its original offer, terminal and interruption assertions.
  Its name and comment now describe the accepted cancel-then-attempt composition.
  It adds status and claimedRuntime assertions. It holds runtime interruption to observe cancel_requested before terminal publication.
- The new sleep test checks against the recorded processing clock.
  Fake-clock waiting can advance time beyond the original 50 ms boundary.
  The test requires a future aligned slot within one interval, one catch-up and one execution.
- The new retry test uses public RuntimeExecutionFailure for a retryable launch failure.
  An ordinary Error is correctly non-retryable in the SDK. The non-retryable case remains covered.
- The new timeout test advances to the SDK's recorded retryAt and waits for asynchronous delivery.
  It retains assertions that the old hook adds no occurrence and another routine proceeds.
- Teardown guards Hono's server union and is idempotent. These changes do not change assertions.
- Independent review found two uncovered paths: swallowed wake scheduling failures and quiet-hour deferral of a raw slot before the current time.
  Both are fixed in implementation. New regression assertions cover each counterexample.
  Calendar selection uses monotone deferral and checks at most two raw slots, even for a 1 ms interval.

## V1 checks (historical)

| Command | Exit | Evidence |
| --- | --- | --- |
| `bun run build` | 0 | All workspace builds completed. |
| `bun run typecheck` | 0 | All workspace typechecks completed. |
| `bun run test` | 0 | Vitest: 9,314 passed, 200 skipped. Cloud-do Node tests: 10 passed, 0 failed. |
| `bun run check:api-surface` | 0 | 9 package goldens match the built declarations. |
| `bun run check:version-authority` | 0 | README and spec agree with dispatch 0.27.0 and keys 0.12.0. |
| `bun run --cwd examples/host-execution-core typecheck` | 0 | Example source, tests and fixture compile. |
| `bun run --cwd examples/host-execution-core test` | 0 | 4 test files and 26 tests passed in 24.51 seconds. |

The root test run completed all workspace scripts. K4 again passed all 26 tests in 24.22 seconds.
Skipped tests were in client (30), cloud-dataplane (139), keys (12), and server (19).
The optional Docker dataplane substrate was not started.
Raw output is in the ignored `_ops/wo-05/` directory of this worktree.

## V1 independent review (historical)

Herdr returned `pane_not_found` for the inherited calling pane. No other pane was controlled.
The review used the gatekeeper route permitted by the work order's AGENTS instructions.
It was read-only and consumed recorded checks. It did not run another test suite.

Round 1 reviewed implementation through `edaac77c` and found two P2 issues.
Commit `f90960d4` fixes both issues and adds their regression tests.
Round 2 reviewed only the new hunks and recovery guidance.
It found no remaining P1/P2 and no tests bent to fit the implementation.
The reviewer held the overall verdict for the root test result only.
It stated that no further code review is needed if that result passes and the code stays unchanged.
The last implementation commit remains `f90960d4`; later changes are documentation only.
The execution owner verified an empty source/package/lockfile diff from that commit after the full run.
The root test exited 0. This closes the review's remaining test condition without another code review.

## Acceptance limits

K4 does not implement K8 actions, memory pages, group chat or synthetic end-to-end slices beyond chat, routines and crash recovery.
The default calendar is a UTC interval reference. Other calendars use the injected shared pure function.
This small ledger uses one JSON snapshot and one live Host owner.
The Host service owns definition commands, version changes, CAS, sync and read-time visibility.
The service-owned command, visibility, credential-log audit and one-hour idle traffic rows from platform PRD section 14.1 are downstream checks.
They are documented in the Host guide, not claimed as tested here.
No packages/ source is changed. No push or PR was made. The main checkout was not changed.

## WO-11 P5a: scope and design

Date: 2026-10-19. Branch: `codex/p5a-memory-page`.
The initial branch has no K4 example. Commit `31ef0823` copies the example and guide
from the read-only K4 worktree at `e5afad26b42108cb4aa5b14f9f674291bc168b81`.
The earlier sections of this file are copied K4 evidence. They are not WO-11 checks.
No file in the reference worktree was changed.

### P1: Boundary

The Host owns the approval, pending body, notice retry, placement check, terminal
readback and policy-approved resident projection. The SDK owns the home lease,
filesystem CAS, device intent ledger and ACK. `memory.ts` adds the Host half.
No SDK package source or wire field changes.

### P2: Real path

The synthetic Linux test uses a real cloud mailbox and daemon. The Host approves an
intent and commits it before notice delivery. The daemon calls the Host transport.
The native backend applies one CAS under the real home lease. The Host commits the
content-free completion and removes the pending body. The test checks file content,
note removal, device ACK and persisted readback after the Host ledger reopens.

A real task closes through the reserved result helper. Its redactor emits the resident
profile through the projection port. The Host uses only that policy-approved text.
The test then replaces memory with 8193 UTF-8 bytes. A later real task-close projection
makes ContextPack construction fail. The old projection remains unchanged until that
new projection arrives. A separate real embedded-server test checks that a missing
projection blocks submit and that an accepted pack stays frozen in the offered input.

### P3: Decision

WO-01 v2 forbids a read-only interpretation of the EMPTY revision. P5a uses it only
for an authorized whole-file write. A conflict ends one intent. A new user approval
must select the next base and body. No automatic rebase runs. Redacted text remains
read-only. P5b edit-view and `contentComplete` are not implemented.

The Host profile is opaque JSON with one `residentMemory` member. It is not an SDK
edit-view format. It contains no file paths or source revisions. The outer mutation
hash and byte count still bind the profile. Authorization is checked on publish and
ContextPack read. The stored Host receipt time is retained on an idempotent publish.
The 8 KiB limit counts UTF-8 bytes. The receiver never truncates text.

### Test change audit

No existing K4 assertion was modified or removed.
The two added files contain 15 Host tests and 3 Linux synthetic tests.
The first draft incorrectly matched an absent `content` member against an explicit
undefined member. The correction uses `not.toHaveProperty`, which checks actual
absence. The Linux fixture now supplies the real egress policy before it submits a
task. This satisfies SDK capability admission. It does not bypass the gate.
A temporary failure diagnostic was removed before commit.

Herdr reported `pane_not_found` for this process's inherited pane. No other existing
pane was controlled. The read-only gatekeeper route is allowed by AGENTS.md.
Round 1 found no confirmed P1/P2 implementation issue and no weakened assertions.
It held acceptance for the unresolved test results. Round 2 reviewed the final evidence.

### WO-11 observed checks

Local runtime: Node 24.21.0 and Bun 1.4.3. Linux uses Node 24.21.0 and Bun 1.4.2
from the WO-01 probe image `byok-bot-m0-memory-intent:r2-base`.
The image has the same package and script baseline as this branch: the source diff
against `becc9f57` is empty for `packages/` and `scripts/`.
Each Linux run installs the current lockfile with `--frozen-lockfile`.
The source archive excludes node_modules and macOS metadata sidecar files.

| Command | Exit | Evidence |
| --- | --- | --- |
| `bun run build` | 0 | All workspace builds completed. |
| `bun run typecheck` | 0 | All workspace typechecks completed. |
| `bun run check:api-surface` | 0 | All 9 package goldens match. |
| `bun run check:version-authority` | 0 | Dispatch 0.27.0 and keys 0.12.0 match README and spec. |
| `bun run --cwd examples/host-execution-core typecheck` | 0 | Final example and Linux fixture compile. |
| `bun run --cwd examples/host-execution-core test` on macOS | 0 | 52 passed, 3 Linux tests skipped. |
| `bun run test src/memory-linux.test.ts` in the example on Linux | 0 | 3 passed. Real replace, delete, conflict, ACK, task-close projection and limit block. |
| Earlier `bun run test` in the example on Linux | 1 | 54 passed, 1 K4 retry-generation timeout. All 3 new Linux tests passed. |
| `bun run test src/core.test.ts -t "retries a retryable device failure"` on Linux | 0 | Final core: 1 passed. K4 baseline core: 1 passed. |
| `bun run --cwd packages/client test src/__tests__/daemon-control-socket.test.ts` | 0 | 15 passed in a focused rerun. |

The initial Linux run also included macOS AppleDouble files as test inputs. The archive
step was corrected. Those binary sidecars are absent from the source tree and later runs.
A first fixture run omitted `agentEgress.policy`. The SDK correctly refused capability
admission. The final fixture configures the policy and uses the same admission path.
A later full Linux run timed out before runtime start in the projection test. An isolated
run passed. That full Linux run and the focused file both pass all new tests. The final complete result follows below.
The K4 retry timeout also passes in isolation with both final and baseline core source.
These focused results do not turn the failed full Linux command into a pass.

The exact cause of the earlier full-run timing failures is unconfirmed. The final Linux full run passes without K4 changes.
No test deadline, assertion or SDK implementation was changed to hide them.
Raw logs, archives and the diagnostic record are in the ignored `_ops/wo-11/` directory.

The first exact root `bun run test` exited 1 after client: 3991 passed, 30 skipped,
1 shutdown test timeout. The sequential root command stopped before later workspaces.
The same unchanged client file passed 15/15 in its focused rerun. The exact full root
rerun then passed. The final evidence below records its result separately.

A later self-review reproduced one notice error blocking the rest of the scan.
The added test first failed with one delivery call instead of two. Commit `0732d0ec`
continues the scan, retains each failed pending row and reports an AggregateError.
The prior lost-response test now checks the exact original error inside `errors`.
It keeps all existing retry and persistence assertions. Final Host tests pass 15/15.
The root rerun had not reached the example when this fix was committed. All earlier
workspace source was unchanged. The example therefore runs the final notice code.

### Final WO-11 evidence

| Command | Exit | Evidence |
| --- | --- | --- |
| `bun run typecheck` after `0732d0ec` | 0 | All workspace typechecks completed. |
| `bun run --cwd examples/host-execution-core test src/memory.test.ts` | 0 | 15 passed, including notice delivery after one failure. |
| `bun run test` in the Linux example after `0732d0ec` | 0 | 56 passed in 7 files. No Linux test skipped. |
| Exact root `bun run test` rerun | 0 | Vitest: 9341 passed, 203 skipped. Cloud-do Node tests: 10 passed. |
| Final example in the root rerun on macOS | 0 | 53 passed, 3 Linux tests skipped. |

Final Linux log: `_ops/wo-11/linux-example-verified.log`.
Exit readback: `_ops/wo-11/linux-verified-exit.txt` contains `linux-example-verified=0`.
The full command includes all 3 real Linux memory tests and the unchanged K4 tests.

Root exit readback: `_ops/wo-11/test-final-exit.txt` contains `test-final=0`.
Root log: `_ops/wo-11/test-final.log`.
The 203 skips include the 3 Linux memory tests. All 3 pass in the separate Linux full run.
The optional Docker dataplane substrate was not started. Its 139 tests remain skipped.

Round 2 found no P1/P2 code or test issue. It verified Linux 56/56 and the notice fix.
It requested accurate historical labels and a README scope correction. Both were made.
The root exit 0 resolves its last verification condition. No implementation changed
since `0732d0ec`. Later changes only record evidence and correct scope text.

P5a is complete for this slice. P5b edit-view and macOS/Windows proof remain outside it.
No push, PR, merge or package publication was performed.

The read-only reviewer returned `VERDICT: PASS` after it read the final root exit.
It found no P1/P2 issue and recommended a local documentation commit with no push.

## PR 529 acceptance fixes (2026-10-19)

This section supersedes the earlier missing-projection blocking rule.
Scope: the two P1 findings and README flow from the read-only acceptance review.
K4 stacking stays PENDING-AIMPACT. The K4 copy and pushed history stay in place.

### P1 map, P2 trace, P3 decision

`HostExecutionCore.begin` reads `HostMemoryPage.contextPack` before submit. The SDK
publishes only at task close. Requiring a projection before submit made first execution
impossible. The former exception also kept a queue head queued and scheduled now+1
wakes. Regression tests reproduced both failures before the fix.

Missing or null memory now yields an empty pack. The original instruction can run.
Oversized text and blob composition failures persist `memory_blocked`, the prior phase
and the error. They spend no attempt or generation. Only deadline wakes remain.
A projection commit rechecks the exact binding and commits a reconciliation wake.
A duplicate publish retries a failed wake. `recover` covers a missed process-local signal.
A blocked routine occurrence also participates in the existing supersede rule.

A verified applied small MEMORY replacement invalidates the old display for ContextPack.
It keeps ordering metadata and stores no new projection. The core binds a fresh submission
to that repair before sending it. Its task-close projection clears the marker. Older task
projections keep the marker. Submitted raw text never becomes model memory directly.

### Assertion changes

- Missing projection, null text and a new profile previously had to throw. They now
  must return `{}`. This implements the reviewed PRD bootstrap rule.
- The existing frozen-input test now seeds an oversized projection before it enqueues.
  It retains zero-attempt, no-offer and frozen-offered-instruction assertions. The later
  projection sequences move forward to preserve monotone ordering after the new seed.
- Resident memory is now optional in the exported example type. The existing content
  assertions retain the same expected strings and byte counts.
- The Linux helper now submits through the real core, not directly through cloud. It
  waits for core settlement. All original filesystem, CAS, ACK and readback assertions
  remain. Restart now closes and recovers the core with the Host ledger.
- A new missing-file test checks the empty pack before first submit. It then checks the
  empty file created by the SDK (`agent-home.ts` home initialization) and runs a new profile.
  It does not require the SDK to preserve file absence after initialization.

New tests bound oversized and blob wakes for two seconds, cover persisted restart,
missed notification recovery, duplicate wake delivery, stale projection replay and a real
Linux bootstrap/repair path. No manual projection publish substitutes for Linux bootstrap.

### Final acceptance-fix verification

| Command | Exit | Result |
| --- | --- | --- |
| `bun run build` | 0 | Workspace builds completed. |
| `bun run typecheck` | 0 | All workspaces, including changed example types and tests. |
| `bun run check:api-surface` | 0 | Nine package goldens match. No SDK export changed. |
| `bun run check:version-authority` | 0 | README/spec train remains aligned. |
| `bun run --cwd examples/host-execution-core test` | 0 | 59 passed, 6 Linux tests skipped on macOS. |
| Linux example `bun run test src/memory-linux.test.ts src/memory.test.ts` | 0 | 27 passed. |
| Linux example `bun run test` | 0 | 65 passed in 7 files. |
| Exact root `bun run test`, after build completed | 0 | 9347 Vitest passed, 206 skipped. Cloud-do Node tests: 10 passed. |

The first broad root run overlapped build and read missing dist entry files. It exited 1
with 15 client failures. The corrected sequential root run passed without a source fix.
The first local full example had a startup timeout. Its completed-build rerun passed.
Both initial logs remain available. No deadline or SDK test assertion was changed.

Readbacks and raw logs are under `_ops/wo-11-review/`. The final root readback is
`test-final=0`. Linux full readback is `linux-full=0`. The two-second blocked wake tests
pass with at most one oversized deadline wake and no added blob wake after restart.
Read-only review found no code, test or documentation finding. It checked the changed
assertions and the PENDING-AIMPACT note. Only verification evidence changed after
implementation commit `932b48c5` and guide commit `c8ce3115`.
The reviewer returned `VERDICT: PASS` after it directly read `test-final=0`.

## WO-11 re-review repair, 2026-10-19

Scope: PR #529 after the read-only review of `e92980af`.

### P1: Boundary

The change stays in the Host memory example. SDK wire types do not change.
`HostMemoryPage.contextPack` checks the current device/profile binding, projection
permission and resident byte count. `HostExecutionCore.begin` prepares the input.
The FIFO key is tenant, device and Agent ID. Profile revisions share that queue.

Merge `1a9dce13` uses the normal `git merge origin/main` path. For the add/add
conflicts, use main's K4 files as the current side and `31ef0823` as the common
K4 baseline. Apply only the memory delta from the previous branch head.
This keeps main's horizon and coalescing fixes. The PRD file matches main's v3.
`git diff origin/main...HEAD` contains only memory example files, its documentation
and its workspace dependency entries. It contains no second K4 implementation.

### P2: Trace and reproduction

A real enqueue commits an intent and enters `drain`, `scan`, `reconcile`, then
`begin`. The old catch in `begin` parks every memory preparation error. A stale
rev1 binding fails `isCurrent`. The parked rev1 head prevents rev2 from reaching
SDK submit. A blob instruction fails before ContextPack and has the same result.

Before the fix, run:

```sh
bun run --cwd examples/host-execution-core test src/memory.test.ts -t 'starts profile rev2|restores a deadline wake'
```

Result: exit 1; three regressions fail. Neither rev2 case reaches the real adapter
session within five seconds. The cases cover a stale queued head and a head that
was already blocked by size before the upgrade. In the wake test, the SDK has no
pending wake after the projection reconciliation schedule fails.

### P3: Decision and invariant

Only oversized text and unauthorized projections throw `MemoryBlockedError`.
Only that error parks an intent. Other preparation errors settle as `failed`,
without a new attempt or generation. The stored intent and Host result projection
keep `preparationError`. The FIFO can then process the next intent.
Recovery rechecks old blocks. An active scan also rechecks a blocked queue head.
Thus a profile upgrade can release a head that was already blocked before the
upgrade. The tenant/device/Agent FIFO key stays unchanged.

After a failed projection reconciliation schedule, make one bounded attempt to
restore a deadline wake with a fresh key. Do not reuse a cancelled wake key.
If both schedules fail, keep the fallback deadline in the durable outbox and
return both errors. Do not start a timer retry loop. A duplicate projection can
request an earlier scan. Recovery or a later drain can retry the durable state.
A restored deadline can expire the waiting intent. It does not promise execution
before that deadline when no earlier retry arrives.

PENDING-AIMPACT P3-1 remains unchanged. An applied small replacement still
invalidates the old projection, including a previously valid projection. The
next task can run without resident memory. The owner must decide that behavior.

### Existing assertion changes in this repair

1. The blob test now requires terminal failure instead of `memory_blocked`.
   This is the requested P2-1 outcome. It still checks zero attempts, zero
   generations, no SDK offer and durable state after restart. It also checks
   that the next inline intent starts and that the result keeps the reason.
   A new fixture checks recovery of a blob block saved by the previous version.
   Cancellation is no longer needed to release this terminal intent.
2. The duplicate projection test no longer requires reuse of the failed wake
   key. The failed key and the previous deadline key are cancelled before the
   fallback is scheduled. The test now requires fresh keys, the exact fallback
   deadline and an earlier scan after duplicate publish. It retains the real
   adapter start and one-attempt checks. No manual drain supplies that start.

The earlier P5a assertion changes remain documented in the PR body. Main's K4
assertion fixes are inherited through the merge and are not PR memory changes.

### Local environment and preliminary checks

Node: `v24.21.0`. Bun: `1.4.3`. Platform: macOS.
`node_modules` was present. The first build failed because installed Pi dependency
files did not match main's pinned inventory. Run `bun install --frozen-lockfile`:
exit 0; 12 packages installed; no lockfile change. The next build passed.
The first focused run found that duplicate publish did not replace the fallback
deadline. Re-arm the scan on projection notifications, including duplicate ones.
The next focused run passed: 27 tests. It began before a later type-only assertion
change in the test file. Do not use that focused run as final-file evidence.
The example typecheck found a union access in the new profile test. Use a structural
assertion for the offer. The next example typecheck passed.
The final full example run is `.wo11-example-test.log`, started at `17:17:12`.
It began after that assertion change. It passed: 65 tests, with 6 Linux-only tests
skipped; exit 0. This run covers the final source and test file.
It includes both profile cases, blob settlement and recovery, authorization repair,
deadline expiry without duplicate publish, bounded fallback failure, and duplicate
publish recovery.

### Read-only review

Result: PASS. The review checked the full memory diff against main, the repair
against the merge head, and the recorded checks. It found no blocking issue and
no assertion change that hides the reported bug. It also checked the unchanged
P3-1 behavior and the exact PRD match.

Two evidence notes were resolved. The final test-file evidence now names
`.wo11-example-test.log` at `17:17:12`, with 65 passed and 6 skipped. The earlier
focused run is not final-file evidence. The local results JSON is not a source
artifact and must not enter the commit.

A Host callback exception is a terminal preparation failure under this rule.
Repair the Host and submit a new intent for that work. Linux-only memory tests
are not platform proof on this macOS run. A double wake schedule failure keeps
durable state but still needs recovery or a later drain for progress.

### Final required checks before push

All commands ran in this worktree. Build finished before typecheck and tests.
No production source or test changed during this final check chain.

| Command | Exit | Observed result |
| --- | --- | --- |
| `bun run build` | 0 | All workspace builds passed; `.wo11-build.log`. |
| `bun run typecheck` | 0 | All workspace typechecks passed; `.wo11-typecheck.log`. |
| `bun run --cwd examples/host-execution-core test` | 0 | 65 passed, 6 Linux-only tests skipped; `.wo11-example-test.log`, start `17:17:12`. |
| `bun run test` | 0 | 9510 Vitest tests passed, 237 skipped; cloud-do Node tests: 10 passed, 0 failed; `.wo11-test.log`. |
| `bun run check:api-surface` | 0 | All 9 package goldens match; `.wo11-api-surface.log`. |
| `bun run check:version-authority` | 0 | README and spec match the dispatch train and keys version; `.wo11-version-authority.log`. |

The root run passed the Host example again: 65 passed, 6 skipped. Its example
run began at `17:29:56`. Optional substrate and platform tests remain skipped.
The final evidence JSON is local ignored state under `_ops/wo11/`. It is not
part of the commit. The PR stays draft. PENDING-AIMPACT P3-1 stays open.

## Merge train after WO-10 / PR #530

Main base: `e9247c63de1a619bafb692f2bfe405bcc8804029`.
Use `git fetch origin` and a normal `git merge origin/main`.

### P1: Boundary

The conflicts are in the Host example package entry points and export list.
Main exposes the core package and `test-support` for bot-collaboration. This
branch also exports the memory page and its types. Both sets are needed.

### P2: Trace

`BotCollaboration` imports `HostExecutionCore`, `HostLedger`, ledger helpers,
`enqueue` and `WAKE_HORIZON_MS` from the Host package. Its constructor supplies
`applyOutcome` and does not enable memory. The memory caller still supplies
`options.memory`. The two paths use the same core and keep their current rules.

### P3: Merge decision

Keep main's package `exports` and core helper exports. Keep this branch's memory
exports and runtime dependencies. The merged bot-collaboration files match main.
The existing memory runtime and test files match the previous branch head.
No test assertion, skip or timeout was changed for this merge. P3-1 remains
PENDING-AIMPACT. No product decision or delegation scope changed.

`bun install --frozen-lockfile` passed with no dependency change. The merged
build and root typecheck passed. Logs and final results for this merge are
kept in ignored local state under `_ops/wo11/main-merge-*`.

### Final checks for the WO-10 merge

| Command | Exit | Result |
| --- | --- | --- |
| `bun run build` | 0 | All workspace builds passed. |
| `bun run typecheck` | 0 | All workspace typechecks passed. |
| `bun run test` | 0 | 9560 Vitest tests passed, 237 skipped; cloud-do Node tests: 10 passed, 0 failed. |
| `bun run check:api-surface` | 0 | All 9 package goldens match. |
| `bun run check:version-authority` | 0 | Version authority check passed. |

The complete root run includes bot-collaboration: 50 passed. It also includes
Host execution: 65 passed, 6 Linux-only tests skipped. No failure required a
source or test change. Optional substrate and platform tests remain skipped.
Only this merge and its record will be pushed. The PR remains draft.

## Merge train after WO-12 / PR #531

Normal merge `31cb5e1d21257823b8e6042a8261a7b5ae60c3e4` includes main at
`6fa6f66e792145b008a594dfb39115e971b9958f`. The merge had no conflicts.
No manual runtime, test assertion, skip or timeout change was needed.
The bot-collaboration files and PRD match main. The memory implementation stays
unchanged. PENDING-AIMPACT P3-1 stays open.

| Command | Exit | Result |
| --- | --- | --- |
| `bun run build` | 0 | All workspace builds passed. |
| `bun run typecheck` | 0 | All workspace typechecks passed. |
| `bun run check:api-surface` | 0 | All 9 package goldens match. |
| `bun run check:version-authority` | 0 | Version authority check passed. |
| `bun run test` | 0 | 9604 Vitest tests passed, 237 skipped; cloud-do Node tests: 10 passed, 0 failed. |

The root run includes bot-collaboration/group chat: 94 passed. It also includes
Host execution: 65 passed, 6 Linux-only tests skipped. No test failure required
repair. Optional substrate and platform tests remain skipped. Logs and results
stay in ignored local state under `_ops/wo11/wo12-merge-*`.
The PR stays draft. The coordinator owns readiness, CI acceptance and merge.
