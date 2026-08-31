# Task Contract: issue-104-pairing-transaction

> **Status**: Active
> **Plan**: plans/plan-20260901-0007-issue-104-pairing-transaction.md
> **Task Profile**: bugfix
> **Workflow Profile**: strict
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-01 00:07
> **Review File**: `tasks/reviews/20260901-0007-issue-104-pairing-transaction.review.md`
> **Notes File**: `tasks/notes/20260901-0007-issue-104-pairing-transaction.notes.md`

## Why

The hosted pairing path commits the single-use code before opening the device-registration transaction. A registration error or crash consumes the credential without creating the device.

## Goal

Make code consumption, machine supersession cleanup, and device registration one mandatory composition-owned atomic operation across in-memory and Postgres implementations.

## Scope

- In scope: pairing enrollment port, removal of direct redemption, auth-plane delegation, both compositions, shared Postgres device mutation, failure/concurrency tests, strict verification and independent review.
- Out of scope: protocol shape, code format/lifetime, client enrollment persistence, schema changes, repair of historical redeemed/no-device rows, deployment, production data, merge/push/PR, and GitHub issue mutation.
- Taste constraints: tenant/product only from guarded code claims; no compensation; no handler transaction; no optional method or sequential fallback; preserve machine supersession cleanup.

## Stop Conditions

- Stop if a path outside Allowed Paths is required.
- Stop if the transaction cannot reuse the existing device registration mutation without semantic duplication.
- Stop if a required real Postgres command cannot run in this environment.

## Falsifier

Inject a device-insert failure after a valid code row is selected for consumption. The call must fail with no device or supersession side effect, then the same code must succeed after the fault is removed. Two concurrent calls must create at most one device.

## Root Cause Evidence

- root_cause: `packages/cloud/src/auth/plane.ts` awaits durable `pairingCodes.redeem()` and then `devices.register()`; Postgres redemption autocommits while registration owns a separate transaction, so the first commit survives a second-step failure.
- repro: a one-shot registration failure makes the first pairing reject and a retry with the same code return invalid because `redeemed_at` already committed.
- regression_guard: packages/cloud/src/__tests__/auth-parity.test.ts
- pre_fix_failure_artifact: tasks/notes/20260901-0007-issue-104-pairing-transaction.pre-fix.txt

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"pairing-transaction-regression","kind":"deterministic_test","paths":["*"]},{"id":"postgres-pairing-rollback-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-plugin","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260901-0007-issue-104-pairing-transaction.md
  - tasks/todos.md
  - tasks/contracts/20260901-0007-issue-104-pairing-transaction.contract.md
  - tasks/reviews/20260901-0007-issue-104-pairing-transaction.review.md
  - tasks/notes/20260901-0007-issue-104-pairing-transaction.notes.md
  - tasks/notes/20260901-0007-issue-104-pairing-transaction.pre-fix.txt
  - packages/cloud/src/auth/plane.ts
  - packages/cloud/src/index.ts
  - packages/cloud/src/stores/ports.ts
  - packages/cloud/src/stores/ports-contract.ts
  - packages/cloud/src/stores/in-memory/index.ts
  - packages/cloud/src/stores/in-memory/pairing-codes.ts
  - packages/cloud/src/__tests__/auth-parity.test.ts
  - packages/cloud/src/__tests__/constraints.test.ts
  - packages/conformance/src/cloud/harness.ts
  - packages/conformance/src/cloud/pairing.ts
  - packages/conformance/src/cloud/tenant-isolation.ts
  - packages/conformance/src/compositions/in-memory-cloud.test.ts
  - packages/cloud-dataplane/src/stores/devices.ts
  - packages/cloud-dataplane/src/stores/pairing-codes.ts
  - packages/cloud-dataplane/src/stores/index.ts
  - packages/cloud-dataplane/src/__tests__/pairing-transaction.test.ts
  - packages/cloud-dataplane/worker-smoke/src.ts
```

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - packages/cloud/src/auth/plane.ts
    - packages/cloud/src/stores/ports.ts
    - packages/cloud-dataplane/src/stores/pairing-codes.ts
    - packages/cloud-dataplane/src/__tests__/pairing-transaction.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260901-0007-issue-104-pairing-transaction.pre-fix.txt
  tests_pass:
    - path: packages/cloud/src/__tests__/auth-parity.test.ts
    - path: packages/conformance/src/compositions/in-memory-cloud.test.ts
    - path: packages/cloud-dataplane/src/__tests__/pairing-transaction.test.ts
    - path: packages/cloud-dataplane/src/__tests__/conformance.test.ts
  commands_succeed:
    - bun --filter @byok-sdk/cloud test -- src/__tests__/auth-parity.test.ts src/__tests__/constraints.test.ts
    - bun --filter @byok-sdk/conformance test -- src/compositions/in-memory-cloud.test.ts
    - BYOK_REQUIRE_DATAPLANE=1 BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 bun --filter @byok-sdk/cloud-dataplane test -- src/__tests__/pairing-transaction.test.ts src/__tests__/conformance.test.ts
    - bun run --cwd packages/cloud typecheck
    - bun run --cwd packages/cloud-dataplane typecheck
    - bun run --cwd packages/conformance typecheck
    - bun run --cwd packages/cloud build
    - bun run --cwd packages/cloud-dataplane build
    - git diff --check
```

## Rollback Point

- Commit / checkpoint: `2c039165f35c9d0167dfe7eaa296871faf846a03`.
- Revert strategy: revert the enrollment port, both implementations, auth-plane delegation, shared registration helper, and tests together.
