# Plan: Pi context usage public observation gap

> **Status**: Executing
> **Created**: 20261001-0132
> **Slug**: context-usage-gap
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: 用户派发独立观测设计与文档commit
> **Verification Boundary**: static source trace + workflow strict + Claude document review
> **Rollback Surface**: 仅新研究和任务文档
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20261001-0132-context-usage-gap.contract.md`
> **Task Review**: `tasks/reviews/20261001-0132-context-usage-gap.review.md`
> **Implementation Notes**: `tasks/notes/20261001-0132-context-usage-gap.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20261001-0132-context-usage-gap.md`
- Sprint contract: `tasks/contracts/20261001-0132-context-usage-gap.contract.md`
- Sprint review: `tasks/reviews/20261001-0132-context-usage-gap.review.md`
- Implementation notes: `tasks/notes/20261001-0132-context-usage-gap.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20261001-0132-context-usage-gap.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20261001-0132-context-usage-gap.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20261001-0132-context-usage-gap.md`.

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
- Contract file: `tasks/contracts/20261001-0132-context-usage-gap.contract.md`
- Review file: `tasks/reviews/20261001-0132-context-usage-gap.review.md`
- Implementation notes file: `tasks/notes/20261001-0132-context-usage-gap.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20261001-0132-context-usage-gap.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20261001-0132-context-usage-gap.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: 仅新研究和任务文档
- **Verification boundary**: static source trace + workflow strict + Claude document review
- **Review/acceptance boundary**: `tasks/reviews/20261001-0132-context-usage-gap.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: 用户派发独立观测设计与文档commit

## Evidence Contract

- **State/progress path**: `plans/plan-20261001-0132-context-usage-gap.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20261001-0132-context-usage-gap.contract.md`, `tasks/reviews/20261001-0132-context-usage-gap.review.md`, and `tasks/notes/20261001-0132-context-usage-gap.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20261001-0132-context-usage-gap.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: 仅新研究和任务文档

## Captured Planning Output

## Brief
只读核对 main12ca4402 的 Pi usage 到公开 Host 读回。只写研究及任务文档，commit授权，不push/PR。主 checkout仅已授权ff-only pull，旧worktree不动。
## Scope
Safe path /Users/chris/Projects/byok-sdk-context-usage，branch codex/context-usage-gap。无SDK/API/wire/Pi/provider/plugin/index修改。architecture/daemon gate停报。
## P1/P2/P3
Host自有UI分类；Pi native usage→AgentEvent→lastUsage→terminal→tasks.deviceTerminal。仅来源明确的last-observed/initial/peak展示；当前余量不可冒充观测，missing=unknown，estimate不入admission。
## Task Breakdown
- [x] 独立worktree与真实source trace。
- [x] 写字段来源三类映射与Host消费例。
- [x] source locators/diff/workflow strict，声明未跑代码checks。
- [x] 五份文档范围核对，按授权commit并交Claude文档验收；不push/PR。
- [ ] Claude独立文档验收（外部）。

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->
