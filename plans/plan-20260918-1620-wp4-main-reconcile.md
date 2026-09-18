# Plan: WP4 reconcile main (stage 3) - custody five-edge lane

> **Status**: Executing
> **Created**: 20260918-1620
> **Slug**: wp4-main-reconcile
> **Planning Source**: codex-plan-or-waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260918-1620-wp4-main-reconcile.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20260918-1620-wp4-main-reconcile.md`; after execution revert branch `codex/wp4-main-reconcile` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260918-1620-wp4-main-reconcile.contract.md`
> **Task Review**: `tasks/reviews/20260918-1620-wp4-main-reconcile.review.md`
> **Implementation Notes**: `tasks/notes/20260918-1620-wp4-main-reconcile.notes.md`

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

- Active plan: `plans/plan-20260918-1620-wp4-main-reconcile.md`
- Sprint contract: `tasks/contracts/20260918-1620-wp4-main-reconcile.contract.md`
- Sprint review: `tasks/reviews/20260918-1620-wp4-main-reconcile.review.md`
- Implementation notes: `tasks/notes/20260918-1620-wp4-main-reconcile.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260918-1620-wp4-main-reconcile.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260918-1620-wp4-main-reconcile.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260918-1620-wp4-main-reconcile.md`.

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
- Contract file: `tasks/contracts/20260918-1620-wp4-main-reconcile.contract.md`
- Review file: `tasks/reviews/20260918-1620-wp4-main-reconcile.review.md`
- Implementation notes file: `tasks/notes/20260918-1620-wp4-main-reconcile.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260918-1620-wp4-main-reconcile.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260918-1620-wp4-main-reconcile.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260918-1620-wp4-main-reconcile.md`; after execution revert branch `codex/wp4-main-reconcile` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260918-1620-wp4-main-reconcile.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260918-1620-wp4-main-reconcile.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260918-1620-wp4-main-reconcile.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260918-1620-wp4-main-reconcile.contract.md`, `tasks/reviews/20260918-1620-wp4-main-reconcile.review.md`, and `tasks/notes/20260918-1620-wp4-main-reconcile.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260918-1620-wp4-main-reconcile.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260918-1620-wp4-main-reconcile.md`; after execution revert branch `codex/wp4-main-reconcile` or the explicitly reviewed diff.

## Captured Planning Output

# Plan: WP4 reconcile main (stage 3)

## Why

Owner 批准的三段合流收尾（#193 已合 = d882aef4；WP1 已合 = PR #198 → main 49ec7477，两 Windows face 消除 receipt 在案）。WP4（claude/wp3-custody-wiring @ 420d1306，含 4de4dcb0 五边启用 + 67afe3b3 测试 + e0f27c74 trio + 420d1306 CI 收据）是 custody 派发面 lane。merge-tree 预检：与 post-198 main 仅 tasks/todos.md 冲突；custody 面全部 auto-merge。

## Task Breakdown

- [x] fast-worker：在 wp4-main-reconcile 分支 merge origin/main（49ec7477），todos.md ledger 合并（保两侧行、去重复行）；全矩阵验证绿（K1 本地 tripwire 已知项除外）
- [ ] strict + gatekeeper PASS
- [ ] orchestrator push `wp4-main-reconcile -> claude/wp3-custody-wiring` + CI watcher（前向验收 = 全矩阵绿——已知红面已全部消除）
- [ ] 回报（WP4 合入 main / PR 开关仍 Owner-gated）

## Non-Goals

不改产品语义；不动 custody 冻结设计 D1–D7；不处理 N1 external-CLI lane（Owner 裁决项，todos 在案）。

## Stop rules

todos.md 出现真实行为分叉（非 ledger 行合并）→ STOP 上报；typecheck/build 3 轮不过 → BLOCKED 带最小失败证据；custody 测试红且根因在 merge 交互 → BLOCKED 上报。

## Rollback

`git reset --hard 420d1306`。

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] fast-worker：在 wp4-main-reconcile 分支 merge origin/main（49ec7477），todos.md ledger 合并（保两侧行、去重复行）；全矩阵验证绿（K1 本地 tripwire 已知项除外）
- [ ] strict + gatekeeper PASS
- [ ] orchestrator push `wp4-main-reconcile -> claude/wp3-custody-wiring` + CI watcher（前向验收 = 全矩阵绿——已知红面已全部消除）
- [ ] 回报（WP4 合入 main / PR 开关仍 Owner-gated）
