> **Archived**: 2026-08-07 13:14
> **Related Plan**: plans/archive/plan-20260807-1144-architecture-root-card-closeout.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260807-1314

# Task Contract: architecture-root-card-closeout

> **Status**: Fulfilled
> **Plan**: plans/plan-20260807-1144-architecture-root-card-closeout.md
> **Task Profile**: docs-only
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-07 11:47
> **Review File**: `tasks/reviews/20260807-1144-architecture-root-card-closeout.review.md`
> **Notes File**: `tasks/notes/20260807-1144-architecture-root-card-closeout.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

`docs/architecture/requests/root.md` has been a pending advisory blocker since 2026-08-05: ArchitectureSync warns on every archive, and K4's keys work will touch the same capability, where the advisory can harden into a gate. The drift events behind the card are the K0 creation of `packages/keys/package.json` and `packages/keys/tsconfig.json` (a3ab9a9) — a real boundary change that the canonical architecture document §7 already records with file:line evidence, re-verified during the v1/v2 architecture slices. The card needs adjudicated closure, not re-documentation.

## Goal

Close the root architecture-queue card by adjudication and drain the queue.

Three acceptance targets, projected from the plan's `## Task Breakdown`:

1. **Card closure** (`C1`). The legal closed status value is read from the installed repo-harness architecture-queue script source (not guessed); the card carries that status plus a dated adjudication note naming a3ab9a9 and canonical §7.
2. **Snapshot + sync** (`C2`). One thin ruling snapshot lands under `docs/architecture/snapshots/` (the directory's first artifact), and `repo-harness run context-contract-sync sync-latest` links it, with every write inside Allowed Paths.
3. **Verification** (`C3`). `repo-harness run architecture-queue status` reports pending=0 and blocking=0, `repo-harness run check-architecture-sync` reports no pending request, and `repo-harness run check-task-workflow --strict` passes.

One constraint binds the slice: this is a documentation slice. No source or test file changes.

## Scope

- In scope: the root request card, one new snapshot, contract-sync link writes under `.ai/context/`, this slice's workflow artifacts.
- Out of scope: `packages/**`, `docs/spec.md`, the sealed K-line artifacts, `docs/architecture/sdk-architecture.md` content changes, `_ref/**`.
- Taste constraints: the snapshot records the ruling and links canonical §7; it must not duplicate §7's content.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if the legal closed status value cannot be determined from the repo-harness script source.
- Stop if `context-contract-sync sync-latest` writes outside Allowed Paths.

## Falsifier

If `repo-harness run architecture-queue status` still reports the root card as pending after the closure edit, the chosen status value or closure mechanism is wrong; re-read the script's status parsing before any further edits. Cheapest proof: run the status command immediately after C1.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260807-1144-architecture-root-card-closeout.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260807-1144-architecture-root-card-closeout.review.md`
- Notes file: `tasks/notes/20260807-1144-architecture-root-card-closeout.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Verification command (the milestone gate, per the plan's Verification Boundary):
  - `repo-harness run check-task-workflow --strict`
- Contract verification command: `repo-harness run verify-contract --contract tasks/contracts/20260807-1144-architecture-root-card-closeout.contract.md --strict`. Recorded here rather than under `exit_criteria.commands_succeed`, because `verify-contract` executes every `commands_succeed` entry through `bash -c` and would otherwise invoke itself.
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/architecture/
  - .ai/context/
  - plans/
  - tasks/todos.md
  # user WIP present in the worktree during acceptance; not part of this slice, never committed by it
  - docs/researches/k4-aip-swap-dryrun.md
  - tasks/contracts/20260807-1144-architecture-root-card-closeout.contract.md
  - tasks/notes/20260807-1144-architecture-root-card-closeout.notes.md
  - tasks/reviews/20260807-1144-architecture-root-card-closeout.review.md
```

## Evidence Requirements

```yaml
evidence_requirements:
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
    - docs/architecture/requests/root.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260807-1144-architecture-root-card-closeout.notes.md
  commands_succeed:
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint: `5184ff6`
- Revert strategy: restore `docs/architecture/requests/root.md` to its `5184ff6` content, delete the added snapshot, and revert any `context-contract-sync` link writes.
