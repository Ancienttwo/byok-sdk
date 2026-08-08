# Task Contract: s4b-c-cloud-cleanup

> **Status**: Fulfilled
> **Plan**: plans/plan-20260809-0001-s4b-c-cloud-cleanup.md
> **Task Profile**: migration
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-09 00:05
> **Review File**: `tasks/reviews/20260809-0001-s4b-c-cloud-cleanup.review.md`
> **Notes File**: `tasks/notes/20260809-0001-s4b-c-cloud-cleanup.notes.md`

## Why

S4B-a/b 已建立 reservation-bound upload/finalize，但没有 host 可调用的 retention、dead-letter operator、R2 tombstone/delete/reconcile 或 GC accounting。若跳过，过期 mailbox 与 orphan bytes 无界增长；若实现错误，会在 quota 满或 crash 后删除 durable user data或让 usage 漂移。

## Goal

以一个 forward-only migration contract 交付 Postgres+R2 cloud maintenance：明确 retention policy、可见/可重放 dead-letter、bounded job/cursor、grace+tombstone orphan GC、幂等 DELETE 与 manifest/usage atomic settlement、drift metrics/runbook；关闭 S4B 剩余五项验收。

## Scope

- In scope: additive `0003`；Postgres-specific maintenance API；R2 LIST/HEAD/DELETE；mailbox retention/dead-letter list/replay；expired reservation；manifest/reference/reservation/grace GC；job/cursor/metrics；runbook与 architecture/sprint 投影。
- Out of scope: runtime HTTP endpoint、S5/S6、frozen protocol、hash read-back/checksum、manifest 新状态、D1 adapter、自动常驻 scheduler。
- Taste constraints: fail-closed；无 compatibility fallback；所有 external delete 先有 durable tombstone；无 manifest key 先建 witness 并重走 grace；tenant-first every query/key/index。

## Stop Conditions

- Stop if implementation would edit `deploy/sql/0001*` or `0002*`, add a fifth manifest state, or claim SHA-256 observation.
- Stop if delete/accounting cannot be made retry-safe at each crash point.
- Stop if hard dataplane or strict workflow cannot run.

## Falsifier

最便宜 proof 是 MinIO 的 tenant-prefixed ListObjectsV2 pagination + idempotent DELETE，以及 real Postgres 的 delete-after-R2-before-DB replay。若 aws4fetch 签名或 XML response 不能稳定表达这两条，改用 AWS SDK 只能限在 `r2-blobs.ts`，不得用 heuristic parser/fallback。

## Workflow Inventory

- Source plan: `plans/plan-20260809-0001-s4b-c-cloud-cleanup.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260809-0001-s4b-c-cloud-cleanup.review.md`
- Notes file: `tasks/notes/20260809-0001-s4b-c-cloud-cleanup.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: prepare acceptance, record one typed AcceptanceReceipt, then verify sprint/contract.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/architecture/sdk-architecture.md
  - docs/researches/
  - plans/
  - plans/sprints/20260807-byok-platform-raft-aligned.sprint.md
  - tasks/current.md
  - tasks/todos.md
  - tasks/contracts/20260809-0001-s4b-c-cloud-cleanup.contract.md
  - tasks/reviews/20260809-0001-s4b-c-cloud-cleanup.review.md
  - tasks/notes/20260809-0001-s4b-c-cloud-cleanup.notes.md
  - .ai/context/capabilities.json
  - .claude/templates/
  - deploy/sql/0003_cloud_cleanup.sql
  - deploy/runbooks/
  - tests/sql/control_plane_invariants.sql
  - packages/cloud-postgres/
  - pnpm-lock.yaml
```

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```

## Delegation Contract

```yaml
delegation:
  budget: {tokens: null, runner_invocations: null, wall_time_minutes: null}
  permission_scope: {mode: inherit_allowed_paths, writable_paths: [], network: inherited}
  roles:
    parent: {mode: narrate_and_gatekeep, purpose: approval_checkpoint_owner}
    explorer: {mode: read_only, purpose: codebase_research}
    worker: {mode: edit_within_allowed_paths, purpose: implementation}
    verifier: {mode: read_only, purpose: exit_criteria_review}
  runner:
    preferred: [main-thread]
    fallback: main-thread
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - deploy/sql/0003_cloud_cleanup.sql
    - packages/cloud-postgres/src/cleanup.ts
    - packages/cloud-postgres/src/__tests__/cleanup.test.ts
    - deploy/runbooks/cloud-cleanup.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260809-0001-s4b-c-cloud-cleanup.notes.md
  tests_pass:
    - path: packages/cloud-postgres/src/__tests__/cleanup.test.ts
    - path: packages/cloud-postgres/src/__tests__/r2-blobs.test.ts
    - path: packages/cloud-postgres/src/__tests__/invariants.test.ts
    - path: packages/cloud-postgres/src/__tests__/object-reference-concurrency.test.ts
  commands_succeed:
    - BYOK_REQUIRE_DATAPLANE=1 BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 pnpm -r run typecheck
    - BYOK_REQUIRE_DATAPLANE=1 BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 pnpm -r run test
    - BYOK_REQUIRE_DATAPLANE=1 BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 pnpm -r run build
    - pnpm run check:deploy-sql
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: retention accounting atomic；dead-letter visible/replayable；orphan waits grace/tombstone；R2 absence replay settles once。
- Edge cases: reference/reservation race、untracked key、invalid key、missing/shape drift、delete response lost、cursor paging、hard-limit reads/deletes。
- Regression risks: tenant key alias、usage double decrement、durable-data eviction、migration checksum drift、hash authority overclaim。

## Rollback Point

- Commit / checkpoint: S4B-c PR merge commit.
- Revert strategy: stop scheduler/revert application code；leave additive schema/tombstones/bytes；reconcile usage before writes resume。
