# Issue 352: one owner for TaskRunner startup resources

Status: decided on 2026-10-11. Implementation is delegated. Review and checks follow.

## Scope and baseline

Base: `45d10428` (`origin/main`). Branch: `claude/issue-352-startup-ownership`.
Scope: issue #352 in `@byok-sdk/client`. This is a maintenance refactor. No
new failure reproduction or performance claim exists. No version change,
publication or merge is part of this slice.

Out of scope: active finalization (`finishOnce`, `settleSemanticTerminal`),
`TerminalCommitQueue`, deployment layers, transport ordering. Issue #160 stays
closed. Transport-global serial handling is not reintroduced.

## P1: Boundaries

- `TaskRunner` (`packages/client/src/daemon/task-runner.ts`) owns offers,
  active tasks and the message, memory and host-toolset contexts.
- Startup resources today live in four TaskRunner members:
  `startupOwners` (map), `startupDisposals` (coalesced disposal promises),
  `startupRetryTimer`, and the methods `disposeStartupOwner` /
  `disposeStartupOwnerOnce`.
- Readers of startup ownership: `activeTaskCount`, the duplicate-offer guard in
  `handleOffer`, `handleCancel`, `shutdownActiveTasks`, the `handleOffer`
  `finally` block, and the retry timer.
- Writers: the `startOwnedRuntime` catch path (cancelled or disposal failure),
  the post-start owner (`session.close()`), the two synchronous handovers to
  `this.tasks`, and `disposeStartupOwnerOnce`.
- `stopAcceptingOffers` clears the retry timer. `stoppingOffers` blocks a new
  timer.
- `runtime-start.ts` owns `startOwnedRuntime`, `AbortedStart` and the 5 s
  abort grace. It does not change.
- `deps.awaitTerminalCommit` is the terminal commit barrier. It does not
  change.
- Public surface: none of these members is exported. The package export list,
  wire schema and storage format do not change.

## P2: Path of one Agent offer

durable receive → `handleOffer` duplicate guard → adapter `prepare` → claim →
`startOwnedRuntime` →

1. start throws, cancelled or disposal failure: an owner is recorded with
   `dispose = retryDisposal` (or no-op), an optional `settle` that sends
   `task.cancelled`, and `release` (Agent lease, git lease). The `finally`
   block disposes it.
2. start returns a Session: an owner is recorded with `dispose =
   session.close()`. Lease bind, handoff record and message activation follow
   with `await`s. Any failure returns early. The `finally` block disposes the
   owner.
3. cancel arrived during start: synchronous handover to `this.tasks`, then
   `settleSemanticTerminal`.
4. normal: synchronous handover to `this.tasks`, then `pump()`.

Disposal order (one owner): `settle` → `abortedStart.running()` check →
`dispose` → `awaitTerminalCommit(taskId)` → `release` → context cleanup
(pending message task, message, memory and host-toolset contexts). A failure
keeps the owner, reports `onRuntimeDisposalFailure`, and arms one 1 s retry
timer. The timer retries only owners whose offer left `inFlightOffers`.

Shutdown: wait for `offerSettlements` → shut down active tasks → for each
startup owner, wait for `abortedStart.settled`, dispose, and throw
`RuntimeDisposalFailure` if disposal is not confirmed.

## P3: Decisions

Why the current design exists: #158–#166 (`55ce43cb`) added startup ownership
so that a deadline or cancel never invents a quiescence receipt and a lease is
never released before the runtime stops. Later fixes added the coalesced
disposal and the retry timer inside TaskRunner. The invariants are correct.
The cost is spread: five call sites read the map and three members carry the
lifecycle.

Decision: move the map, the coalesced disposal, the retry timer and the
shutdown drain into one module, `packages/client/src/daemon/startup-ownership.ts`,
class `StartupOwnership`. TaskRunner keeps one instance. No second map or
task status remains.

Module contract:

- `adopt(taskId, owner)`: record the owner. Throw an internal invariant error
  if an owner already exists for that taskId. One resource has one owner.
- `has(taskId)` and `count` (read-only): used by `activeTaskCount`, the
  duplicate-offer guard and `handleCancel`.
- `transferToActive(taskId)`: synchronous, returns `void`, no `await`. The
  caller calls it in the same synchronous block as `this.tasks.set`.
- `dispose(taskId): Promise<boolean>`: coalesce concurrent calls for one owner
  into one running attempt. Keep the exact order from P2. On success, delete
  the owner only if it is still the same object, then call the
  `onDisposed(taskId)` callback. TaskRunner runs its existing context cleanup
  there. On failure, keep the owner, call the failure callback, and arm the
  retry timer if none exists and the module is not stopped.
