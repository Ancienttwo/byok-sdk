> **Archived**: 2026-08-08 21:34
> **Related Plan**: plans/archive/plan-20260808-2014-s4b-b-reservation-bound-blobs.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260808-2134

# Task Contract: s4b-b-reservation-bound-blobs

> **Status**: Fulfilled
> **Plan**: plans/plan-20260808-2014-s4b-b-reservation-bound-blobs.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-08 20:20
> **Review File**: `tasks/reviews/20260808-2014-s4b-b-reservation-bound-blobs.review.md`
> **Notes File**: `tasks/notes/20260808-2014-s4b-b-reservation-bound-blobs.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

S4B-a 已使 cloud 不再伪称 SHA-256 被观测验证，但 hosted upload 仍绕过 quota reservation，并由首次 download 隐式提交 manifest。若不收口，上传成功与计费/manifest authority 会在 crash 后漂移，reservation 也无法与 tenant-scoped blob resource 绑定。

## Goal

交付 reservation-bound blob lifecycle：device-auth create 在签 PUT 前 reserve，daemon PUT 后显式 finalize；finalize 观测存在性/size/type，并让 Postgres 在同一 transaction/statement 提交 manifest、reservation 与 usage；两套 composition 跑同一 conformance，pending 对象不得下载。

## Scope

- In scope: core reservation read/collision/finalize；cloud reservation-bound grant/observe；device create/finalize routes；BlobClient/self-hosted surface；InMemory 与 Postgres+R2 conformance；protocol/architecture/sprint 投影。
- Out of scope: migration、manifest 新状态、GC/delete/ListObjects、checksum fallback、frozen `CreateBlob*` body/golden 变更。
- Taste constraints: 复用既有 `{error}` envelope 与 stable storage error/status；用 `Idempotency-Key` 承载 reservation id；不保留 lazy finalize、optional compatibility path 或第二套 API version。

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

若 R2/MinIO 不接受从 reservation shape 铸造的 SigV4 PUT，或 Postgres 无法在现有 `0002` schema 以单 statement 原子提交 manifest/reservation/usage，则方向失效。最便宜 proof point 是 object adapter 的 MinIO presign PUT test 与 quota Postgres conformance；任一失败即停止，不新增 migration 或双模式 fallback。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260808-2014-s4b-b-reservation-bound-blobs.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260808-2014-s4b-b-reservation-bound-blobs.review.md`
- Notes file: `tasks/notes/20260808-2014-s4b-b-reservation-bound-blobs.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - docs/protocol.md
  - docs/architecture/sdk-architecture.md
  - plans/sprints/20260807-byok-platform-raft-aligned.sprint.md
  - plans/
  - tasks/current.md
  - tasks/todos.md
  - tasks/contracts/20260808-2014-s4b-b-reservation-bound-blobs.contract.md
  - tasks/reviews/20260808-2014-s4b-b-reservation-bound-blobs.review.md
  - tasks/notes/20260808-2014-s4b-b-reservation-bound-blobs.notes.md
  - .ai/context/capabilities.json
  - .claude/templates/
  - packages/core/
  - packages/cloud/
  - packages/cloud-postgres/
  - packages/conformance/
  - packages/client/
  - packages/server/
  - pnpm-lock.yaml
```

## Evidence Requirements

```yaml
evidence_requirements:
  # Set benchmark to required when this contract consumes the harness profile benchmark matrix.
  benchmark: not_applicable
```

## Delegation Contract

```yaml
delegation:
  budget:
    tokens: null
    runner_invocations: null
    wall_time_minutes: null
  permission_scope:
    mode: inherit_allowed_paths
    writable_paths: []
    network: inherited
  roles:
    parent:
      mode: narrate_and_gatekeep
      purpose: approval_checkpoint_owner
    explorer:
      mode: read_only
      purpose: codebase_research
    worker:
      mode: edit_within_allowed_paths
      purpose: implementation
    verifier:
      mode: read_only
      purpose: exit_criteria_review
  runner:
    preferred:
      - subagent
      - codex-exec
      - main-thread
    fallback: main-thread
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - packages/cloud/src/handlers/blobs.ts
    - packages/cloud-postgres/src/stores/core/quota.ts
    - packages/client/src/daemon/blob-client.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260808-2014-s4b-b-reservation-bound-blobs.notes.md
  tests_pass:
    - path: packages/conformance/src/compositions/in-memory-core.test.ts
    - path: packages/conformance/src/compositions/in-memory-cloud.test.ts
    - path: packages/cloud/src/__tests__/device-surface.test.ts
    - path: packages/cloud-postgres/src/__tests__/r2-blobs.test.ts
    - path: packages/cloud-postgres/src/__tests__/quota-concurrency.test.ts
  commands_succeed:
    - BYOK_REQUIRE_DATAPLANE=1 BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 pnpm -r run typecheck
    - BYOK_REQUIRE_DATAPLANE=1 BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 pnpm -r run test
    - BYOK_REQUIRE_DATAPLANE=1 BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 pnpm -r run build
    - pnpm run check:deploy-sql
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: reserve precedes grant；explicit finalize；committed-only download；manifest/accounting atomic。
- Edge cases: reservation/resource collision、missing object、size/type mismatch、finalize response lost/replay、quota refusal。
- Regression risks: frozen wire/schema drift、lazy finalize residue、composition-specific branch、billing double count。

## Rollback Point

- Commit / checkpoint: S4B-b PR merge commit。
- Revert strategy: revert 单一 PR；无 migration 或 delete side effect。
