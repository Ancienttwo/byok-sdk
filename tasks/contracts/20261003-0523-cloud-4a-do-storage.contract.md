# Task Contract: cloud-4a-do-storage

> **Status**: Active
> **Plan**: plans/plan-20261003-0523-cloud-4a-do-storage.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: chris
> **Capability ID**: root
> **Last Updated**: 2026-10-03 05:23
> **Review File**: `tasks/reviews/20261003-0523-cloud-4a-do-storage.review.md`
> **Notes File**: `tasks/notes/20261003-0523-cloud-4a-do-storage.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The approved 4a slice needs one native pi storage API across local SQLite and Cloudflare DO SQLite, without weakening local replica security or importing Worker runtime into Node consumers.

## Goal

Deliver the /tmp/byok-cloud-4a.md storage seam, private DO adapter/AgentDO, shared conformance and real workerd restart/isolation tests, required verification, small local commits and /tmp/byok-cloud-4a-report.md.

## Scope

- In scope: client storage construction seam, additive tests, private cloud-do workspace, lockfile, task evidence and scoped architecture projection.
- Out of scope: slices 4b–4e, new published exports, main checkout, pushes, credentials, tools/jobs, wake/events, Postgres.
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

If native pi conformance fails in workerd or async SQL transactions cannot roll back/isolate without Node files or manual SQL BEGIN, revisit the adapter instead of weakening assertions.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear as a `package_test` check in Verification Plan).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20261003-0523-cloud-4a-do-storage.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20261003-0523-cloud-4a-do-storage.review.md`
- Notes file: `tasks/notes/20261003-0523-cloud-4a-do-storage.notes.md`
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
  - packages/client/src/adapters/pi-durable/engine.ts
  - packages/client/src/adapters/pi-durable/storage.ts
  - packages/client/src/__tests__/pi-durable-storage-seam.test.ts
  - packages/cloud-do/
  - bun.lock
  - scripts/release/check-package-graph.mjs
  - tasks/todos.md
  - plans/plan-20261003-0523-cloud-4a-do-storage.md
  - tasks/contracts/20261003-0523-cloud-4a-do-storage.contract.md
  - tasks/reviews/20261003-0523-cloud-4a-do-storage.review.md
  - tasks/notes/20261003-0523-cloud-4a-do-storage.notes.md
  - docs/architecture/modules/sdk/sdk-root.md
  - docs/architecture/.projection-manifest.json
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
  files_exist:
    - packages/client/src/adapters/pi-durable/storage.ts
    - packages/cloud-do/src/storage.ts
    - packages/cloud-do/src/agent-do.ts
    - packages/cloud-do/wrangler.jsonc
    - packages/cloud-do/test/storage.test.ts
  artifacts_exist: []
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
  {
    "id": "install",
    "kind": "command",
    "command": "bun ci",
    "cwd": ".",
    "phase": "verification",
    "cost": "normal",
    "evidence_policy": "current_exact",
    "necessity": "Owner-required check or package/architecture invariant affected by slice 4a.",
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
    "necessity": "Owner-required check or package/architecture invariant affected by slice 4a.",
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
    "necessity": "Owner-required check or package/architecture invariant affected by slice 4a.",
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
    "necessity": "Owner-required check or package/architecture invariant affected by slice 4a.",
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
    "necessity": "Owner-required check or package/architecture invariant affected by slice 4a.",
    "inputs": {
      "env": []
    }
  },
  {
    "id": "release-graph",
    "kind": "command",
    "command": "bun run check:release-graph",
    "cwd": ".",
    "phase": "verification",
    "cost": "normal",
    "evidence_policy": "current_exact",
    "necessity": "Owner-required check or package/architecture invariant affected by slice 4a.",
    "inputs": {
      "env": []
    }
  },
  {
    "id": "script-tests",
    "kind": "command",
    "command": "bun run test:scripts",
    "cwd": ".",
    "phase": "verification",
    "cost": "normal",
    "evidence_policy": "current_exact",
    "necessity": "Owner-required check or package/architecture invariant affected by slice 4a.",
    "inputs": {
      "env": []
    }
  },
  {
    "id": "workspace-tests",
    "kind": "command",
    "command": "BYOK_TEST_BUN_BIN=/Users/chris/.bun/bin/bun bun run test",
    "cwd": ".",
    "phase": "verification",
    "cost": "expensive",
    "evidence_policy": "current_exact",
    "necessity": "Owner-required check or package/architecture invariant affected by slice 4a.",
    "inputs": {
      "env": [
        "BYOK_TEST_BUN_BIN"
      ]
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
    "necessity": "Owner-required check or package/architecture invariant affected by slice 4a.",
    "inputs": {
      "env": []
    }
  },
  {
    "id": "projection",
    "kind": "command",
    "command": "repo-harness architecture-projection check --json",
    "cwd": ".",
    "phase": "verification",
    "cost": "normal",
    "evidence_policy": "current_exact",
    "necessity": "Owner-required check or package/architecture invariant affected by slice 4a.",
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

- Changed behavior/boundary, existing covering tests and remaining gap: storage construction only in the local engine; portable native pi contracts in a private DO package. Existing authority/recovery assertions are unchanged.
- New test case/file rationale, or why existing coverage is sufficient: same 25 native/BYOK cases run on both backends, five workerd host/adapter cases and additive local factory authority test.
- Selected check IDs and why their coverage is sufficient; omitted coverage: above complete dispatch chain plus release inventory and generated architecture provenance. Production deployment/provider/job/wake execution is out of 4a scope.
- Full/expensive check justification and expected cost, if applicable: full workspace suite explicitly required by owner; approximately three minutes for the client plus remaining workspace suites.
- Execution/baseline references, subject, current delta and disposition:
- Residual risks and incomplete observations: pinned workerd accepts dates only through 2026-08-18; no remote deployment, exact 2 MB edge, capacity, retention or model execution proof.

## Rollback Point

- Commit / checkpoint:
- Revert strategy:
