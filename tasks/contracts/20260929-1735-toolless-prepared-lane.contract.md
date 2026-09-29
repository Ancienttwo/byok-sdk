# Task Contract: toolless-prepared-lane

> **Status**: Active
> **Plan**: plans/plan-20260929-1735-toolless-prepared-lane.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-29T17:50:00+0800
> **Review File**: `tasks/reviews/20260929-1735-toolless-prepared-lane.review.md`
> **Notes File**: `tasks/notes/20260929-1735-toolless-prepared-lane.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

A Host SummaryJob (strict fresh, `terminalProjection 'result-document'`, no `messageEgress`) must run on the prepared lane with zero tools. The protocol already accepts the record; the device refuses it at six sites. If this ships wrong, either the lane keeps refusing tool-less records or a prepared session launches with tools nobody counted.

## Goal

The prepared lane admits and launches a record with `requiredToolsets []` and `agentMemory 'none'`; its offer omits `requiredToolsets` (RequiredToolsetsSchema stays `.min(1)`). The launch attestation is still bound. Admission binds only the toolsets the record names. The Pi prepared session fails `prepared_registry_drift` when its registered tools differ from the manifest. No wire, record, digest, capability or version change.

## Scope

- In scope: G1 `prepared-tool-surface.ts`, G2 and G4 call site and G6 in `task-runner.ts`, G4 in `prepared-offer-admission.ts`, G5 `adapters/pi/prepared-tools.ts`, hardening in `adapters/pi/prepared-session.ts`, tests P1-P8 and N1-N11, docs and errata.
- Out of scope: protocol schemas, `RequiredToolsetsSchema`, digest formulas, wire/record versions, version-authority phrases, published text rewrites (bracketed errata only), claude/codex launcher-wrapped adapters (G3 unchanged), the ordinary lane's `resolveMcpServers`, push/PR/publish.
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

What observable evidence would prove this task's direction wrong, and the cheapest proof point to check first. Leave as-is if not applicable.

## Root Cause Evidence

Not applicable (Task Profile is `code-change`). The G6 regression test and its pre-fix failure are recorded in the notes file.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear as a `package_test` check in Verification Plan).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260929-1735-toolless-prepared-lane.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260929-1735-toolless-prepared-lane.review.md`
- Notes file: `tasks/notes/20260929-1735-toolless-prepared-lane.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-review","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - docs/protocol.md
  - CHANGELOG.md
  - docs/releases/v0.24.0.md
  - docs/releases/v0.22.0.md
  - docs/releases/v0.22.0-handoff.md
  - docs/researches/2026-09-28-hermes-prepared-memory-design.md
  - packages/client/src/daemon/prepared-tool-surface.ts
  - packages/client/src/daemon/task-runner.ts
  - packages/client/src/daemon/prepared-offer-admission.ts
  - packages/client/src/adapters/pi/prepared-tools.ts
  - packages/client/src/adapters/pi/prepared-session.ts
  - packages/client/src/__tests__/
  - packages/protocol/src/__tests__/input-preparation.test.ts
  - plans/plan-20260929-1735-toolless-prepared-lane.md
  - tasks/contracts/20260929-1735-toolless-prepared-lane.contract.md
  - tasks/reviews/20260929-1735-toolless-prepared-lane.review.md
  - tasks/notes/20260929-1735-toolless-prepared-lane.notes.md
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
      "id": "build",
      "kind": "command",
      "command": "bun run build",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Build every workspace artifact.",
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
      "necessity": "Type-check the changed client and test code.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "test",
      "kind": "command",
      "command": "bun run test",
      "cwd": ".",
      "phase": "verification",
      "cost": "expensive",
      "evidence_policy": "current_exact",
      "necessity": "Full offline regression including P1-P8 and N1-N11.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "api-surface",
      "kind": "command",
      "command": "bun run check:api-surface",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Public API golden must not move.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "version-authority",
      "kind": "command",
      "command": "bun run check:version-authority",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Single version authority; docs edits must not add version phrases.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "test-scripts",
      "kind": "command",
      "command": "bun run test:scripts",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Repository script tests.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "package-graph",
      "kind": "command",
      "command": "node scripts/release/check-package-graph.mjs",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Package graph unchanged.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "workflow-strict",
      "kind": "command",
      "command": "repo-harness run check-task-workflow --strict",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Task governance.",
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

- Changed behavior/boundary, existing covering tests and remaining gap: prepared admission and Pi launch accept a zero-tool record; existing prepared-offer-lane, prepared-tools and launcher tests cover the tool-bearing shapes and are extended.
- New test case/file rationale, or why existing coverage is sufficient:
- Selected check IDs and why their coverage is sufficient; omitted coverage:
- Full/expensive check justification and expected cost, if applicable:
- Execution/baseline references, subject, current delta and disposition:
- Residual risks and incomplete observations:

## Rollback Point

- Commit / checkpoint: base `ede2db31`; spec-first docs commit, then the code commit on branch `worktree-agent-a46dfd1f828f9604a`.
- Revert strategy: `git revert` the code commit; the docs commit is text only.
