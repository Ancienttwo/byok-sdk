# Task Contract: issue-102-atomic-auth-nonce

> **Status**: Active
> **Plan**: plans/plan-20260831-2147-issue-102-atomic-auth-nonce.md
> **Task Profile**: bugfix
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-31 21:53
> **Review File**: `tasks/reviews/20260831-2147-issue-102-atomic-auth-nonce.review.md`
> **Notes File**: `tasks/notes/20260831-2147-issue-102-atomic-auth-nonce.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

`POST /byok/token` currently validates and consumes a single-use nonce through
two store operations. Two identical concurrent signed requests can both pass
validation and mint access tokens. The mutation authority must select exactly
one winner after signature verification.

## Goal

Replace the hosted nonce split validate/mark-used surface with one atomic
consume-if-valid operation across the port, in-memory implementation, Postgres
implementation, AuthPlane, and token handler so exactly one concurrent request
can mint an access token.

## Scope

- In scope:
  - hosted `NonceStore` port and both in-memory/Postgres implementations;
  - declared cloud port method inventory and nonce/tenant conformance consumers;
  - `AuthPlane` and `/byok/token` composition;
  - deterministic in-memory and Postgres concurrency/negative regressions;
  - focused package build, typecheck, tests, strict contract verification, and
    independent diff review.
- Out of scope:
  - mailbox cursor semantics, pairing transactions, HTTP body limits, client auth request deadlines, publication, deployment, production migration, GitHub issue mutation.
- Taste constraints: signature verification remains before consumption; remove
  the split mutation surface in the same work package; no alias, dual path,
  controller mutex, best-effort rollback, or compatibility fallback.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

Stop if the store cannot atomically bind tenant, device, nonce, expiry, and
unused state while keeping invalid signatures non-consuming. The cheapest proof
is a two-request barrier test where the unfixed implementation mints twice and
the fixed implementation returns exactly one success and one 401.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: `packages/cloud/src/handlers/auth.ts:86` accepts a non-mutating nonce validation before `packages/cloud/src/handlers/auth.ts:96` consumes it, so two same-nonce valid requests released after validation both reach `mintAccessToken`; the Postgres implementation preserves that split with `SELECT` at `packages/cloud-dataplane/src/stores/nonces.ts:57` and unconditional `UPDATE` at `packages/cloud-dataplane/src/stores/nonces.ts:70`.
- repro: `bun --filter @byok-sdk/cloud test -- src/__tests__/auth-parity.test.ts` against the unfixed source deterministically releases two `/byok/token` requests after `validateNonce` and observes two 200 responses.
- regression_guard: packages/cloud/src/__tests__/auth-parity.test.ts
- pre_fix_failure_artifact: tasks/notes/20260831-2147-issue-102-atomic-auth-nonce.pre-fix.log

## Workflow Inventory

- Source plan: `plans/plan-20260831-2147-issue-102-atomic-auth-nonce.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260831-2147-issue-102-atomic-auth-nonce.review.md`
- Notes file: `tasks/notes/20260831-2147-issue-102-atomic-auth-nonce.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"hosted-nonce-contract-suite","kind":"deterministic_test","paths":["*"]},{"id":"postgres-nonce-concurrency-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-plugin","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/
  - tasks/contracts/20260831-2147-issue-102-atomic-auth-nonce.contract.md
  - tasks/reviews/20260831-2147-issue-102-atomic-auth-nonce.review.md
  - tasks/notes/20260831-2147-issue-102-atomic-auth-nonce.notes.md
  - tasks/notes/20260831-2147-issue-102-atomic-auth-nonce.pre-fix.log
  - tasks/todos.md
  - packages/cloud/src/handlers/auth.ts
  - packages/cloud/src/auth/plane.ts
  - packages/cloud/src/stores/ports.ts
  - packages/cloud/src/stores/ports-contract.ts
  - packages/cloud/src/stores/in-memory/nonces.ts
  - packages/cloud/src/__tests__/auth-parity.test.ts
  - packages/cloud/src/__tests__/nonce-store.test.ts
  - packages/cloud-dataplane/src/stores/nonces.ts
  - packages/cloud-dataplane/src/__tests__/nonce-store.test.ts
  - packages/conformance/src/cloud/nonces.ts
  - packages/conformance/src/cloud/tenant-isolation.ts
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
    fallback: null
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - packages/cloud/src/handlers/auth.ts
    - packages/cloud/src/stores/in-memory/nonces.ts
    - packages/cloud-dataplane/src/stores/nonces.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260831-2147-issue-102-atomic-auth-nonce.pre-fix.log
  tests_pass:
    - path: packages/cloud/src/__tests__/auth-parity.test.ts
    - path: packages/cloud/src/__tests__/nonce-store.test.ts
    - path: packages/cloud-dataplane/src/__tests__/nonce-store.test.ts
    - path: packages/conformance/src/compositions/in-memory-cloud.test.ts
    - path: packages/cloud-dataplane/src/__tests__/conformance.test.ts
  commands_succeed:
    - bun --filter @byok-sdk/cloud test -- src/__tests__/auth-parity.test.ts src/__tests__/nonce-store.test.ts
    - bun --filter @byok-sdk/cloud-dataplane test -- src/__tests__/nonce-store.test.ts
    - bun --filter @byok-sdk/conformance test -- src/compositions/in-memory-cloud.test.ts
    - bun --filter @byok-sdk/cloud-dataplane test -- src/__tests__/conformance.test.ts
    - bun run --cwd packages/cloud typecheck
    - bun run --cwd packages/cloud-dataplane typecheck
    - bun run --cwd packages/conformance typecheck
    - bun run --cwd packages/cloud build
    - bun run --cwd packages/cloud-dataplane build
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: exactly one concurrent valid request consumes and mints;
  every loser/replay returns the stable invalid/expired/already-used 401.
- Edge cases: invalid signature does not consume; expired, used, wrong-device,
  and wrong-tenant nonces are rejected by both store implementations.
- Regression risks: changing the public store port must update every
  implementation and consumer in one unit; Postgres SQL must use guarded
  `UPDATE ... RETURNING` rather than SELECT plus UPDATE.

## Rollback Point

- Commit / checkpoint: pre-implementation worktree base.
- Revert strategy: revert the port, both implementations, AuthPlane/handler,
  and their regression tests together; do not retain the split mutation API.
