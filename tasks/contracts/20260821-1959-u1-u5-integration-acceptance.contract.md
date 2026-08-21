# Task Contract: u1-u5-integration-acceptance

> **Status**: Active
> **Plan**: plans/plan-20260821-1959-u1-u5-integration-acceptance.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> **Owner**: `/root`
> **Capability ID**: root
> **Review File**: `tasks/reviews/20260821-1959-u1-u5-integration-acceptance.review.md`
> **Notes File**: `tasks/notes/20260821-1959-u1-u5-integration-acceptance.notes.md`

## Objective

Accept and merge only the exact PR #81 U1-U5 integration subject after fresh
remote CI, current-SHA pack closure, independent semantic review, a typed
external-pass AcceptanceReceipt, and a verified local merge seal.

No product behavior change is authorized by this contract. Product drift after
the acceptance envelope is committed is a hard stop.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"github-ci","kind":"deterministic_test","paths":["*"]},{"id":"packed-runtime-readback","kind":"runtime_readback","paths":["*"]}]}
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
  - .ai/harness/failures/.gitkeep
  - .ai/harness/handoff/
  - .ai/harness/worktrees/.gitkeep
  - CHANGELOG.md
  - bun.lock
  - deploy/
  - docs/
  - examples/
  - packages/
  - plans/archive/
  - plans/plan-20260821-1516-local-agent-release-identity.md
  - plans/plan-20260821-1710-terminal-inference-usage.md
  - plans/plan-20260821-1715-tenant-readiness-primitives.md
  - plans/plan-20260821-1720-tenant-erasure.md
  - plans/plan-20260821-1959-u1-u5-integration-acceptance.md
  - scripts/release/
  - tasks/archive/
  - tasks/contracts/20260821-1516-local-agent-release-identity.contract.md
  - tasks/contracts/20260821-1710-terminal-inference-usage.contract.md
  - tasks/contracts/20260821-1715-tenant-readiness-primitives.contract.md
  - tasks/contracts/20260821-1720-tenant-erasure.contract.md
  - tasks/contracts/20260821-1959-u1-u5-integration-acceptance.contract.md
  - tasks/current.md
  - tasks/notes/20260821-1516-local-agent-release-identity.notes.md
  - tasks/notes/20260821-1710-terminal-inference-usage.notes.md
  - tasks/notes/20260821-1715-tenant-readiness-primitives.notes.md
  - tasks/notes/20260821-1720-tenant-erasure.notes.md
  - tasks/notes/20260821-1959-u1-u5-integration-acceptance.notes.md
  - tasks/reviews/20260821-1516-local-agent-release-identity.review.md
  - tasks/reviews/20260821-1710-terminal-inference-usage.review.md
  - tasks/reviews/20260821-1715-tenant-readiness-primitives.review.md
  - tasks/reviews/20260821-1720-tenant-erasure.review.md
  - tasks/reviews/20260821-1959-u1-u5-integration-acceptance.review.md
  - templates/
  - tests/
```

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - deploy/sql/0009_task_cancellation.sql
    - deploy/sql/0010_tenant_readiness.sql
    - deploy/sql/0011_tenant_erasure.sql
    - packages/client/src/release-identity.ts
    - packages/cloud-dataplane/src/tenant-erasure.ts
    - scripts/release/pack-and-smoke.mjs
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260821-1959-u1-u5-integration-acceptance.notes.md
    - tasks/reviews/20260821-1959-u1-u5-integration-acceptance.review.md
  commands_succeed:
    - git diff --check origin/main...HEAD
    - repo-harness run check-deploy-sql-order
    - node scripts/release/check-package-graph.mjs
    - node scripts/release/pack-and-smoke.mjs
    - gh pr checks 81
    - repo-harness run check-task-workflow --strict
```

## Exit conditions

The contract is complete only when the final PR head and target are unchanged,
all machine checks pass, the independent gatekeeper returns PASS, the typed
external-pass receipt verifies, and the merge seal verifies. A successful
merge does not authorize any release or production action.
