# Plan: Fix SDK README namespace drift for Issue177

> **Status**: Approved
> **Created**: 20260909-1321
> **Slug**: brc177-sdk-readme
> **Planning Source**: waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: sprint:plans/sprints/brc1415-canary.sprint.md#Campaign byok-brc1415-20260909-text-connector group 1 slot 01: bugfix #177
> **Artifact Level**: work-package
> **Promotion Reason**: verification_boundary
> **Verification Boundary**: Original Issue177 regression and independent Docker verifier before manual repair PR merge
> **Rollback Surface**: Revert the README and package-local regression in one repair PR
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260909-1321-brc177-sdk-readme.contract.md`
> **Task Review**: `tasks/reviews/20260909-1321-brc177-sdk-readme.review.md`
> **Implementation Notes**: `tasks/notes/20260909-1321-brc177-sdk-readme.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from waza-think planning output.
- Source ref: sprint:plans/sprints/brc1415-canary.sprint.md#Campaign byok-brc1415-20260909-text-connector group 1 slot 01: bugfix #177
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260909-1321-brc177-sdk-readme.md`
- Sprint contract: `tasks/contracts/20260909-1321-brc177-sdk-readme.contract.md`
- Sprint review: `tasks/reviews/20260909-1321-brc177-sdk-readme.review.md`
- Implementation notes: `tasks/notes/20260909-1321-brc177-sdk-readme.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260909-1321-brc177-sdk-readme.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260909-1321-brc177-sdk-readme.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260909-1321-brc177-sdk-readme.md`.

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
- Contract file: `tasks/contracts/20260909-1321-brc177-sdk-readme.contract.md`
- Review file: `tasks/reviews/20260909-1321-brc177-sdk-readme.review.md`
- Implementation notes file: `tasks/notes/20260909-1321-brc177-sdk-readme.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260909-1321-brc177-sdk-readme.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260909-1321-brc177-sdk-readme.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert the README and package-local regression in one repair PR
- **Verification boundary**: Original Issue177 regression and independent Docker verifier before manual repair PR merge
- **Review/acceptance boundary**: `tasks/reviews/20260909-1321-brc177-sdk-readme.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: verification_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260909-1321-brc177-sdk-readme.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260909-1321-brc177-sdk-readme.contract.md`, `tasks/reviews/20260909-1321-brc177-sdk-readme.review.md`, and `tasks/notes/20260909-1321-brc177-sdk-readme.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260909-1321-brc177-sdk-readme.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert the README and package-local regression in one repair PR

## Captured Planning Output

## Problem and decision

The shipped SDK README describes six namespaces and omits uiRuntime, while packages/sdk/src/index.ts exports seven. Update only the package README and add a package-local regression that checks the documented import against the source namespace exports and preserves the separate keys boundary. No runtime API changes are needed.

## Task Breakdown

- [ ] Prove the README mismatch with a failing package-local regression and record Root Cause Evidence.
- [ ] Have the acquired Docker worker update the README count, import and uiRuntime description within the two-file scope.
- [ ] Have the independent verifier run the regression plus the target repository required build, typecheck, tests, API surface, version authority and workflow checks.
- [ ] Publish the repair PR, manually merge, and let campaign closeout record Issue closure and exact cleanup.

## Acceptance scope

This is original Issue177 in the authorized two-slot canary. Slot02 is handled independently as not_reproducible based on existing packed-package smoke coverage. No additional Issues, features, release or package publication.

## Verification rationale

The targeted README test is the behavioral oracle. The target AGENTS.md explicitly requires the named SDK integrity checks, including its test script. Run those once in final verification, retaining logs; no repo-harness full-suite rerun. The changed runtime surface is zero. At higher volume, documentary drift remains bounded by the package-local regression.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] Prove the README mismatch with a failing package-local regression and record Root Cause Evidence.
- [ ] Have the acquired Docker worker update the README count, import and uiRuntime description within the two-file scope.
- [ ] Have the independent verifier run the regression plus the target repository required build, typecheck, tests, API surface, version authority and workflow checks.
- [ ] Publish the repair PR, manually merge, and let campaign closeout record Issue closure and exact cleanup.
