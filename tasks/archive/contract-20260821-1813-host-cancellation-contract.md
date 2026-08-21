> **Archived**: 2026-08-21 18:13
> **Related Plan**: plans/archive/plan-20260821-1645-host-cancellation-contract.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260821-1813

# Task Contract: host-cancellation-contract

> **Status**: Fulfilled
> **Plan**: plans/plan-20260821-1645-host-cancellation-contract.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-21 16:45
> **Review File**: `tasks/reviews/20260821-1645-host-cancellation-contract.review.md`
> **Notes File**: `tasks/notes/20260821-1645-host-cancellation-contract.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Salesko has made BYOK the fail-closed dispatch authority, but its host-side
cancel currently changes only the Salesko job row. The hosted SDK keeps the
device work alive, allowing it to spend user tokens and race a later success
against the host's cancellation. This work package closes that cross-process
authority gap before Salesko S2 can ship.

## Goal

Ship one tenant-scoped host cancellation operation that atomically persists a
durable cancellation tombstone and its device delivery, prevents an offline
device from starting cancelled work, reuses the existing client
`Session.interrupt()`/`Session.close()` lifecycle for running work, and makes
an accepted cancellation outrank a later success receipt.

## Scope

- In scope:
  - Hosted task-attempt `cancel_requested` state plus cancellation timestamp/reason authority.
  - Tenant-scoped `ByokCloud.cancelTask()` and one atomic cancellation mutation port.
  - In-memory and PostgreSQL implementations, including a forward-only additive migration.
  - Long-poll filtering so a cancellation tombstone suppresses the original offer while retaining `task.cancel` delivery.
  - Cancellation-first terminal projection and the five required acceptance scenarios.
  - Client regression proof for existing runtime interrupt/close and `task.cancelled` behavior.
- Out of scope:
  - U2 usage telemetry, U3 readiness, U4 release hygiene, package version bumps, publishing, deployment, production migration, and Salesko changes.
- Taste constraints: one cancellation authority; no dual read/write, compatibility alias, repair/fallback result path, second process-kill API, multi-backend abstraction, or load-aware scheduler.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Safe path: work only in the dedicated contract worktree after its base and
  ownership are verified; preserve the root worktree's release-identity and
  architecture WIP.
- Destructive boundary: no publish, deploy, production migration, down
  migration, secret mutation, force push/reset, worktree removal, or user-data
  deletion is authorized.

## Falsifier

If the task tombstone and mailbox cancellation cannot be committed under one
composition-owned atomic boundary, stop rather than ship an accepted-but-
undeliverable cancellation. Cheapest proof: an injected-failure test around
the cancellation mutation must show both state and mailbox remain unchanged.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260821-1645-host-cancellation-contract.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260821-1645-host-cancellation-contract.review.md`
- Notes file: `tasks/notes/20260821-1645-host-cancellation-contract.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"u1-contract-tests","kind":"deterministic_test","paths":["*"]},{"id":"u1-postgres-minio-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - docs/protocol.md
  - plans/
  - tasks/contracts/20260821-1645-host-cancellation-contract.contract.md
  - tasks/reviews/20260821-1645-host-cancellation-contract.review.md
  - tasks/notes/20260821-1645-host-cancellation-contract.notes.md
  - tasks/todos.md
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
  - deploy/sql/
  - packages/protocol/src/
  - packages/cloud/src/
  - packages/cloud-dataplane/src/
  - packages/client/src/
  - packages/testkit/src/
  - packages/conformance/src/
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
    - docs/spec.md
    - deploy/sql/0009_task_cancellation.sql
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260821-1645-host-cancellation-contract.notes.md
  commands_succeed:
    - bun run --cwd packages/cloud test -- src/__tests__/task-cancellation.test.ts src/__tests__/mailbox-cursor.test.ts src/__tests__/inbound-gate.test.ts
    - bun run --cwd packages/client test -- src/__tests__/task-runner-cancel-race.test.ts src/__tests__/real-cloud-longpoll.test.ts
    - bun run --cwd packages/conformance test -- src/compositions/in-memory-cloud.test.ts
    - BYOK_REQUIRE_DATAPLANE=1 bun run --cwd packages/cloud-dataplane test -- src/__tests__/task-cancellation.test.ts src/__tests__/invariants.test.ts
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: cancellation is tenant-closed, durable, idempotent, and interrupts running work through the existing runtime lifecycle.
- Edge cases: pre-lease, running, offline reconnect, cancellation/success race, duplicate cancellation, unknown/cross-tenant task, and atomic rollback.
- Regression risks: mailbox cursor ordering, task terminal first-write-wins, PostgreSQL migration parity, and all-or-nothing CloudStores composition.

## Rollback Point

- Commit / checkpoint: exact reviewed candidate commit recorded during verification.
- Revert strategy: before deploy, revert the coherent code/migration diff; after any forward migration, disable the host entrypoint while retaining additive schema and data.
