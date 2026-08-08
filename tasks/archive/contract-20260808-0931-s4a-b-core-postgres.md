> **Archived**: 2026-08-08 09:31
> **Related Plan**: plans/archive/plan-20260808-0232-s4a-b-core-postgres.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260808-0931

# Task Contract: s4a-b-core-postgres

> **Status**: Fulfilled
> **Plan**: plans/plan-20260808-0232-s4a-b-core-postgres.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-08 02:40
> **Review File**: `tasks/reviews/20260808-0232-s4a-b-core-postgres.review.md`
> **Notes File**: `tasks/notes/20260808-0232-s4a-b-core-postgres.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

S4A-b is the domain cut of the data plane (sprint D-7): the seven `@byok/core` ports get their production Postgres implementations, and the 56-case conformance suite — whose assertions were frozen byte-identical in S4A-a — becomes the proof that in-memory and Postgres agree on the program's heaviest semantics: board five-state CAS, truth first-hash-wins, mailbox read-not-ack with mark-not-delete retirement, quota no-oversell (D-6 pulled the quota trio forward because the suite is all-or-nothing). `0002` freezes at merge under forward-only migrations, and `tests/sql/control_plane_invariants.sql` turns the tenant-first key discipline (§12.6.2 layer 3) into an executable catalog assertion that operators can run against production. This closes the I4 SQL-side commitment recorded in D-2. Shipped wrong, an oversold reservation or a deleted unacked mailbox row is a durable-data incident no later slice can retract. Design authority: `docs/researches/s4a-dataplane-design.md` (§5, §8, §9, §10, §11) and sprint amendments D-6/D-7.

## Goal

Deliver the S4A-b domain cut, leaving the whole repo green: the two S4A-a gate P2 ride-alongs (migrate runner ROLLBACK shadowing fix; `noteSkippedSeq` todos trigger narrowed to protocol-bump-only); `deploy/sql/0002_core_domain.sql` with the eleven core-domain tables per design §5 (canonical-instant columns TEXT, byte sizes BIGINT, every key tenant-first, `0001` untouched); Postgres implementations of all seven core ports under `packages/cloud-postgres/` (single-statement CAS discipline; quota reserve aggregate-guarded in one statement; mailbox `advanceCursor` monotonic; `collectRetired` deletes acked rows and marks unacked rows `expired`, never deleting them); a Postgres core composition entry running `runCoreConformance('postgres', factory)` at 56/56 with the conformance package zero-diff; `tests/sql/control_plane_invariants.sql` (executable `DO $$` catalog assertions: tenant-first UNIQUE rule with the two-entry whitelist, `tenant_id NOT NULL` on every tenant-owned table; header references both migrations, satisfying check-deploy-sql reference mode) plus a test executing it post-migration; and `deploy/runbooks/mailbox-retention.md` (default windows, host-driven invocation, §12.7.5 mapping, the ring-vs-SQL non-interchangeability clause, the `noteSkippedSeq` evidence gap).

## Scope

- In scope: `deploy/sql/0002_core_domain.sql`; `packages/cloud-postgres/**` (core store implementations, composition entry, invariants test, index export, the P2 migrate.ts fix); `tests/sql/control_plane_invariants.sql`; `deploy/runbooks/mailbox-retention.md`; `tasks/todos.md` (P2 trigger narrowing); workflow/docs artifacts listed in Allowed Paths.
- Out of scope: R2 adapter, capability split, `CloudStores.blobs` narrowing, object tests, `deploy/env|scripts` (all S4A-c); dead-letter flow, reservation-bound presign, GC/reconciliation (all S4B); any change to `packages/core|cloud|protocol|server|keys|client/**`, `examples/**`, or `deploy/sql/0001_cloud_local.sql`; any conformance assertion change; publishing anything.
- Taste constraints: single-statement CAS SQL (no read-modify-write); assertions live in exactly one place (catalog rules only in the invariants SQL, behavior rules only in the conformance dimensions); comment density and idiom match the existing cloud-postgres sources.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if any conformance assertion needs a change or a per-composition branch to pass on Postgres — that is a port-contract bug to escalate, not an assertion to adjust.
- Stop if any implementation would require editing `deploy/sql/0001_cloud_local.sql` (it is frozen; the runner's checksum enforces this at runtime and the zero-diff check at review).
- Stop if a CAS or quota path cannot be expressed as a single guarded statement and seems to need read-then-write.
- Stop if any retirement/cleanup path would delete an unacked mailbox row.

## Falsifier

The slice's thesis is that the frozen 56-case suite certifies the Postgres composition without touching a single assertion, and that the §5 schema supports all seven port contracts as single-statement SQL. Observable evidence of the wrong direction: a core dimension that cannot pass on Postgres without weakening an assertion, or a port method whose contract forces multi-statement read-then-write on a competitive path. Cheapest proof point: implement quota first and run the quota dimension (36 expects, incl. concurrency) against the compose substrate before the other six ports — reserve's aggregate-guarded insert is the hardest statement in the slice and fails loudest if the schema shape or the single-statement discipline is wrong.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260808-0232-s4a-b-core-postgres.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260808-0232-s4a-b-core-postgres.review.md`
- Notes file: `tasks/notes/20260808-0232-s4a-b-core-postgres.notes.md`
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
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260808-0232-s4a-b-core-postgres.contract.md
  - tasks/reviews/20260808-0232-s4a-b-core-postgres.review.md
  - tasks/notes/20260808-0232-s4a-b-core-postgres.notes.md
  - .ai/context/capabilities.json
  - .claude/templates/
  - packages/cloud-postgres/
  - packages/conformance/ # prefer zero diff; minimal export addition only if an import is genuinely unavailable
  - deploy/sql/
  - tests/sql/
  - deploy/runbooks/
  - .github/workflows/ci.yml # prefer zero diff; the dataplane job filters should already cover the new entries
  - docs/architecture/
  - docs/researches/
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
    - deploy/sql/0002_core_domain.sql
    - tests/sql/control_plane_invariants.sql
    - deploy/runbooks/mailbox-retention.md
    - packages/cloud-postgres/src/__tests__/core-conformance.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260808-0232-s4a-b-core-postgres.notes.md
  files_contain:
    # D-6 evidence: the quota trio and the object manifest landed in this slice's migration.
    - path: deploy/sql/0002_core_domain.sql
      pattern: "storage_reservation"
    - path: deploy/sql/0002_core_domain.sql
      pattern: "object_manifest"
    # Reference mode: the invariants file must claim both migrations.
    - path: tests/sql/control_plane_invariants.sql
      pattern: "0001_cloud_local\.sql"
    - path: tests/sql/control_plane_invariants.sql
      pattern: "0002_core_domain\.sql"
    # The runbook carries the two required clauses.
    - path: deploy/runbooks/mailbox-retention.md
      pattern: "noteSkippedSeq"
    - path: deploy/runbooks/mailbox-retention.md
      pattern: "ring"
  files_not_contain:
    # P2 evidence: the consumed S4A trigger branch is gone from the ledger row.
    - path: tasks/todos.md
      pattern: "mailbox retention work"
  commands_succeed:
    - pnpm -r run typecheck
    - pnpm -r run test
    - pnpm -r run build
    - pnpm run check:deploy-sql
    - repo-harness run check-task-workflow --strict
    - git diff --exit-code main -- packages/protocol/ packages/server/ packages/keys/ packages/client/ packages/core/ packages/cloud/ examples/
    - git diff --exit-code main -- deploy/sql/0001_cloud_local.sql
```

## Acceptance Notes (Human Review)

- Functional behavior: core conformance 56/56 on the Postgres composition with `packages/conformance/` zero-diff; cloud conformance 44/44 regression; invariants file executes clean post-migration; quota concurrency case green against real Postgres contention.
- Edge cases: stale ack (monotonic guard no-ops); double reserve racing the same entitlement (exactly one wins); truth re-attest with identical hash (idempotent) vs different hash (first wins, typed rejection); board claim on a claimed item (current snapshot returned); collectRetired with unacked rows (marked `expired`, never deleted); expireReservations against the injected clock only.
- Regression risks: 0002 key/type design freezes at merge (DDL review against §5 line-by-line); check-deploy-sql flips to reference mode when the invariants file lands (both migrations referenced from day one); the S4A-a suites must stay green untouched.

## Rollback Point

- Commit / checkpoint: `d62f608` (planning artifacts on main; the slice branch `codex/s4a-b-core-postgres` starts here).
- Revert strategy: everything is additive on top of S4A-a — revert the PR to restore the post-S4A-a state. Migrations are forward-only and no durable environment has executed `0002`; the frozen `0001` is untouched by construction.