- Retry: on fire, dispose each owner for which `retryEligible(taskId)` is true.
  TaskRunner passes `id => !this.inFlightOffers.has(id)`.
- `stop()`: cancel the timer. No new timer after stop. TaskRunner calls it in
  `stopAcceptingOffers`.
- `drain()`: the startup part of shutdown. For each owner, wait for
  `abortedStart?.settled`, then dispose, and throw `RuntimeDisposalFailure`
  (`stage: 'quiescence'`) if disposal is not confirmed. TaskRunner still waits
  for `offerSettlements` and active tasks first.

Dependencies are injected callbacks: `awaitTerminalCommit`,
`onDisposalFailure` (report plus the existing `console.error` line),
`onDisposed`, `retryEligible`. The module does not import TaskRunner. The
retry delay stays 1 000 ms.

Kept unchanged:

- The 5 s grace end is not a quiescence receipt. A late session stays with the
  original owner and its `retryDisposal`.
- `revokeHostToolsetContexts` stays the first statement of `handleCancel`.
  `revokeAllHostToolsetContexts` stays in `stopAcceptingOffers`.
- The owner closures (`settle`, `dispose`, `release`) are still built in
  `handleOffer`. They capture offer-local state. Moving them is out of scope.
- `startOwnedRuntime`, `finishOnce`, `TerminalCommitQueue`, wire schema,
  storage format and public exports.

Rejected: a pure plan/effects state machine in the RAFT style. It would add a
second authority for a refactor with no new failure. RAFT is design reference
only. No RAFT code is copied. byok stays MIT.

## Task Breakdown

- [x] T1 Add `startup-ownership.ts` with the contract above.
- [x] T2 Add `src/__tests__/startup-ownership.test.ts`: coalescing, exact
      order, retention on failure, identity-checked delete, retry only for
      eligible owners, no timer after `stop()`, `drain()` waits for the aborted
      start and throws on unconfirmed disposal, `adopt` refuses a second owner.
- [x] T3 Replace the four TaskRunner members and both dispose methods with the
      module. Route all readers and writers from P1 through it.
- [x] T4 Run the six named test files with no assertion change, then the root
      checks. Record commands and exit codes below.

## Verification evidence

Run on 2026-10-11 against the uncommitted working tree on base `45d10428`.

- `npx vitest run` in `packages/client` with the seven files
  `startup-ownership`, `runtime-start`, `task-runner-shutdown-startup`,
  `task-runner-cancel-race`, `task-runner-shutdown`, `terminal-commit-queue`,
  `adapter-disposal-parity`: exit 0. 7 files passed. 39 tests passed
  (12 new in `startup-ownership.test.ts`). No existing assertion changed.
- Mutation probe on `startup-ownership.ts` (no identity check, no stop gate,
  no retry eligibility): 3 of 12 new tests failed as expected. The source was
  restored and the file passed again (12/12).
- `bun run build`: exit 0.
- `bun run typecheck`: first run exit 1 (a type error in the new test file
  only). After the fix: exit 0.
- `bun run check:api-surface`: first run exit 1. The drift was private
  `TaskRunner` member names in `api-surface/client.d.ts` only
  (`startupRetryTimer`, `startupOwners`, `startupDisposals`,
  `disposeStartupOwner`, `disposeStartupOwnerOnce` → `startup`). The golden
  was updated with `--update`. Rerun: exit 0, 9 goldens match. No public
  export changed. `StartupOwnership` is not exported.
- `bun run check:version-authority`: exit 0.
- `bun run test` (first run, in parallel with `build`): exit 1. 22 failures
  came from `dist/` files that the parallel build removed. Not a code fault.
- `bun run test` (second run, alone): exit 1. client 1 failed / 3662 passed /
  39 skipped. The one failure is `official-pi-workflow.test.ts`: "Bun is
  required for the vendored TS workflow probe". Local bun is at
  `~/.bun/bin/bun`, which the test helper does not search. Unrelated to this
  change. That file alone with `BYOK_TEST_BUN_BIN` set: exit 0, 1/1 passed.
- `BYOK_TEST_BUN_BIN=~/.bun/bin/bun bun run test`: exit 0. client 3676 passed
  / 28 skipped (310 files passed, 2 skipped). All other packages passed.

## Scope limits

- No change to existing test assertions.
- No public API, wire schema or storage format change.
