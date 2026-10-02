# Plan: T1 TaskRunner 取消路径测试与修复

> **Status**: Approved
> **Created**: 20261002-1356
> **Slug**: taskrunner-cancel
> **Planning Source**: codex-plan-or-waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20261002-1356-taskrunner-cancel.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20261002-1356-taskrunner-cancel.md`; after execution revert branch `codex/taskrunner-cancel` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20261002-1356-taskrunner-cancel.contract.md`
> **Task Review**: `tasks/reviews/20261002-1356-taskrunner-cancel.review.md`
> **Implementation Notes**: `tasks/notes/20261002-1356-taskrunner-cancel.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan-or-waza-think planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20261002-1356-taskrunner-cancel.md`
- Sprint contract: `tasks/contracts/20261002-1356-taskrunner-cancel.contract.md`
- Sprint review: `tasks/reviews/20261002-1356-taskrunner-cancel.review.md`
- Implementation notes: `tasks/notes/20261002-1356-taskrunner-cancel.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20261002-1356-taskrunner-cancel.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20261002-1356-taskrunner-cancel.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20261002-1356-taskrunner-cancel.md`.

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
- Contract file: `tasks/contracts/20261002-1356-taskrunner-cancel.contract.md`
- Review file: `tasks/reviews/20261002-1356-taskrunner-cancel.review.md`
- Implementation notes file: `tasks/notes/20261002-1356-taskrunner-cancel.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20261002-1356-taskrunner-cancel.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20261002-1356-taskrunner-cancel.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20261002-1356-taskrunner-cancel.md`; after execution revert branch `codex/taskrunner-cancel` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20261002-1356-taskrunner-cancel.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20261002-1356-taskrunner-cancel.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20261002-1356-taskrunner-cancel.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20261002-1356-taskrunner-cancel.contract.md`, `tasks/reviews/20261002-1356-taskrunner-cancel.review.md`, and `tasks/notes/20261002-1356-taskrunner-cancel.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20261002-1356-taskrunner-cancel.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20261002-1356-taskrunner-cancel.md`; after execution revert branch `codex/taskrunner-cancel` or the explicitly reviewed diff.

## Captured Planning Output

# T1 TaskRunner cancellation

用户已明确授权执行 `/tmp/byok-t1-taskrunner-cancel.md`。
仅当前 worktree `byok-sdk-wt-taskrunner-cancel` / `codex/taskrunner-cancel`。
只本地 commit，不 push/PR/merge。禁区文件以该任务文件为准。

## P1
TaskRunner owns offer admission, cancellation reservation, terminal publication and runtime disposal.
Bundled claude/codex/pi adapters own native protocols and process-tree close receipts.
Keep existing SDK umbrella capability; no architectural model repartition is needed.

## P2
task.offer → admission → task.claim → startOwnedRuntime → active task/pump → task.cancel or shutdown/maxDurationMs → reservation → bounded interrupt → native final usage → terminal → close receipt.
Proven gap: pump exits after reservation before native interrupt usage is consumed (three failing regression cases).

## P3
Preserve single semantic terminal and authoritative close receipts. Drain only usage under the existing interrupt deadline, reuse the same close attempt, avoid awaiting a pump from its own resource-limit teardown.
At 10x concurrency native process trees/startup ownership are the limiting resource.

## Task Breakdown
- [x] Cover queued/pre-claim/startup/stream/tool/repeated terminal cancellation with 55 new cases.
- [x] Commit proven cancellation fixes locally with strict assertions and unchanged deadlines.
- [ ] Close the remaining full-suite Codex tool-stage usage mismatch (456/29 expected, 123/17 observed).
- [x] Run Required Checks; final workspace test fails one case, acceptance remains blocked.
- [x] Write `/tmp/byok-t1-taskrunner-cancel-report.md` with state machine, evidence and `RESULT: BLOCKED`.

## Verification Plan
Run focused Vitest cancellation suites first, then root Required Checks. Do not relax assertions, skip tests or increase existing timeouts. Report baseline/tooling failures separately; BLOCKED if owner decision or forbidden-file changes become necessary.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Cover queued/pre-claim/startup/stream/tool/repeated terminal cancellation with 55 new cases.
- [x] Commit proven cancellation fixes locally with strict assertions and unchanged deadlines.
- [ ] Close the remaining full-suite Codex tool-stage usage mismatch (456/29 expected, 123/17 observed).
- [x] Run Required Checks; final workspace test fails one case, acceptance remains blocked.
- [x] Write `/tmp/byok-t1-taskrunner-cancel-report.md` with state machine, evidence and `RESULT: BLOCKED`.

## Execution Outcome

Acceptance is BLOCKED. Final source head: `f58e951f`; all changes remain local.
Added cancellation suites pass 55/55 independently. Build, workspace typecheck, API golden, version authority and strict workflow checks pass. Final root workspace test fails one Codex tool-stage usage case; it returns 123/17 rather than 456/29. The distinction between deadline fallback and dropped native observation is not yet proven. Keep the guard and deadlines unchanged.

Evidence/state machine: `/tmp/byok-t1-taskrunner-cancel-report.md`.
Failing command: `BYOK_REQUIRE_BUN=1 BYOK_TEST_BUN_BIN=/Users/chris/.bun/bin/bun bun run test`.
Failing log: `/tmp/byok-t1-workspace-test-final-current.log`.
No push, PR, merge, Draft-to-ready transition, branch/worktree deletion was performed.

## PM-authorized continuation

PM authorized the next slice: distinguish product loss from fixture scheduling
by recording interrupt ACK, native usage/result, deadline and disposal order.
Fix production minimally if proven; otherwise determinize the fixture using
fake timers or explicit synchronization. Preserve assertions, skip policy and
all timeout values. Only local commits are authorized.

### Task Breakdown
- [ ] Capture a counterexample with native-frame/deadline/disposal timing evidence.
- [ ] Classify the cause and apply the smallest proven fix.
- [ ] Pass the full workspace test twice consecutively, then workspace typecheck.
- [ ] Update `/tmp/byok-t1-taskrunner-cancel-report.md` and its RESULT line.

Acceptance command: `BYOK_REQUIRE_BUN=1 BYOK_TEST_BUN_BIN=/Users/chris/.bun/bin/bun bun run test`, twice consecutively. Recheck root build/API/version/workflow gates if affected. No push, PR, merge, ready transition or deletion.
