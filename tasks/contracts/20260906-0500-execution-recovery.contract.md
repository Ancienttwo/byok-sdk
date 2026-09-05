# Task Contract: execution-recovery

> **Status**: Active
> **Plan**: plans/plan-20260906-0500-execution-recovery.md
> **Task Profile**: code-change
> **Owner**: tmux %8
> **Capability ID**: root
> **Review File**: tasks/reviews/20260906-0500-execution-recovery.review.md
> **Notes File**: tasks/notes/20260906-0500-execution-recovery.notes.md

## Goal

Deliver real crash/restart recovery and durable terminal/interruption settlement through existing authenticated cloud authority, with exact execution fencing and no automatic runtime re-execution.

## Scope

Named recovery paths and their cross-package consumers. Version metadata, audit-log and unrelated product work are excluded. Complete concrete design and narrow owned files before implementation; maintain one authoring authority.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"real-compiled-kill-and-durable-cloud-restart","kind":"runtime_readback","paths":["*"]},{"id":"source-and-cross-package-regression","kind":"deterministic_test","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - packages/client/src/
  - packages/cloud/src/
  - packages/core/src/
  - packages/protocol/src/
  - packages/server/src/
  - packages/cloud-dataplane/src/
  - packages/conformance/
  - deploy/sql/
  - docs/spec.md
  - docs/protocol.md
  - docs/architecture/
  - docs/researches/
  - api-surface/
  - plans/plan-20260906-0500-execution-recovery.md
  - tasks/contracts/20260906-0500-execution-recovery.contract.md
  - tasks/reviews/20260906-0500-execution-recovery.review.md
  - tasks/notes/
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
    - docs/spec.md
  artifacts_exist:
    - tasks/notes/20260906-0500-execution-recovery.notes.md
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - bun run check:api-surface
    - bun run check:version-authority
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Stop Conditions

Preserve immutable execution authority and existing WIP. Report a genuinely contradictory contract to coordinator while continuing independent authorized work. Do not publish packages or mutate production data.
