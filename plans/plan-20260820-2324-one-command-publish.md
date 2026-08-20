# Plan: One-command release publish driver

> **Status**: Executing
> **Created**: 20260820-2324
> **Slug**: one-command-publish
> **Planning Source**: codex-plan-or-waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260820-2324-one-command-publish.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20260820-2324-one-command-publish.md`; after execution revert branch `codex/one-command-publish` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260820-2324-one-command-publish.contract.md`
> **Task Review**: `tasks/reviews/20260820-2324-one-command-publish.review.md`
> **Implementation Notes**: `tasks/notes/20260820-2324-one-command-publish.notes.md`

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

- Active plan: `plans/plan-20260820-2324-one-command-publish.md`
- Sprint contract: `tasks/contracts/20260820-2324-one-command-publish.contract.md`
- Sprint review: `tasks/reviews/20260820-2324-one-command-publish.review.md`
- Implementation notes: `tasks/notes/20260820-2324-one-command-publish.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260820-2324-one-command-publish.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260820-2324-one-command-publish.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260820-2324-one-command-publish.md`.

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
- Contract file: `tasks/contracts/20260820-2324-one-command-publish.contract.md`
- Review file: `tasks/reviews/20260820-2324-one-command-publish.review.md`
- Implementation notes file: `tasks/notes/20260820-2324-one-command-publish.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260820-2324-one-command-publish.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260820-2324-one-command-publish.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260820-2324-one-command-publish.md`; after execution revert branch `codex/one-command-publish` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260820-2324-one-command-publish.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260820-2324-one-command-publish.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260820-2324-one-command-publish.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260820-2324-one-command-publish.contract.md`, `tasks/reviews/20260820-2324-one-command-publish.review.md`, and `tasks/notes/20260820-2324-one-command-publish.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260820-2324-one-command-publish.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260820-2324-one-command-publish.md`; after execution revert branch `codex/one-command-publish` or the explicitly reviewed diff.

## Captured Planning Output

## Goal
Collapse the 8-package fixed-version release into one command: scripts/release/publish.mjs chains version-consistency gate -> bun run build -> pack-and-smoke -> topo-ordered publish plan -> git tag -> npm publish per tarball -> registry-readback. Default is dry-run (steps 1-4 real, plan printed); tag/publish/readback only behind --execute. Fail-closed at every step, no fallback paths.

## Task Breakdown
- [ ] Land scripts/release/publish.mjs (implementation reviewed by orchestrator; authored via fast-worker dispatch)
- [ ] Verify: node scripts/release/publish.mjs dry-run end-to-end, node scripts/release/check-package-graph.mjs, bun run typecheck, bun run test

## Out of scope
Running --execute (publish/tag remain owner-authorized); CI wiring; version bumps.

## Source
Deferred-goal ledger row "一键发布脚本" (tasks/todos.md), owner-directed batch 2026-08-20.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] Land scripts/release/publish.mjs (implementation reviewed by orchestrator; authored via fast-worker dispatch)
- [ ] Verify: node scripts/release/publish.mjs dry-run end-to-end, node scripts/release/check-package-graph.mjs, bun run typecheck, bun run test
