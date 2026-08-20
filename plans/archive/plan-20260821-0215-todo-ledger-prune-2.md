# Plan: Todo Ledger Prune Batch 2

> **Status**: Archived
> **Created**: 20260821-0215
> **Slug**: todo-ledger-prune-2
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: User explicitly requested the next Todo cleanup batch
> **Verification Boundary**: Three-row ledger deletion with research-preservation and workflow checks
> **Rollback Surface**: Restore three Markdown table rows only
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260821-0215-todo-ledger-prune-2.contract.md`
> **Task Review**: `tasks/reviews/20260821-0215-todo-ledger-prune-2.review.md`
> **Implementation Notes**: `tasks/notes/20260821-0215-todo-ledger-prune-2.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260821-0215-todo-ledger-prune-2.md`
- Sprint contract: `tasks/contracts/20260821-0215-todo-ledger-prune-2.contract.md`
- Sprint review: `tasks/reviews/20260821-0215-todo-ledger-prune-2.review.md`
- Implementation notes: `tasks/notes/20260821-0215-todo-ledger-prune-2.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260821-0215-todo-ledger-prune-2.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260821-0215-todo-ledger-prune-2.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260821-0215-todo-ledger-prune-2.md`.

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
- Contract file: `tasks/contracts/20260821-0215-todo-ledger-prune-2.contract.md`
- Review file: `tasks/reviews/20260821-0215-todo-ledger-prune-2.review.md`
- Implementation notes file: `tasks/notes/20260821-0215-todo-ledger-prune-2.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260821-0215-todo-ledger-prune-2.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260821-0215-todo-ledger-prune-2.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Restore three Markdown table rows only
- **Verification boundary**: Three-row ledger deletion with research-preservation and workflow checks
- **Review/acceptance boundary**: `tasks/reviews/20260821-0215-todo-ledger-prune-2.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: User explicitly requested the next Todo cleanup batch

## Evidence Contract

- **State/progress path**: `plans/plan-20260821-0215-todo-ledger-prune-2.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260821-0215-todo-ledger-prune-2.contract.md`, `tasks/reviews/20260821-0215-todo-ledger-prune-2.review.md`, and `tasks/notes/20260821-0215-todo-ledger-prune-2.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260821-0215-todo-ledger-prune-2.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Restore three Markdown table rows only

## Captured Planning Output

## Goal

Remove only deferred rows that are solution-shaped imports from external research rather than current BYOK SDK commitments, while preserving every row backed by an observed product, security, protocol, or operational gap.

## Decision

Delete exactly these three rows from `tasks/todos.md`:

1. Scheduled dispatch inspired by Hermes cron.
2. Device assertion capability-conditions grammar inspired by Buzz NIP-OA.
3. Session-level single-flight scheduling inspired by Buzz EventQueue.

All three explicitly lack a current downstream consumer or triggering runtime shape. Their reusable design evidence remains in `docs/researches/2026-08-12_hermes-buzz-extraction-assessment.md`, so removing them from the deferred-goal ledger does not erase research. Do not remove or rewrite the remaining eleven rows.

## P1 Architecture Map

- Authority: `tasks/todos.md` is the deferred-goal ledger.
- Research source: `docs/researches/2026-08-12_hermes-buzz-extraction-assessment.md`.
- Derived state: `tasks/current.md` and harness handoff/resume projections.
- Out of scope: product code, protocol schemas, releases, deployments, other worktrees, and the other eleven deferred rows.

## P2 Concrete Trace

For each candidate, trace the row's stated trigger to current code and consumers. A row is removable only when no trigger exists and the row is merely an imported implementation pattern; live gaps remain in the ledger.

## P3 Decision Rationale

The ledger should record intended work, not every pattern that might become useful someday. Retaining research in its canonical assessment preserves future recall without implying product commitment. The smallest coherent change is a three-row deletion plus workflow evidence; no product behavior changes.

## Workflow Inventory

- Active plan: this captured plan.
- Contract: matching file under `tasks/contracts/`.
- Review: matching file under `tasks/reviews/`.
- Notes: matching file under `tasks/notes/`.
- Deferred ledger: `tasks/todos.md`.
- Checks: `.ai/harness/checks/latest.json` and `.ai/harness/runs/`.
- Allowed-path owner: this contract; scope is workflow/docs only.
- Isolation: current main worktree, no product-code writes and no branch/push/release action.

## Task Breakdown

- [x] Audit all current deferred rows against current code, tests, research, and trigger conditions.
- [x] Remove exactly the three imported, untriggered solution-pattern rows.
- [x] Verify the remaining ledger contains eleven evidence-backed deferred goals.
- [x] Run `git diff --check` and `repo-harness run check-task-workflow --strict`.
- [x] Record review/notes and archive the completed workflow.

## Verification

- `rg` confirms the three removed titles are absent from `tasks/todos.md` and remain present in the research assessment.
- `git diff --check` passes.
- `repo-harness run check-task-workflow --strict` passes.
- Architecture queue has no unresolved blocking request at closeout.

## Rollback

Restore the three table rows from this plan or the research assessment; no code, schema, registry, deployment, or user data is affected.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Audit all current deferred rows against current code, tests, research, and trigger conditions.
- [x] Remove exactly the three imported, untriggered solution-pattern rows.
- [x] Verify the remaining ledger contains eleven evidence-backed deferred goals.
- [x] Run `git diff --check` and `repo-harness run check-task-workflow --strict`.
- [x] Record review/notes and archive the completed workflow.
