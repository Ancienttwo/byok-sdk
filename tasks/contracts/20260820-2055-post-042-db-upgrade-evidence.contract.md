# Task Contract: post-042-db-upgrade-evidence

> **Status**: Active
> **Plan**: plans/plan-20260820-2055-post-042-db-upgrade-evidence.md
> **Task Profile**: migration
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-20 20:55
> **Review File**: `tasks/reviews/20260820-2055-post-042-db-upgrade-evidence.review.md`
> **Notes File**: `tasks/notes/20260820-2055-post-042-db-upgrade-evidence.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Migration `0008` is the only new persisted authority after published `v0.4.2`.
An empty-database smoke cannot prove that a real prior-version ledger and
existing mailbox, task, truth, and quota rows survive the candidate upgrade.
Without this slice, the release train has no exact artifact-bound upgrade proof.

## Goal

Produce an exact `0.5.0` candidate package set whose installed
`@byok-sdk/cloud-dataplane` migrates both an empty database and a frozen,
seeded `v0.4.2` fixture. The upgrade must preserve existing rows, apply only
post-`v0.4.2` migrations, install the replay table/indexes, enforce atomic
single-use replay, and remain idempotent.

## Scope

- In scope: frozen `v0.4.2` migration checksums, packed-tarball Postgres smoke,
  aligned dispatch manifest/lockfile candidate version, CI wiring, and A2 evidence.
- Out of scope: production database access, publish, deploy, Salesko repin,
  `@byok-sdk/keys` version changes, connector lifecycle, and rollback SQL.
- Taste constraints: one forward-only runner, one SQL authoring authority, no
  database dump fixture, compatibility migrator, fallback, or production probe.

## Stop Conditions

- Stop if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop before publish, push, deploy, or any connection to a non-disposable database.

## Falsifier

The direction is wrong if tag `v0.4.2` does not freeze migrations `0001`-`0007`
at the recorded checksums, if applying candidate `0008` changes seeded prior
rows, if replay uniqueness is not atomic, or if the exact installed candidate
package graph cannot close to one version. The cheapest first proof is checksum
readback directly from `v0.4.2`.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260820-2055-post-042-db-upgrade-evidence.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260820-2055-post-042-db-upgrade-evidence.review.md`
- Notes file: `tasks/notes/20260820-2055-post-042-db-upgrade-evidence.notes.md`
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
  - .github/workflows/ci.yml
  - bun.lock
  - packages/cloud/package.json
  - packages/cloud-dataplane/package.json
  - packages/client/package.json
  - packages/core/package.json
  - packages/protocol/package.json
  - packages/sdk/package.json
  - packages/server/package.json
  - packages/testkit/package.json
  - packages/ui-runtime/package.json
  - scripts/release/pg-migrate-smoke.mjs
  - scripts/release/fixtures/
  - docs/researches/2026-08-20_post-042-progress-and-sprint-audit.md
  - plans/
  - tasks/todos.md
  - tasks/current.md
  - tasks/contracts/20260820-2055-post-042-db-upgrade-evidence.contract.md
  - tasks/reviews/20260820-2055-post-042-db-upgrade-evidence.review.md
  - tasks/notes/20260820-2055-post-042-db-upgrade-evidence.notes.md
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
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
    - scripts/release/pg-migrate-smoke.mjs
    - scripts/release/fixtures/v0.4.2-migration-checksums.json
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260820-2055-post-042-db-upgrade-evidence.notes.md
  tests_pass:
    - path: packages/cloud-dataplane/src/__tests__/device-assertion-replay.test.ts
  commands_succeed:
    - bun run check:release-graph
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: exact candidate tarballs migrate empty and seeded
  `v0.4.2` schemas, preserve seed rows, and reject a repeated replay key.
- Edge cases: frozen checksum drift, second-run idempotence, prior ledger
  preservation, installed migration directory and index readback.
- Regression risks: generated smoke quoting and Postgres `search_path`
  isolation; both require a real local container run.

## Rollback Point

- Commit / checkpoint: exact local candidate commit used to build release artifacts.
- Revert strategy: revert the candidate commit before publish; disposable
  Postgres schemas require no rollback path.
