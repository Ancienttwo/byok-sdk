# Plan: Domain model and authority ADR ledger (WP2)

> **Status**: Draft
> **Created**: 20260903-0442
> **Slug**: domain-model-adr
> **Artifact Level**: work-package
> **Promotion Reason**:
> **Verification Boundary**:
> **Rollback Surface**:
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260903-0442-domain-model-adr.contract.md`
> **Task Review**: `tasks/reviews/20260903-0442-domain-model-adr.review.md`
> **Implementation Notes**: `tasks/notes/20260903-0442-domain-model-adr.notes.md`

## Agentic Routing
- Selected route:
- Routing reason:
- Due diligence:
  - P1 map:
  - P2 trace:
  - P3 decision rationale:

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260903-0442-domain-model-adr.md`
- Sprint contract: `tasks/contracts/20260903-0442-domain-model-adr.contract.md`
- Sprint review: `tasks/reviews/20260903-0442-domain-model-adr.review.md`
- Implementation notes: `tasks/notes/20260903-0442-domain-model-adr.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260903-0442-domain-model-adr.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260903-0442-domain-model-adr.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260903-0442-domain-model-adr.md`.

## Approach
### Strategy
### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|

### Code Snippets
### Data Flow

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|

## Task Contracts
- Contract file: `tasks/contracts/20260903-0442-domain-model-adr.contract.md`
- Review file: `tasks/reviews/20260903-0442-domain-model-adr.review.md`
- Implementation notes file: `tasks/notes/20260903-0442-domain-model-adr.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260903-0442-domain-model-adr.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**:
- **Rollback surface**:
- **Verification boundary**:
- **Review/acceptance boundary**:
- **High-risk surface**:
- **Why not checklist row**:

## Evidence Contract

- **State/progress path**:
- **Verification evidence**:
- **Evaluator rubric**:
- **Stop condition**:
- **Rollback surface**:

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] ...
