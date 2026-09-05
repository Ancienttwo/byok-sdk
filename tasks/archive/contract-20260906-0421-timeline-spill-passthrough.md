> **Archived**: 2026-09-06 04:21
> **Related Plan**: plans/archive/plan-20260906-0412-timeline-spill-passthrough.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260906-0421
> **Archive Projection V1**: `plans/plan-20260906-0412-timeline-spill-passthrough.md` => `plans/archive/plan-20260906-0412-timeline-spill-passthrough.md`
> **Archive Projection V1**: `tasks/notes/20260906-0412-timeline-spill-passthrough.notes.md` => `tasks/archive/notes-20260906-0421-timeline-spill-passthrough.md`
> **Archive Projection V1**: `tasks/contracts/20260906-0412-timeline-spill-passthrough.contract.md` => `tasks/archive/contract-20260906-0421-timeline-spill-passthrough.md`
> **Archive Projection V1**: `tasks/reviews/20260906-0412-timeline-spill-passthrough.review.md` => `tasks/archive/review-20260906-0421-timeline-spill-passthrough.md`

# Task Contract: timeline-spill-passthrough

> **Status**: Fulfilled
> **Plan**: plans/archive/plan-20260906-0412-timeline-spill-passthrough.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-06 04:15
> **Review File**: `tasks/archive/review-20260906-0421-timeline-spill-passthrough.md`
> **Notes File**: `tasks/archive/notes-20260906-0421-timeline-spill-passthrough.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

PR #149 made oversized `tool_use.input` / `tool_result.output` ship as a preview plus a `spill` descriptor. `ToolTimelineItem` copies the two fields by name and drops `spill`, so the in-repo timeline consumer renders the preview as the full value with no truncation signal.

## Goal

`ToolTimelineItem` carries `inputSpill` and `outputSpill` (`AgentEventSpill`), each present exactly when the corresponding source event carried `spill`; paired and unpaired folds both pass them through; tests prove presence and absence; the ui-runtime golden is regenerated additively; the delivered todos row is removed.

## Scope

- In scope: `packages/ui-runtime/src/types.ts`, `packages/ui-runtime/src/timeline.ts`, `packages/ui-runtime/src/__tests__/timeline.test.ts`, `api-surface/ui-runtime.d.ts`, `CHANGELOG.md`, `tasks/todos.md`, workflow artifacts.
- Out of scope: any rendering logic, `bin/audit-log.ts`, protocol changes.
- Taste constraints: no inference from the preview shape; fields present only via `Object.hasOwn(observation, 'spill')`.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

Not applicable; mechanical passthrough.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/archive/plan-20260906-0412-timeline-spill-passthrough.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/archive/review-20260906-0421-timeline-spill-passthrough.md`
- Notes file: `tasks/archive/notes-20260906-0421-timeline-spill-passthrough.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"ui-runtime-required-checks","kind":"deterministic_test","paths":["*"]},{"id":"timeline-fold-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/archive/plan-20260906-0412-timeline-spill-passthrough.md
  - tasks/todos.md
  - tasks/current.md
  - tasks/archive/contract-20260906-0421-timeline-spill-passthrough.md
  - tasks/archive/review-20260906-0421-timeline-spill-passthrough.md
  - tasks/archive/notes-20260906-0421-timeline-spill-passthrough.md
  - packages/ui-runtime/src/types.ts
  - packages/ui-runtime/src/timeline.ts
  - packages/ui-runtime/src/__tests__/timeline.test.ts
  - api-surface/ui-runtime.d.ts
  - CHANGELOG.md
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

```yaml
exit_criteria:
  files_exist:
    - packages/ui-runtime/src/timeline.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/archive/notes-20260906-0421-timeline-spill-passthrough.md
  tests_pass:
    - path: packages/ui-runtime/src/__tests__/timeline.test.ts
  commands_succeed:
    - bun run --filter @byok-sdk/ui-runtime typecheck
    - bun run --filter @byok-sdk/ui-runtime build
    - bun run --filter @byok-sdk/ui-runtime test
    - bun run check:api-surface
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: both fields present exactly when the source events carried `spill`.
- Edge cases: unpaired result; unpaired use; neither side spilled (keys absent, not `undefined`).
- Regression risks: none beyond the additive golden.

## Rollback Point

- Commit / checkpoint: `612ec44` (origin/main before this task).
- Revert strategy: revert the PR.
