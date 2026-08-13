# Plan: Quiescent Runtime Process-Tree Disposal

> **Status**: Draft
> **Created**: 20260814-0011
> **Slug**: quiescent-runtime-disposal
> **Planning Source**: waza-think
> **Orchestration Kind**: sprint-task
> **Source Ref**: sprint:plans/sprints/20260814-0005-runtime-adapter-lifecycle-contracts.sprint.md#Quiescent process-tree disposal + built adapter lifecycle evidence
> **Artifact Level**: work-package
> **Promotion Reason**: Pi, Claude, and Codex Sessions currently signal close without proving process-tree exit, while TaskRunner releases active/workspace ownership before close and swallows close failure; a shared OS process-tree controller serves three real adapters and protects daemon shutdown and Git workspace exclusivity.
> **Verification Boundary**: Run client typecheck/test/build, real child-plus-descendant lifecycle tests on supported CI OSes, daemon shutdown and Git workspace race suites, built adapter smoke, workspace typecheck/test/build, and strict contract/workflow verification; close and daemon stop must not resolve before quiescence.
> **Rollback Surface**: Revert the shared process-tree controller, three process clients/sessions, TaskRunner teardown state/barrier integration, observer/health projection, fixtures, CI constraints, docs, and tests as one commit; never preserve early ownership release beside the quiescent path.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260814-0011-quiescent-runtime-disposal.contract.md`
> **Task Review**: `tasks/reviews/20260814-0011-quiescent-runtime-disposal.review.md`
> **Implementation Notes**: `tasks/notes/20260814-0011-quiescent-runtime-disposal.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from waza-think planning output.
- Source ref: sprint:plans/sprints/20260814-0005-runtime-adapter-lifecycle-contracts.sprint.md#Quiescent process-tree disposal + built adapter lifecycle evidence
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260814-0011-quiescent-runtime-disposal.md`
- Sprint contract: `tasks/contracts/20260814-0011-quiescent-runtime-disposal.contract.md`
- Sprint review: `tasks/reviews/20260814-0011-quiescent-runtime-disposal.review.md`
- Implementation notes: `tasks/notes/20260814-0011-quiescent-runtime-disposal.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260814-0011-quiescent-runtime-disposal.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260814-0011-quiescent-runtime-disposal.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260814-0011-quiescent-runtime-disposal.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/20260814-0011-quiescent-runtime-disposal.contract.md`
- Review file: `tasks/reviews/20260814-0011-quiescent-runtime-disposal.review.md`
- Implementation notes file: `tasks/notes/20260814-0011-quiescent-runtime-disposal.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260814-0011-quiescent-runtime-disposal.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260814-0011-quiescent-runtime-disposal.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert the shared process-tree controller, three process clients/sessions, TaskRunner teardown state/barrier integration, observer/health projection, fixtures, CI constraints, docs, and tests as one commit; never preserve early ownership release beside the quiescent path.
- **Verification boundary**: Run client typecheck/test/build, real child-plus-descendant lifecycle tests on supported CI OSes, daemon shutdown and Git workspace race suites, built adapter smoke, workspace typecheck/test/build, and strict contract/workflow verification; close and daemon stop must not resolve before quiescence.
- **Review/acceptance boundary**: `tasks/reviews/20260814-0011-quiescent-runtime-disposal.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: Pi, Claude, and Codex Sessions currently signal close without proving process-tree exit, while TaskRunner releases active/workspace ownership before close and swallows close failure; a shared OS process-tree controller serves three real adapters and protects daemon shutdown and Git workspace exclusivity.

## Evidence Contract

- **State/progress path**: `plans/plan-20260814-0011-quiescent-runtime-disposal.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260814-0011-quiescent-runtime-disposal.contract.md`, `tasks/reviews/20260814-0011-quiescent-runtime-disposal.review.md`, and `tasks/notes/20260814-0011-quiescent-runtime-disposal.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260814-0011-quiescent-runtime-disposal.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert the shared process-tree controller, three process clients/sessions, TaskRunner teardown state/barrier integration, observer/health projection, fixtures, CI constraints, docs, and tests as one commit; never preserve early ownership release beside the quiescent path.

## Captured Planning Output

## Recommendation

