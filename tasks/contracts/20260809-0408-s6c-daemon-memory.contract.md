# Task Contract: s6c-daemon-memory

> **Status**: Fulfilled
> **Plan**: plans/plan-20260809-0408-s6c-daemon-memory.md
> **Task Profile**: code-change
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-09 04:08
> **Review File**: `tasks/reviews/20260809-0408-s6c-daemon-memory.review.md`
> **Notes File**: `tasks/notes/20260809-0408-s6c-daemon-memory.notes.md`

## Why

Cloud 已能验证 proof 并原子提交 truth，但 daemon 尚无 canonical signer、manifest selector 与 hash-verified fetch 路径。若直接把远端 body 交给 runtime，R2 同 size/type 字节替换与 list/get race 都会绕过本地完整性和语义边界。

## Goal

交付 client-side device proof signer 与 `TruthMemoryClient`：显式 tenant/product/key identity；metadata-only manifest；local selector；selected-only fetch；inline/object byte-size + SHA-256 verification；manifest race fail-closed；local filter 是唯一输出；1 MiB snapshot metric；proof-bound snapshot/terminal write。

## Scope

- In scope: client runtime dependency on core；proof signer；truth HTTP DTO decoding；read/write methods；selector/filter/metric seams；real-cloud E2E；architecture/sprint/ledger sync。
- Out of scope: protocol/schema/migration；cloud semantic merge/ranking；automatic task-loop prompt injection；key rotation；object upload implementation（复用既有 reservation/finalize 后的 hash/size）。
- Taste: explicit identity, proof-only auth, fail-closed remote parsing/integrity, no compatibility or bearer fallback。

## Stop Conditions

- Stop if proof canonicalization is copied instead of imported from `@byok/core`。
- Stop if any unverified bytes can reach the filter callback。
- Stop if implementation needs `packages/protocol/**`、`deploy/sql/**` or a migration。
- Stop if the client starts performing cloud-side semantic decisions or guesses runtime prompt shape。

## Falsifier

Return a selected record whose GET metadata differs from the listed manifest, or whose downloaded bytes have the same size but a different hash. If the filter is called or any context is returned, the design is false。

## Workflow Inventory

- Source plan: `plans/plan-20260809-0408-s6c-daemon-memory.md`
- Review: `tasks/reviews/20260809-0408-s6c-daemon-memory.review.md`
- Notes: `tasks/notes/20260809-0408-s6c-daemon-memory.notes.md`
- Completion: stacked Draft PR, CI/readback and independent Codex acceptance；Claude remains paused。

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/architecture/sdk-architecture.md
  - docs/researches/s6-proof-truth-memory-design.md
  - plans/plan-20260809-0408-s6c-daemon-memory.md
  - plans/sprints/20260807-byok-platform-raft-aligned.sprint.md
  - tasks/current.md
  - tasks/todos.md
  - tasks/contracts/20260809-0408-s6c-daemon-memory.contract.md
  - tasks/reviews/20260809-0408-s6c-daemon-memory.review.md
  - tasks/notes/20260809-0408-s6c-daemon-memory.notes.md
  - packages/client/
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
      purpose: implementation_owner
    verifier:
      mode: read_only
      purpose: independent_codex_security_review
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
    - packages/client/src/daemon/device-proof-signer.ts
    - packages/client/src/daemon/truth-memory-client.ts
    - packages/client/src/__tests__/device-proof-signer.test.ts
    - packages/client/src/__tests__/truth-memory-client.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260809-0408-s6c-daemon-memory.notes.md
  files_contain:
    - path: packages/client/src/daemon/device-proof-signer.ts
      pattern: "deviceProofSigningInput"
    - path: packages/client/src/daemon/truth-memory-client.ts
      pattern: "MemorySelector"
  commands_succeed:
    - test -z "$(git diff 7f26b5c -- packages/protocol deploy/sql)"
    - pnpm --filter @byok/client run test
    - BYOK_REQUIRE_DATAPLANE=1 BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 pnpm -r run typecheck
    - BYOK_REQUIRE_DATAPLANE=1 BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 pnpm -r run test
    - pnpm -r run build
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional: proof headers work for list/read/write and exact write replay；selector fetches only selected entries。
- Security: explicit identity, no bearer fallback, remote JSON fail-closed, list/get binding, rehash before filter。
- Reliability: requestId caller-owned for writes；large snapshot metric does not reject or synthesize delta。

## Rollback Point

- Base: `7f26b5c` / PR #35。
- Strategy: revert S6-c client modules/dependency/docs；leave truth capability gated。
