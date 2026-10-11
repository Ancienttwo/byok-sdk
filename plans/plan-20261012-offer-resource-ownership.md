# Own pre-active offer resources in one place

Status: Planned (revision 2)
Approval: The owner approved this direction on 2026-10-12. Each PR needs its own review.
Base: 5ba300cbffc4cbb728315b44362fb3a636d5a42b
Previous slices: https://github.com/Ancienttwo/byok-sdk/pull/354 (startup owner), https://github.com/Ancienttwo/byok-sdk/pull/357 (active close receipt)

## Goal

Each resource that handleOffer acquires has exactly one owner at each moment.
The owner is the offer, the startup owner, or the active task.
Each change of owner is one synchronous step, with no await between the old owner giving it up and the new owner taking it.
A thrown exception cannot leak a resource that the offer still owns.

This plan has two PRs.
PR A fixes a confirmed git lease leak with the smallest change.
PR B makes the owner explicit and adds a safety net for thrown exceptions.
PR B lists every intended behavior change in D5.

## Revision 2

An independent review (GPT, 2026-10-12) reproduced the PR A leak at the base commit.
It also found three defects in revision 1 of PR B. All three were checked against the code and accepted:

1. A generic `releaseAll()` that logs and drops failures breaks StartupOwnership.
   StartupOwnership keeps an owner and retries only when `release` throws (`startup-ownership.ts:61-87`).
   Today the startup release throws when the agent lease release fails. The pre-claim releases are best-effort (`.catch(() => {})`).
   These are two different contracts.
2. Two transfers from one list do not work. Every active task first passes through startup registration (`task-runner.ts:3028`).
   A second `transfer()` at the active handoff (`:3153`, `:3182`) would get an empty list.
   ActiveTask takes `gitLease` and the agent binding from handleOffer locals (`:3077`), not from the startup owner.
3. Moving the releases into the finally reverses the order at each exit.
   Every manual site releases first and then sends decline or fail (for example `:2460-2462`, `:2631-2632`, `:2875-2877`).
   A retryable decline that the cloud redelivers to the same device could then meet `lease-busy`.

Revision 2 responds by removing the generic module from PR B.
The three defects come from one shared container, which would need two failure contracts, a two-stage transfer, and an ordering rule.
An explicit owner variable and the existing release sites avoid all three.

The review also corrected the D3 reason. `models.json` holds `$PI_PROVIDER_API_KEY` or `byok:durable-ipc`, not the key (`keys/src/pi-provider-projection.ts:7`, `piApiKey`).
The secret reaches the child through env or IPC. Deleting the projection directory does not revoke a credential.

## P1: Boundary

The scope is `packages/client/src/daemon/task-runner.ts` and its tests.
No new module, public export, wire schema, storage format, adapter contract, or package changes.

The current owners stay authoritative:

- StartupOwnership owns a returned or aborted startup until disposal or active transfer. Its release must succeed, or it keeps the owner and retries.
- ActiveTask and finishOnce own an active task until terminal commit and release. They release `active.gitLease` (`:5204`, `:5212`) and the preparation pin (`:5205`, `:5213`).
- TerminalCommitQueue owns terminal bytes. The execution journal stays the durable authority.
- A Pi Session owns `runtimeLaunch.release` after start returns (`adapters/pi/pi-adapter.ts:578`, `:901`; `adapters/pi-durable/session.ts:81`).
- The cloud claim stays the cross-process authority for one execution per task.

## P2: Observed path and defects

Path: duplicate guard (`:1989`) → in-flight registration (`:2080`) → agent lease (`:2422`) → git lease (`:2561`) → runtime launch (`:2577`) → preparation compare and pin (`:2741`) → claim → startOwnedRuntime (`:2963`) → startup owner (`:2978` on start failure, `:3028` on return) → active handoff (`:3153`, `:3182`) → finally (`:3225-3256`).

Observed maintenance cost:

- handleOffer is one method of about 1,280 lines (`:1975-3256`).
- The git lease is declared inside the try block (`:2440`), so the finally cannot see it. Early exits release it by hand at 11 sites. Two more calls sit inside the startup owner release callbacks (`:2992`, `:3033`).
- The agent lease is released by hand at 4 sites before claim (`:2460`, `:2485`, `:2498`, `:2524`), and again in the finally (`:3243`) when `agentLeaseTransferred` is false.
- `agentLeaseTransferred` is written 4 times and read 2 times. At `:3153` and `:3182` its value is `agentBinding !== undefined`, so it does not name the owner.
- The finally decides on three different facts: `startupOwnership.has`, `agentLeaseTransferred`, and `tasks.has`.
- Message, memory, and host-toolset context cleanup is gated by the agent lease flag. This is correct only because those contexts need an agentRef (`:2297`).
- The in-flight markers are cleared at the end of the finally (`:3253-3255`). A throw from an earlier step in the finally skips them.

