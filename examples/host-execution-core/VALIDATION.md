# WO-05 validation

Date: 2026-10-18. Baseline: `8e8839a3`.
Branch: `codex/bot-k4-host-execution-core`.
Environment: macOS, Node `v24.21.0`, Bun `1.4.3`.

## V3 scope ruling and chat acceptance

V3 starts at `ae7acb2c`. Aimpact made these scope decisions on 2026-10-18:

- Platform PRD section 14.1's service rows belong to the downstream Host service after K2 and A2.
  They cover routine sync with the browser closed, `sync_failed`, 409, `device_offline`, `missed`, security and cost.
  This reference covers the device-local Topology L execution rows.
- Same-routine-ID version changes belong to K8a with `update_routine`.
  This includes current/pending versions, scheduling generation and the in-flight limit.
  K4 keeps definitions immutable. A changed definition needs a new ID.

Both decisions are recorded in the Host guide and example README.

P1: The test boundary is the existing embedded server, daemon and fake runtime.
P2: A routine and a Bot chat pass through the same core `executions.submit` path.
The runtime publishes a message and submits a result. The SDK stores the exact message decision and device terminal.
The Host reads that terminal and commits the opaque outcome, applied marker and result projections.
P3: Add one acceptance test and an optional message consumer in test support. Keep production code unchanged.

The new `src/core.test.ts` chat test covers Bot PRD section 5.8's first item.
It holds the consumer decision to observe a pending disposition, no terminal and no applied marker.
It checks the exact task/device identity, frozen context, message body, byte count and SHA-256 hash.
After acceptance it reads `tasks.messageDisposition(taskId, deviceId, payload).outcome === 'accepted'`.
It reads `task.complete` with the expected result document and compares it with the Host's stored terminal.
It proves FIFO order behind a routine and uses one injected outcome handler for both sources.
After ledger reopen, both conclusions, outcome markers and projections remain, with exactly two applications.
The same immutable accepted disposition remains readable after terminal settlement.

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
