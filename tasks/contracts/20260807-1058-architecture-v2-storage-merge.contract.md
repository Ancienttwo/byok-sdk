# Task Contract: architecture-v2-storage-merge

> **Status**: Fulfilled
> **Plan**: plans/plan-20260807-1058-architecture-v2-storage-merge.md
> **Task Profile**: docs-only
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-07 11:02
> **Review File**: `tasks/reviews/20260807-1058-architecture-v2-storage-merge.review.md`
> **Notes File**: `tasks/notes/20260807-1058-architecture-v2-storage-merge.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The GPT Pro v2 bundle at `_ref/byok-architecture-rewrite-v2/` supersedes the v1 bundle whose target-design increments were merged into `docs/architecture/sdk-architecture.md` and `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` by the archived `architecture-merge-gpt-pro` slice. The v2 delta closes storage gaps the v1 design left open: the local journal was still a file implementation (now SQLite-canonical), the production cloud composition was still Postgres/S3 primary with D1/R2 parity (now decided as Postgres + R2), and there was no storage entitlement/usage/reservation contract, quota error taxonomy, disk-watermark policy, or safe cleanup ordering. If the repo documents keep the v1 scope, the next platform sprint would project contracts from a superseded design.

## Goal

Fold the v1→v2 bundle deltas into the three repo artifacts derived from the v1 bundle, preserving every repo-side v1 adaptation (current-state evidence skeleton, 目標設計 markers, sprint status legal values, crosswalk, S4A/S4B structure, withdrawn C1/C2 record). The mechanical `diff -u` between `_ref/byok-architecture-rewrite/` and `_ref/byok-architecture-rewrite-v2/` for the charter and the sprint file is the authority for what "done" means.

Four acceptance targets, projected from the plan's `## Task Breakdown`:

1. **Canonical document merge** (`B1`). Every charter delta group lands in the matching target-design block of `docs/architecture/sdk-architecture.md`; current-state sections stay byte-identical except where a delta group explicitly extends a ledger table.
2. **Sprint file merge** (`B2`). Every sprint delta group lands in `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md`, with S4A re-scoped to the Postgres + R2 data plane and S4B to quota/reservation/GC, D1 demoted to an optional post-Beta adapter.
3. **Decision record supersede note** (`B3`). `docs/researches/gpt-pro-architecture-rewrite-decision.md` records the v2 bundle path, ZIP SHA-256, delta summary, and that the v1 merge rubric carries over.
4. **Verification** (`B4`). `repo-harness run check-task-workflow --strict` passes with this slice's plan/contract pair active.

One constraint binds the slice: this is a documentation slice. No source or test file changes.

## Scope

- In scope: `docs/architecture/sdk-architecture.md` target-design blocks and ledger tables; the RAFT-aligned sprint file; the GPT Pro decision record; this slice's workflow artifacts.
- Out of scope: `packages/**`, `docs/spec.md`, the sealed K-line plan/contract/review/notes, `_ref/**` (read-only reference), any current-state claim in the canonical document.
- Taste constraints: keep the canonical document's zh-CN prose register and existing 目標設計 marking convention; do not reformat unchanged blocks.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if a v2 delta group would require asserting a current-runtime fact not verifiable against local source.

## Falsifier

If any heading or table row named only in the v1 bundle's superseded S4 shape (Postgres/S3 primary、D1/R2 parity as a required beta gate, or the file-journal L-001 story) survives in the edited sections of the two `docs/`-and-sprint targets after the merge, the fold missed a delta group. Cheapest proof: re-run the v1→v2 bundle diffs and spot-check each hunk's counterpart in the repo files.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260807-1058-architecture-v2-storage-merge.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260807-1058-architecture-v2-storage-merge.review.md`
- Notes file: `tasks/notes/20260807-1058-architecture-v2-storage-merge.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Verification command (the milestone gate, per the plan's Verification Boundary):
  - `repo-harness run check-task-workflow --strict`
- Contract verification command: `repo-harness run verify-contract --contract tasks/contracts/20260807-1058-architecture-v2-storage-merge.contract.md --strict`. Recorded here rather than under `exit_criteria.commands_succeed`, because `verify-contract` executes every `commands_succeed` entry through `bash -c` and would otherwise invoke itself.
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/architecture/sdk-architecture.md
  - docs/researches/
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260807-1058-architecture-v2-storage-merge.contract.md
  - tasks/notes/20260807-1058-architecture-v2-storage-merge.notes.md
  - tasks/reviews/20260807-1058-architecture-v2-storage-merge.review.md
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
    - docs/architecture/sdk-architecture.md
    - plans/sprints/20260807-byok-platform-raft-aligned.sprint.md
    - docs/researches/gpt-pro-architecture-rewrite-decision.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260807-1058-architecture-v2-storage-merge.notes.md
  commands_succeed:
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint: `f81e844`
- Revert strategy: restore `docs/architecture/sdk-architecture.md`, `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md`, and `docs/researches/gpt-pro-architecture-rewrite-decision.md` to their `f81e844` content.
