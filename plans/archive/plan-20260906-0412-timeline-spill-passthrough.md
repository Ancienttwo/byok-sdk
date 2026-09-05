> **Archived**: 2026-09-06 04:21
> **Related Plan**: plans/archive/plan-20260906-0412-timeline-spill-passthrough.md
> **Outcome**: Completed
> **Lifecycle**: plan
> **Parent Run ID**: run-20260906-0421
> **Archive Projection V1**: `plans/plan-20260906-0412-timeline-spill-passthrough.md` => `plans/archive/plan-20260906-0412-timeline-spill-passthrough.md`
> **Archive Projection V1**: `tasks/notes/20260906-0412-timeline-spill-passthrough.notes.md` => `tasks/archive/notes-20260906-0421-timeline-spill-passthrough.md`
> **Archive Projection V1**: `tasks/contracts/20260906-0412-timeline-spill-passthrough.contract.md` => `tasks/archive/contract-20260906-0421-timeline-spill-passthrough.md`
> **Archive Projection V1**: `tasks/reviews/20260906-0412-timeline-spill-passthrough.review.md` => `tasks/archive/review-20260906-0421-timeline-spill-passthrough.md`

# Plan: Carry the AgentEvent spill descriptor on ToolTimelineItem

> **Status**: Archived
> **Created**: 20260906-0412
> **Slug**: timeline-spill-passthrough
> **Artifact Level**: work-package
> **Promotion Reason**: `ToolTimelineItem` copies `input`/`output` by named field and drops the additive `spill` descriptor landed by PR #149, so a timeline consumer sees `{ preview: { head, tail } }` with no truncation signal. This was that contract's stated falsifier and deferred goal.
> **Verification Boundary**: ui-runtime typecheck/test, `check:api-surface`, strict workflow check.
> **Rollback Surface**: two optional fields on `ToolTimelineItem`, two passthrough spreads in `timeline.ts`, tests, the ui-runtime golden, CHANGELOG, todos row.
> **Spec**: `docs/spec.md`
> **Research**: `docs/protocol.md` §11.6
> **Task Contract**: `tasks/archive/contract-20260906-0421-timeline-spill-passthrough.md`
> **Task Review**: `tasks/archive/review-20260906-0421-timeline-spill-passthrough.md`
> **Implementation Notes**: `tasks/archive/notes-20260906-0421-timeline-spill-passthrough.md`

## Agentic Routing
- Selected route: main-loop planning; `fast-worker` execution in a contract worktree; orchestrator verifies directly (mechanical passthrough, no gatekeeper round).
- Routing reason: two files plus a test; the field type already exists in `@byok-sdk/protocol`.
- Due diligence:
  - P1 map: `packages/ui-runtime/src/types.ts:60-67` (`ToolTimelineItem`), `packages/ui-runtime/src/timeline.ts:200-222` (paired fold and unpaired fold), `api-surface/ui-runtime.d.ts` golden, `@byok-sdk/ui-runtime` depends on `@byok-sdk/protocol` (`AgentEventSpill` exported).
  - P2 trace: `task.progress` event → `projectItems` → `ToolAccumulator` → `pairedTool`/`unpairedTool` spread `input`/`output` only → consumer renders the preview object as the full value.
  - P3 decision rationale: a tool item merges one `tool_use` and one `tool_result`, so it needs two descriptors: `inputSpill` and `outputSpill`, each present only when the source event carried `spill`. No rendering logic, no inference from the preview shape.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/archive/plan-20260906-0412-timeline-spill-passthrough.md`
- Sprint contract: `tasks/archive/contract-20260906-0421-timeline-spill-passthrough.md`
- Sprint review: `tasks/archive/review-20260906-0421-timeline-spill-passthrough.md`
- Implementation notes: `tasks/archive/notes-20260906-0421-timeline-spill-passthrough.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/archive/contract-20260906-0421-timeline-spill-passthrough.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/archive/plan-20260906-0412-timeline-spill-passthrough.md` and may start `repo-harness run contract-worktree start --plan plans/archive/plan-20260906-0412-timeline-spill-passthrough.md`.

## Approach
### Strategy
1. `types.ts`: add `readonly inputSpill?: AgentEventSpill; readonly outputSpill?: AgentEventSpill;` to `ToolTimelineItem` (type import from `@byok-sdk/protocol`).
2. `timeline.ts`: in `pairedTool` and `unpairedTool`, spread `inputSpill` when the `tool_use` observation has `spill`, `outputSpill` when the `tool_result` observation has `spill`.
3. Tests: paired item carries both; unpaired result carries `outputSpill` only; an item without spill has neither key (`Object.hasOwn` false).
4. Regenerate `api-surface/ui-runtime.d.ts`; CHANGELOG; remove the delivered todos row.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Two descriptors (chosen) | Mirrors the two source events; no loss | Two fields | Use |
| One `spill` field | Smaller | Ambiguous when both sides spilled | Reject |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/ui-runtime/src/types.ts` | Edit | two optional fields |
| `packages/ui-runtime/src/timeline.ts` | Edit | passthrough |
| `packages/ui-runtime/src/__tests__/timeline.test.ts` | Edit | three cases |
| `api-surface/ui-runtime.d.ts` | Regenerate | golden |
| `CHANGELOG.md`, `tasks/todos.md` | Edit | entry; delivered row removed |

### Code Snippets
```ts
...(use && Object.hasOwn(use, 'spill') ? { inputSpill: use.spill } : {}),
...(result && Object.hasOwn(result, 'spill') ? { outputSpill: result.spill } : {}),
```

### Data Flow
Unchanged except the two new fields ride along the existing fold.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Golden drift beyond the two fields | Low | Gate fails | Diff the golden; additions only |

## Task Contracts
- Contract file: `tasks/archive/contract-20260906-0421-timeline-spill-passthrough.md`
- Review file: `tasks/archive/review-20260906-0421-timeline-spill-passthrough.md`
- Implementation notes file: `tasks/archive/notes-20260906-0421-timeline-spill-passthrough.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/archive/contract-20260906-0421-timeline-spill-passthrough.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: one small PR.
- **Rollback surface**: revert the PR.
- **Verification boundary**: ui-runtime typecheck/test, api-surface, strict workflow.
- **Review/acceptance boundary**: orchestrator verification; no gatekeeper round for a two-field passthrough.
- **High-risk surface**: none; additive public type fields.
- **Why not checklist row**: it changes a public package type and its golden.

## Evidence Contract

- **State/progress path**: this plan, contract, notes.
- **Verification evidence**: command outputs in notes; golden diff.
- **Evaluator rubric**: both fields present exactly when the source events carried `spill`; golden additions only.
- **Stop condition**: none foreseeable.
- **Rollback surface**: revert the PR.

## Annotations

- [RESOLVED]: `AgentEventSpill` is exported from `packages/protocol/src/index.ts` (PR #149) and `@byok-sdk/ui-runtime` already depends on `@byok-sdk/protocol` (`package.json:48`).

## Task Breakdown
- [x] Add the two fields and passthrough; tests.
- [x] Regenerate the golden; CHANGELOG; remove the todos row; notes.
- [ ] Verify; PR.
