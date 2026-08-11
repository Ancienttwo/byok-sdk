# Current Status Snapshot

<!-- generated-by: repo-harness refresh-current-status v1 -->
<!-- updated_at: 2026-08-12T03:37:46+0800 -->
<!-- stale_after: 24h -->

> **Status**: Active
> **Updated At**: 2026-08-12T03:37:46+0800
> **Source Branch**: codex/presence-producer-capability-discovery
> **Source Commit**: f8498c5
> **Target Branch**: main
> **Stale After**: 24h
> **Reason**: manual
> **Derived From**: active-plan, active-sprint, workstreams, handoff, checks, git status

This file is a tracked mainline snapshot derived from repo artifacts. It is not a live lock, not a kanban board, and not an implementation gate. If it is stale, read the source artifacts below.

## Current Focus

- Status: Active
- Active Plan: (none)
- Plan Status: (none)
- Next Task: inspect active worktree marker(s)
- Clear Note: (none)

## Mainline Snapshot Reading

- Current worktree: `tasks/current.md`
- Target branch snapshot: `git show main:tasks/current.md`
- Rule: non-target worktrees may read the target branch snapshot, but must verify against source artifacts before acting.

## Active Work

- /private/tmp/byok-sdk-pi-provider-baseurl-probe: plans/plan-20260812-0333-llm-access-provider-adapter.md
- /private/tmp/byok-sdk-pi-provider-baseurl-probe: active-worktree owner -> /private/tmp/byok-sdk-pi-provider-baseurl-probe
## Active Sprint

- Sprint: (none)
## Workstreams

- (none)
## Handoff

- Exact Next Step: (none)

## Checks

- status=pass, source=verify-sprint, exit_code=0, file=.ai/harness/checks/latest.json

## Git Status

- Summary: 24 changed/untracked path(s)

```
M  .github/workflows/ci.yml
M  packages/cloud-postgres/README.md
M  packages/cloud-postgres/package.json
A  packages/cloud-postgres/scripts/copy-migrations.mjs
A  packages/cloud-postgres/src/__tests__/migrations-dir.test.ts
M  packages/cloud-postgres/src/index.ts
A  packages/cloud-postgres/src/migrations-dir.ts
A  packages/keys/src/sqlite-lifecycle.test.ts
M  packages/keys/src/sqlite-profile-store.ts
M  packages/keys/src/sqlite-support.ts
M  packages/server/src/__tests__/sqlite-blob-store.test.ts
A  packages/server/src/__tests__/sqlite-lifecycle.test.ts
M  packages/server/src/__tests__/sqlite-task-store.test.ts
M  packages/server/src/sqlite-blob-store.ts
M  packages/server/src/sqlite-support.ts
M  packages/server/src/sqlite-task-store.ts
R  plans/plan-20260812-0201-cloud-postgres-sql-projection.md -> plans/archive/plan-20260812-0201-cloud-postgres-sql-projection.md
M  scripts/release/pack-and-smoke.mjs
A  scripts/release/pg-migrate-smoke.mjs
A  tasks/archive/contract-20260812-0310-cloud-postgres-sql-projection.md
A  tasks/archive/notes-20260812-0310-cloud-postgres-sql-projection.md
A  tasks/archive/review-20260812-0310-cloud-postgres-sql-projection.md
A  tasks/archive/todo-20260812-0310-cloud-postgres-sql-projection.md
UU tasks/current.md
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
