# Implementation Notes: shutdown-lease-order

> **Status**: Active
> **Plan**: plans/plan-20260813-2201-shutdown-lease-order.md
> **Contract**: tasks/contracts/20260813-2201-shutdown-lease-order.contract.md
> **Review**: tasks/reviews/20260813-2201-shutdown-lease-order.review.md
> **Last Updated**: 2026-08-13 22:20
> **Lifecycle**: notes

## Design Decisions

### The invariant

A daemon must never remove its liveness signal while it still holds the store-mutation lease: **"gone" implies "lease free"**.

"Gone" has exactly one external definition — `isControlDaemonGone` (`packages/client/src/bin/control-client.ts:376-394`): the control token file is absent AND a connect to the control socket is refused. `bin/commands/unpair.ts` polls it, `byok-agent start` and doctor race it implicitly. The lease is `acquireDaemonOwner`'s store mutex (`daemon/daemon-owner.ts`), whose refusal is `DaemonOwnerActiveError`.

Before this change `runShutdownSequence` published "gone" first (`controlServerHandle.close()` unlinks both files) and released the lease 11-46ms later, so any acquire landing in that gap probed a still-bound mutex and was refused with `DaemonOwnerActiveError('unknown')`.

### Split control teardown (`daemon/control-server.ts`)

`ControlServerHandle` gained a `stopServing()` stage; `close()` is now `stopServing()` + file removal and keeps its exact old behavior for every other caller.

- `stopServing()` — destroy every open socket, `server.close()`. Leaves `control.sock` and `control.token` on disk. Memoized on a promise rather than latched on a boolean, so a `close()` racing an in-flight `stopServing()` awaits the same teardown instead of unlinking files out from under a listener that is still going down.
- `close()` — `await stopServing()`, then remove the socket file (never on win32, where a pipe has no file) and the token file. Still idempotent, still safe to call without ever calling `stopServing()`.

Between the two stages the external predicate reads *not gone* (a connect is refused, but the token file is still there), which is the conservative answer: "still running". That is the whole point — it is the state that can never lie in the dangerous direction.

### New teardown order (`daemon/create-daemon.ts:1811-1861`)

1. `controlServerHandle.stopServing()` — under `attempt(..., mutationBarrier: true)`. The coupling the combined `close()` had is deliberately preserved: a failed stop-serving means a control RPC may still be in flight against this store, i.e. a possible residual writer, so the lease must be retained for it.
2. `operationalHealth.markCleanStop()`, then `daemonOwnerLease.release()` — unchanged, still gated on `mutationBarrierComplete && daemonOwnerLease`.
3. `controlServerHandle.close()` — removes `control.sock` + `control.token`, the last observable act of the daemon, gated on `daemonOwnerLease === undefined`.

### The `mutationBarrierComplete === false` branch

Old behavior: the same combined `close()` ran unconditionally, so the branch published "exited" *and* retained the lease forever — the exact combination that turned unpair's intended `UnpairExitUnconfirmedError` into a confusing `DaemonOwnerActiveError`.

The mechanics chosen: rather than a second `if (!mutationBarrierComplete)` branch, step 3 is gated on the single condition that makes "gone" honest — `daemonOwnerLease === undefined`, i.e. this process no longer holds the lease. One predicate, three cases covered:

- barrier incomplete, lease retained → files stay → `isControlDaemonGone` stays false;
- `release()` itself throws (the lease variable is only cleared after a successful release) → files stay;
- nothing ever held a lease (`stop()` on a never-started daemon) → files are removed, as before, with no lease to contradict.

Why that yields `UnpairExitUnconfirmedError`: `runUnpairCommand` (`bin/commands/unpair.ts:371-388`) sends `shutdown`, then polls `waitForControlExit` → `isControlDaemonGone`. With the token file still present, the poll returns false, the 15s timeout expires, and `if (!exited && !deps.force) throw new UnpairExitUnconfirmedError()` fires *before* the post-exit reacquire is ever attempted. The typed error and its "verify no byok-agent process is still running / retry / --force" message is the intended fail-closed outcome for "the daemon did not confirm exit".

The handle is intentionally NOT set to `undefined` on this path: it stays as a stopped-serving handle, and both of its stages are idempotent, so the retry that finally completes the barrier and releases the lease is what removes the files. `runShutdownSequence`'s idempotency doc comment was updated to state this.

Left-behind files on that pathological path are already handled by existing code: a later `start()` finds a refused socket and unlinks it as stale (`handleStaleUnixSocket`), and the token is rewritten atomically at bind.

### Regression guard

Added to `packages/client/src/__tests__/daemon-stop-shutdown-parity.test.ts` (reuses its `TestServer`/`StubRuntimeAdapter`/`pairedAndStarted` fixtures):

- `pairedAndStarted` → `shutdown` over the control socket, not awaiting teardown (the RPC acks and defers via `setImmediate`) → tight sampling loop.
- Each sample reads the exit gate FIRST (the real `isControlDaemonGone`, imported — not a copy), then probes the store mutex. Order is load-bearing: the lease is only released during this sequence, never re-taken, so a lock still bound *after* a gate that already read "gone" proves it was bound at the gate too. The reverse order proves nothing.
- The mutex probe is a local helper in the test (`storeMutexBound`) over `storeMutexEndpoint(...)`, using the same "`ECONNREFUSED`/`ENOENT` is the only proof of absence" rule as `daemon-owner.ts`'s private probe. Written locally on purpose: the guard must not modify the module whose ordering it polices.
- At the first `controlGone` sample it runs the real product call, `acquireDaemonOwner(storeDir, 'doctor')`, and records the outcome; assertion is `{violations: [], acquireAtGate: 'acquired'}` so a failure reports both halves of the invariant at once.
- **Window amplification**: the real gap is 11-46ms, too short for an in-process sampler to hit reliably, and a guard that is only probabilistically red is not a guard. `markCleanStop` — the one product step that already sits between the two operations under test — is spied to sleep 250ms and then call through. Nothing is reordered and no semantics change; the pre-fix gap simply becomes wide enough that sampling cannot miss it, while on fixed code the window is unreachable no matter how long that step takes. Restored in a `finally`.
- The `mutationBarrierComplete === false` behavior is asserted in the two existing barrier tests: while ownership is retained, `isControlDaemonGone` must be `false`; after the clean retry, `true`. Both were red pre-fix.

