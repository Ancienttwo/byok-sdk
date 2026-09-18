# Plan: WP1 reconcile main (stage 2) - Windows CI elimination lane

> **Status**: Executing
> **Created**: 20260918-1526
> **Slug**: wp1-main-reconcile
> **Planning Source**: codex-plan-or-waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260918-1526-wp1-main-reconcile.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20260918-1526-wp1-main-reconcile.md`; after execution revert branch `codex/wp1-main-reconcile` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260918-1526-wp1-main-reconcile.contract.md`
> **Task Review**: `tasks/reviews/20260918-1526-wp1-main-reconcile.review.md`
> **Implementation Notes**: `tasks/notes/20260918-1526-wp1-main-reconcile.notes.md`

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

- Active plan: `plans/plan-20260918-1526-wp1-main-reconcile.md`
- Sprint contract: `tasks/contracts/20260918-1526-wp1-main-reconcile.contract.md`
- Sprint review: `tasks/reviews/20260918-1526-wp1-main-reconcile.review.md`
- Implementation notes: `tasks/notes/20260918-1526-wp1-main-reconcile.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260918-1526-wp1-main-reconcile.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260918-1526-wp1-main-reconcile.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260918-1526-wp1-main-reconcile.md`.

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
- Contract file: `tasks/contracts/20260918-1526-wp1-main-reconcile.contract.md`
- Review file: `tasks/reviews/20260918-1526-wp1-main-reconcile.review.md`
- Implementation notes file: `tasks/notes/20260918-1526-wp1-main-reconcile.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260918-1526-wp1-main-reconcile.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260918-1526-wp1-main-reconcile.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260918-1526-wp1-main-reconcile.md`; after execution revert branch `codex/wp1-main-reconcile` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260918-1526-wp1-main-reconcile.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260918-1526-wp1-main-reconcile.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260918-1526-wp1-main-reconcile.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260918-1526-wp1-main-reconcile.contract.md`, `tasks/reviews/20260918-1526-wp1-main-reconcile.review.md`, and `tasks/notes/20260918-1526-wp1-main-reconcile.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260918-1526-wp1-main-reconcile.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260918-1526-wp1-main-reconcile.md`; after execution revert branch `codex/wp1-main-reconcile` or the explicitly reviewed diff.

## Captured Planning Output

# Plan: WP1 reconcile main (stage 2)

## Why

Owner 批准的三段合流顺序第二步。#193 已合入 main（d882aef4，2026-09-18）。WP1（claude/wp1-windows-ci-on-193 @ 9cc3b7cd，base d4dcf961 + 17 commits）是 #193 线上的 Windows CI 消除 lane：修复两 Windows face（lifecycle smoke 的 cwd admission + npm pack/install 的 implementation-identity entry 解析）。merge-tree 预检（b29d1dbb1a）：与 post-193 main 仅 tasks/todos.md 冲突；pi-launcher-smoke.mjs 自动合并——stage 1 reconcile 已取 #193 mcpEnv + main shape，WP1 的 observer/file-URL/ProgramFiles 修复干净叠加。

## Task Breakdown

- [x] fast-worker：在 wp1-main-reconcile 分支 merge origin/main（d882aef4），todos.md ledger 合并（保两侧行、去重复行）；全矩阵验证绿（K1 本地 tripwire 已知项除外）
- [ ] strict + gatekeeper PASS
- [ ] orchestrator push `wp1-main-reconcile -> claude/wp1-windows-ci-on-193` + CI watcher（前向验收 = 两 Windows job 转绿）
- [ ] 回报（WP1 合入 main / PR 开关仍 Owner-gated）

## Non-Goals

不改产品语义；不重排 WP1 修复内容；WP4（custody 面）不在本刀。

## Stop rules

todos.md 出现真实行为分叉（非 ledger 行合并）→ STOP 上报；typecheck/build 3 轮不过 → BLOCKED 带最小失败证据。

## Rollback

`git reset --hard 9cc3b7cd`。

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] fast-worker：在 wp1-main-reconcile 分支 merge origin/main（d882aef4），todos.md ledger 合并（保两侧行、去重复行）；全矩阵验证绿（K1 本地 tripwire 已知项除外）
- [ ] strict + gatekeeper PASS
- [ ] orchestrator push `wp1-main-reconcile -> claude/wp1-windows-ci-on-193` + CI watcher（前向验收 = 两 Windows job 转绿）
- [ ] 回报（WP1 合入 main / PR 开关仍 Owner-gated）
