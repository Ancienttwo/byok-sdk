# Task Contract: issue-103-mailbox-cursor-atomicity

> **Status**: Fulfilled
> **Plan**: plans/plan-20260831-2304-issue-103-mailbox-cursor-atomicity.md
> **Task Profile**: bugfix
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-31 23:50
> **Review File**: `tasks/reviews/20260831-2304-issue-103-mailbox-cursor-atomicity.review.md`
> **Notes File**: `tasks/notes/20260831-2304-issue-103-mailbox-cursor-atomicity.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The authenticated events route advances durable mailbox acknowledgement to any client-supplied non-negative integer. A forged future cursor can make present and later control messages permanently unreadable.

## Goal

Bind mailbox acknowledgement to a server-owned delivery watermark, reject future/unsafe cursors without mutation, and preserve normal monotonic replay/ack behavior across in-memory and Postgres compositions.

## Scope

- In scope:
  - core mailbox port/state/error vocabulary;
  - in-memory and Postgres implementations;
  - additive SQL migration and catalog invariant;
  - hosted events handler;
  - route/store/conformance regressions;
  - strict verification and independent review.
- Out of scope:
  - client cursor/journal behavior, protocol shape changes, mailbox retention policy, deployment, production migration execution, publication, merge/push/PR, and GitHub issue mutation.
- Taste constraints: no deriving delivery from enqueue high-watermark; no handler-local mutex; no compatibility alias or optional store method; reads remain non-acknowledging; Postgres acknowledgement selection stays in one guarded statement.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

Stop if a two-poll sequence cannot distinguish server-returned cursors from merely allocated/enqueued sequences. The cheapest proof is a forged future cursor that fails without mutation, followed by enqueue and a poll that still delivers the new envelope.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: `packages/cloud/src/handlers/events.ts` accepts every non-negative integer and calls `MailboxStore.advanceCursor`; both store implementations enforce only monotonic non-regression and hold no server-owned delivered watermark, so a future value durably moves acknowledgement and marks all rows at or below it acked.
- repro: `bun --filter @byok-sdk/cloud test -- src/__tests__/mailbox-cursor.test.ts` against the unfixed source accepts `cursor=999999999`, persists that value, then suppresses a newly enqueued lower-sequence envelope.
- regression_guard: packages/cloud/src/__tests__/mailbox-cursor.test.ts
- pre_fix_failure_artifact: tasks/notes/20260831-2304-issue-103-mailbox-cursor-atomicity.pre-fix.txt

## Workflow Inventory

- Source plan: `plans/plan-20260831-2304-issue-103-mailbox-cursor-atomicity.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260831-2304-issue-103-mailbox-cursor-atomicity.review.md`
- Notes file: `tasks/notes/20260831-2304-issue-103-mailbox-cursor-atomicity.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"mailbox-future-cursor-contract-suite","kind":"deterministic_test","paths":["*"]},{"id":"postgres-mailbox-delivery-watermark-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-plugin","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260831-2304-issue-103-mailbox-cursor-atomicity.md
  - tasks/todos.md
  - tasks/contracts/20260831-2304-issue-103-mailbox-cursor-atomicity.contract.md
  - tasks/reviews/20260831-2304-issue-103-mailbox-cursor-atomicity.review.md
  - tasks/notes/20260831-2304-issue-103-mailbox-cursor-atomicity.notes.md
  - tasks/notes/20260831-2304-issue-103-mailbox-cursor-atomicity.pre-fix.txt
  - packages/core/src/errors.ts
  - packages/core/src/index.ts
  - packages/core/src/mailbox.ts
  - packages/core/src/ports-contract.ts
  - packages/core/src/in-memory/mailbox.ts
  - packages/conformance/src/core/mailbox.ts
  - packages/conformance/src/core/tenant-isolation.ts
  - packages/cloud/src/handlers/events.ts
  - packages/cloud/src/tenant-stores.ts
  - packages/cloud/src/__tests__/mailbox-cursor.test.ts
  - packages/cloud/src/__tests__/task-cancellation.test.ts
  - packages/cloud-dataplane/src/stores/core/mailbox.ts
  - packages/cloud-dataplane/src/__tests__/cleanup.test.ts
  - packages/cloud-dataplane/worker-smoke/src.ts
  - deploy/sql/0016_mailbox_delivery_watermark.sql
  - tests/sql/control_plane_invariants.sql
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
    - packages/cloud/src/handlers/events.ts
    - packages/core/src/in-memory/mailbox.ts
    - packages/cloud-dataplane/src/stores/core/mailbox.ts
    - deploy/sql/0016_mailbox_delivery_watermark.sql
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260831-2304-issue-103-mailbox-cursor-atomicity.pre-fix.txt
  tests_pass:
    - path: packages/cloud/src/__tests__/mailbox-cursor.test.ts
    - path: packages/conformance/src/compositions/in-memory-core.test.ts
    - path: packages/cloud-dataplane/src/__tests__/cleanup.test.ts
    - path: packages/cloud-dataplane/src/__tests__/core-conformance.test.ts
    - path: packages/cloud-dataplane/src/__tests__/invariants.test.ts
  commands_succeed:
    - bun --filter @byok-sdk/cloud test -- src/__tests__/mailbox-cursor.test.ts
    - bun --filter @byok-sdk/conformance test -- src/compositions/in-memory-core.test.ts
    - BYOK_REQUIRE_DATAPLANE=1 BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 bun --filter @byok-sdk/cloud-dataplane test -- src/__tests__/core-conformance.test.ts
    - BYOK_REQUIRE_DATAPLANE=1 BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 bun --filter @byok-sdk/cloud-dataplane test -- src/__tests__/conformance.test.ts src/__tests__/cleanup.test.ts src/__tests__/invariants.test.ts
    - bun run --cwd packages/core typecheck
    - bun run --cwd packages/cloud typecheck
    - bun run --cwd packages/cloud-dataplane typecheck
    - bun run --cwd packages/conformance typecheck
    - bun run --cwd packages/core build
    - bun run --cwd packages/cloud build
    - bun run --cwd packages/cloud-dataplane build
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: only a cursor previously returned by the server may advance durable acknowledgement.
- Edge cases: unsafe integers and negative/fractional/non-numeric cursors reject before store mutation; future safe integers conflict without mutation; equal/older cursors preserve existing behavior.
- Regression risks: migration must backfill existing `delivered_seq` from acknowledged truth; Postgres ack and outbox marking must remain one statement.

## Rollback Point

- Commit / checkpoint: `2c039165f35c9d0167dfe7eaa296871faf846a03`.
- Revert strategy: revert the port, stores, migration, route, and tests together; do not leave an optional or dual cursor authority.
