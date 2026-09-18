# Task Contract: pr187-review-closeout

> **Status**: Active
> **Plan**: plans/plan-20260917-0218-pr187-review-closeout.md
> **Task Profile**: bugfix
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-17 02:18
> **Review File**: `tasks/reviews/20260917-0218-pr187-review-closeout.review.md`
> **Notes File**: `tasks/notes/20260917-0218-pr187-review-closeout.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

PR187 cannot be safely merged while caller source claims bypass authority, non-cooperative counters block stop, idle retention is unenforced, and runtime faults masquerade as invalid input.

## Goal

Repair and prove the four PR187 preparation review boundaries; preserve durable idempotency and fail-closed authorization. Prepare one accepted patch for PR187 and its safe merge.

## Scope

- In scope: preparation source authorization, bounded counter settlement, lifecycle retention, typed runtime faults, direct regression tests and required projections.
- Out of scope: other C07 features, provider calls, registry publication, other worktrees, browser review.
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

If the old code passes the non-cooperative counter, source denial, idle/restart retention and runtime-fault regression cases, reconsider the diagnosis before changing production code.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: input-preparation-service.ts awaits a cooperative counter after merely aborting its signal, only invokes GC during prepare, never obtains source authorization, and catches runtime import errors as unsupported_input.
- repro: focused input-preparation Vitest regressions on unmodified production source, captured before repair.
- regression_guard: packages/client/src/__tests__/input-preparation.test.ts
- pre_fix_failure_artifact: _ops/pr187-closeout/pre-fix.log

## Workflow Inventory

- Source plan: `plans/plan-20260917-0218-pr187-review-closeout.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260917-0218-pr187-review-closeout.review.md`
- Notes file: `tasks/notes/20260917-0218-pr187-review-closeout.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol": 1, "oracles": [{"id": "preparation-authority-and-lifecycle", "kind": "deterministic_test", "paths": ["*"]}]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-plugin","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - packages/client/src/index.ts
  - packages/client/src/input-preparation.ts
  - packages/client/src/daemon/create-daemon.ts
  - packages/client/src/daemon/input-preparation-service.ts
  - packages/client/src/daemon/input-preparation-store.ts
  - packages/client/src/adapters/pi/input-preparation.ts
  - packages/client/src/__tests__/input-preparation.test.ts
  - packages/client/src/__tests__/input-preparation-store.test.ts
  - packages/client/src/__tests__/input-preparation-control.test.ts
  - packages/client/src/__tests__/pi-input-preparation.test.ts
  - docs/architecture/.projection-manifest.json
  - docs/architecture/modules/sdk/sdk-root.md
  - api-surface/
  - tasks/todos.md
  - .ai/harness/policy.json
  - docs/researches/runtime-input-preparation-contract.md
  - plans/plan-20260917-0218-pr187-review-closeout.md
  - tasks/contracts/20260917-0218-pr187-review-closeout.contract.md
  - tasks/reviews/20260917-0218-pr187-review-closeout.review.md
  - tasks/notes/20260917-0218-pr187-review-closeout.notes.md
  - packages/client/scripts/check-adapters-entry.mjs
  - packages/client/src/__tests__/control-client.test.ts
  - packages/client/src/__tests__/control-protocol.test.ts
  - packages/client/src/__tests__/control-server.test.ts
  - packages/client/src/__tests__/daemon-control-socket.test.ts
  - packages/client/src/bin/control-client.ts
  - packages/client/src/daemon/control-protocol.ts
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

This block contains only non-executable artifact requirements. Define every
executable check once in the canonical Verification Plan below. Each check must
state its phase, cost, evidence policy, necessity, and input environment; a
missing or malformed plan fails closed. Populate artifact requirements only
for deliverables this task actually owns; do not create a spec, notes or report
merely to fill this template.

```yaml
exit_criteria:
  files_exist: []
  artifacts_exist: []
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "guard-input-preparation",
      "kind": "package_test",
      "path": "packages/client/src/__tests__/input-preparation.test.ts",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Focused preparation boundary regression",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "guard-input-preparation-store",
      "kind": "package_test",
      "path": "packages/client/src/__tests__/input-preparation-store.test.ts",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Focused preparation boundary regression",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "guard-input-preparation-control",
      "kind": "package_test",
      "path": "packages/client/src/__tests__/input-preparation-control.test.ts",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Focused preparation boundary regression",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "guard-pi-input-preparation",
      "kind": "package_test",
      "path": "packages/client/src/__tests__/pi-input-preparation.test.ts",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Focused preparation boundary regression",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "build",
      "kind": "command",
      "command": "bun run build",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Required repository build",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "typecheck",
      "kind": "command",
      "command": "bun run typecheck",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Required public resolver contract and all consumers",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "tests",
      "kind": "command",
      "command": "bun run test",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Required repository regression matrix",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "api",
      "kind": "command",
      "command": "bun run check:api-surface",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Public resolver declarations and exports",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "version",
      "kind": "command",
      "command": "bun run check:version-authority",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Required single version authority",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "workflow",
      "kind": "command",
      "command": "repo-harness run check-task-workflow --strict",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Required scope and execution records",
      "inputs": {
        "env": []
      }
    }
  ]
}
```

Author the actual checks using [Testing Policy and Artifact Standards](../../docs/reference-configs/sprint-contracts.md#testing-policy-and-artifact-standards).
The empty array is not permission to omit required repository checks: retain it
only when no executable criterion applies and explain why in Acceptance Notes.
Prefer existing covering tests; creating a task-named test or adding typecheck
is not a template requirement. For each selected check declare `id`, `kind`,
`cwd`, `phase`, `cost`, `evidence_policy`, `necessity`, `inputs.env`, and its
`command` or `path`. Declare the same execution once, including checks nested
inside aggregate scripts. Use `baseline_with_delta` only with an immutable
baseline and named current delta checks; never infer it from paths or command text.

## Acceptance Notes (Human Review)

- Changed behavior/boundary, existing covering tests and remaining gap:
- New test case/file rationale, or why existing coverage is sufficient:
- Selected check IDs and why their coverage is sufficient; omitted coverage:
- Full/expensive check justification and expected cost, if applicable: root AGENTS.md explicitly requires build/typecheck/full test/API/version/workflow. Expected a few minutes per suite; no provider or matrix reruns. Run once after implementation freeze.
- Execution/baseline references, subject, current delta and disposition:
- Residual risks and incomplete observations:

## Rollback Point

- Commit / checkpoint:
- Revert strategy:
