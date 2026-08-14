# Plan: Quiescent Runtime Disposal

> **Status**: Executing
> **Created**: 20260814-0947
> **Slug**: quiescent-runtime-disposal
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: sprint-task
> **Source Ref**: sprint:plans/sprints/20260814-0005-runtime-adapter-lifecycle-contracts.sprint.md#Quiescent process-tree disposal + built adapter lifecycle evidence
> **Artifact Level**: work-package
> **Promotion Reason**: Session.close currently signals without proving process-tree quiescence, while TaskRunner releases active and Git workspace ownership before close settles; three bundled adapters and daemon shutdown share one cross-module lifecycle invariant that must land atomically.
> **Verification Boundary**: Run the pre-fix child-plus-descendant falsifier, client typecheck/test/build, built adapter smoke, workspace typecheck/test/build, multi-OS CI lifecycle smoke, strict contract/workflow verification, and one exact-SHA semantic review.
> **Rollback Surface**: Revert the shared process-tree owner, three adapter close barriers, TaskRunner ownership ordering, teardown observer projection, fixtures/smoke/CI/docs as one commit; do not retain detached process groups without the matching quiescence barrier.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260814-0947-quiescent-runtime-disposal.contract.md`
> **Task Review**: `tasks/reviews/20260814-0947-quiescent-runtime-disposal.review.md`
> **Implementation Notes**: `tasks/notes/20260814-0947-quiescent-runtime-disposal.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: sprint:plans/sprints/20260814-0005-runtime-adapter-lifecycle-contracts.sprint.md#Quiescent process-tree disposal + built adapter lifecycle evidence
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260814-0947-quiescent-runtime-disposal.md`
- Sprint contract: `tasks/contracts/20260814-0947-quiescent-runtime-disposal.contract.md`
- Sprint review: `tasks/reviews/20260814-0947-quiescent-runtime-disposal.review.md`
- Implementation notes: `tasks/notes/20260814-0947-quiescent-runtime-disposal.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260814-0947-quiescent-runtime-disposal.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260814-0947-quiescent-runtime-disposal.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260814-0947-quiescent-runtime-disposal.md`.

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
- Contract file: `tasks/contracts/20260814-0947-quiescent-runtime-disposal.contract.md`
- Review file: `tasks/reviews/20260814-0947-quiescent-runtime-disposal.review.md`
- Implementation notes file: `tasks/notes/20260814-0947-quiescent-runtime-disposal.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260814-0947-quiescent-runtime-disposal.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260814-0947-quiescent-runtime-disposal.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert the shared process-tree owner, three adapter close barriers, TaskRunner ownership ordering, teardown observer projection, fixtures/smoke/CI/docs as one commit; do not retain detached process groups without the matching quiescence barrier.
- **Verification boundary**: Run the pre-fix child-plus-descendant falsifier, client typecheck/test/build, built adapter smoke, workspace typecheck/test/build, multi-OS CI lifecycle smoke, strict contract/workflow verification, and one exact-SHA semantic review.
- **Review/acceptance boundary**: `tasks/reviews/20260814-0947-quiescent-runtime-disposal.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: Session.close currently signals without proving process-tree quiescence, while TaskRunner releases active and Git workspace ownership before close settles; three bundled adapters and daemon shutdown share one cross-module lifecycle invariant that must land atomically.

## Evidence Contract

- **State/progress path**: `plans/plan-20260814-0947-quiescent-runtime-disposal.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260814-0947-quiescent-runtime-disposal.contract.md`, `tasks/reviews/20260814-0947-quiescent-runtime-disposal.review.md`, and `tasks/notes/20260814-0947-quiescent-runtime-disposal.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260814-0947-quiescent-runtime-disposal.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert the shared process-tree owner, three adapter close barriers, TaskRunner ownership ordering, teardown observer projection, fixtures/smoke/CI/docs as one commit; do not retain detached process groups without the matching quiescence barrier.

## Captured Planning Output

## Recommendation

Treat runtime disposal as an ownership receipt, not cleanup. Session.close() settles only after every process owned by the runtime operation is quiescent and task-scoped resources are cleaned. TaskRunner retains active-task and Git workspace ownership until that receipt succeeds. A disposal failure is typed local evidence and never changes an already-sent task.complete, task.fail, or task.cancelled.

## Geju Thesis and Falsifier

- Thesis: delete the inherited best-effort process-kill model. At 10x concurrency, direct-child signal plus early lease release admits overlapping writers and orphan tools.
- Non-negotiable: one process-tree owner; one close settlement authority; no ownership release before quiescence; semantic terminal and disposal evidence stay separate.
- Kill list: direct-child-only POSIX signals, fire-and-forget close, swallowed cleanup errors, and TaskRunner.finish() deleting/releasing before disposal.
- Cheapest proof point: each fake runtime spawns a real descendant that survives root-only SIGTERM. Current close resolves while the descendant remains observable (RED); the shared owner makes it GREEN.
- Falsifier: if supported Node spawn/process primitives cannot create and terminate a bounded POSIX process group without breaking the three runtime transports, or Windows taskkill /T /F cannot prove the fixture descendant gone before settlement, stop and use a platform-specific supervised launcher. Never replace this proof with PID mocks.
- [ASSUMED] Supported lifecycle evidence OSes are the existing GitHub-hosted Ubuntu, macOS, and Windows matrix because it is the repository release authority.

