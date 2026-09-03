> **Archived**: 2026-09-03 08:47
> **Related Plan**: plans/archive/plan-20260903-0436-agent-home-single-writer.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260903-0847

# Implementation Notes: agent-home-single-writer

> **Status**: Active
> **Plan**: plans/plan-20260903-0436-agent-home-single-writer.md
> **Contract**: tasks/contracts/20260903-0436-agent-home-single-writer.contract.md
> **Review**: tasks/reviews/20260903-0436-agent-home-single-writer.review.md
> **Last Updated**: 2026-09-03 05:10
> **Lifecycle**: notes

## Falsifier (run first, on unchanged code)

Contract §Falsifier required proving that two sessions of one Agent can both
hold execution leases on the same canonical home in one daemon process and
both receive the same cwd. A red test was written first at
`packages/client/src/__tests__/agent-home-single-writer.test.ts` (later
replaced by the regression suite) driving a real daemon over `TestServer`:
two `task.offer_for_agent` envelopes for one `agentRef`, different taskIds.

```
$ bun run --cwd packages/client test -- src/__tests__/agent-home-single-writer.test.ts --reporter=verbose
 ✓ src/__tests__/agent-home-single-writer.test.ts > FALSIFIER: canonical Agent home co-writing on unchanged code > lets two sessions of one Agent hold execution leases on the same canonical home with the same cwd 129ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
```

It passed on unchanged code: both offers were claimed and started, `task.decline`
count was 0, and `startCalls[0].ctx.workspaceDir === startCalls[1].ctx.workspaceDir`
(the canonical home). Co-writing was possible today, so the review's reading of
`agent-home.ts:600-632` holds and the slice is necessary.

## What was built

- `packages/client/src/agent-home.ts`
  - `AgentHomeExecutionLeaseManager.activeAttemptCount(canonicalHome)` —
    the per-home active-Attempt count the admission gate reads. Derived from
    the existing `leasesByKey` registry rather than a second tally, so it has
    exactly the lease lifecycle: entry at `acquire()`, survives `bindSession()`
    (rekey in place), gone only at `release()`. Counted regardless of owning
    manager: the invariant protected is the filesystem path.
  - `activeAttemptSummary()` — counts-only readback for status, scoped to this
    manager's own leases so the number describes one daemon.
  - `AgentHomeExecutionStatus` interface (counts only; no path, agentId or
    taskId), declared here so both `create-daemon.ts` and `control-protocol.ts`
    can import it without a module cycle.
  - Class doc updated: this layer counts, it does not cap.
- `packages/client/src/daemon/task-runner.ts`
  - `DEFAULT_MAX_CONCURRENT_MUTABLE_SESSIONS_PER_AGENT_HOME = 1`,
    `TaskRunnerDeps.maxConcurrentMutableSessionsPerAgentHome?`, and the
    `maxConcurrentMutableSessionsPerAgentHome` getter (same shape as
    `maxTaskOutputBytes`).
  - The busy gate in `handleOffer`, placed immediately after the
    `strictAgentOnly` gate and before the host `admissionGuard`, `prepare()`,
    the claim, the workspace and every process side effect. Resolves the
    canonical home for the offer's `agentRef`, reads the count, and on
    `count >= limit` emits a retryable `task.decline` with reason
    `agent home busy: <n> active attempt(s)` — counts only.
  - No release wiring was needed: `finish()` already releases the Agent-home
    lease only after `Session.close()` resolved, and returns early on a
    disposal failure without releasing. The new count inherits that.
- `packages/client/src/daemon/create-daemon.ts`
  - `DaemonConfig.maxConcurrentMutableSessionsPerAgentHome?: number`, validated
    up front as a positive safe integer (0, negative, NaN, non-integer and
    `Number.POSITIVE_INFINITY` all rejected — unlike `maxTaskOutputBytes` there
    is deliberately no infinity opt-out, since "no cap" is the state this
    exists to prevent). Resolved once into `agentHomeAttemptLimit`.
  - `agentHomeExecutionStatus()` — one reader feeding both `Daemon.status()`
    and the authenticated local control status.
  - `DaemonStatus.agentHomeExecution` (required).
- `packages/client/src/daemon/control-protocol.ts`
  - `ControlStatusResult.agentHomeExecution?` (optional: an older control peer
    predates the field).
- `packages/client/src/index.ts` — exports the `AgentHomeExecutionStatus` type,
  since the public `DaemonStatus` now references it.
- `docs/spec.md` §Durable Agent homes — execution is serialised per canonical
  Agent home by default; the cap, the pre-side-effect retryable decline, the
  release-after-close rule, and the explicit-opt-in co-writing caveat.
- `CHANGELOG.md` — new `## Unreleased` breaking note.
- `packages/client/src/__tests__/agent-home-single-writer.test.ts` — 12 tests.

## Deviations From Plan Or Spec

