# Task Contract: typed-runtime-failure-taxonomy

> **Status**: Active
> **Plan**: plans/plan-20260814-0010-typed-runtime-failure-taxonomy.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-14 03:46
> **Review File**: `tasks/reviews/20260814-0010-typed-runtime-failure-taxonomy.review.md`
> **Notes File**: `tasks/notes/20260814-0010-typed-runtime-failure-taxonomy.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Post-admission failures currently cross the adapter boundary as unrelated generic errors. `TaskRunner` then treats almost every start or event-stream failure as retryable, so permanent authority/session violations can churn across the fleet while vendor semantic failures are indistinguishable from transient process loss. The 0.4.0 prepared-operation contract needs one typed execution-failure authority before custom adapters can implement retry behavior safely.

## Goal

Define and publicly export one closed runtime execution failure vocabulary with `phase`, `category`, and explicit retry disposition; make Pi, Claude, Codex, and custom Session boundaries terminate expected failures with it; and make `TaskRunner` exhaustively project that value to the existing `task.fail` wire. Unknown throws must fail closed as a stable adapter-contract violation without parsing provider messages.

## Scope

- In scope:
  - shared typed execution-failure value/error constructors and public exports;
  - exhaustive TaskRunner start/run projection to existing reason/retryable fields;
  - Pi, Claude, and Codex mappings for semantic, infrastructure, and authority failures;
  - custom adapter/session fixtures, exactly-once terminal races, and static no-parser guards;
  - spec, security, and SDK architecture truth for failure/retry authority.
- Out of scope:
  - pre-claim admission decisions (Row 1), process-tree close/teardown receipts (Row 3), provider-specific retry loops, server scheduling policy, protocol versioning, and durable receipt storage.
- Taste constraints: one source of truth; no message regex/substring classification, no default retryable catch, no compatibility `PolicyUnsupportedError` translator, and no new protocol field or AgentEvent variant.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

The direction is wrong if an existing bare `Error` from a custom Session already projects non-retryable, or if an authoritative session-id mismatch already has a typed terminal cause. Cheapest proof: add one TaskRunner regression that throws a bare `Error` containing misleading transient language and observe the current `task.fail.retryable === true`; then keep the same source message and require the new contract-violation projection to be non-retryable.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260814-0010-typed-runtime-failure-taxonomy.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260814-0010-typed-runtime-failure-taxonomy.review.md`
- Notes file: `tasks/notes/20260814-0010-typed-runtime-failure-taxonomy.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - docs/security.md
  - docs/architecture/sdk-architecture.md
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260814-0010-typed-runtime-failure-taxonomy.contract.md
  - tasks/reviews/20260814-0010-typed-runtime-failure-taxonomy.review.md
  - tasks/notes/20260814-0010-typed-runtime-failure-taxonomy.notes.md
  - packages/client/src/runtime-failure.ts
  - packages/client/src/types.ts
  - packages/client/src/index.ts
  - packages/client/src/daemon/task-runner.ts
  - packages/client/src/adapters/pi/
  - packages/client/src/adapters/claude/
  - packages/client/src/adapters/codex/
  - packages/client/src/__tests__/fixtures/
  - packages/client/src/__tests__/runtime-failure.test.ts
  - packages/client/src/__tests__/task-runner-runtime-failure.test.ts
  - packages/client/src/__tests__/task-runner-runtime-selection.test.ts
  - packages/client/src/__tests__/pi-adapter.test.ts
  - packages/client/src/__tests__/claude-adapter.test.ts
  - packages/client/src/__tests__/codex-adapter.test.ts
  - packages/client/src/__tests__/pi-events.test.ts
  - packages/client/src/__tests__/claude-events.test.ts
  - packages/client/src/__tests__/codex-events.test.ts
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
      - codex-exec
      - main-thread
    fallback: main-thread
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - docs/spec.md
    - packages/client/src/runtime-failure.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260814-0010-typed-runtime-failure-taxonomy.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/runtime-failure.test.ts
    - path: packages/client/src/__tests__/task-runner-runtime-failure.test.ts
  commands_succeed:
    - pnpm --filter @byok-sdk/client run typecheck
    - pnpm --filter @byok-sdk/client run test
    - pnpm --filter @byok-sdk/client run build
    - pnpm --filter @byok-sdk/client run smoke:adapters
    - pnpm -r run typecheck
    - pnpm -r run test
    - pnpm -r run build
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: authority/semantic failures project non-retryable; process/transport unavailability projects retryable; success remains explicit `turn_end`; wire shape stays unchanged.
- Edge cases: bare throws, malformed native terminal frames, session identity mismatch, child disappearance, typed failure followed by queue close/late frame, and diagnostic `AgentEvent.error` without terminal authority.
- Regression risks: provider process wrappers may currently rely on queue closure as an implicit terminal cause; migrate all three adapters atomically and keep teardown result handling out of this contract.

## Rollback Point

- Commit / checkpoint: record the implementation candidate SHA before acceptance.
- Revert strategy: revert runtime-failure authority, all three provider mappings, TaskRunner projection, fixtures/tests, and docs as one unit; do not restore a typed/text-derived dual path.
