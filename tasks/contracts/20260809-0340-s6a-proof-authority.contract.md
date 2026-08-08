# Task Contract: s6a-proof-authority

> **Status**: Fulfilled
> **Plan**: plans/plan-20260809-0340-s6a-proof-authority.md
> **Task Profile**: migration
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-09 03:40
> **Review File**: `tasks/reviews/20260809-0340-s6a-proof-authority.review.md`
> **Notes File**: `tasks/notes/20260809-0340-s6a-proof-authority.notes.md`

## Why

S6 truth routes cannot safely exist until proof bytes、device-row key authority、request binding 与 replay identity 已冻结并通过 I3。当前 core 只提供 canonical primitives；cloud/Postgres 尚无 verifier、key epoch row 或专用 proof receipt。

## Goal

交付 S6-a：device row 显式 proof key id/epoch、专用 tenant/device/request receipt、raw-byte Ed25519 verifier、DB-row-derived proof principal、bounded time/request binding、Node/Workers golden 与完整 I3 adversarial tests。保持 proof/truth capability undeclared，直到 S6-b 原子 truth composition 存在。

## Scope

- In scope: S6 design/ledger；core proof golden tests；cloud crypto/verifier/principal/device port；InMemory/Postgres device+receipt adapters；forward-only `0004`；conformance/I3 tests。
- Out of scope: record routes、truth committer、inline/object accounting、client signer/selector/fetch、protocol changes、capability default-on。
- Taste constraints: no fallback；claims are lookup keys only；uniform unauthorized；one canonical byte format；no edits to prior migrations。

## Stop Conditions

- Stop if implementation requires `packages/protocol/**` changes or editing `0001`/`0002`/`0003`.
- Stop if proof auth cannot derive final principal exclusively from the device row.
- Stop if receipt replay cannot be tenant+device+request scoped.
- Stop if full hard-dataplane checks cannot run.

## Falsifier

任一 signed request 在 tenant/product/device/key epoch/body/path/resource/time 被修改后仍通过，或同 requestId 在另一 device/不同 binding 下返回首次结果，即证伪本刀。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

## Workflow Inventory

- Source plan: `plans/plan-20260809-0340-s6a-proof-authority.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260809-0340-s6a-proof-authority.review.md`
- Notes file: `tasks/notes/20260809-0340-s6a-proof-authority.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Scope gate: edit only paths listed under `allowed_paths`.
- Completion gate: prepare acceptance, record a typed AcceptanceReceipt, then verify sprint/contract.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/researches/s6-proof-truth-memory-design.md
  - docs/architecture/sdk-architecture.md
  - plans/plan-20260809-0340-s6a-proof-authority.md
  - plans/sprints/20260807-byok-platform-raft-aligned.sprint.md
  - tasks/current.md
  - tasks/todos.md
  - tasks/contracts/20260809-0340-s6a-proof-authority.contract.md
  - tasks/reviews/20260809-0340-s6a-proof-authority.review.md
  - tasks/notes/20260809-0340-s6a-proof-authority.notes.md
  - packages/core/
  - packages/cloud/
  - packages/cloud-postgres/
  - packages/conformance/
  - deploy/sql/0004_device_proof_truth.sql
  - tests/sql/control_plane_invariants.sql
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
    verifier:
      mode: read_only
      purpose: independent_codex_security_review
  runner:
    preferred:
      - codex-exec
      - main-thread
    fallback: main-thread
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - docs/researches/s6-proof-truth-memory-design.md
    - deploy/sql/0004_device_proof_truth.sql
    - packages/cloud/src/auth/device-proof.ts
    - packages/cloud/src/__tests__/device-proof.test.ts
  files_absent: []
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260809-0340-s6a-proof-authority.notes.md
  files_contain:
    - path: packages/cloud/src/auth/device-proof.ts
      pattern: deviceProofSigningInput
    - path: deploy/sql/0004_device_proof_truth.sql
      pattern: proof_request_receipt
  files_not_contain:
    - path: packages/cloud/src/auth/device-proof.ts
      pattern: fallback
  commands_succeed:
    - test -z "$(git diff origin/main -- packages/protocol)"
    - pnpm --filter @byok/core test
    - pnpm --filter @byok/cloud test
    - BYOK_REQUIRE_DATAPLANE=1 BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 pnpm --filter @byok/cloud-postgres test
    - BYOK_REQUIRE_DATAPLANE=1 BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 pnpm -r run typecheck
    - BYOK_REQUIRE_DATAPLANE=1 BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 pnpm -r run test
    - pnpm -r run build
    - repo-harness run check-task-workflow --strict
  tests_pass:
    - path: packages/core/src/__tests__/attestation.test.ts
    - path: packages/cloud/src/__tests__/device-proof.test.ts
```

## Notes

- Claude review is explicitly paused by the user because provider quota is exhausted. No Claude invocation is permitted for this contract.
