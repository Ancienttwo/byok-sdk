# Task Contract: client-dependency-purity

> **Status**: Active
> **Plan**: plans/plan-20260815-0205-client-dependency-purity.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-15 02:05
> **Review File**: `tasks/reviews/20260815-0205-client-dependency-purity.review.md`
> **Notes File**: `tasks/notes/20260815-0205-client-dependency-purity.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The SEA/bun single-file packagability invariant (Decision #6 + 2026-08-15 deep-reasoner ruling against koffi-in-core) currently has no durable guard: a future direct native dependency in `@byok-sdk/client` would pass review silently and regress 2 of 6 packageability CI legs.

## Goal

`scripts/release/check-package-graph.mjs` fails when any direct dependency of `@byok-sdk/client` ships a `.node` file or declares an `install`/`preinstall`/`postinstall` script; exits 0 on today's graph; the violation path is proven red by a negative control.

## Scope

- In scope: the direct-scope rule in `scripts/release/check-package-graph.mjs` (port from validated prototype), its negative control (self-test mode, unit test, or fixture).
- Out of scope: transitive-closure scanning, any allowlist for the pi subtree, changes to dependencies or packaging templates.
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

If the direct-dependency scan cannot be made red against a known violating input (negative control), the rule asserts nothing. Cheapest proof: point the scanner at `@earendil-works/pi-tui` (known `.node` shipper in node_modules) and require a nonzero exit.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260815-0205-client-dependency-purity.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260815-0205-client-dependency-purity.review.md`
- Notes file: `tasks/notes/20260815-0205-client-dependency-purity.notes.md`
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
  - tasks/contracts/20260815-0205-client-dependency-purity.contract.md
  - tasks/reviews/20260815-0205-client-dependency-purity.review.md
  - tasks/notes/20260815-0205-client-dependency-purity.notes.md
  - scripts/release/
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
    - scripts/release/check-package-graph.mjs
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260815-0205-client-dependency-purity.notes.md
  commands_succeed:
    - node scripts/release/check-package-graph.mjs
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
