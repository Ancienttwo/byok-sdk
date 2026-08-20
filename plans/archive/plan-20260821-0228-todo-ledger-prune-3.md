# Plan: Todo Ledger Prune Batch 3

> **Status**: Archived
> **Created**: 20260821-0228
> **Slug**: todo-ledger-prune-3
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: User explicitly requested continued Todo cleanup after the prior verified batch
> **Verification Boundary**: Four-row ledger deletion with trigger evidence, preserved research, and strict workflow verification
> **Rollback Surface**: Restore four Markdown table rows only
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260821-0228-todo-ledger-prune-3.contract.md`
> **Task Review**: `tasks/reviews/20260821-0228-todo-ledger-prune-3.review.md`
> **Implementation Notes**: `tasks/notes/20260821-0228-todo-ledger-prune-3.notes.md`

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

- Active plan: `plans/plan-20260821-0228-todo-ledger-prune-3.md`
- Sprint contract: `tasks/contracts/20260821-0228-todo-ledger-prune-3.contract.md`
- Sprint review: `tasks/reviews/20260821-0228-todo-ledger-prune-3.review.md`
- Implementation notes: `tasks/notes/20260821-0228-todo-ledger-prune-3.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260821-0228-todo-ledger-prune-3.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260821-0228-todo-ledger-prune-3.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260821-0228-todo-ledger-prune-3.md`.

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
- Contract file: `tasks/contracts/20260821-0228-todo-ledger-prune-3.contract.md`
- Review file: `tasks/reviews/20260821-0228-todo-ledger-prune-3.review.md`
- Implementation notes file: `tasks/notes/20260821-0228-todo-ledger-prune-3.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260821-0228-todo-ledger-prune-3.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260821-0228-todo-ledger-prune-3.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Restore four Markdown table rows only
- **Verification boundary**: Four-row ledger deletion with trigger evidence, preserved research, and strict workflow verification
- **Review/acceptance boundary**: `tasks/reviews/20260821-0228-todo-ledger-prune-3.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: User explicitly requested continued Todo cleanup after the prior verified batch

## Evidence Contract

- **State/progress path**: `plans/plan-20260821-0228-todo-ledger-prune-3.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260821-0228-todo-ledger-prune-3.contract.md`, `tasks/reviews/20260821-0228-todo-ledger-prune-3.review.md`, and `tasks/notes/20260821-0228-todo-ledger-prune-3.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260821-0228-todo-ledger-prune-3.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Restore four Markdown table rows only

## Captured Planning Output

## Goal

Remove four deferred rows that currently encode untriggered solution designs rather than active BYOK SDK commitments, while retaining every row backed by an observable product, protocol, security, or data-integrity gap.

## Decision

Delete exactly these rows from `tasks/todos.md`:

1. P2 runtime ID extension protocol.
2. Connector subprocess isolation / supervision contract.
3. Git-backed `LocalTaskJournal` backend.
4. Unified device/cloud append-only hash-chain audit ledger port.

The trigger audit found no real non-built-in runtime consumer, no browser/LinkedIn dogfood or second stdio connector, no host requesting structured Git journal history, and no enterprise retention/query consumer. Existing research and archived todo snapshots preserve the design evidence. Do not remove or rewrite the remaining seven rows.

## P1 Architecture Map

- Authority: `tasks/todos.md` is the deferred-goal ledger.
- Evidence: current protocol/client sources, Salesko downstream checkout, `docs/researches/`, and archived workflow snapshots.
- Derived state: `tasks/current.md`, harness checks, handoff, and resume projections.
- Out of scope: product code, protocol changes, releases, deployments, downstream writes, and the remaining seven deferred rows.

## P2 Concrete Trace

Trace each row from its stated revisit trigger to current code and real consumers. Presence of an extension seam or hypothetical risk is insufficient; a ledger row remains only when a current behavior gap exists or a real consumer has crossed the trigger.

## P3 Decision Rationale

A deferred-goal ledger is a product commitment surface, not a catalog of reusable architecture ideas. Research and archived snapshots retain the four patterns without keeping them perpetually prioritized. The smallest coherent change is four table-row deletions plus derived workflow refresh and verification.

## Task Breakdown

- [x] Record current trigger evidence for all four candidates.
- [x] Remove exactly the four untriggered solution-design rows from `tasks/todos.md`.
- [x] Verify the remaining ledger contains seven evidence-backed deferred goals.
- [x] Run `git diff --check` and `repo-harness run check-task-workflow --strict`.
- [x] Record review/notes and archive the completed workflow.

## Verification

- The four titles are absent from `tasks/todos.md` and remain recoverable from archived todo snapshots/research.
- The remaining deferred row count is seven.
- `git diff --check` passes.
- `repo-harness run check-task-workflow --strict` passes.
- Architecture queue closes with zero pending requests.

## Rollback

Restore the four table rows from the archived workflow snapshot; no product code, schema, registry, deployment, or user data changes.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Record current trigger evidence for all four candidates.
- [x] Remove exactly the four untriggered solution-design rows from `tasks/todos.md`.
- [x] Verify the remaining ledger contains seven evidence-backed deferred goals.
- [x] Run `git diff --check` and `repo-harness run check-task-workflow --strict`.
- [x] Record review/notes and archive the completed workflow.
