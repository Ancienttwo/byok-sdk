# Task Contract: audit-log-spill-size

> **Status**: Active
> **Plan**: plans/plan-20260906-0433-audit-log-spill-size.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-06 04:36
> **Review File**: `tasks/reviews/20260906-0433-audit-log-spill-size.review.md`
> **Notes File**: `tasks/notes/20260906-0433-audit-log-spill-size.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

For a spilled `tool_use`/`tool_result`, the audit log records the byte size of the preview object as if it were the tool content, so the record under-reports and the read-side placeholder repeats the wrong number.

## Goal

`redactAgentEvent` records `inputSize`/`outputSize` as `spill.totalBytes` plus a boolean `inputSpilled`/`outputSpilled` when the event carries `spill`; `reconstructAgentEvent` renders `[redacted: N bytes, spilled]` from those keys; no locator or reason text ever reaches the record; unspilled events are byte-identical to today.

## Scope

- In scope: `packages/client/src/bin/audit-log.ts` write and read sides, `bin-audit-log.test.ts`, CHANGELOG, todos row, workflow artifacts.
- Out of scope: record format version, other event types, protocol.
- Taste constraints: sizes, identifiers, counts and booleans only.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

Not applicable; mechanical change guarded by a no-content test.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260906-0433-audit-log-spill-size.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260906-0433-audit-log-spill-size.review.md`
- Notes file: `tasks/notes/20260906-0433-audit-log-spill-size.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"client-required-checks","kind":"deterministic_test","paths":["*"]},{"id":"audit-log-jsonl-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260906-0433-audit-log-spill-size.md
  - tasks/todos.md
  - tasks/current.md
  - tasks/contracts/20260906-0433-audit-log-spill-size.contract.md
  - tasks/reviews/20260906-0433-audit-log-spill-size.review.md
  - tasks/notes/20260906-0433-audit-log-spill-size.notes.md
  - packages/client/src/bin/audit-log.ts
  - packages/client/src/__tests__/bin-audit-log.test.ts
  - api-surface/client.d.ts
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
    - packages/client/src/bin/audit-log.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260906-0433-audit-log-spill-size.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/bin-audit-log.test.ts
  commands_succeed:
    - bun run --filter @byok-sdk/client typecheck
    - bun run --filter @byok-sdk/client build
    - bun run --filter @byok-sdk/client test
    - bun run check:api-surface
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: spilled events record `totalBytes` and a boolean flag; read-back placeholder says `spilled`.
- Edge cases: `unstoredReason` form (no blob) still records `totalBytes`; unspilled events unchanged.
- Regression risks: none; additive keys.

## Rollback Point

- Commit / checkpoint: `17714f9` (origin/main before this task).
- Revert strategy: revert the PR.
