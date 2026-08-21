# Current Status Snapshot

<!-- generated-by: repo-harness refresh-current-status v1 -->
<!-- updated_at: 2026-08-21T11:41:33+0800 -->
<!-- stale_after: 24h -->

> **Status**: ManualClearedWithActiveWork
> **Updated At**: 2026-08-21T11:41:33+0800
> **Source Branch**: codex/hosted-integration-authority-closure
> **Source Commit**: 1a9c661
> **Target Branch**: main
> **Stale After**: 24h
> **Reason**: ensure-task-workflow
> **Derived From**: active-plan, active-sprint, workstreams, handoff, checks, git status

This file is a tracked mainline snapshot derived from repo artifacts. It is not a live lock, not a kanban board, and not an implementation gate. If it is stale, read the source artifacts below.

## Current Focus

- Status: ManualClearedWithActiveWork
- Active Plan: plans/plan-20260821-0425-hosted-integration-authority-closure.md
- Plan Status: Executing
- Next Task: Capture and activate this plan in an isolated contract worktree; fill a self-sufficient contract with root-cause evidence, disjoint writer ownership, allowed paths and machine-verifiable exit criteria.
- Clear Note: Manual clear requested, but active work markers still exist. Idle was not written.

## Mainline Snapshot Reading

- Current worktree: `tasks/current.md`
- Target branch snapshot: `git show main:tasks/current.md`
- Rule: non-target worktrees may read the target branch snapshot, but must verify against source artifacts before acting.

## Active Work

- .: plans/plan-20260821-0425-hosted-integration-authority-closure.md
- .: active-worktree owner -> /Users/kito/Projects/byok-sdk-wt-hosted-integration-authority-closure
- /Users/kito/Projects/byok-sdk: stale active-plan marker -> plans/plan-20260821-0425-hosted-integration-authority-closure.md
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

- Summary: 27 changed/untracked path(s)

```
 M bun.lock
 M docker-compose.test.yml
 M docs/researches/2026-08-12-salesko-integration-handoff.md
 M docs/spec.md
 M packages/cloud-dataplane/README.md
 M packages/cloud-dataplane/src/__tests__/constraints.test.ts
 M packages/cloud-dataplane/src/__tests__/migrate-runner.test.ts
 M packages/cloud-dataplane/src/__tests__/runtime-entry.test.ts
 M packages/cloud-dataplane/src/__tests__/support/dataplane.ts
 M packages/cloud-dataplane/src/__tests__/worker-e2e.test.ts
 M packages/cloud-dataplane/src/index.ts
 M packages/cloud-dataplane/src/migrate.ts
 M packages/cloud-dataplane/worker-smoke/src.ts
 M packages/cloud-dataplane/worker-smoke/wrangler.jsonc
 M packages/keys/package.json
 M scripts/release/check-package-graph.mjs
 M scripts/release/pack-and-smoke.mjs
 M scripts/release/pg-migrate-smoke.mjs
 M scripts/release/registry-readback.mjs
 M tasks/todos.md
?? packages/cloud-dataplane/src/__tests__/fixtures/
?? plans/plan-20260821-0425-hosted-integration-authority-closure.md
?? scripts/release/fixtures/keys-0.2.0-stale-core-edge.json
?? tasks/contracts/20260821-0425-hosted-integration-authority-closure.contract.md
?? tasks/notes/20260821-0425-hosted-integration-authority-closure.notes.md
?? tasks/reviews/20260821-0425-hosted-integration-authority-closure.review.md
?? tests/unit/keys-release-graph.test.ts
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
