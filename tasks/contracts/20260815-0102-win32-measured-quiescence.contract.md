# Task Contract: win32-measured-quiescence

> **Status**: Active
> **Plan**: plans/plan-20260815-0102-win32-measured-quiescence.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-15 01:02
> **Review File**: `tasks/reviews/20260815-0102-win32-measured-quiescence.review.md`
> **Notes File**: `tasks/notes/20260815-0102-win32-measured-quiescence.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Windows disposal in `process-tree.ts` accepts the direct child's `close` plus a taskkill exit code as a proxy for tree quiescence it never measures; descendants can outlive the receipt and keep writing to the workspace while ownership is released. `runtime-process-tree.test.ts` already asserts descendant death platform-ungated — today that passes by luck. `spawnSync` additionally stalls the daemon event loop under concurrent teardowns.

## Goal

win32 `disposeOwnedProcessTree` resolves only after every taskkill-walked PID (structural co-occurrence extraction from taskkill output, `process.pid` excluded) reports ESRCH, with a half-grace re-sweep for post-snapshot children; taskkill runs via async `spawn`; `terminationRequestFailed` exit-code interpretation is deleted; `stage:'signal'` means only "taskkill could not be spawned" and `stage:'quiescence'` reports the count of walked PIDs still alive. Three adapter callers updated coherently. Zero new dependencies; `templates/packaging/*` untouched.

## Scope

- In scope: T2/T3 of the plan's Task Breakdown (T1 extractor + tests already landed in the worktree): `packages/client/src/adapters/process-tree.ts` rework, three adapter interrupt-path caller updates, 3-level/escape-race/receipt-authority/adapter-parity tests, `scripts/release/check-package-graph.mjs` native-dep guard.
- Out of scope:
  - POSIX changes, sandboxing, Job Object/FFI, daemon-crash orphan reaping, MCP subprocess supervision.
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

If the taskkill co-occurrence extractor cannot reliably recover the walked PID set on a real non-English Windows box, the accepted set collapses to `{rootPid}` and the async-signature churn is not worth it. Cheapest proof: the multi-locale fixture suite in `packages/client/src/__tests__/taskkill-pid-set.test.ts` (already green 10/10, red-first verified against a naive extractor; real-Windows confirmation rides the windows-latest CI leg).

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260815-0102-win32-measured-quiescence.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260815-0102-win32-measured-quiescence.review.md`
- Notes file: `tasks/notes/20260815-0102-win32-measured-quiescence.notes.md`
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
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260815-0102-win32-measured-quiescence.contract.md
  - tasks/reviews/20260815-0102-win32-measured-quiescence.review.md
  - tasks/notes/20260815-0102-win32-measured-quiescence.notes.md
  - packages/client/src/adapters/
  - packages/client/src/__tests__/
  - packages/client/scripts/
  - scripts/release/check-package-graph.mjs
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
    - packages/client/src/adapters/taskkill-pid-set.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260815-0102-win32-measured-quiescence.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/taskkill-pid-set.test.ts
    - path: packages/client/src/__tests__/runtime-process-tree.test.ts
  commands_succeed:
    - pnpm -r run typecheck
    - pnpm -r run test
    - pnpm -r run build
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint:
- Revert strategy:
