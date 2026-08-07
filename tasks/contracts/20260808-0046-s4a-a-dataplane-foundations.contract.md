# Task Contract: s4a-a-dataplane-foundations

> **Status**: Active
> **Plan**: plans/plan-20260808-0046-s4a-a-dataplane-foundations.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-08 00:50
> **Review File**: `tasks/reviews/20260808-0046-s4a-a-dataplane-foundations.review.md`
> **Notes File**: `tasks/notes/20260808-0046-s4a-a-dataplane-foundations.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

S4A moves the hosted data plane onto the ruled production composition (Postgres + R2, ADR-020). This first slice (sprint D-7: S4A-a) lands the three one-way doors everything later inherits: the migration ledger semantics (checksummed, forward-only, advisory-locked), the conformance package shape (one assertion source for every composition, ever), and the cloud-local port table key design (frozen at merge under forward-only migrations). If any of these ships wrong, S4A-b/c build on a broken foundation and the error cost multiplies: a runner bug becomes a production schema incident, a conformance shape that permits per-composition branches reopens the silent-downgrade door the whole program is built to keep shut, and a naked-key table design becomes a cross-tenant exposure that migrations cannot retract. Design authority: `docs/researches/s4a-dataplane-design.md` (decision points 1, 2, 4, 5, 7) and sprint amendments D-6/D-7.

## Goal

Deliver the S4A-a mechanism cut, leaving the whole repo green: root `docker-compose.test.yml` (postgres + minio, healthchecked, test-only credentials); private `@byok/conformance` package holding the nine core dimensions (moved verbatim from `packages/core/src/__tests__/conformance/`, assertion-preserving) plus a new `runCloudConformance` with cloud-local dimensions; `CORE_PORT_METHODS`/`CORE_PORT_INTERFACES` lifted into `@byok/core` shipped source and `CLOUD_PORT_METHODS`/`CLOUD_PORT_INTERFACES` exported from `@byok/cloud` (export-only additions); new `@byok/cloud-postgres` package (README + LICENSE from day one) with a `pg` Pool factory (int8 parser injected, no global mutation), the hand-written ordered migrate runner (sorted `NNNN_*.sql`, `pg_advisory_lock`, self-bootstrapped `byok_schema_migration` ledger, per-file transaction, sha256 checksum fail-closed, no down migrations) and its unit suite; `deploy/sql/0001_cloud_local.sql` creating the seven cloud-local port tables with tenant-first keys (`device_stream` carries both `next_seq` and `acked_seq`); Postgres implementations of the seven cloud-local ports (`devices`, `pairingCodes`, `nonces`, `dedup`, `tasks`, `receipts`, `sequence`; `rateLimiter` stays in-memory, `blobs` is S4A-c) green under the same cloud conformance suite as the in-memory composition; CI `dataplane` job (compose up --wait, `BYOK_REQUIRE_DATAPLANE=1`, Node [20, 22]) plus a source-scan constraint test pinning that job.

## Scope

- In scope: `docker-compose.test.yml`; `packages/conformance/**` (new); `packages/core/**` (conformance move-out, port-table lift, index export); `packages/cloud/**` (export-only: `ports-contract` data + index export); `packages/cloud-postgres/**` (new); `deploy/sql/0001_cloud_local.sql`; `.github/workflows/ci.yml` (new dataplane job); `pnpm-lock.yaml`; workflow/docs artifacts listed in Allowed Paths.
- Out of scope: core seven-port Postgres implementations, `deploy/sql/0002`, `tests/sql/control_plane_invariants.sql`, mailbox retention runbook (all S4A-b); R2 adapter, capability split `blobs.presigned`/`blobs.contentProxy`, `CloudStores.blobs` narrowing, object tests, `deploy/env|runbooks|scripts` (all S4A-c); any change to cloud handlers, routes, or `stores/ports.ts` semantics; any change to `packages/protocol|server|keys|client/**` or `examples/**`; publishing anything.
- Taste constraints: single-statement CAS SQL (no read-modify-write); assertions live in exactly one place; comment density and idiom match the existing core/cloud sources.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if any conformance assertion needs a per-composition branch to pass — that is a port-contract bug to escalate, not a branch to write.
- Stop if the runner design would require a down migration or any destructive path.
- Stop if making the Postgres composition green would require an in-memory stand-in for any port it claims to implement.

## Falsifier

The slice's thesis is that one assertion source can certify both the in-memory and Postgres compositions of the cloud-local ports, with ordering authority left entirely to `check-deploy-sql-order` filenames. Observable evidence of the wrong direction: a cloud conformance dimension that cannot pass on Postgres without weakening or branching an assertion that passes in-memory. Cheapest proof point: implement `pairingCodes` first and run the pairing single-consumption dimension against the compose substrate before building the remaining six ports — redemption CAS is the sharpest semantic (single-statement `UPDATE ... WHERE redeemed_at IS NULL`, zero rows = typed rejection) and fails loudest if the suite shape is wrong.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260808-0046-s4a-a-dataplane-foundations.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260808-0046-s4a-a-dataplane-foundations.review.md`
- Notes file: `tasks/notes/20260808-0046-s4a-a-dataplane-foundations.notes.md`
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
  - tasks/contracts/20260808-0046-s4a-a-dataplane-foundations.contract.md
  - tasks/reviews/20260808-0046-s4a-a-dataplane-foundations.review.md
  - tasks/notes/20260808-0046-s4a-a-dataplane-foundations.notes.md
  - tasks/reviews/byok-document-review-20260807.md # pre-existing user WIP in the primary worktree, not part of this slice; listed so the acceptance allowed_paths sweep does not trip on it
  - .ai/context/capabilities.json
  - .claude/templates/
  - docker-compose.test.yml
  - packages/conformance/
  - packages/core/
  - packages/cloud/
  - packages/cloud-postgres/
  - deploy/sql/
  - .github/workflows/ci.yml
  - pnpm-lock.yaml
  - pnpm-workspace.yaml
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
    - docker-compose.test.yml
    - deploy/sql/0001_cloud_local.sql
    - packages/conformance/package.json
    - packages/cloud-postgres/package.json
    - packages/cloud-postgres/README.md
    - packages/cloud-postgres/LICENSE
    - packages/cloud-postgres/src/migrate.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260808-0046-s4a-a-dataplane-foundations.notes.md
  files_contain:
    # The conformance package is private and never published.
    - path: packages/conformance/package.json
      pattern: '"private": true'
    # The port contract data moved into shipped source, breaking the devDep cycle.
    - path: packages/core/src/index.ts
      pattern: "CORE_PORT_METHODS"
    - path: packages/cloud/src/index.ts
      pattern: "CLOUD_PORT_METHODS"
    # The dataplane job exists and is non-skippable in CI.
    - path: .github/workflows/ci.yml
      pattern: "BYOK_REQUIRE_DATAPLANE"
    # The compose file defines both substrate services.
    - path: docker-compose.test.yml
      pattern: "minio"
    - path: docker-compose.test.yml
      pattern: "postgres"
    # device_stream is created complete so S4A-b never alters a frozen file.
    - path: deploy/sql/0001_cloud_local.sql
      pattern: "acked_seq"
  files_not_contain:
    # Node-free core: the pg dependency may not leak upward.
    - path: packages/core/package.json
      pattern: '"pg"'
    # The stateless handler package may not depend on a database driver.
    - path: packages/cloud/package.json
      pattern: '"pg"'
  commands_succeed:
    - pnpm -r run typecheck
    - pnpm -r run test
    - pnpm -r run build
    - pnpm run check:deploy-sql
    - repo-harness run check-task-workflow --strict
    - git diff --exit-code main -- packages/protocol/ packages/server/ packages/keys/ packages/client/ examples/
    - git diff --exit-code main -- packages/cloud/src/cloud.ts packages/cloud/src/inbound.ts packages/cloud/src/stores/ports.ts
```

## Acceptance Notes (Human Review)

- Functional behavior: cloud conformance dimensions green on the in-memory AND Postgres compositions from one assertion source; migrate runner survives its four-way fault suite (out-of-order files, checksum drift, concurrent runners, partial-failure atomicity); fresh migrate-up from an empty database every CI run.
- Edge cases: pairing redemption double-consume (zero-row CAS = typed rejection); nonce single-use + TTL; dedup boundedness; per-device seq monotonic across reconnect; `resolveByDeviceId`/`redeem` pre-tenant exceptions covered by targeted tenant-isolation assertions.
- Regression risks: conformance move must be assertion-preserving (dimension/assertion counts not decreased — review the move diff as pure relocation); core/cloud export surfaces grow only (no signature changes); frozen directories zero-diff (machine-checked); cloud handler files byte-identical.

## Rollback Point

- Commit / checkpoint: `4efef85` (planning artifacts on main; the slice branch `codex/s4a-a-dataplane-foundations` starts here).
- Revert strategy: everything is additive — revert the PR to restore today exactly (moved conformance files return with it). Migrations are forward-only and no durable environment has executed the runner, so no data-bearing rollback path is required.
