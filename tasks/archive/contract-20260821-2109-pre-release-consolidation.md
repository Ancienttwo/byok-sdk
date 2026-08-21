> **Archived**: 2026-08-21 21:09
> **Related Plan**: plans/archive/plan-20260821-2058-pre-release-consolidation.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260821-2109

# Task Contract: pre-release-consolidation

> **Status**: Fulfilled
> **Plan**: plans/plan-20260821-2058-pre-release-consolidation.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-21 21:00
> **Review File**: `tasks/reviews/20260821-2058-pre-release-consolidation.review.md`
> **Notes File**: `tasks/notes/20260821-2058-pre-release-consolidation.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Three historical branches remain outside current main even though one is already
present by patch equivalence and the others contain reviewed schema/release authority
or durable handoff work. Publishing before classifying and consolidating them could
freeze an incomplete or stale source graph into immutable npm versions.

## Goal

Produce one clean, current-main-based release candidate that contains every still-
missing approved WIP change, preserves U1-U5 as the newer semantic authority, closes
the root architecture queue, and passes full product plus packed-runtime verification.
This contract authorizes source integration and release readiness only. Actual npm
publish, tag and GitHub Release happen from the subsequently merged clean main under
a separate exact-SHA release contract.

## Scope

- In scope: hosted schema/migration/keys release authority; Live Activity content-
  absorption proof; root release handoff; current circuit-breaker policy and its
  architecture projection; conflict resolution; full and packed-runtime verification;
  PR acceptance and merge readiness.
- Out of scope: Salesko code, deploy, production migration, production role or secret
  mutation, npm publish, tag and GitHub Release in this contract.
- Taste constraints: no compatibility fallback, no stale workflow resurrection, one
  migration/readback authority, and no synthetic merge for patch-equivalent content.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if conflict resolution would remove any current U1-U5 public contract or
  migration, or if the hosted authority cannot pass against the current schema set.
- Stop before registry/tag/Release mutation; project a separate release contract after
  this exact candidate is merged and old worktrees are cleaned.

## Falsifier

Before expensive checks, merge-tree plus focused diffs must show that current main can
retain U1-U5 while adding the hosted role/migration/keys closures. Any removal of
`0009`-`0011`, terminal usage, readiness, erasure, cancellation, or release identity
proves the resolution wrong. A packed clean install containing multiple core versions
or Worker/Postgres writing SDK tables to `public` also falsifies the candidate.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260821-2058-pre-release-consolidation.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260821-2058-pre-release-consolidation.review.md`
- Notes file: `tasks/notes/20260821-2058-pre-release-consolidation.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"github-ci","kind":"deterministic_test","paths":["*"]},{"id":"packed-and-dataplane-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - .ai/harness/checks/latest.json
  - .ai/harness/checks/change-assessment.latest.json
  - .ai/harness/runs/
  - .ai/harness/failures/
  - .ai/harness/handoff/
  - .ai/harness/worktrees/
  - .ai/harness/policy.json
  - CHANGELOG.md
  - bun.lock
  - docker-compose.test.yml
  - docs/
  - packages/
  - plans/
  - scripts/release/
  - tasks/archive/
  - tasks/current.md
  - tasks/todos.md
  - tasks/contracts/20260821-2058-pre-release-consolidation.contract.md
  - tasks/reviews/20260821-2058-pre-release-consolidation.review.md
  - tasks/notes/20260821-2058-pre-release-consolidation.notes.md
  - templates/
  - tests/
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
    - docs/researches/2026-08-20_hosted-live-activity-pilot-closure.md
    - docs/researches/2026-08-21_local-agent-version-tolerance-handoff.md
    - packages/cloud-dataplane/src/__tests__/fixtures/schema-authority-bootstrap.sql
    - scripts/release/fixtures/keys-0.2.0-stale-core-edge.json
    - tests/unit/keys-release-graph.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260821-2058-pre-release-consolidation.notes.md
    - tasks/reviews/20260821-2058-pre-release-consolidation.review.md
  tests_pass: []
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-deploy-sql-order
    - bun run check:release-graph
    - bun run check:release-pack
    - repo-harness run check-architecture-sync
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint: `origin/main` at plan activation.
- Revert strategy: delete the unmerged candidate branch/worktree or revert its single
  PR merge; no registry, tag, deploy or production state is mutated by this contract.
