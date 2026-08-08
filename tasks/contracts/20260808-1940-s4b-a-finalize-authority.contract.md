# Task Contract: s4b-a-finalize-authority

> **Status**: Active
> **Plan**: plans/plan-20260808-1940-s4b-a-finalize-authority.md
> **Task Profile**: code-change
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-08 19:45
> **Review File**: `tasks/reviews/20260808-1940-s4b-a-finalize-authority.review.md`
> **Notes File**: `tasks/notes/20260808-1940-s4b-a-finalize-authority.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

ADR-024 已裁定 authenticated daemon declaration 是 canonical SHA-256 authority，R2 `HEAD` 只能观测 object existence、byte size 与 content type。当前 `StorageFinalizeInput.observedContentHash` 与此事实冲突：composition 没有第二个 hash observation，只能把 reservation 的声明值复制回来，形成 cloud 验证 digest 的虚假语义。

该字段跨 `@byok/core` shared port、InMemory reference、Postgres production composition 与 quota conformance。若不先删除，S4B 的 reservation-bound presign、manifest commit 与 GC/reconcile 会继承错误 evidence boundary，并可能再造 `hash_verified` 状态或 checksum fallback。

## Goal

交付 S4B 的首个 bounded implementation commit：

1. `StorageFinalizeInput` 只含 `reservationId`、`observedByteSize`、`observedContentType`。
2. InMemory 与 Postgres finalize 只比较 observed size/type；hash identity、dedupe 与 accounting 只读取 reservation 的 daemon-declared `contentHash`。
3. 同一份 quota conformance 在 InMemory 与 Postgres composition 上证明 finalize success、mismatch release、expiry、same-tenant hash dedupe、downgrade grace 与 usage invariants 未退化。
4. `packages/**` 不再出现 `observedContentHash`；无 deprecated/optional compatibility field 或 overload。
5. Sprint 将本交付记为 S4B-a，并明确 S4B-b reservation-bound cloud surface 与 S4B-c migration/GC 尚未交付。

## Scope

- In scope: `@byok/core` finalize input 与 reference implementation、Postgres quota implementation、quota conformance 的对应调用/断言、platform sprint 的 S4B slice projection、本 workflow 的 plan/contract/review/notes。
- Out of scope: cloud HTTP routes、protocol DTO、R2 adapter API、reservation-bound presign、`0003` migration、retention/dead-letter、ListObjectsV2、GC/tombstone worker、metrics/runbook、archived evidence。
- Out of scope: 修改已冻结的 `deploy/sql/0001_cloud_local.sql` 或 `0002_core_domain.sql`；不创建 `hash_verified` 字段/状态，不加入 read-back/checksum fallback。
- Taste constraints: fail closed；declared/observed/verified 用词严格区分；不留 compatibility overload 或 optional deprecated input；现有 conformance assertion source 不按 composition 分支。

## Stop Conditions

- Stop if the change needs any path outside Allowed Paths.
- Stop if the same quota conformance assertions cannot certify both compositions.
- Stop if implementation would require a wire route/DTO change, a migration, an R2 checksum/read-back path, or a fifth `object_manifest` state.
- Stop if a required verification command cannot run in this environment.

## Falsifier

若实际 object-store finalize path 能提供独立、可信且与 reservation declaration 无关的 SHA-256 observation，则删除字段会丢失证据。最便宜 proof point 是当前 `R2CloudBlobStore.#head` 的 `HeadResult` 与 ADR-024 capability evidence：前者只有 `present/byteSize/contentType`，后者记录 R2 PutObject SHA-256 `FULL_OBJECT` 不支持。当前 falsifier 不成立。

## Root Cause Evidence

Not a bugfix profile. The semantic mismatch and its authoritative resolution are recorded by ADR-024; this slice implements that accepted shared-contract change.

## Workflow Inventory

- Source plan: `plans/plan-20260808-1940-s4b-a-finalize-authority.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260808-1940-s4b-a-finalize-authority.review.md`
- Notes file: `tasks/notes/20260808-1940-s4b-a-finalize-authority.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260808-1940-s4b-a-finalize-authority.md
  - plans/sprints/20260807-byok-platform-raft-aligned.sprint.md
  - tasks/todos.md
  - tasks/current.md
  - tasks/contracts/20260808-1940-s4b-a-finalize-authority.contract.md
  - tasks/reviews/20260808-1940-s4b-a-finalize-authority.review.md
  - tasks/notes/20260808-1940-s4b-a-finalize-authority.notes.md
  - packages/core/src/quota.ts
  - packages/core/src/in-memory/quota.ts
  - packages/cloud-postgres/src/stores/core/quota.ts
  - packages/conformance/src/core/quota.ts
```

## Evidence Requirements

```yaml
evidence_requirements:
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
      - main-thread
    fallback: main-thread
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - packages/core/src/quota.ts
    - packages/core/src/in-memory/quota.ts
    - packages/cloud-postgres/src/stores/core/quota.ts
    - packages/conformance/src/core/quota.ts
    - plans/sprints/20260807-byok-platform-raft-aligned.sprint.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260808-1940-s4b-a-finalize-authority.notes.md
  files_contain:
    - path: packages/core/src/quota.ts
      pattern: "readonly observedByteSize: bigint"
    - path: packages/core/src/quota.ts
      pattern: "readonly observedContentType: string"
    - path: packages/core/src/in-memory/quota.ts
      pattern: "reservation\.contentHash"
    - path: packages/cloud-postgres/src/stores/core/quota.ts
      pattern: "p\.content_hash = r\.content_hash"
    - path: plans/sprints/20260807-byok-platform-raft-aligned.sprint.md
      pattern: "S4B-a"
  files_not_contain:
    - path: packages/core/src/quota.ts
      pattern: "observedContentHash"
    - path: packages/core/src/in-memory/quota.ts
      pattern: "observedContentHash"
    - path: packages/cloud-postgres/src/stores/core/quota.ts
      pattern: "observedContentHash"
    - path: packages/conformance/src/core/quota.ts
      pattern: "observedContentHash"
  commands_succeed:
    - docker compose -f docker-compose.test.yml up -d --wait
    - pnpm -r run typecheck
    - BYOK_REQUIRE_DATAPLANE=1 BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 pnpm -r run test
    - pnpm -r run build
    - pnpm run check:deploy-sql
    - repo-harness run check-task-workflow --strict
    - git diff --check
    - git diff --exit-code main -- deploy/sql/ packages/cloud/ packages/protocol/
    - test -z "$(rg -n 'observedContentHash' packages || true)"
```

## Acceptance Notes (Human Review)

- Functional behavior: successful finalize moves reserved bytes to committed; replay returns the original dedupe answer; same tenant/hash counts once using the reservation declaration.
- Edge cases: expired/aborted reservation rejects finalize; observed size/type mismatch releases reservation and commits no bytes; hash is never presented as an object-store observation.
- Regression risks: InMemory and Postgres diverge on dedupe source; a hidden caller retains the removed field; the sprint falsely closes all of S4B; a frozen migration is edited.

## Rollback Point

- Commit / checkpoint: branch base is the planning-artifact commit created before worktree start.
- Revert strategy: revert this PR; no database or object-store rollback exists because this slice adds no migration and touches no external state.