## P1: Architecture Map

- Public lifecycle: packages/client/src/types.ts owns Session.interrupt() and Session.close().
- Process owners: Pi rpc-client/pi-adapter, Claude process-client/claude-adapter, Codex process-runner/codex-adapter.
- Current gap: all three use default process groups, signal only the direct POSIX child, use taskkill /T /F on Windows, and return from close without awaiting child close.
- Task ownership: packages/client/src/daemon/task-runner.ts owns terminal publication, active registration, approvals, Git lease, and close.
- Shutdown authority: packages/client/src/daemon/create-daemon.ts already retains daemon ownership when task teardown is an unsettled mutation barrier; Row 3 feeds honest disposal settlement into that flow.
- Observability: TaskRunnerDeps to DaemonObserver to CLI/audit projections is the existing non-wire seam.
- Built evidence: packages/client/scripts/adapter-task-smoke.mjs imports dist and drives a real @byok-sdk/server with all three fake runtime binaries.
- CI authority: .github/workflows/ci.yml owns Ubuntu/macOS/Windows built smoke.
- Out of scope: protocol-v1 changes, provider wire redesign, runtime IDs, sandbox policy, plugin loaders, and the landed control-socket/daemon-owner ordering.

## P2: Concrete Trace and Pressure Point

Current path:
1. A runtime root may spawn Bash/tool descendants.
2. cancel, resource enforcement, or daemon stop reaches teardownActiveTask.
3. interrupt is deadline-raced. close is only attempted on interrupt timeout and is not authoritative.
4. The semantic terminal is sent.
5. finish stops timers, deletes active state, marks finished, resolves approvals, releases Git lease, then awaits close.
6. Bundled close only sends a signal. Claude removes MCP config before proving process exit. Failures are swallowed.
7. A new task can acquire the workspace while the old tree still writes.

Target path:
1. Bundled adapters spawn through one owned-process-tree primitive.
2. interrupt keeps provider semantics and is not ownership settlement.
3. close is idempotent/single-flight, terminates the tree, awaits root stdio close, verifies quiescence, escalates within a deadline, then cleans task resources.
4. Typed RuntimeDisposalFailure distinguishes signal, quiescence, and cleanup.
5. TaskRunner records semantic terminal exactly once, joins one disposal attempt, and retains active/Git ownership until success.
6. Failure emits safe local evidence, keeps ownership fail-closed, and may be retried without another semantic terminal.
7. Daemon shutdown treats rejection/unsettled disposal as its existing mutation barrier.

## P3: Design Decision

### Shared process-tree owner

Add packages/client/src/adapters/process-tree.ts, used by all three bundled adapters.

- POSIX spawn sets detached:true so the root is a new process-group/session leader while stdio remains piped and referenced.
- POSIX dispose validates a positive owned PID, signals the negative group with SIGTERM, awaits root close, verifies group absence, escalates to SIGKILL after grace, and rejects typed if the final deadline cannot prove quiescence.
- Windows dispose runs taskkill /PID pid /T /F, requires success or already-closed root, awaits Node child close, and surfaces command/settlement failure typed. Real fixture PID checks prove descendants on Windows CI.
- Never signal unresolved/zero PIDs or the daemon process group. Spawn failure owns no group.
- Preserve spawnFn injection and pass it the same authoritative spawn options; group semantics are tested with real processes.

### Public disposal contract

Add a distinct RuntimeDisposalFailure public type with closed stage signal, quiescence, or cleanup and an audit-safe reason. It is not RuntimeExecutionFailure and carries no retryability. Session.close documentation becomes idempotent, single-flight, bounded, resolves only after owned resources are quiescent, and rejects typed for expected disposal failure.

Bundled sessions make repeated close calls join one promise, wait for the real tree, end queues consistently, and clean Claude MCP config only after process quiescence. Cleanup failure is surfaced, not swallowed. Pi interrupt remains soft abort; Claude/Codex interrupt may request termination but close remains the receipt.

### TaskRunner ownership and semantic separation

- Add one finalization/disposal state per active task.
- Stop timers, batching, and approvals when semantic finalization starts.
- Record semantic terminal before disposal so races/redelivery cannot duplicate it.
- Keep tasks map entry and gitLease until close succeeds.
- finish, cancel, shutdown, and pump races join the same disposal promise.
- Disposal rejection never enters execution-failure projection and never sends another task.fail.
- Emit runtime-disposal-failed through TaskRunnerDeps to DaemonObserver with task id, runtime id, stage, and safe reason only.
- Retain active/Git ownership after failure. A later shutdown/retry may reattempt close after the failed attempt settles, without replaying terminal.
- shutdownActiveTasks surfaces failed mutation settlement to create-daemon, preserving its daemon-owner lease retention.

### Alternatives rejected