- `api-surface/client.d.ts` (resolved). The branch is now rebased onto
  `2e01c9a`, which introduced the golden, so the regenerated surface is part of
  this diff and `bun run check:api-surface` passes. It records the public
  changes this slice makes: `DaemonConfig.
  maxConcurrentMutableSessionsPerAgentHome`, `DaemonStatus.agentHomeExecution`,
  `AgentHomeExecutionStatus`, and `AgentHomeLayout.canonicalHomePath()`.
- `packages/client/src/types.ts` was not edited: `DaemonConfig` and
  `DaemonStatus` live in `create-daemon.ts`, and the new status interface went
  to `agent-home.ts` to avoid a `create-daemon` <-> `control-protocol` cycle.
- One file outside `allowed_paths` was edited — see below.

## Post-gate fixes

Two acceptance findings on the first cut, both fixed on this branch:

- **Side effect ahead of the host admission veto.** The busy count keyed itself
  off `AgentHomeLayout.resolve()`, which takes the cross-process
  `agent-home-root` mutation gate, materializes `agents/<agentId>` and records
  the Agent binding. Because the gate deliberately sits *before* the host's own
  admission veto, an offer the host went on to decline (storage pressure,
  `limits.maxTokens`, a policy rejection) durably left an empty Agent home
  directory behind that `main` never created. The count now derives its key
  through the new non-mutating `AgentHomeLayout.canonicalHomePath()`, which
  validates the `AgentRef` and joins the same
  `<hostStorageRoot>/agents/<agentId>` segments while canonicalizing only what
  already exists — no gate, no `mkdir`, no binding. `resolve()` still runs
  later, on the admission path, for an offer that actually executes. Guarded by
  two tests: a pressure-vetoed offer leaves no `agents/<agentId>` on disk, and a
  busy-declined offer leaves the Agent-home root byte-identical.
- **A sleep standing in for a barrier.** The duplicate-offer test slept 50 ms
  after re-sending the offer and then asserted steady state, which would have
  passed even if the duplicate had never been processed. It now uses the
  deterministic barrier the file already documents: `ConnectionManager` runs
  every envelope through one serial chain, so a `task.claim` for a follow-on
  offer queued behind the duplicate proves the duplicate was already handled.

## Existing tests adjusted

- `packages/client/src/__tests__/agent-home-contract.test.ts` (NOT in
  `allowed_paths`; edited under the dispatch's explicit instruction to keep
  existing client tests green). One test, `runs different sessions for the same
  Agent concurrently while retaining one canonical home`, encoded the 0.12.0
  default directly: it drives `TaskRunner.handleEnvelope` twice for one
  `agentRef` and asserts two `startCalls`. It now passes
  `maxConcurrentMutableSessionsPerAgentHome: 2` in its `TaskRunnerDeps` and its
  title says "once the host raises the per-home cap"; the scenario is exactly
  the concurrent-sessions case the knob exists for. Body assertions unchanged.
  No other test in any package needed a change.

## Design Decisions

- Gate placement follows the plan snippet literally: after the
  receive/dedup/pre-cancel/`strictAgentOnly` precedence, before the host
  `admissionGuard` and `prepare()`. The existing precedence at
  `task-runner.ts:1560-1573` was not reordered. A duplicate or pre-cancelled
  offer returns above the gate, so it can never consume a slot (tested).
- Counted per HOME, not per lane: a `pi` session and a `claude` session in the
  same home still co-write `MEMORY.md`, `notes/` and `.git`; a lane cap would
  not stop that.
- Fail closed on disposal: a failed `Session.close()` keeps the slot, so the
  home stays busy until the daemon restarts (visible as a non-zero
  `activeAttempts` in status). Same posture as `runtime-disposal-failed`.
- Crash residue needed no new code: a restarted daemon starts with an empty
  in-process registry (count 0) and reclaims the on-disk marker only under the
  same `stableAgentHomeOwnerId`. Both halves are tested, including the
  fail-closed foreign-owner case.
- No check-then-acquire race in the daemon path: `ConnectionManager` chains
  every envelope through one serial promise chain, so two `handleOffer` calls
  never interleave between the count read and `acquireExecution`.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Separate per-home counter map in the lease manager | Rejected | Two authorities for one fact; `leasesByKey.size` already has the exact lifecycle required |
| Enforce the cap inside `AgentHomeExecutionLeaseManager.acquire` | Rejected | Contract places the decision in admission so the offer is declined before side effects; the lease layer counts, it does not cap |
| Gate after the host `admissionGuard` | Rejected | Plan's code snippet pins it directly after the `strictAgentOnly` gate; a busy home costs the offer nothing either way |
| Blocking `Session.close()` to observe the cancel ordering | Rejected | A blocked close stalls the serial envelope chain, so the probing offer never arrives; the test observes the count from inside `close()` instead |

## Open Questions

- None.

## Verification

`bun run --cwd packages/client test -- src/__tests__/agent-home-single-writer.test.ts` (exit 0):

