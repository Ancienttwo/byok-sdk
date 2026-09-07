# Task Contract: message-recovery-ordering

> **Status**: Blocked
> **Plan**: plans/plan-20260907-1236-message-recovery-ordering.md
> **Task Profile**: code-change
> **Owner**: Codex
> **Capability ID**: root
> **Notes File**: tasks/notes/20260907-1236-message-recovery-ordering.notes.md

## Goal

Recover pending local Agent messages before immutable interrupted terminal delivery, without runtime rerun or weakening cloud admission.

## Allowed Paths

```yaml
allowed_paths:
  - packages/client/src/
  - api-surface/client.d.ts
  - docs/spec.md
  - docs/researches/
  - plans/plan-20260907-1236-message-recovery-ordering.md
  - tasks/contracts/20260907-1236-message-recovery-ordering.contract.md
  - tasks/notes/20260907-1236-message-recovery-ordering.notes.md
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
    - plans/plan-20260907-1236-message-recovery-ordering.md
  artifacts_exist:
    - tasks/notes/20260907-1236-message-recovery-ordering.notes.md
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

Three fix/reverify rounds per issue. Preserve WIP. No npm publish, production mutation or dependency pin claim.