| Alternative | Rejection |
|---|---|
| Only move gitLease.release after current close | Current close resolves immediately after signal. |
| Sleep after direct-child kill | Time is not quiescence evidence. |
| Kill only direct POSIX child | Descendants remain structurally unowned. |
| Reuse RuntimeExecutionFailure or send task.fail | Rewrites or duplicates semantic authority. |
| Release lease in finally | Admits overlap when quiescence is unproven. |
| Swallow Claude MCP cleanup errors | Makes owned resource leakage invisible. |
| Build a generic plugin supervisor | Three subprocess adapters need one focused invariant, not a framework. |

## File and Ownership Plan

- packages/client/src/adapters/process-tree.ts: shared spawn/dispose/quiescence owner.
- packages/client/src/runtime-failure.ts, types.ts, public exports: distinct disposal type and close contract.
- Pi/Claude/Codex process clients and sessions: owned spawn and quiescent close.
- packages/client/src/daemon/task-runner.ts: single-flight finalization, terminal separation, active/Git retention.
- packages/client/src/daemon/create-daemon.ts and observer/CLI audit projections: safe failure evidence and existing mutation-barrier propagation.
- fake runtime fixtures and focused tests: real descendants, escalation, typed cleanup, lease ordering, races.
- packages/client/scripts/adapter-task-smoke.mjs: built real-server normal, rejection, cancellation, and shutdown lifecycle.
- .github/workflows/ci.yml: run lifecycle smoke on existing Ubuntu/macOS/Windows built matrix.
- docs/spec.md, docs/security.md, docs/architecture/sdk-architecture.md, client README/CHANGELOG as required: 0.4.0 truth.

One writer owns all production files because spawn semantics, close, TaskRunner finalization, and shutdown barriers are atomic. Existing unrelated dirty architecture-request projection files in main are preserved and excluded.

## Test and Verification Design

- Capture pre-fix RED with real root and descendant PID evidence.
- Shared owner: both PIDs absent before resolve; idempotent join; POSIX SIGKILL escalation; safe invalid PID; typed Windows taskkill failure.
- Adapters: all three close only after root and descendant absence; normal, resume, and event tests remain green.
- TaskRunner: deferred close keeps active count and Git lease busy; reacquire fails until success; rejection emits one disposal event, retains ownership, and cannot add or rewrite terminal; cancel, complete, fail, and stop races join; clean retry releases without a second terminal.
- Daemon: failed or unsettled task disposal retains daemon-owner lease and stop rejects; clean retry releases in existing control-socket order.
- Built smoke: all three complete; missing Pi launcher declines; hanging child and descendant cancellation and daemon stop prove quiescence.
- Multi-OS: identical built smoke on Ubuntu, macOS, and Windows; platform branches are real, not mocked.
- Static guards: no direct-child-only production SIGTERM remains in adapters; no Git lease release before close success; disposal never enters projectRuntimeBoundaryFailure.
- Commands: targeted falsifier; client typecheck, test, build, and smoke; workspace typecheck, test, and build; strict contract, workflow, and sprint verification; one exact-SHA semantic review after code freeze.

## Rollout and Rollback

- Rows 1 and 2 and shutdown-lease-order are landed on main and are the base.
- One 0.4.0 merge unit; no compatibility path keeps fire-and-forget close.
- Rollback the whole Row 3 commit. Never keep detached process groups without group disposal or ownership retention without failure evidence.
- First 10x pressure is concurrent workspace reuse, so quiescence and lease order outrank broader supervisor features.

## Approval Boundary

The user approved the Sprint and 0.4.0 breaking cut. Row 3 implementation and one exact-SHA review are authorized. Publication and unrelated cleanup are not.

## Task Breakdown

- [x] Capture real child-plus-descendant pre-fix RED evidence on the landed Row 2 base.
- [x] Add the typed disposal contract and shared cross-platform process-tree primitive.
- [x] Migrate Pi, Claude, and Codex to quiescent idempotent close.
- [x] Refactor TaskRunner finalization for exactly-once semantic terminal and active/Git retention.
- [x] Wire disposal evidence and shutdown mutation-barrier propagation.
- [x] Add descendant, escalation, cleanup, terminal-separation, retry, and lease-order tests.
- [x] Extend built smoke and multi-OS CI lifecycle evidence.
- [x] Update spec, security, architecture, and release docs.
- [ ] Freeze, verify once, obtain exact-SHA semantic review, and close the Sprint row.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Capture real child-plus-descendant pre-fix RED evidence on the landed Row 2 base.
- [x] Add the typed disposal contract and shared cross-platform process-tree primitive.
- [x] Migrate Pi, Claude, and Codex to quiescent idempotent close.
- [x] Refactor TaskRunner finalization for exactly-once semantic terminal and active/Git retention.
- [x] Wire disposal evidence and shutdown mutation-barrier propagation.
- [x] Add descendant, escalation, cleanup, terminal-separation, retry, and lease-order tests.
- [x] Extend built smoke and multi-OS CI lifecycle evidence.
- [x] Update spec, security, architecture, and release docs.
- [ ] Freeze, verify once, obtain exact-SHA semantic review, and close the Sprint row.