Confirmed defect (PR A):

When `resolveRuntimeLaunch` throws (`:2581-2583`), or the offer is withdrawn right after it (`:2585`), handleOffer returns without `gitLease?.release()`.
The lease stays in the module-level `workspaceLeases` and `sessionLeases` maps (`git-workspace.ts:218-219`).
Each later acquire for that workspace or sessionRef then fails with `lease-busy` (`git-workspace.ts:389`) until the process restarts.

Evidence: two independent probes at the base commit used the real GitWorkspaceManager.
Both paths sent only `task.decline` and reported `acquired=1 released=0`. The second probe also saw a later acquire return `lease-busy`.
A sweep of all 21 `return` statements from `:2561` to `:3030` found no other explicit return that skips the release.

Inferred defect (PR B): an uncaught throw between `:2561` and `:3028` also skips the release, because the finally cannot see the lease. No test has reproduced it yet.

Known gap from the PR 354 review (D2): when startup disposal fails and the owner keeps the runtime, the finally still unpins the preparation (`:3249-3250`).

## P3: Decisions

D1. Replace `agentLeaseTransferred` with one local owner variable: `let owner: 'offer' | 'startup' | 'active' = 'offer'`.
Set it to `'startup'` on the same synchronous path as each `startupOwnership.register` (`:2978`, `:3028`).
Set it to `'active'` on the same synchronous path as each `startupOwnership.transferToActive` and `tasks.set` (`:3153-3155`, `:3182-3185`).
The finally reads only `owner` and `startupOwnership.has` to decide what it still releases.

D2. The startup owner releases the preparation pin after quiescence.
Add `releasePreparationPin` to the end of both startup `release` callbacks, after the agent lease and the git lease.
The finally unpins only when `owner === 'offer'`.
A retained startup keeps its pin until a later disposal succeeds. This is the purpose of the pin: GC must not remove material that a possibly running Execution needs.

D3. Keep the existing projection cleanup timing.
When `owner !== 'active'`, the finally still calls `runtimeLaunch?.release()`, including for a retained startup.
This is for scope control, not security. Moving it is out of scope.
The code comment must say so. A test must cover the branch where start has not yet returned.

D4. Keep each manual release site and its order. Add a safety net.
Hoist the `gitLease` declaration to handleOffer scope, next to `agentBinding`.
In the finally, when `owner === 'offer'`, call `gitLease?.release()` after the existing agent lease release. `GitWorkspaceLease.release` is idempotent (`git-workspace.ts:394-396`).
The manual sites keep release-before-decline. The finally only covers throws and missed sites. Nothing moves later.

D5. Intended behavior changes. No other change is intended.

- A retained startup now keeps its preparation pin (D2).
- An uncaught throw after the git lease acquire now releases the git lease in the finally (D4). Before, it leaked.
- When the task becomes active and then finishes before the finally runs (the cancelled-at-start path, `:3156`), the finally no longer repeats the pin and runtime-launch releases. finishOnce and the Session already own them, and both releases are idempotent. The visible result is the same.

D6. Two release contracts stay separate and named in code comments.

- Startup release must succeed. The agent lease failure throws, so StartupOwnership keeps the owner and retries. Unchanged.
- Offer-phase release is best-effort. The agent lease uses `.catch(() => {})`. `releasePreparationPin` logs and continues. Unchanged.

D7. The in-flight markers (`inFlightBlobAborts`, `inFlightOffers`, `claimedHarnesses`) move into an inner `finally`, so a throw from any earlier cleanup step cannot skip them.

D8. Keep these unchanged: startOwnedRuntime, StartupOwnership, finishOnce, the close receipt from PR 357, TerminalCommitQueue, cancel routing, shutdown order, sync revoke positions, and the home reservation counter.

D9. Do not split handleOffer into phase methods here. That is the next slice, and it must be a pure move.

Rejected:

- A generic offer resource container (revision 1). See Revision 2.
- A per-task phase table that replaces tasks, startupOwnership, inFlightOffers, and the ID sets. Without a full replacement it would become a second authority.
- An execution generation id like RAFT's process binding fence. One execution per task in a process is enforced at `:1989`, and across processes by the cloud claim.
- RAFT's inbox plan/effects split. The client has no inbox. Cloud DO inbox admission is already a pure function (`cloud-do/src/inbox-admission.ts:19`).

## Task Breakdown

PR A: release the git lease on runtime launch admission exits