Introduce one client-internal owned process-tree controller used by Pi, Claude, and Codex. Make Session close idempotently terminate the owned tree, escalate within bounded deadlines, and resolve with typed teardown evidence only after quiescence. Change TaskRunner terminalization so semantic task outcome and teardown settlement are orthogonal: a completion/failure/cancellation can be sent once, but active/workspace ownership is released only after disposal settles. A failed or timed-out disposal remains a visible mutation barrier and keeps ownership fail-closed.

## P1: Architecture Map

- Process owners today: Pi `rpc-client.ts`, Claude `process-client.ts`, and Codex `process-runner.ts` each spawn and signal child processes independently.
- Session owners: PiSession, ClaudeSession, and CodexSession implement idempotent-looking close methods, but Pi/Claude return immediately after kill and Codex ends its queue immediately after kill without awaiting `waitClosed()`.
- Task owner: `packages/client/src/daemon/task-runner.ts` keeps ActiveTask, batcher, approvals, timers, Git workspace lease, and Session. `finish()` currently stops timers, deletes the task, releases the Git lease, then awaits close and swallows errors.
- Daemon owner: `packages/client/src/daemon/create-daemon.ts` already models shutdown mutation barriers, late unsettled task teardown, operational health, and ownership-lease retention. Row 3 must integrate with that authority, not build a parallel shutdown manager.
- Real-composition evidence: `packages/client/scripts/adapter-task-smoke.mjs` runs built client/server and fake vendor CLIs but currently proves normal completion only, not cancellation descendants or ownership timing.
- Separate branch boundary: the `shutdown-lease-order` worktree owns control endpoint versus daemon-owner lease ordering. This row starts only after that work lands and never edits `daemon-owner.ts` or reopens its invariant.
- Out of scope: container/VM sandboxing, arbitrary third-party daemon supervision, remote MCP subprocesses, provider retry policy, protocol changes, and operating-system features unavailable to Node without a concrete adapter consumer.

## P2: Concrete Trace and Pressure Point

Current normal completion path:

1. A native terminal frame maps to `turn_end`.
2. TaskRunner sends `task.complete` and calls `finish()`.
3. `finish()` clears the duration timer, stops batching, deletes ActiveTask, drains approvals, releases the Git workspace lease, and only then awaits `session.close()`.
4. Pi and Claude close signal only their direct child and resolve; Codex signals its current child and resolves without waiting for `waitClosed()`.
5. TaskRunner catches and discards close failure. The daemon and another task can now observe zero active ownership/reacquire the workspace while the runtime or a descendant remains alive.

Current shutdown path:

1. TaskRunner marks a task tearing down and races interrupt against a grace window.
2. If interrupt does not settle, it races close against the same window.
3. It sends semantic task.fail and then calls the same early-release `finish()` path.
4. create-daemon tracks the outer shutdown promise as a mutation barrier, but a close method that resolves on signal makes that barrier settle before OS quiescence.

Concrete falsifiers:

- A child fixture that spawns a long-lived descendant can leave that descendant alive after Session.close resolves on POSIX because direct-child SIGTERM is not process-tree termination.
- A delayed close fixture exposes the existing `tasks.delete() -> gitLease.release() -> await close()` window; another task can reacquire while the first runtime is still writing.
- A close rejection disappears, so operational health and daemon ownership cannot distinguish clean stop from unknown residual writer.

Target path:

1. Each adapter spawns through one OwnedProcessTree controller. On POSIX it owns a dedicated process group; on Windows it owns the tree targeted by `taskkill /T`.
2. Graceful terminate signals the entire owned tree and waits for child stdio close plus process-group/tree disappearance. On deadline it escalates to hard kill and waits through a second bounded deadline.
3. Close returns typed evidence identifying already-closed/graceful/hard-kill settlement and native exit code/signal; inability to prove quiescence rejects with typed teardown failure.
4. TaskRunner marks semantic terminal outcome exactly once, stops event/approval production, but retains task/workspace ownership while disposal is pending.
5. On teardown success, TaskRunner releases the Git lease and removes local ownership. On failure/timeout it keeps ownership, emits one local teardown-failure observation, and exposes a retryable teardown barrier to daemon stop. It never sends a second task.fail after a semantic terminal message.
6. create-daemon includes pending runtime teardown in its existing mutation-barrier/ownership-lease decision. A clean retry may settle and release; an unsettled writer keeps daemon ownership fail-closed.

