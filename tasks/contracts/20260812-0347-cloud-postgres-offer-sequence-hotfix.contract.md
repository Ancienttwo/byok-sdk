# Task Contract: cloud-postgres-offer-sequence-hotfix

> **Status**: Partial
> **Plan**: plans/plan-20260812-0347-cloud-postgres-offer-sequence-hotfix.md
> **Task Profile**: bugfix
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-12 03:47
> **Review File**: `tasks/reviews/20260812-0347-cloud-postgres-offer-sequence-hotfix.review.md`
> **Notes File**: `tasks/notes/20260812-0347-cloud-postgres-offer-sequence-hotfix.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

`@byok-sdk/cloud-postgres@0.2.0` cannot deliver any offer: the cloud sequence
store and mailbox both increment the same database counter, so every envelope
and row disagree and the control-plane call returns 500 after writing outbox.

## Goal

Make mailbox append the single atomic per-device sequence authority across the
in-memory and Postgres compositions, keep core protocol-free through an opaque
body factory, and make dead-letter replay bind its cloned envelope/hash/size to
the newly allocated row sequence.

## Scope

- In scope: core mailbox contract/reference/conformance; cloud offer composition
  and removal of the redundant sequence port; Postgres transactional append;
  protocol-aware dead-letter replay; package dependency/constraint updates;
  durable bug report and obsolete todo closeout.
- Out of scope: schema migrations, release/publish/versioning, unrelated active
  sprint work, and changes to the user-owned provider-adapter PRD.
- Taste constraints: one authority only; no dual API, body parsing inside core,
  heuristic compatibility path, or silent mismatch suppression.

## Stop Conditions

- Stop and update this human-approved contract before editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop after three fail-fix-reverify loops for one issue.

## Falsifier

If a mailbox-owned `materialize(seq)` operation cannot serialize allocation,
body creation, and row insertion without violating the protocol-free core
boundary, this direction is wrong. The cheapest proof is the in-memory and
real-Postgres concurrent append conformance plus the end-to-end offer test.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: `packages/cloud/src/cloud.ts:413` allocates N through
  `cloud.sequence`, then `packages/cloud-postgres/src/stores/core/mailbox.ts:111`
  allocates N+1 from the same `device_stream.next_seq`, so the equality guard
  throws after the outbox insert.
- repro: `BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 pnpm --filter @byok-sdk/cloud-postgres exec vitest run src/__tests__/conformance.test.ts -t "persists the exact sequence encoded into an offer envelope"`
- regression_guard: packages/cloud-postgres/src/__tests__/conformance.test.ts
- pre_fix_failure_artifact: tasks/notes/20260812-0347-cloud-postgres-offer-sequence-hotfix.pre-fix.md

## Workflow Inventory

- Source plan: `plans/plan-20260812-0347-cloud-postgres-offer-sequence-hotfix.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260812-0347-cloud-postgres-offer-sequence-hotfix.review.md`
- Notes file: `tasks/notes/20260812-0347-cloud-postgres-offer-sequence-hotfix.notes.md`
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
  - packages/core/
  - packages/cloud/
  - packages/cloud-postgres/
  - packages/conformance/
  - pnpm-lock.yaml
  - docs/researches/2026-08-12-cloud-postgres-offer-sequence-p0.md
  - plans/plan-20260812-0347-cloud-postgres-offer-sequence-hotfix.md
  - tasks/todos.md
  - tasks/contracts/20260812-0347-cloud-postgres-offer-sequence-hotfix.contract.md
  - tasks/reviews/20260812-0347-cloud-postgres-offer-sequence-hotfix.review.md
  - tasks/notes/20260812-0347-cloud-postgres-offer-sequence-hotfix.notes.md
  - tasks/notes/20260812-0347-cloud-postgres-offer-sequence-hotfix.pre-fix.md
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
    - docs/researches/2026-08-12-cloud-postgres-offer-sequence-p0.md
  artifacts_exist:
    - tasks/notes/20260812-0347-cloud-postgres-offer-sequence-hotfix.notes.md
  tests_pass:
    - path: packages/cloud-postgres/src/__tests__/conformance.test.ts
    - path: packages/cloud-postgres/src/__tests__/cleanup.test.ts
    - path: packages/conformance/src/compositions/in-memory-core.test.ts
  commands_succeed:
    - BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 pnpm --filter @byok-sdk/cloud-postgres test
    - pnpm -r run typecheck
    - pnpm -r run test
    - pnpm -r run build
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: offer envelope seq equals outbox row seq; delivery no longer returns 500.
- Edge cases: concurrent appends remain commit-ordered; failed materialization consumes no sequence; replay recalculates size across digit boundaries.
- Regression risks: public removal of `DeviceSequenceStore`; longer per-device lock duration while hashing.

## Rollback Point

- Commit / checkpoint: parent base `bf8d711`; revert the work-package commit as one unit.
- Revert strategy: revert the work-package diff as one unit; no schema/data rollback exists or is required.
