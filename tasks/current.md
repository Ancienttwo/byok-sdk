# Current Status Snapshot

<!-- generated-by: repo-harness refresh-current-status v1 -->
<!-- updated_at: 2026-08-09T02:12:29+0800 -->
<!-- stale_after: 24h -->

> **Status**: ManualClearedWithActiveWork
> **Updated At**: 2026-08-09T02:12:29+0800
> **Source Branch**: codex/s5-board-streams
> **Source Commit**: 140b109
> **Target Branch**: main
> **Stale After**: 24h
> **Reason**: ensure-task-workflow
> **Derived From**: active-plan, active-sprint, workstreams, handoff, checks, git status

This file is a tracked mainline snapshot derived from repo artifacts. It is not a live lock, not a kanban board, and not an implementation gate. If it is stale, read the source artifacts below.

## Current Focus

- Status: ManualClearedWithActiveWork
- Active Plan: plans/plan-20260809-0148-s5-board-streams.md
- Plan Status: Executing
- Next Task: Record S5 design/contract and update S4B merge ledger.
- Clear Note: Manual clear requested, but active work markers still exist. Idle was not written.

## Mainline Snapshot Reading

- Current worktree: `tasks/current.md`
- Target branch snapshot: `git show main:tasks/current.md`
- Rule: non-target worktrees may read the target branch snapshot, but must verify against source artifacts before acting.

## Active Work

- .: plans/plan-20260809-0148-s5-board-streams.md
- .: active-worktree owner -> /Users/ancienttwo/Projects/byok-sdk-wt-s5-board-streams
- /Users/ancienttwo/Projects/byok-sdk: plans/plan-20260805-1659-byok-keys-package.md
- /Users/ancienttwo/Projects/byok-sdk: active-worktree owner -> /Users/ancienttwo/Projects/byok-sdk
- /Users/ancienttwo/Projects/byok-sdk-wt-s4b-c-cloud-cleanup: plans/plan-20260809-0001-s4b-c-cloud-cleanup.md
- /Users/ancienttwo/Projects/byok-sdk-wt-s4b-c-cloud-cleanup: active-worktree owner -> /Users/ancienttwo/Projects/byok-sdk-wt-s4b-c-cloud-cleanup
## Active Sprint

- Sprint: (none)
## Workstreams

- (none)
## Handoff

- Exact Next Step: (none)

## Checks

- status=(none), source=(none), exit_code=(none), file=.ai/harness/checks/latest.json

## Git Status

- Summary: 31 changed/untracked path(s)

```
 M docs/architecture/sdk-architecture.md
 M packages/cloud-postgres/src/stores/core/presence.ts
 M packages/cloud/src/__tests__/constraints.test.ts
 M packages/cloud/src/__tests__/route-inventory.test.ts
 M packages/cloud/src/capabilities.ts
 M packages/cloud/src/cloud.ts
 M packages/cloud/src/composition/in-memory.ts
 M packages/cloud/src/errors.ts
 M packages/cloud/src/handlers/messages.ts
 M packages/cloud/src/inbound.ts
 M packages/cloud/src/index.ts
 M packages/cloud/src/tenant-stores.ts
 M packages/conformance/src/core/presence.ts
 M packages/conformance/src/core/tenant-isolation.ts
 M packages/core/src/errors.ts
 M packages/core/src/in-memory/presence.ts
 M packages/core/src/presence.ts
 M plans/sprints/20260807-byok-platform-raft-aligned.sprint.md
 M tasks/todos.md
?? docs/researches/s5-board-streams-design.md
?? packages/cloud-postgres/src/__tests__/board-concurrency.test.ts
?? packages/cloud/src/__tests__/board-streams.test.ts
?? packages/cloud/src/board-projection.ts
?? packages/cloud/src/coordination-client.ts
?? packages/cloud/src/coordination.ts
?? packages/cloud/src/handlers/board.ts
?? packages/cloud/src/handlers/presence.ts
?? plans/plan-20260809-0148-s5-board-streams.md
?? tasks/contracts/20260809-0148-s5-board-streams.contract.md
?? tasks/notes/20260809-0148-s5-board-streams.notes.md
?? tasks/reviews/20260809-0148-s5-board-streams.review.md
```

## Source Artifacts

- Plans: `plans/plan-*.md`
- Active marker: `.ai/harness/active-plan`
- Active worktree marker: `.ai/harness/active-worktree`
- PRDs: `plans/prds/*.prd.md`
- Sprints: `plans/sprints/*.sprint.md`
- Active sprint marker: `.ai/harness/sprint/active-sprint`
- Workstreams: `tasks/workstreams/**/*.md`
- Handoff: `.ai/harness/handoff/current.md`
- Checks: `.ai/harness/checks/latest.json`
