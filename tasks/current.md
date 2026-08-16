# Current Status Snapshot

<!-- generated-by: repo-harness refresh-current-status v1 -->
<!-- updated_at: 2026-08-16T19:58:09+0800 -->
<!-- stale_after: 24h -->

> **Status**: Idle
> **Updated At**: 2026-08-16T19:58:09+0800
> **Source Branch**: main
> **Source Commit**: c4f52a7
> **Target Branch**: main
> **Stale After**: 24h
> **Reason**: archive-workflow
> **Derived From**: active-plan, active-sprint, workstreams, handoff, checks, git status

This file is a tracked mainline snapshot derived from repo artifacts. It is not a live lock, not a kanban board, and not an implementation gate. If it is stale, read the source artifacts below.

## Current Focus

- Status: Idle
- Active Plan: (none)
- Plan Status: (none)
- Next Task: (none)
- Clear Note: (none)

## Mainline Snapshot Reading

- Current worktree: `tasks/current.md`
- Target branch snapshot: `git show main:tasks/current.md`
- Rule: non-target worktrees may read the target branch snapshot, but must verify against source artifacts before acting.

## Active Work

- (none)
## Active Sprint

- Sprint: `plans/sprints/20260814-0005-runtime-adapter-lifecycle-contracts.sprint.md`
- Sprint Status: Done
- Backlog: 3/3
- Next Sprint Task: (none)
## Workstreams

- (none)
## Handoff

- Exact Next Step: Stage the completed module diff first; then run /check and let canonical workflow gates determine whether review, external acceptance, verification, or worktree finish is next. Command: /check

## Checks

- status=pass, source=verify-sprint, exit_code=0, file=.ai/harness/checks/latest.json

## Git Status

- Summary: 10 changed/untracked path(s)

```
 D plans/plan-20260816-1550-live-activity-timeline-pr1-tool-correlation.md
 D tasks/contracts/20260816-1550-live-activity-timeline-pr1-tool-correlation.contract.md
 D tasks/notes/20260816-1550-live-activity-timeline-pr1-tool-correlation.notes.md
 D tasks/reviews/20260816-1550-live-activity-timeline-pr1-tool-correlation.review.md
 M tasks/todos.md
?? plans/archive/plan-20260816-1550-live-activity-timeline-pr1-tool-correlation.md
?? tasks/archive/contract-20260816-1958-live-activity-timeline-pr1-tool-correlation.md
?? tasks/archive/notes-20260816-1958-live-activity-timeline-pr1-tool-correlation.md
?? tasks/archive/review-20260816-1958-live-activity-timeline-pr1-tool-correlation.md
?? tasks/archive/todo-20260816-1958-live-activity-timeline-pr1-tool-correlation.md
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
