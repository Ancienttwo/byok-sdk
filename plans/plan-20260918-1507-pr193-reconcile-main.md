# Plan: PR193 reconcile main (stage 1) + CI disposition + test-only flake hardening

> **Status**: Executing
> **Created**: 20260918-1507
> **Slug**: pr193-reconcile-main
> **Planning Source**: codex-plan-or-waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260918-1507-pr193-reconcile-main.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20260918-1507-pr193-reconcile-main.md`; after execution revert branch `codex/pr193-reconcile-main` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260918-1507-pr193-reconcile-main.contract.md`
> **Task Review**: `tasks/reviews/20260918-1507-pr193-reconcile-main.review.md`
> **Implementation Notes**: `tasks/notes/20260918-1507-pr193-reconcile-main.notes.md`

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

- Active plan: `plans/plan-20260918-1507-pr193-reconcile-main.md`
- Sprint contract: `tasks/contracts/20260918-1507-pr193-reconcile-main.contract.md`
- Sprint review: `tasks/reviews/20260918-1507-pr193-reconcile-main.review.md`
- Implementation notes: `tasks/notes/20260918-1507-pr193-reconcile-main.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260918-1507-pr193-reconcile-main.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260918-1507-pr193-reconcile-main.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260918-1507-pr193-reconcile-main.md`.

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
- Contract file: `tasks/contracts/20260918-1507-pr193-reconcile-main.contract.md`
- Review file: `tasks/reviews/20260918-1507-pr193-reconcile-main.review.md`
- Implementation notes file: `tasks/notes/20260918-1507-pr193-reconcile-main.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260918-1507-pr193-reconcile-main.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260918-1507-pr193-reconcile-main.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260918-1507-pr193-reconcile-main.md`; after execution revert branch `codex/pr193-reconcile-main` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260918-1507-pr193-reconcile-main.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260918-1507-pr193-reconcile-main.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260918-1507-pr193-reconcile-main.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260918-1507-pr193-reconcile-main.contract.md`, `tasks/reviews/20260918-1507-pr193-reconcile-main.review.md`, and `tasks/notes/20260918-1507-pr193-reconcile-main.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260918-1507-pr193-reconcile-main.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260918-1507-pr193-reconcile-main.md`; after execution revert branch `codex/pr193-reconcile-main` or the explicitly reviewed diff.

## Captured Planning Output

# Plan: pr193-reconcile-main (stage 1 of the approved three-stage merge order)

> **Status**: Executing
> **Created**: 20260918-1307
> **Slug**: pr193-reconcile-main
> **Planning Source**: fable-main-loop
> **Orchestration Kind**: host-plan
> **Source Ref**: Owner approval 2026-09-18 ("批准" on the #193 merge assessment)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: `repo-harness run verify-contract --contract tasks/contracts/20260918-1307-pr193-reconcile-main.contract.md --strict`.
> **Rollback Surface**: reset branch to d4dcf961.
> **Spec**: `docs/spec.md`
> **Task Contract**: `tasks/contracts/20260918-1307-pr193-reconcile-main.contract.md`
> **Task Review**: `tasks/reviews/20260918-1307-pr193-reconcile-main.review.md`
> **Implementation Notes**: `tasks/notes/20260918-1307-pr193-reconcile-main.notes.md`

## Why
PR #193 CONFLICTING vs main (8 files, c07 overlap where main holds the #185–#190 accepted evolution). Owner approved stage 1: in-branch reconciliation, house merge style.

## Task Breakdown
- [x] deep-worker 完成：merge commit 0a3202f3（8 文件按裁决 + 6 interlock + notes 落账，全矩阵绿除 K1/K2 已知项）
- [x] strict 12 检查 10 绿（K1 本地 tripwire、K2 继承 whitespace，均已定性）
- [x] gatekeeper PASS（B1–B7；N1/N2 非阻塞）
- [x] orchestrator push `pr193-reconcile -> codex/c07-pi-runtime-launch` + CI watcher（0a3202f3 + 145dbb97；CI 判定见 review 收据）
- [x] test-only flake hardening：input-preparation.test.ts 三处固定 sleep（450/150/450ms，fake-clock GC timer 余量 ~50ms）改 vi.waitFor 轮询；本地验证后随收据 commit push（已向 Owner 预告）
- [x] 回报

## Non-Goals
WP1/WP4 合流（stage 2/3）、CI/workflow 改动、mark ready、merge PR、任何 compatibility shim。

## Stop rules
见契约 Stop Conditions；BLOCKED 只带最小反例回报，不静默取舍。

## Rollback
`git reset --hard d4dcf961`（worktree /Users/kito/Projects/byok-sdk-wt-pr193-reconcile）。

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] deep-worker 完成：merge commit 0a3202f3（8 文件按裁决 + 6 interlock + notes 落账，全矩阵绿除 K1/K2 已知项）
- [x] strict 12 检查 10 绿（K1 本地 tripwire、K2 继承 whitespace，均已定性）
- [x] gatekeeper PASS（B1–B7；N1/N2 非阻塞）
- [x] orchestrator push `pr193-reconcile -> codex/c07-pi-runtime-launch` + CI watcher（0a3202f3 + 145dbb97；CI 判定见 review 收据）
- [x] test-only flake hardening：input-preparation.test.ts 三处固定 sleep（450/150/450ms，fake-clock GC timer 余量 ~50ms）改 vi.waitFor 轮询；本地验证后随收据 commit push（已向 Owner 预告）
- [x] 回报