## P3: Decision Rationale

### Process-tree controller

- One internal module owns spawn, process-group/tree identity, close/error observation, graceful signal, hard escalation, and typed teardown evidence. It has three current production consumers, satisfying the shared-abstraction threshold.
- POSIX children are spawned into a dedicated process group. Termination targets the group, and quiescence requires the group no longer exists, not merely that the leader emitted `exit`.
- Windows uses `taskkill /T` for tree targeting and waits for command completion plus child close; hard termination uses `/F`. Tests use real descendant PIDs rather than mocks.
- Node `close`, not `exit`, remains the direct-child stdio-drained signal. Tree disappearance is an additional condition.
- Deadlines are explicit validated daemon/runtime configuration, monotonic, and bounded. No unbounded wait and no silent success after timeout.
- The controller never logs argv, env, credentials, stdin, or model output in its receipt.

### Semantic versus teardown state

- Task protocol/store remains semantic authority. Once task.complete/fail/cancelled is sent, teardown cannot rewrite it.
- Local TaskRunner ownership has a terminalizing state until teardown settles. Active-task count and diagnostics include this state because a local writer may still exist.
- Workspace/session lease release is a projection of teardown success, never of semantic completion alone.
- Teardown failure is locally observable and feeds the existing daemon mutation-barrier/operational-health path. It is not encoded as `task.fail.retryable`.
- Retry of close is idempotent and targets the same owned tree identity. No new process may be spawned during teardown retry.

### Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Await only direct child `close` | Descendants can outlive the leader and keep writing. |
| Keep direct kill and add a sleep | Time passage is not quiescence evidence and is nondeterministic under load. |
| Release workspace ownership before close but warn | Preserves the unsafe overlap window; observability does not enforce exclusivity. |
| Turn teardown failure into task.fail | Can contradict an already-authoritative completed/cancelled task. |
| Swallow close errors to keep shutdown available | Falsely releases daemon/workspace ownership while a writer may survive. |
| Introduce a generic connector supervisor | Only runtime adapter process trees are in scope; MCP supervision has its own deferred trigger and policy surface. |
| Use PID-only liveness | PID reuse and descendants make a leader PID insufficient; owned group/tree identity is required. |

## File and Ownership Plan

| Surface | Change |
|---|---|
| New client-internal process-tree lifecycle module | Own spawn/tree identity, graceful/hard termination, quiescence wait, and typed teardown receipt/failure. |
| Pi RPC client/session | Spawn through controller; preserve in-band abort for interrupt; close terminates/waits for the tree. |
| Claude process client/session | Spawn through controller; interrupt/close share termination but both observe the same idempotent settlement. Temp MCP config is removed only after process quiescence. |
| Codex process runner/session | Replace signal-only close with controller settlement; preserve one-process-per-turn and session queue semantics. |
| `packages/client/src/types.ts` | Freeze the Session close/teardown evidence contract consumed by custom adapters; no optional legacy semantics. |
| `packages/client/src/daemon/task-runner.ts` | Add terminalizing/teardown-pending ownership state; separate exactly-once semantic terminal from ownership release and close retry. |
| `packages/client/src/daemon/create-daemon.ts`, observer/operational health | Fold pending teardown into existing mutation barrier and one local audit/health projection. Consume the landed shutdown-order base; do not modify daemon-owner authority. |
| Fixtures and tests | Add real child+descendant programs, delayed/rejected close fakes, Git lease race tests, shutdown retry tests, and supported-OS constraints. |
| `packages/client/scripts/adapter-task-smoke.mjs` | Exercise built-entry cancellation/stop for all three adapters and assert descendant exit before cleanup resolves. |
| CI/docs | Run lifecycle evidence on supported OS matrix and document guarantees/limits. |

One deep implementation worker owns all production paths because the shared controller, Session contract, TaskRunner ownership state, and daemon barrier must land atomically. Test fixture work may be delegated only after the controller API freezes and must use disjoint fixture/test files. Gatekeeper review runs read-only after code freeze.

## Test and Verification Design