- [x] Add two regression tests to `git-workspace-task-runner.test.ts`: launch resolution throws, and the offer is withdrawn after launch resolution. Each asserts that a later acquire for the same workspace succeeds. Record that both fail on the base.
- [x] Add `gitLease?.release()` before the two returns at `:2583` and `:2585`.
- [x] Run the focused suites and the five required checks.
- [ ] Open a Draft PR. Mark it as a bug fix.

PR A verification notes:

The two new tests failed on the base. Both declined the offer. The later acquire then threw `GitWorkspaceError: workspace is busy` at `git-workspace.ts:389`.
The fix adds one `gitLease?.release()` at each exit. The throw exit releases before the decline. The withdrawn exit uses the same form as the existing sites at `:2757` and `:2759`.
After the fix, the 9 focused suites passed: 103 of 103 tests.
`bun run build`, `bun run typecheck`, `bun run check:api-surface`, and `bun run check:version-authority` exited 0. The API golden did not change.
The runs used local Node 26.10.0 (Homebrew), not the official Node 24.21.0. Bun was 1.4.3. The profile was `BYOK_REQUIRE_BUN=1 VITEST_MAX_WORKERS=1` with `BYOK_TEST_BUN_BIN` set and a short fresh TMPDIR.
`bun run test` exited 1. The client package had 1 failure in 3702 tests (3674 passed, 27 skipped).
The failing test is the node host form in `pi-host-payload.test.ts`. The Homebrew node binary links `@rpath/libnode.147.dylib`, so a copied binary cannot load. The same test fails the same way on the base code. The fix does not cause it.
`bun run test` stops after the first failed package. A second run covered the other 14 packages. All passed: 3817 Vitest tests passed, 133 skipped, and 15 of 15 `node --test` tests in cloud-do passed.

PR B: explicit offer owner and throw safety net

- [ ] Add tests before the change. Record which fail on the base.
  - D2, with a real InputPreparationStore and `gc()`: the record survives GC while the owner is retained after a close failure, after a late startup that is still running, and while terminal commit is not complete. After disposal succeeds, the pin is gone and GC can remove the record. Expected to fail on the base.
  - D3: the projection directory is removed when handleOffer exits with a retained startup, including the branch where start has not returned. Expected to pass on the base.
  - D4: a throw after the git lease acquire releases the git lease and the agent lease. Expected to fail on the base (git lease).
  - D6: an agent lease release failure inside the startup release keeps the owner and is retried. Expected to pass on the base.
  - D7: a throw from a cleanup step in the finally still clears the in-flight markers, so a later offer for the same taskId is not blocked by `inFlightOffers`.
- [ ] Introduce `owner` (D1) and remove `agentLeaseTransferred`.
- [ ] Move the pin release into both startup release callbacks (D2).
- [ ] Hoist `gitLease` and add the finally safety net (D4). Keep all manual release sites.
- [ ] Move the in-flight markers into an inner `finally` (D7).
- [ ] Add the D3 and D6 comments.
- [ ] Run the focused suites, the five required checks, and an independent review. Run a separate read-only review of the test changes: no existing assertion may change.

## Verification

Focused suites for both PRs:
startup-ownership, runtime-start, task-runner-shutdown-startup, task-runner-cancel-race, task-runner-shutdown, task-runner-close-receipt, terminal-commit-queue, adapter-disposal-parity, git-workspace-task-runner, prepared-offer-lane, prepared-offer-process-restart, prepared-memory-lifecycle, input-preparation-store, daemon-stop-shutdown-parity, and pi-runtime-launch.

Required: bun run build; bun run typecheck; bun run test; bun run check:api-surface; bun run check:version-authority.
Use the profile of the previous slices: official Node 24.21.0, Bun 1.4.3, BYOK_REQUIRE_BUN=1, VITEST_MAX_WORKERS=1.
Record each exit code.

The API golden may change only in private TaskRunner members. PR B is not expected to change it.
Do not change existing test assertions, timeouts, or skip rules.

## Risks and limits

The main risk is a change in release order on cancel, shutdown, or a late startup.
D4 keeps every existing release site, so the order at each exit stays the same. The tests added before the change are the guard.

D2 holds the pin longer for a retained startup. If disposal never succeeds, that record stays until the process restarts. This is the intended trade: keep material for a possibly running Execution rather than let GC remove it.

Full suites pass only with one file worker today. The tmpdir leak and wake-inbox flake stay in `tasks/todos.md`. This plan does not fix them.

## Reference

RAFT study: `~/Projects/RAFT-study/docs/byok-sdk-architecture.md` (owner workspace, not in this repo).
The RAFT idea used here is one owner per resource at each moment. No RAFT code is copied. byok stays MIT.
