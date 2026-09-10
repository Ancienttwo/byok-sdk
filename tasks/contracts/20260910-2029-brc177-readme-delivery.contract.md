# Task Contract: Deliver Issue177 SDK README correction

> **Status**: Active
> **Plan**: plans/plan-20260910-2029-brc177-readme-delivery.md
> **Task Profile**: bugfix
> **Owner**: ancienttwo
> **Capability ID**: capability.sdk.sdk-root
> **Review File**: tasks/reviews/20260910-2029-brc177-readme-delivery.review.md
> **Notes File**: tasks/notes/20260910-2029-brc177-readme-delivery.notes.md

## Why

The package-local published README omits the seventh namespace, and its existing regression prevents the canary CI from reaching tests because a required capture lacks a type assertion.

## Goal

Document all seven existing SDK namespaces and preserve a type-safe regression that rejects README/export drift and keys inclusion. Publish a reviewed repair draft PR against codex/brc1415-canary.

## Scope

- In scope: packages/sdk/README.md, its existing readme.test.ts capture typing, and task evidence for this parent-owned delivery.
- Out of scope: runtime exports, dependencies, versions, global config, campaign/grant state, worker/verifier reruns, automatic merge, Issue closure or package publication.

## Falsifier

The corrected regression passes against the old README, a documented namespace differs from index.ts, or typecheck still reports TS2532.

## Root Cause Evidence

- root_cause: packages/sdk/README.md was omitted when uiRuntime was exported; readme.test.ts:12 additionally dereferences a required RegExp capture whose indexed type includes undefined under noUncheckedIndexedAccess.
- repro: bun run --cwd packages/sdk test -- src/readme.test.ts; current canary CI34468443838 Typecheck reports TS2532 before Test.
- regression_guard: packages/sdk/src/readme.test.ts
- pre_fix_failure_artifact: tasks/evidence/brc177-readme-delivery-pre-fix.log

## Allowed Paths

```yaml
allowed_paths:
  - packages/sdk/README.md
  - tasks/todos.md
  - packages/sdk/src/readme.test.ts
  - plans/plan-20260910-2029-brc177-readme-delivery.md
  - tasks/contracts/20260910-2029-brc177-readme-delivery.contract.md
  - tasks/reviews/20260910-2029-brc177-readme-delivery.review.md
  - tasks/notes/20260910-2029-brc177-readme-delivery.notes.md
  - tasks/evidence/brc177-readme-delivery-pre-fix.log
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - packages/sdk/README.md
    - packages/sdk/src/readme.test.ts
    - tasks/evidence/brc177-readme-delivery-pre-fix.log
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "readme-regression",
      "kind": "package_test",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Preserves the existing Issue177 failing regression and keys exclusion.",
      "inputs": {
        "env": [
          "PATH"
        ]
      },
      "path": "packages/sdk/src/readme.test.ts"
    },
    {
      "id": "build",
      "kind": "command",
      "cwd": ".",
      "phase": "verification",
      "cost": "expensive",
      "evidence_policy": "current_exact",
      "necessity": "Target AGENTS.md explicitly requires the workspace build before typecheck/test.",
      "inputs": {
        "env": [
          "PATH"
        ]
      },
      "command": "bun run build"
    },
    {
      "id": "typecheck",
      "kind": "command",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Proves the required regex capture compiles with noUncheckedIndexedAccess and workspace types remain valid.",
      "inputs": {
        "env": [
          "PATH"
        ]
      },
      "command": "bun run typecheck"
    },
    {
      "id": "workspace-tests",
      "kind": "command",
      "cwd": ".",
      "phase": "verification",
      "cost": "expensive",
      "evidence_policy": "current_exact",
      "necessity": "Target AGENTS.md explicitly requires the complete workspace test script; execute once on frozen implementation.",
      "inputs": {
        "env": [
          "PATH"
        ]
      },
      "command": "bun run test"
    },
    {
      "id": "api-surface",
      "kind": "command",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Target-required API golden integrity.",
      "inputs": {
        "env": [
          "PATH"
        ]
      },
      "command": "bun run check:api-surface"
    },
    {
      "id": "version-authority",
      "kind": "command",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Target-required version authority integrity.",
      "inputs": {
        "env": [
          "PATH"
        ]
      },
      "command": "bun run check:version-authority"
    },
    {
      "id": "workflow",
      "kind": "command",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Target-required strict workflow integrity.",
      "inputs": {
        "env": [
          "PATH"
        ]
      },
      "command": "repo-harness run check-task-workflow --strict"
    }
  ]
}
```

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-plugin","user_waiver":"allowed"}
```

## Stop Conditions

Stop on runtime/API scope expansion or a required failure outside the two-file repair. Preserve failures. Parent source checks and PR CI are not a campaign completed passing final. No external acceptance or user waiver may be invented.

## Acceptance Notes (Human Review)

Use the exact canary base ce48120507bb51360d48aa2ab3a2ffbe4be67951. The focused regression also provides the required root-cause guard; the complete workspace run remains an explicit target requirement. Pinned local toolchain is Node22.22.0/Bun1.4.0. Source semantic acceptance remains pending until a real receipt exists.

## Rollback Point

Revert the bounded repair PR. The live canary remains unchanged during draft delivery.
