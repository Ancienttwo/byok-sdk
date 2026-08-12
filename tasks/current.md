# Current Status Snapshot

<!-- generated-by: repo-harness refresh-current-status v1 -->
<!-- updated_at: 2026-08-13T00:18:59+0800 -->
<!-- stale_after: 24h -->

> **Status**: ManualClearedWithActiveWork
> **Updated At**: 2026-08-13T00:18:59+0800
> **Source Branch**: main
> **Source Commit**: f2aa162
> **Target Branch**: main
> **Stale After**: 24h
> **Reason**: archive-workflow
> **Derived From**: active-plan, active-sprint, workstreams, handoff, checks, git status

This file is a tracked mainline snapshot derived from repo artifacts. It is not a live lock, not a kanban board, and not an implementation gate. If it is stale, read the source artifacts below.

## Current Focus

- Status: ManualClearedWithActiveWork
- Active Plan: (none)
- Plan Status: (none)
- Next Task: inspect active worktree marker(s)
- Clear Note: Manual clear requested, but active work markers still exist. Idle was not written.

## Mainline Snapshot Reading

- Current worktree: `tasks/current.md`
- Target branch snapshot: `git show main:tasks/current.md`
- Rule: non-target worktrees may read the target branch snapshot, but must verify against source artifacts before acting.

## Active Work

- .: stale active-plan marker -> plans/plan-20260812-0347-cloud-postgres-offer-sequence-hotfix.md
- .: active-worktree owner -> /Users/kito/Projects/byok-sdk
## Active Sprint

- Sprint: `plans/sprints/20260812-0218-salesko-upstream-asks.sprint.md`
- Sprint Status: Done
- Backlog: 0/8
- Next Sprint Task: Presence producer + hosted capability discovery（已在 contract worktree 执行中，勿重复展开）
## Workstreams

- (none)
## Handoff

- Exact Next Step: (none)

## Checks

- status=fail, source=verify-sprint, exit_code=1, file=.ai/harness/checks/latest.json

## Git Status

- Summary: 11 changed/untracked path(s)

```
 D plans/plan-20260812-0333-llm-access-provider-adapter.md
 D tasks/contracts/20260812-0333-llm-access-provider-adapter.contract.md
 D tasks/notes/20260812-0333-llm-access-provider-adapter.notes.md
 D tasks/reviews/20260812-0333-llm-access-provider-adapter.review.md
 M tasks/todos.md
?? docs/researches/2026-08-12_hermes-buzz-extraction-assessment.md
?? plans/archive/plan-20260812-0333-llm-access-provider-adapter.md
?? tasks/archive/contract-20260813-0018-llm-access-provider-adapter.md
?? tasks/archive/notes-20260813-0018-llm-access-provider-adapter.md
?? tasks/archive/review-20260813-0018-llm-access-provider-adapter.md
?? tasks/archive/todo-20260813-0018-llm-access-provider-adapter.md
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
