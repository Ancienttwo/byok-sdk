> **Archived**: 2026-08-21 02:32
> **Related Plan**: plans/archive/plan-20260821-0228-todo-ledger-prune-3.md
> **Outcome**: Superseded
> **Lifecycle**: contract
> **Parent Run ID**: run-20260821-0232

# Task Contract: todo-ledger-prune-3

> **Status**: Active
> **Plan**: plans/plan-20260821-0228-todo-ledger-prune-3.md
> **Task Profile**: ledger-closeout
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-21 02:28
> **Review File**: `tasks/reviews/20260821-0228-todo-ledger-prune-3.review.md`
> **Notes File**: `tasks/notes/20260821-0228-todo-ledger-prune-3.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

`tasks/todos.md` is the deferred product-goal authority. Keeping untriggered
solution designs there makes speculative abstractions look like committed SDK
work and obscures the smaller set of current, evidence-backed gaps.

## Goal

Remove exactly four untriggered solution-design rows while preserving their
historical research evidence and leaving the seven current gap-backed rows
unchanged.

## Scope

- In scope:
  - trigger readback for the four named rows;
  - `tasks/todos.md` four-row deletion;
  - plan, contract, review, notes, current, handoff, checks, and architecture
    queue projections required for workflow closeout.
- Out of scope:
  - product code, protocol changes, releases, deployments, downstream writes, and the remaining seven deferred rows.
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

A real current consumer crossing any row's own trigger would falsify deletion.
The cheapest proof is current source/downstream search for a non-built-in
runtime, second stdio/browser connector dogfood, structured Git-journal host,
or enterprise immutable-audit query requirement.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260821-0228-todo-ledger-prune-3.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260821-0228-todo-ledger-prune-3.review.md`
- Notes file: `tasks/notes/20260821-0228-todo-ledger-prune-3.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/architecture/
  - plans/
  - tasks/current.md
  - tasks/todos.md
  - tasks/archive/
  - tasks/contracts/20260821-0228-todo-ledger-prune-3.contract.md
  - tasks/reviews/20260821-0228-todo-ledger-prune-3.review.md
  - tasks/notes/20260821-0228-todo-ledger-prune-3.notes.md
  - .ai/harness/
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
    - tasks/todos.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260821-0228-todo-ledger-prune-3.notes.md
  commands_succeed:
    - git diff --check
    - repo-harness run architecture-queue status --format json
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: four speculative rows disappear; seven current gaps remain.
- Edge cases: archived snapshots and research retain the removed design evidence.
- Regression risks: accidental deletion or rewriting of a live-gap row.

## Rollback Point

- Commit / checkpoint: pre-task HEAD `82ca334600935be76d5688a75c3752da92a14a65`.
- Revert strategy: restore only the four table rows from the archived snapshot.