## Deviations From Plan Or Spec

- None on the fix itself. The contract's preferred "split close" shape was implementable; the fallback ("move the whole close later") was not needed.
- Scope addition inside the same test file, required by the harness completion gate: `daemon-stop-shutdown-parity.test.ts` is an `exit_criteria.tests_pass` target and the gate runs `tests_pass` under `bun test` on the WHOLE file, so the four pre-existing cases had to become dual-runner green, not just the new guard. Two runner-portability fixes, both behavior-preserving with no assertion or semantics change: (a) the eight `vi.waitFor(...)` calls now use a local `waitFor(check, {timeoutMs, intervalMs})` polling helper defined in the file — bun's `vi` shim has no `waitFor` — with the same "retry until it stops throwing, rethrow the last failure at the deadline" contract and a 2s default, well inside bun's 5s per-test budget (no case needed more; the three cases that already carried `}, 10000)` keep it, and the new guard carries `}, 20000)` — both runner-portable per-test timeout arguments); (b) the concurrent-stop case awaits its two simultaneously-rejecting `stop()` promises through `Promise.allSettled` instead of two sequential `expect(...).rejects.toThrow()` — bun's `.rejects` does not attach its handler synchronously, so the second promise sat momentarily unhandled and bun failed the test on the unhandled rejection (reproduced in isolation: two sibling rejected promises asserted that way fail under bun; the same pair via `allSettled` passes). This also de-risks the queued Bun migration for this file.
- Under bun the sqlite barrier case reports `skip` rather than `pass`: `it.skipIf(!isSqliteAvailable())`, and bun 1.3.14 has no `node:sqlite` (`No such built-in module: node:sqlite`; Node 22 has it). It runs and passes under vitest, which is where its assertions — including the new `isControlDaemonGone === false` one — are exercised.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Split `close()` into `stopServing()` + `close()` | **Chosen** | Keeps the stop-serving/mutation-barrier coupling intact, keeps the single-stage `close()` working for its other caller, and makes file removal the provably last act. |
| Move the whole `close()` after the lease release | Rejected | Would leave the control socket serving RPCs (including `shutdown`, `approvals.resolve`) after the lease is gone — post-teardown RPCs could then touch the store with no lease held. |
| Retry the acquire inside `unpair.ts` | Rejected (contract, proven by prover) | Papers over a TOCTOU with a timeout; `start`/doctor race the same window and would each need their own retry. |
| Unlink `mutex.sock` early | Rejected (contract, proven by prover) | Admits two writers — the whole point of the lock. |
| Separate `if (!mutationBarrierComplete)` branch for the signal | Rejected | Two predicates for one invariant. `daemonOwnerLease === undefined` states the invariant directly and also covers a failed `release()`. |
| Guard without timing amplification | Rejected | Probabilistically red on unfixed code; a race-lottery guard would have let this regress again. |

## Open Questions

- None.

## Evidence Links

- Prover artifacts (root cause, pre-existing): `scratchpad/rcp-unpair/probe-race.mjs`, `probe-window.mjs`, `pre-fix-failure.txt`, `race-run-{1,2,3}.txt`, `real-*.txt`, `job-94465898325.log`
- Guard RED on unfixed source (bun, `PRE_FIX_EXIT=1`, shows `DaemonOwnerActiveError: store mutation lease is already held by an active unknown process` at the gate): `scratchpad/rcp-unpair/guard-red.txt`
- Guard RED on unfixed source (vitest, whole file, 3 failed / 4 passed — the ordering guard plus both barrier-branch assertions): `scratchpad/rcp-unpair/guard-red-vitest.txt`
- Guard GREEN after the fix, WHOLE file on both runners (`bun test` 6 pass / 1 skip / 0 fail, `BUN_EXIT=0`; vitest 7/7, `VITEST_EXIT=0`): `scratchpad/rcp-unpair/guard-green.txt`
- Prover's own out-of-process repro re-run against the fixed build, 3/3 `acquired OK` (was 3/3 `REPRO`/exit 1 on main): `scratchpad/rcp-unpair/race-fixed-{1,2,3}.txt` (`probe-race-fixed.mjs`, identical to `probe-race.mjs` except the repo path)
- `node packages/client/scripts/ipc-smoke.mjs` ×3 consecutive PASS: `scratchpad/rcp-unpair/ipc-smoke-fixed-{1,2,3}.log`
- `pnpm --filter @byok-sdk/client run test`: 111 files / 1168 tests passed
- `pnpm -r run typecheck`: clean; `pnpm -r build`: exit 0
- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

`packages/client/src/daemon/daemon-owner.ts` has **zero diff** — its refusal branches were never touched. Confirmed by `git diff --stat`, which lists only `create-daemon.ts`, `control-server.ts`, and the test file.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Candidate for `tasks/lessons.md` after one more occurrence: when a process publishes an "I am gone" signal and holds a separate lock, the signal must be the last thing released; ordering them the other way creates a window that is invisible locally and only surfaces as intermittent CI red once a poll interval happens to align with it.
