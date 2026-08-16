# Current Status Snapshot

<!-- generated-by: repo-harness refresh-current-status v1 -->
<!-- updated_at: 2026-08-16T20:18:25+0800 -->
<!-- stale_after: 24h -->

> **Status**: ManualClearedWithActiveWork
> **Updated At**: 2026-08-16T20:18:25+0800
> **Source Branch**: codex/live-activity-timeline-pr2-typed-activity-projection-impl
> **Source Commit**: 4c9707c
> **Target Branch**: main
> **Stale After**: 24h
> **Reason**: ensure-task-workflow
> **Derived From**: active-plan, active-sprint, workstreams, handoff, checks, git status

This file is a tracked mainline snapshot derived from repo artifacts. It is not a live lock, not a kanban board, and not an implementation gate. If it is stale, read the source artifacts below.

## Current Focus

- Status: ManualClearedWithActiveWork
- Active Plan: plans/plan-20260816-1958-live-activity-timeline-pr2-typed-activity-projection.md
- Plan Status: Executing
- Next Task: Document the stop-writer → one TTL drain → start typed reader/writer cutover and verify the full workspace.
- Clear Note: Manual clear requested, but active work markers still exist. Idle was not written.

## Mainline Snapshot Reading

- Current worktree: `tasks/current.md`
- Target branch snapshot: `git show main:tasks/current.md`
- Rule: non-target worktrees may read the target branch snapshot, but must verify against source artifacts before acting.

## Active Work

- .: plans/plan-20260816-1958-live-activity-timeline-pr2-typed-activity-projection.md
- .: active-worktree owner -> /Users/kito/Projects/byok-sdk-wt-live-activity-timeline-pr2-typed-activity-projection
- /Users/kito/Projects/byok-sdk: stale active-plan marker -> plans/plan-20260816-1958-live-activity-timeline-pr2-typed-activity-projection.md
- /Users/kito/Projects/byok-sdk: active-worktree owner -> /Users/kito/Projects/byok-sdk
## Active Sprint

- Sprint: (none)
## Workstreams

- (none)
## Handoff

- Exact Next Step: (none)

## Checks

- status=(none), source=(none), exit_code=(none), file=.ai/harness/checks/latest.json

## Git Status

- Summary: 42 changed/untracked path(s)

```
 M docs/spec.md
 M packages/client/src/__tests__/fixtures/real-cloud.ts
 M packages/cloud-dataplane/src/__tests__/board-concurrency.test.ts
 M packages/cloud-dataplane/src/stores/core/index.ts
 M packages/cloud-dataplane/src/stores/core/presence.ts
 M packages/cloud-dataplane/src/stores/index.ts
 M packages/cloud/src/__tests__/board-streams.test.ts
 M packages/cloud/src/__tests__/constraints.test.ts
 M packages/cloud/src/__tests__/inbound-gate.test.ts
 M packages/cloud/src/cloud.ts
 M packages/cloud/src/coordination.ts
 M packages/cloud/src/handlers/presence.ts
 M packages/cloud/src/inbound.ts
 M packages/cloud/src/index.ts
 M packages/cloud/src/stores/in-memory/index.ts
 M packages/cloud/src/stores/ports-contract.ts
 M packages/cloud/src/stores/ports.ts
 M packages/cloud/src/tenant-stores.ts
 M packages/conformance/src/cloud/harness.ts
 M packages/conformance/src/cloud/index.ts
 M packages/conformance/src/cloud/tenant-isolation.ts
 M packages/conformance/src/compositions/in-memory-cloud.test.ts
 M packages/conformance/src/core/presence.ts
 M packages/conformance/src/core/tenant-isolation.ts
 M packages/conformance/src/index.ts
 M packages/core/src/__tests__/constraints.test.ts
 M packages/core/src/in-memory/index.ts
 M packages/core/src/in-memory/presence.ts
 M packages/core/src/index.ts
 M packages/core/src/ports-contract.ts
 M packages/core/src/presence.ts
 M packages/core/src/stores.ts
 M plans/plan-20260816-1958-live-activity-timeline-pr2-typed-activity-projection.md
 M tasks/contracts/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.contract.md
 M tasks/notes/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.notes.md
?? deploy/runbooks/activity-tail-cutover.md
?? packages/cloud-dataplane/src/__tests__/activity-conformance.test.ts
?? packages/cloud-dataplane/src/stores/core/activity.ts
?? packages/cloud/src/__tests__/activity-store-conformance.test.ts
?? packages/cloud/src/activity.ts
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
