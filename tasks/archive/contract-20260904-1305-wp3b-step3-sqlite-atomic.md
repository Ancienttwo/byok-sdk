> **Archived**: 2026-09-04 13:05
> **Related Plan**: plans/archive/plan-20260904-1237-wp3b-step3-sqlite-atomic.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260904-1305
> **Archive Projection V1**: `plans/plan-20260904-1237-wp3b-step3-sqlite-atomic.md` => `plans/archive/plan-20260904-1237-wp3b-step3-sqlite-atomic.md`
> **Archive Projection V1**: `tasks/notes/20260904-1237-wp3b-step3-sqlite-atomic.notes.md` => `tasks/archive/notes-20260904-1305-wp3b-step3-sqlite-atomic.md`
> **Archive Projection V1**: `tasks/contracts/20260904-1237-wp3b-step3-sqlite-atomic.contract.md` => `tasks/archive/contract-20260904-1305-wp3b-step3-sqlite-atomic.md`
> **Archive Projection V1**: `tasks/reviews/20260904-1237-wp3b-step3-sqlite-atomic.review.md` => `tasks/archive/review-20260904-1305-wp3b-step3-sqlite-atomic.md`

# Task Contract: wp3b-step3-sqlite-atomic

> **Status**: Fulfilled
> **Plan**: plans/archive/plan-20260904-1237-wp3b-step3-sqlite-atomic.md
> **Task Profile**: code-change
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-04 12:40
> **Review File**: `tasks/archive/review-20260904-1305-wp3b-step3-sqlite-atomic.md`
> **Notes File**: `tasks/archive/notes-20260904-1305-wp3b-step3-sqlite-atomic.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The reference server lost its SQLite mode during Step 2. The original four-interface Step 3 shape cannot satisfy the current atomic cancellation contract because task attempts and cancellation delivery would live under different authorities.

## Goal

Provide an explicit SQLite embedded composition in which task attempt, cancellation, mailbox, object manifest, blob grant metadata, and blob bytes survive restart without dual writes or semantic fallbacks, while every other port remains in-memory.

## Scope

- In scope: six-interface SQLite composition; server selection/lifecycle; unmodified conformance; example SQLite mode and restart proof; design packet correction.
- Out of scope: remaining core/cloud ports, client Step 4 paths, production migration, release, push, PR, merge.
- Taste constraints: one database/transaction coordinator; storage modes are mutually exclusive; corrupt/unsupported SQLite fails closed.

## Stop Conditions

- Stop if correctness requires dual reads/writes, two mailbox sequence authorities, or a runtime fallback from SQLite to memory.
- Stop if a second unrelated failure blocks this deliverable.
- Stop after three fix/reverify rounds for one issue.

## Falsifier

Any unmodified conformance assertion fails, cancellation can commit only one of tombstone/delivery, a reopened server cannot read persisted task/blob/mailbox state, or `BYOK_STORE=sqlite` silently uses memory.

## Workflow Inventory

- Source plan: `plans/archive/plan-20260904-1237-wp3b-step3-sqlite-atomic.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/archive/review-20260904-1305-wp3b-step3-sqlite-atomic.md`
- Notes file: `tasks/archive/notes-20260904-1305-wp3b-step3-sqlite-atomic.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed below; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt, then run `verify-sprint`.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"sqlite-conformance-and-atomic-guards","kind":"deterministic_test","paths":["*"]},{"id":"sqlite-server-restart-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/archive/plan-20260904-1237-wp3b-step3-sqlite-atomic.md
  - tasks/archive/contract-20260904-1305-wp3b-step3-sqlite-atomic.md
  - tasks/archive/review-20260904-1305-wp3b-step3-sqlite-atomic.md
  - tasks/archive/notes-20260904-1305-wp3b-step3-sqlite-atomic.md
  - tasks/todos.md
  - tasks/current.md
  - docs/researches/2026-09-03_wp3b-coordination-kernel-design-packet.md
  - packages/server/src/stores.ts
  - packages/server/src/index.ts
  - packages/server/src/types.ts
  - packages/server/src/sqlite-support.ts
  - packages/server/src/stores/sqlite/
  - packages/server/src/__tests__/
  - packages/server/package.json
  - examples/basic/
  - api-surface/server.d.ts
  - bun.lock
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
    preferred: []
    fallback: null
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - packages/server/src/stores/sqlite/index.ts
    - packages/server/src/stores/sqlite/__tests__/conformance.test.ts
    - packages/server/src/stores/sqlite/__tests__/atomic-restart.test.ts
  artifacts_exist:
    - tasks/archive/notes-20260904-1305-wp3b-step3-sqlite-atomic.md
  tests_pass:
    - path: packages/server/src/stores/sqlite/__tests__/conformance.test.ts
    - path: packages/server/src/stores/sqlite/__tests__/atomic-restart.test.ts
  commands_succeed:
    - bun run --cwd packages/server test -- stores/sqlite
    - bun run --cwd packages/server test
    - bun run build
    - bun run typecheck
    - bun run test
    - bun run check:api-surface
    - bun run check:version-authority
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: explicit SQLite mode survives restart; memory remains default.
- Edge cases: tenant isolation, idempotent open/grant, immutable terminal/manifest, rollback on cancellation failure, owner-only database files.
- Regression risks: shared connection lifecycle, async transaction serialization, API golden drift.

## Rollback Point

- Commit / checkpoint: `10bb9fc76b0a1ee3a533f50a42e869235c5c7bd1`
- Revert strategy: revert the Step 3 commit; no production migration exists.
