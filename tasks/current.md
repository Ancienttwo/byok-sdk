# Current Status Snapshot

<!-- generated-by: repo-harness refresh-current-status v1 -->
<!-- updated_at: 2026-08-21T21:05:00+0800 -->
<!-- stale_after: 24h -->

> **Status**: ManualClearedWithActiveWork
> **Updated At**: 2026-08-21T21:05:00+0800
> **Source Branch**: codex/pre-release-consolidation
> **Source Commit**: d14d94e
> **Target Branch**: main
> **Stale After**: 24h
> **Reason**: archive-workflow
> **Derived From**: active-plan, active-sprint, workstreams, handoff, checks, git status

This file is a tracked mainline snapshot derived from repo artifacts. It is not a live lock, not a kanban board, and not an implementation gate. If it is stale, read the source artifacts below.

## Current Focus

- Status: ManualClearedWithActiveWork
- Active Plan: plans/plan-20260821-2058-pre-release-consolidation.md
- Plan Status: Executing
- Next Task: Preserve and inventory every WIP candidate; classify merged-by-content versus truly missing work.
- Clear Note: Manual clear requested, but active work markers still exist. Idle was not written.

## Mainline Snapshot Reading

- Current worktree: `tasks/current.md`
- Target branch snapshot: `git show main:tasks/current.md`
- Rule: non-target worktrees may read the target branch snapshot, but must verify against source artifacts before acting.

## Active Work

- .: plans/plan-20260821-2058-pre-release-consolidation.md
- .: active-worktree owner -> /Users/kito/Projects/byok-sdk-wt-pre-release-consolidation
- /Users/kito/Projects/byok-sdk: stale active-plan marker -> plans/plan-20260821-1645-host-cancellation-contract.md
- /Users/kito/Projects/byok-sdk: active-worktree owner -> /Users/kito/Projects/byok-sdk
- /Users/kito/Projects/byok-sdk-wt-hosted-integration-authority-closure: plans/plan-20260821-0425-hosted-integration-authority-closure.md
- /Users/kito/Projects/byok-sdk-wt-hosted-integration-authority-closure: active-worktree owner -> /Users/kito/Projects/byok-sdk-wt-hosted-integration-authority-closure
- /Users/kito/Projects/byok-sdk-wt-local-agent-release-identity: plans/plan-20260821-1516-local-agent-release-identity.md
- /Users/kito/Projects/byok-sdk-wt-local-agent-release-identity: active-worktree owner -> /Users/kito/Projects/byok-sdk-wt-local-agent-release-identity
- /Users/kito/Projects/byok-sdk-wt-tenant-readiness-primitives: plans/plan-20260821-1715-tenant-readiness-primitives.md
- /Users/kito/Projects/byok-sdk-wt-tenant-readiness-primitives: active-worktree owner -> /Users/kito/Projects/byok-sdk-wt-tenant-readiness-primitives
## Active Sprint

- Sprint: (none)
## Workstreams

- (none)
## Handoff

- Exact Next Step: If a major module was just completed, stage its coherent diff first; then continue the next Task Breakdown item: Preserve and inventory every WIP candidate; classify merged-by-content versus truly missing work.

## Checks

- status=(none), source=(none), exit_code=(none), file=.ai/harness/checks/latest.json

## Git Status

- Summary: 13 changed/untracked path(s)

```
 M docs/architecture/index.md
 D docs/architecture/requests/root.md
 D plans/plan-20260821-0425-hosted-integration-authority-closure.md
 D tasks/contracts/20260821-0425-hosted-integration-authority-closure.contract.md
 D tasks/notes/20260821-0425-hosted-integration-authority-closure.notes.md
 D tasks/reviews/20260821-0425-hosted-integration-authority-closure.review.md
 M tasks/todos.md
?? docs/architecture/requests/archive/2026/20260821-210458-root.md
?? plans/archive/plan-20260821-0425-hosted-integration-authority-closure.md
?? tasks/archive/contract-20260821-2104-hosted-integration-authority-closure.md
?? tasks/archive/notes-20260821-2104-hosted-integration-authority-closure.md
?? tasks/archive/review-20260821-2104-hosted-integration-authority-closure.md
?? tasks/archive/todo-20260821-2104-hosted-integration-authority-closure.md
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
