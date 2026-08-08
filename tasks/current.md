# Current Status Snapshot

<!-- generated-by: repo-harness refresh-current-status v1 -->
<!-- updated_at: 2026-08-09T03:15:45+0800 -->
<!-- stale_after: 24h -->

> **Status**: ManualClearedWithActiveWork
> **Updated At**: 2026-08-09T03:15:45+0800
> **Source Branch**: codex/s6-device-proof-memory
> **Source Commit**: 2a1c4a7
> **Target Branch**: main
> **Stale After**: 24h
> **Reason**: ensure-task-workflow
> **Derived From**: active-plan, active-sprint, workstreams, handoff, checks, git status

This file is a tracked mainline snapshot derived from repo artifacts. It is not a live lock, not a kanban board, and not an implementation gate. If it is stale, read the source artifacts below.

## Current Focus

- Status: ManualClearedWithActiveWork
- Active Plan: plans/plan-20260809-0340-s6a-proof-authority.md
- Plan Status: Executing
- Next Task: Add device proof key authority and dedicated receipt schema/adapters.
- Clear Note: Manual clear requested, but active work markers still exist. Idle was not written.

## Mainline Snapshot Reading

- Current worktree: `tasks/current.md`
- Target branch snapshot: `git show main:tasks/current.md`
- Rule: non-target worktrees may read the target branch snapshot, but must verify against source artifacts before acting.

## Active Work

- .: plans/plan-20260809-0340-s6a-proof-authority.md
- .: active-worktree owner -> /Users/ancienttwo/Projects/byok-sdk-wt-s6-device-proof-memory
- /Users/ancienttwo/Projects/byok-sdk: plans/plan-20260805-1659-byok-keys-package.md
- /Users/ancienttwo/Projects/byok-sdk: active-worktree owner -> /Users/ancienttwo/Projects/byok-sdk
- /Users/ancienttwo/Projects/byok-sdk-wt-s4b-c-cloud-cleanup: plans/plan-20260809-0001-s4b-c-cloud-cleanup.md
- /Users/ancienttwo/Projects/byok-sdk-wt-s4b-c-cloud-cleanup: active-worktree owner -> /Users/ancienttwo/Projects/byok-sdk-wt-s4b-c-cloud-cleanup
- /Users/ancienttwo/Projects/byok-sdk-wt-s5-board-streams: plans/plan-20260809-0148-s5-board-streams.md
- /Users/ancienttwo/Projects/byok-sdk-wt-s5-board-streams: active-worktree owner -> /Users/ancienttwo/Projects/byok-sdk-wt-s5-board-streams
## Active Sprint

- Sprint: (none)
## Workstreams

- (none)
## Handoff

- Exact Next Step: (none)

## Checks

- status=(none), source=(none), exit_code=(none), file=.ai/harness/checks/latest.json

## Git Status

- Summary: 30 changed/untracked path(s)

```
 M docs/architecture/sdk-architecture.md
 M packages/cloud-postgres/README.md
 M packages/cloud-postgres/src/stores/devices.ts
 M packages/cloud-postgres/src/stores/index.ts
 M packages/cloud/src/__tests__/constraints.test.ts
 M packages/cloud/src/auth/plane.ts
 M packages/cloud/src/crypto/port.ts
 M packages/cloud/src/crypto/web-crypto.ts
 M packages/cloud/src/index.ts
 M packages/cloud/src/stores/in-memory/device-directory.ts
 M packages/cloud/src/stores/in-memory/index.ts
 M packages/cloud/src/stores/ports-contract.ts
 M packages/cloud/src/stores/ports.ts
 M packages/conformance/src/cloud/fixtures.ts
 M packages/conformance/src/cloud/harness.ts
 M packages/conformance/src/cloud/tenant-isolation.ts
 M packages/conformance/src/compositions/in-memory-cloud.test.ts
 M plans/sprints/20260807-byok-platform-raft-aligned.sprint.md
 M tests/sql/control_plane_invariants.sql
?? deploy/sql/0004_device_proof_truth.sql
?? docs/researches/s6-proof-truth-memory-design.md
?? packages/cloud-postgres/src/stores/proof-receipts.ts
?? packages/cloud/src/__tests__/device-proof.test.ts
?? packages/cloud/src/auth/device-proof.ts
?? packages/cloud/src/stores/in-memory/proof-receipts.ts
?? packages/conformance/src/cloud/proof-receipts.ts
?? plans/plan-20260809-0340-s6a-proof-authority.md
?? tasks/contracts/20260809-0340-s6a-proof-authority.contract.md
?? tasks/notes/20260809-0340-s6a-proof-authority.notes.md
?? tasks/reviews/20260809-0340-s6a-proof-authority.review.md
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