- Controller unit/integration matrix on POSIX and Windows: already-exited, graceful direct child, graceful child+descendant, ignored graceful signal requiring hard escalation, spawn error, and unverifiable teardown timeout.
- Receipt assertions: settlement mode and exit evidence are exact; no argv/env/secret values appear.
- Session matrix: Pi interrupt preserves session but close settles tree; Claude interrupt/close converge idempotently; Codex closes the current turn process and waits, including repeated close.
- TaskRunner normal completion race: after task.complete is emitted but close is blocked, active/terminalizing ownership and Git lease remain; reacquire fails. After close settles, ownership releases exactly once.
- Teardown failure race: semantic terminal remains unchanged, one local failure observation appears, workspace lease remains, and daemon stop retains owner lease until a later clean close retry.
- Cancel/shutdown races: late turn_end/process close cannot create a second task terminal; pending teardown is included in shutdown deadlines and late barriers.
- Built-entry real server test: fake Pi/Claude/Codex CLIs each spawn a descendant; cancel or stop; verify both PIDs are absent before public cleanup resolves.
- Static guard: bundled adapters do not call raw child.kill/taskkill directly outside the shared controller; TaskRunner cannot release Git lease/delete ownership before teardown success.
- Required commands: client typecheck/test/build, lifecycle OS matrix, daemon shutdown/Git suites, built adapter smoke, workspace typecheck/test/build, strict workflow and contract verification.

## Rollout and Rollback

- Dependencies: Rows 1 and 2 are merged; `shutdown-lease-order` is merged; implementation starts from those exact commits. No rebase across an unreviewed shutdown lifecycle diff.
- Rollout: one 0.4.0 merge unit. The built adapter smoke becomes mandatory evidence before the eventual release row can publish.
- Rollback: revert the complete controller/ownership/barrier cut. Do not restore early lease release while leaving controller receipts or mix direct-child and process-tree close paths.
- First 10x pressure: many concurrent terminalizing tasks can exhaust process/workspace capacity if runtimes ignore signals. Bounded escalation plus honest retained ownership fails closed; metrics/tests must expose the count instead of auto-releasing.

## Approval Boundary

This plan stays Draft. Row 3 execution begins only after Rows 1-2 and shutdown-order land. Approval does not authorize generic MCP supervision, sandboxing, protocol changes, or npm publication.

## Task Breakdown

- [ ] Freeze the exact landed bases for Rows 1-2 and shutdown-lease-order; reconcile their lifecycle invariants without reopening prior scope.
- [ ] Implement the shared owned process-tree controller and typed teardown evidence with bounded graceful/hard settlement.
- [ ] Migrate Pi process ownership and Session close while preserving in-band interrupt semantics.
- [ ] Migrate Claude process ownership, idempotent close, and post-quiescence temp-config cleanup.
- [ ] Migrate Codex per-turn process ownership and Session close without corrupting shared queue/resume behavior.
- [ ] Change TaskRunner to retain terminalizing task/workspace ownership until teardown success and to keep semantic terminal exactly once.
- [ ] Integrate pending runtime teardown with create-daemon's existing mutation barrier, shutdown retry, audit, and operational health.
- [ ] Add real child+descendant OS fixtures, controller/session matrix, Git lease race, teardown-failure, cancel, and shutdown tests.
- [ ] Extend built adapter smoke and CI constraints so quiescent cancellation/stop is release evidence.
- [ ] Update spec/security/architecture truth and run the complete verification boundary.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] Freeze the exact landed bases for Rows 1-2 and shutdown-lease-order; reconcile their lifecycle invariants without reopening prior scope.
- [ ] Implement the shared owned process-tree controller and typed teardown evidence with bounded graceful/hard settlement.
- [ ] Migrate Pi process ownership and Session close while preserving in-band interrupt semantics.
- [ ] Migrate Claude process ownership, idempotent close, and post-quiescence temp-config cleanup.
- [ ] Migrate Codex per-turn process ownership and Session close without corrupting shared queue/resume behavior.
- [ ] Change TaskRunner to retain terminalizing task/workspace ownership until teardown success and to keep semantic terminal exactly once.
- [ ] Integrate pending runtime teardown with create-daemon's existing mutation barrier, shutdown retry, audit, and operational health.
- [ ] Add real child+descendant OS fixtures, controller/session matrix, Git lease race, teardown-failure, cancel, and shutdown tests.
- [ ] Extend built adapter smoke and CI constraints so quiescent cancellation/stop is release evidence.
- [ ] Update spec/security/architecture truth and run the complete verification boundary.
