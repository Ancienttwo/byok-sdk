# Task Contract: Official Pi migration

> **Status**: Active
> **Plan**: plans/plan-20260925-0336-official-pi-migration.md
> **Task Profile**: code-change
> **Owner**: codex
> **Capability ID**: root
> **Review File**: `tasks/reviews/20260925-0336-official-pi-migration.review.md`
> **Notes File**: `tasks/notes/20260925-0336-official-pi-migration.notes.md`

## Goal
Migrate to the exact official Pi runtime while preserving verified prepared execution and supporting explicitly zero-tool Summary. Production stays disabled.

## Scope
Initial boundary: authoritative API/artifact feasibility. Expand allowed paths only after a coherent native authority path is proven. Do not edit or republish the frozen fork.

## Allowed Paths
```yaml
allowed_paths:
  - plans/plan-20260925-0336-official-pi-migration.md
  - tasks/contracts/20260925-0336-official-pi-migration.contract.md
  - tasks/notes/20260925-0336-official-pi-migration.notes.md
  - tasks/reviews/20260925-0336-official-pi-migration.review.md
  - docs/researches/20260925-official-pi-migration.md
  - docs/researches/20260925-official-pi-migration-surface.json
  - tasks/current.md
  - tasks/todos.md
```

## Change Assessment
```json
{"protocol":1,"oracles":[]}
```

## Acceptance Policy
```json
{"protocol":2,"reviewer":"parent","source":"self-review","user_waiver":"allowed"}
```

## Exit Criteria (Machine Verifiable)
```yaml
exit_criteria:
  files_exist:
    - docs/researches/20260925-official-pi-migration.md
  artifacts_exist:
    - tasks/notes/20260925-0336-official-pi-migration.notes.md
```

## Verification Plan
Exact official artifact probe first. Full SDK required gates and clean packed smoke after implementation. No paid provider or production state.

## Stop Conditions
Never replace runtime-owned serialization with an SDK fork clone or an invented projection. A missing official contract is a gap to demonstrate, not a fallback opportunity.
