# Split handleOffer into phase methods

Status: Planned
Approval: The owner asked for this slice on 2026-10-12. Each PR needs its own review.
Base: a13d2a559f9fab36150e31dcf0def6ad4ab28d4d
Previous slice: `plans/plan-20261012-offer-resource-ownership.md` (D9 names this slice), delivered by #359, #363 and #364.

## Goal

`TaskRunner.handleOffer` becomes a short sequence of phase calls plus its existing `finally`.
Each phase is one private method with typed inputs and outputs.
The change is a pure move. Every send, await, release and decline happens in the same order as before.
The resource owner contract from the previous slice stays in one place: handleOffer and its `finally`.

Success criteria:

- handleOffer is under about 200 lines. Today it is about 1,300 lines (`task-runner.ts:1975-3272`).
- No existing test assertion, timeout or skip rule changes.
- `git diff --color-moved=dimmed-zebra --color-moved-ws=allow-indentation-change` shows each moved body as moved, except the listed seam edits.
- The API golden changes only in private TaskRunner members.

## P1: Boundary

Scope: `packages/client/src/daemon/task-runner.ts` and client tests.
The phase methods stay in TaskRunner. They use `this.deps` and the TaskRunner maps, so a new file would need a second dependency surface. A later slice can move them if real reuse appears.
No public export, wire schema, storage format, adapter contract or package changes.

Authorities that stay unchanged: StartupOwnership, ActiveTask and finishOnce, TerminalCommitQueue, the execution journal, startOwnedRuntime and the cloud claim.

## P2: Observed structure

At the base, handleOffer has these phases. Line numbers are approximate seams.

| Phase | Lines | Content |
| --- | --- | --- |
| a | 1989-2071 | Duplicate guard, strict AgentRef, `decline`, preparation lane and egress checks. Runs before `inFlightOffers.add` and outside the `try`. |
| b | 2080-2107 | In-flight registration, blob abort, startup timer, `admissionWithdrawn`, resource `let`s, `releaseReservation`. |
| b2 | 2115-2246 | Pre-claim admission: pending cancel, strict mode, reader, canonical home, reservation, admission guard, limits, dispatch selection. |
| c | 2247-2405 | Toolsets, adapter pick, env, host toolset context, message and memory MCP, toolset probe, `adapter.prepare`. |
| d, e | 2407-2576 | Agent home lease, then agent, Git or plain workspace. |
| f | 2578-2590 | Runtime launch resolution. |
| g | 2595-2755 | Manifest seal, then prepared-lane compare, admit and pin. |
| h, i | 2760-2908 | Claim, instruction resolution, Git workspace preparation, prepared memory MCP. |
| j | 2909-3045 | Start input, startOwnedRuntime, both startup owner registrations. |
| k | 3046-3234 | Inner `try`: bindSession, active build, handoff, `task.started`, active transfer, pump. Its `catch` rethrows when `tasks.has(taskId)`. |
| l | 3235-3271 | `finally`: reservation, owner-based release, inner `finally` for in-flight markers. |

What makes a pure move hard:

- About 30 locals cross phase seams. Several are written in more than one phase: `taskMcpServers` (c and i), `workspaceDir`, `gitWorkspaceId` and `gitBaseline` (e and i), `agentBinding` (set, then cleared to `undefined` after four error releases in e), and `owner` (j and k).
- The `finally` reads five of them: `owner`, `agentBinding`, `gitLease`, `runtimeLaunch` and `reservedHome`.
- Every early exit is a bare `return;` that must leave handleOffer.
- `decline`, `admissionWithdrawn` and `releaseReservation` are closures over handleOffer state. `declineMemory` is local to phase g.
- The inner `try` of phase k starts mid-block and is not indented. Only the whole block from bindSession to the session record can move as one unit.

Test coverage gap: these 12 decline or fail reasons appear in no test file at the base (checked by `git grep -F` over `packages/client/src/__tests__`):
`workspace is busy or unavailable`, `runtime activation failed`, `workspace mode is unavailable`, `Agent home initialization failed`, `Agent message outbox initialization`, `could not bind the runtime session`, `daemon shutting down during runtime startup`, `runtime preparation failed`, `runtime detection failed`, `invalid AgentRef`, `session is incompatible with Git`, `Agent session handoff could not be durably`.
Some branches may be covered by other assertions. A move error in the rest would not fail a test.

## P3: Decisions

D1. Two kinds of state, kept apart.

- Owned resources stay in one small mutable record that handleOffer creates and its `finally` reads: `owner`, `agentBinding`, `gitLease`, `runtimeLaunch` and `reservedHome`. It is a plain local object type, not a class, and it holds no other data. Phase methods write it at the same points where the code writes those locals today.
- All other cross-phase data flows as typed return values. A phase returns its outputs, or `undefined` when the offer has already ended (decline or fail already sent). handleOffer then does `if (x === undefined) return;`.
- A phase that rewrites a value (for example `workspaceDir` in phase i) returns the new value. A later phase never reads a stale copy.

Reason: one bag of 30 optional fields would weaken definite assignment and hide which phase owns which value. The previous slice already showed that the resource owner must stay explicit and in one place.

D2. Exits. Each `return;` inside a moved body becomes `return undefined;`. The decline, fail and release calls before it stay unchanged and in the same order. No phase sends a terminal envelope that it did not send before.

D3. Await boundaries. A phase method is `async` only when its body already awaits. A seam may add a microtask boundary only where the inline code already had an `await` at that point. Otherwise the phase stays synchronous. The synchronous handoffs stay inside one method each, with no await between the steps: the owner change and `startupOwnership.register` (phase j), and the owner change, `transferToActive` and `tasks.set` (phase k).

