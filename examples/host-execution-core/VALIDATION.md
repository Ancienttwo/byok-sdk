# WO-05 validation

Date: 2026-10-18. Baseline: `8e8839a3`.
Branch: `codex/bot-k4-host-execution-core`.
Environment: macOS, Node `v24.21.0`, Bun `1.4.3`.

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

## Checks

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

## Independent review

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

K4 does not implement K8 actions, memory pages, group chat or the other synthetic end-to-end slices.
The default calendar is a UTC interval reference. Other calendars use the injected shared pure function.
This small ledger uses one JSON snapshot and one live Host owner.
The Host service owns definition commands, version changes, CAS, sync and read-time visibility.
The service-owned command, visibility, credential-log audit and one-hour idle traffic rows from platform PRD section 14.1 are downstream checks.
They are documented in the Host guide, not claimed as tested here.
No packages/ source is changed. No push or PR was made. The main checkout was not changed.
