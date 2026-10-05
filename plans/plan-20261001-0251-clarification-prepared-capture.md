# Plan: Clarification fresh preparation offline capture

> **Status**: Executing
> **Created**: 20261001-0251
> **Slug**: clarification-prepared-capture
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: 用户授权clarification9.6测试与commit，监工确认两个client测试资产例外
> **Verification Boundary**: offline byte capture; no production admission or provider verification
> **Rollback Surface**: only two new client test assets and five documents
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20261001-0251-clarification-prepared-capture.contract.md`
> **Task Review**: `tasks/reviews/20261001-0251-clarification-prepared-capture.review.md`
> **Implementation Notes**: `tasks/notes/20261001-0251-clarification-prepared-capture.notes.md`

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

- Active plan: `plans/plan-20261001-0251-clarification-prepared-capture.md`
- Sprint contract: `tasks/contracts/20261001-0251-clarification-prepared-capture.contract.md`
- Sprint review: `tasks/reviews/20261001-0251-clarification-prepared-capture.review.md`
- Implementation notes: `tasks/notes/20261001-0251-clarification-prepared-capture.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20261001-0251-clarification-prepared-capture.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20261001-0251-clarification-prepared-capture.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20261001-0251-clarification-prepared-capture.md`.

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
- Contract file: `tasks/contracts/20261001-0251-clarification-prepared-capture.contract.md`
- Review file: `tasks/reviews/20261001-0251-clarification-prepared-capture.review.md`
- Implementation notes file: `tasks/notes/20261001-0251-clarification-prepared-capture.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20261001-0251-clarification-prepared-capture.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20261001-0251-clarification-prepared-capture.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: only two new client test assets and five documents
- **Verification boundary**: offline byte capture; no production admission or provider verification
- **Review/acceptance boundary**: `tasks/reviews/20261001-0251-clarification-prepared-capture.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: 用户授权clarification9.6测试与commit，监工确认两个client测试资产例外

## Evidence Contract

- **State/progress path**: `plans/plan-20261001-0251-clarification-prepared-capture.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20261001-0251-clarification-prepared-capture.contract.md`, `tasks/reviews/20261001-0251-clarification-prepared-capture.review.md`, and `tasks/notes/20261001-0251-clarification-prepared-capture.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20261001-0251-clarification-prepared-capture.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: only two new client test assets and five documents

## Captured Planning Output

## Brief
main708ed45b。只新增两个获准client测试资产及研究/plan/contract/notes/review；生产源码/API/wire/Pi/package/lock不改。新worktree codex/clarification-prepared-capture。
## P1/P2/P3
真实preparation service/持久化receipt/native compiler→两个不同source/message→真实Pi launcher→loopback HTTP capture。counter=test_fixture必然ready=false；只证明native first-request bytes闭合，不伪装production admission。
## Task Breakdown
- [x] 独立worktree/source trace，监工确认两个测试路径例外。
- [x] 新两个测试资产：不同receipt/source/D，自身首请求byte equality与旧receipt重放负控。
- [x] focused/typecheck/build/root/API/version/workflow与非rootLinux离线测试。
- [x] 短结论文档、授权commit；架构/daemon gate停报、不push/PR。

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->


## External acceptance
- [ ] Claude独立复跑及验收（当前pending）。