Reason: an extra await at a seam adds a scheduling point where a concurrent `task.cancel` can run. The cancel-race tests depend on these points.

D4. Closures. `decline`, `admissionWithdrawn` and `releaseReservation` are built once in handleOffer, as today. Phases get them through one small parameter object. `declineMemory` moves into the phase g method.

D5. Phase k moves as one unit: the whole inner `try` from bindSession to the session record, with its `catch` and the `tasks.has(taskId)` rethrow. `let active!` moves with it.

D6. The `finally` stays in handleOffer, unchanged except that it reads the resource record (D1). It is the ownership contract. Keeping it beside the phase calls keeps that contract visible.

D7. Method names follow the phases: `screenOffer` (a), `admitOffer` (b2), `prepareOfferRuntime` (c), `acquireOfferWorkspace` (d, e, f), `admitPreparedOffer` (g), `claimOffer` (h, i), `startOfferRuntime` (j), `activateOfferSession` (k). Phase b stays inline. The implementer may adjust a seam when the code shows a better one. The plan and the PR then record the change.

Rejected:

- A phase pipeline object or state machine. The phases run once, in order, with no reuse. A framework would add indirection without a second user.
- Moving the phases to another file in this slice. See P1.
- Changing behavior while moving: no new checks, no fixes, no reordering. A bug found during the move goes into its own issue and PR.

## Task Breakdown

PR 1: characterization tests (tests only)

- [x] Add one TaskRunner test for each reason in the coverage gap list, unless an existing test already drives that branch (then name that test in the PR). Each test asserts the terminal envelope type, the reason, `retryable`, and that the offer released what it held (agent lease, Git lease, pin, in-flight marker) where the branch holds one.
- [x] All new tests pass on the base without any production change. A test that fails on the base reports a real defect: stop, file an issue, and keep it out of this PR.
- [x] Focused suites and the five required checks.

PR 1 verification notes: The new file is `packages/client/src/__tests__/handle-offer-characterization.test.ts`. It has nine cases. They cover eight gap reasons and the validation branch of `workspace is busy or unavailable`. Existing tests already drive four reasons: `session is incompatible with Git`, the lease branch of `workspace is busy or unavailable`, `daemon shutting down during runtime startup` and `Agent session handoff could not be durably`. A temporary probe confirmed the exact reason of each of those four tests. The probe was deleted. No production file changed. Each new case passed on the base. The new file passed three runs in a row. The focused suites passed with one file worker. With four workers, three focused files failed under machine load. They passed with one file worker. No new test found a defect. In the full run, one client test failed: `agent-memory-guidance.test.ts`, case "injects guidance and the reserved MCP only for strict Agent tasks across the shared runtime seam". It fails the same way on unchanged origin/main on this machine, so it is not caused by this PR.

PR 2: front phases without owned resources

- [ ] Extract `screenOffer` (a), `admitOffer` (b2) and `prepareOfferRuntime` (c). Introduce the D4 parameter object.
- [ ] Each moved body keeps its statements and order. Only seam edits change: parameters, `return undefined`, and the returned outputs.

PR 3: resource phases

- [ ] Introduce the D1 resource record. Make the `finally` read it.
- [ ] Extract `acquireOfferWorkspace` (d, e, f) and `admitPreparedOffer` (g). Keep every manual release before its decline.

PR 4: claim, start and activation

- [ ] Extract `claimOffer` (h, i), `startOfferRuntime` (j) and `activateOfferSession` (k).
- [ ] Confirm by reading that the D3 synchronous handoffs have no await between their steps.

Each of PR 2 to PR 4:

- [ ] Review the diff with `--color-moved`. List every seam edit in the PR body.
- [ ] Focused suites, the five required checks, and one independent read-only review.

## Verification

Focused suites: the PR 1 characterization tests, strict-agent-only, prepared-offer-lane, prepared-offer-process-restart, s11-f2-pin-retention, admission-deadline, admission-deadline-release-guard, agent-home-readers, agent-home-single-writer, mcp-toolsets, task-runner-admission-limits, task-runner-environment, git-workspace-task-runner, create-daemon-git-workspace, pi-runtime-launch, startup-ownership, task-runner-shutdown-startup, task-runner-runtime-failure, task-runner-cancel-race, task-runner-cancel-native, task-runner-close-receipt, task-runner-bounded-collections, mailbox-read-ahead and journal-offer-family.

Required: bun run build; bun run typecheck; bun run test; bun run check:api-surface; bun run check:version-authority.
For the full test run, put the self-contained Node 24.18.0 first on PATH. Homebrew Node 26 links libnode, so a copied-host test fails under it. Use `BYOK_REQUIRE_BUN=1 VITEST_MAX_WORKERS=1`, `BYOK_TEST_BUN_BIN`, and a short fresh TMPDIR.
Record each exit code. If a test fails, run only that file on the unchanged base before concluding.

The API golden gains private method names and loses nothing public. State that in each PR body.

## Risks and limits

The main risk is a changed scheduling point at a seam (D3), or a stale copy of a value that a later phase rewrites (D1).
PR 1 reduces the first risk for untested branches. Review against D1 and D3 covers the rest.
The cancel-race and shutdown tests cover the concurrent paths. They cannot prove that every microtask order is unchanged.

Full suites pass only with one file worker today. The tmpdir leak and the wake-inbox flake stay in `tasks/todos.md`.

Out of scope: `create-daemon.ts`, `pump`, `finishOnce`, and any behavior change.
