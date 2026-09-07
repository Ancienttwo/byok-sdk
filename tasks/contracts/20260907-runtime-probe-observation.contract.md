# Task Contract: Runtime probe failure observation

> **Status**: Review
> **Plan**: plans/plan-20260907-runtime-probe-observation.md
> **Task Profile**: code-change
> **Owner**: Codex
> **Capability ID**: root
> **Review File**: tasks/reviews/20260907-runtime-probe-observation.review.md
> **Notes File**: tasks/notes/20260907-runtime-probe-observation.notes.md

## Goal

Preserve closed, credential-blind runtime probe failure outcomes across the three adapters and local runtimes/status/doctor. One mandatory adapter shape; display presence derived from available. Registration/admission predicates are mechanically updated without changing wire/retry/policy semantics.

## Scope

Client detection types/helper/adapters, direct consumers, related fixtures/tests, local documentation and API snapshot. No new runtime, auth interpretation, scheduler, cloud schema, updater or compatibility authoring path.

## Allowed Paths

```yaml
allowed_paths:
  - packages/client/src/
  - packages/client/scripts/adapter-task-smoke.mjs
  - templates/packaging/bun/README.md
  - templates/packaging/bun/smoke-test.sh
  - templates/packaging/sea/README.md
  - templates/packaging/sea/smoke-test.sh
  - examples/packaging/launcher.ts
  - api-surface/client.d.ts
  - docs/spec.md
  - CHANGELOG.md
  - plans/plan-20260907-runtime-probe-observation.md
  - tasks/contracts/20260907-runtime-probe-observation.contract.md
  - tasks/notes/20260907-runtime-probe-observation.notes.md
  - tasks/reviews/20260907-runtime-probe-observation.review.md
  - tasks/current.md
```

## Exit Criteria

- ENOENT, executable refusal, owned timeout and unknown process failures are distinct fixed outcomes; errors never expose paths/messages/streams.
- A timeout reports its own deadline and does not rely on arbitrary killed/signal fields. Real owned version child is terminated.
- Old, mixed and malformed custom detect results fail closed; throw/deadline remain explicit failure observations.
- runtimes/status text and doctor JSON/text preserve the result; available is the only presence source.
- Existing task selection and registration boundaries remain intact. Required checks are recorded honestly, including unrelated blockers.
