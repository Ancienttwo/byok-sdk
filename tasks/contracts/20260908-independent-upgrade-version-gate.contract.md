# Task Contract: independent upgrade version admission

> **Status**: In Progress
> **Plan**: plans/plan-20260908-independent-upgrade-version-gate.md
> **Task Profile**: bugfix
> **Owner**: kito
> **Capability ID**: root
> **Notes File**: tasks/notes/20260908-independent-upgrade-version-gate.notes.md

## Goal

Reject unsupported wire majors before client execution/cursor acknowledgement
or cloud lifecycle admission. Return the independent-upgrade responsibility
matrix. No Salesko, publication, deployment or production data changes.

## Allowed Paths

```yaml
allowed_paths:
  - packages/protocol/src/envelope.ts
  - packages/protocol/src/__tests__/validation.test.ts
  - packages/client/src/__tests__/protocol-version-admission.test.ts
  - packages/cloud/src/__tests__/protocol-version-admission.test.ts
  - packages/cloud/src/inbound.ts
  - docs/protocol.md
  - docs/researches/2026-09-08-independent-upgrade-responsibility.md
  - docs/researches/evidence/independent-upgrade-20260908/**
  - plans/plan-20260908-independent-upgrade-version-gate.md
  - tasks/contracts/20260908-independent-upgrade-version-gate.contract.md
  - tasks/notes/20260908-independent-upgrade-version-gate.notes.md
```

## Root Cause Evidence

- root_cause: EnvelopeSchema validates v as any integer; both real long-poll
  receive and cloud messages admission consume that schema without rejecting an
  unsupported major. The hello supported-version list does not validate later
  envelopes.
- repro: Pair a real ConnectionManager with createByokServer; modify only a
  known task.offer wire v to 2, then send a task.claim with v 2.
- regression_guard: Assert v2 never reaches client dispatch/cursor retirement
  and never changes cloud task state; supported v1 remains a positive control.
- pre_fix_failure_artifact: docs/researches/evidence/independent-upgrade-20260908/version-pre-fix.log

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - bun run check:api-surface
    - bun run check:version-authority
    - bun run check:release-graph
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Stop Conditions

At most three repair/verification rounds per issue. Report unrelated failures;
do not change runtime fallbacks, product task semantics, credentials or original
user state. Cross-version claims require specified old artifacts.

## Rollback Point

The isolated branch can be abandoned without changing the verified main base.