```
 RUN  v4.1.10 /Users/kito/Projects/byok-sdk-wt-agent-home-single-writer/packages/client


 Test Files  1 passed (1)
      Tests  10 passed (10)
   Start at  05:06:33
   Duration  1.58s (transform 394ms, setup 0ms, import 544ms, tests 918ms, environment 0ms)
```

`bun run build` (exit 0):

```
byok-sdk build: CLI Using tsup config: /Users/kito/Projects/byok-sdk-wt-agent-home-single-writer/packages/sdk/tsup.config.ts
byok-sdk build: CLI Target: es2022
byok-sdk build: CLI Cleaning output folder
byok-sdk build: ESM Build start
byok-sdk build: ESM dist/index.js     540.00 B
byok-sdk build: ESM dist/index.js.map 89.00 B
byok-sdk build: ESM ⚡️ Build success in 17ms
byok-sdk build: Exited with code 0
```

`bun run typecheck` (exit 0):

```
@byok-sdk/example-packaging:typecheck                | Done in 99ms
@byok-sdk/example-salesko-connector-broker:typecheck | Done in 177ms
@byok-sdk/keys:typecheck                             | Done in 133ms
@byok-sdk/protocol:typecheck                         | Done in 251ms
@byok-sdk/server:typecheck                           | Done in 473ms
@byok-sdk/testkit:typecheck                          | Done in 110ms
@byok-sdk/ui-runtime:typecheck                       | Done in 126ms
byok-sdk:typecheck                                   | Done in 105ms
```

`bun run test` (full, exit 0) — per-package summaries:

```
@byok-sdk/client:test                           |  Test Files  165 passed | 2 skipped (167)
@byok-sdk/client:test                           |       Tests  1610 passed | 11 skipped (1621)
@byok-sdk/cloud:test                            |  Test Files  29 passed (29)
@byok-sdk/cloud:test                            |       Tests  261 passed (261)
@byok-sdk/cloud-dataplane:test                  |  Test Files  8 passed | 25 skipped (33)
@byok-sdk/cloud-dataplane:test                  |       Tests  74 passed | 101 skipped (175)
@byok-sdk/conformance:test                      |  Test Files  4 passed (4)
@byok-sdk/conformance:test                      |       Tests  147 passed (147)
@byok-sdk/core:test                             |  Test Files  9 passed (9)
@byok-sdk/core:test                             |       Tests  252 passed (252)
@byok-sdk/example-live-activity-host:test       |  Test Files  1 passed (1)
@byok-sdk/example-live-activity-host:test       |       Tests  21 passed (21)
@byok-sdk/example-salesko-connector-broker:test |  Test Files  5 passed (5)
@byok-sdk/example-salesko-connector-broker:test |       Tests  25 passed (25)
@byok-sdk/keys:test                             |  Test Files  20 passed (20)
@byok-sdk/keys:test                             |       Tests  387 passed (387)
@byok-sdk/protocol:test                         |  Test Files  21 passed (21)
@byok-sdk/protocol:test                         |       Tests  349 passed (349)
@byok-sdk/server:test                           |  Test Files  36 passed (36)
@byok-sdk/server:test                           |       Tests  279 passed (279)
@byok-sdk/testkit:test                          |  Test Files  1 passed (1)
@byok-sdk/testkit:test                          |       Tests  4 passed (4)
@byok-sdk/ui-runtime:test                       |  Test Files  3 passed (3)
@byok-sdk/ui-runtime:test                       |       Tests  15 passed (15)
byok-sdk:test                                   |  Test Files  1 passed (1)
byok-sdk:test                                   |       Tests  1 passed (1)
```

`repo-harness run check-task-workflow --strict` (exit 0):

```
[workflow] OK
```

`git diff --check` (exit 0, no output).

`git status --short`:

```
 M CHANGELOG.md
 M docs/spec.md
 M packages/client/src/__tests__/agent-home-contract.test.ts
 M packages/client/src/agent-home.ts
 M packages/client/src/daemon/control-protocol.ts
 M packages/client/src/daemon/create-daemon.ts
 M packages/client/src/daemon/task-runner.ts
 M packages/client/src/index.ts
?? packages/client/src/__tests__/agent-home-single-writer.test.ts
?? plans/plan-20260903-0436-agent-home-single-writer.md
?? tasks/contracts/20260903-0436-agent-home-single-writer.contract.md
?? tasks/notes/20260903-0436-agent-home-single-writer.notes.md
?? tasks/reviews/20260903-0436-agent-home-single-writer.review.md
```

`README.md:87` ("enforces one writer") and `docs/host-local-storage-layout.md`
("Enforce one mutable writer per canonical Agent home") are true again at the
default; no edit was needed, as the plan predicted.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Not promoted (single occurrence, kept here): with the cap raised above 1, two
  concurrent Attempts in one home must still carry distinct runtime
  `sessionRef`s. Two `StubRuntimeAdapter` instances both name their first
  session `stub-session-1`, which the execution lease manager correctly refuses
  as a duplicate session in one home — a test-fixture artifact, not a product
  behaviour, but it decides how a raised-limit test must be written.
