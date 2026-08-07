# Task Contract: architecture-merge-gpt-pro

> **Status**: Fulfilled
> **Plan**: plans/plan-20260807-0931-architecture-merge-gpt-pro.md
> **Task Profile**: docs-only
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-07 09:31
> **Review File**: `tasks/reviews/20260807-0931-architecture-merge-gpt-pro.review.md`
> **Notes File**: `tasks/notes/20260807-0931-architecture-merge-gpt-pro.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

`docs/architecture/sdk-architecture.md` is the single canonical architecture authority for this repo: a recomputable due-diligence snapshot whose claims about current runtime are anchored to `file:line` evidence. The GPT Pro rewrite bundle in `_ref/byok-architecture-rewrite/` contains real target-design increments the canonical document is missing (crash matrix, journal contract, GAP-004/GAP-005, I1-I9, the ADR ledger), but it was written without a local checkout and carries nine falsified current-runtime claims. If the increments are merged without the marking rule, the canonical document stops being a trustworthy current-state snapshot; if they are discarded, verified real gaps stay unrecorded.

## Goal

Execute option B from `docs/researches/gpt-pro-architecture-rewrite-decision.md`, which is the authority for what "done" means here: keep the canonical document's current-state evidence skeleton, apply the six self-corrections it owes regardless of the bundle, and merge the ten target-design increment groups into §12-§15 with an explicit 目標設計 marker, rejecting every E1-E9 claim.

Three acceptance targets, projected from the plan's `## Task Breakdown`:

1. **Canonical document merge** (`A1`). The six items under 「canonical 自身要修的錯」 are applied, and the ten groups under 「併入清單」 are merged into §12-§15, each marked as target design. No E1-E9 claim appears.
2. **Proposed sprint file** (`A2`). The sprint file lands under `plans/sprints/` with the 4+1 preconditions applied. A parallel agent may already have completed this; verify and annotate rather than rewrite.
3. **Verification** (`A3`). `repo-harness run check-task-workflow --strict` passes, confirming the new Proposed sprint file does not conflict with the Executing K-line plan.

One constraint binds the slice: this is a documentation slice. No source or test file changes.

## Scope

- In scope: `docs/architecture/sdk-architecture.md`, the Proposed sprint file under `plans/`, the decision record under `docs/researches/`, the deferred-goal ledger, and this slice's own plan/contract/notes/review workflow artifacts.
- Out of scope: every `packages/**` path (docs-only slice — no runtime or test change); `docs/spec.md`; `docs/security.md`.
- Out of scope, hard: the K-line plan `plans/plan-20260805-1659-byok-keys-package.md` and its contract, notes, and review. That line is Executing and sealed; its status and content must not move. Deferred items that would otherwise be appended to it (K-501) go to `tasks/todos.md` instead.
- Out of scope: running the bundle's `apply.sh`, or any whole-file replacement of the canonical document.
- Taste constraints: preserve the existing P1/P2/P3 + `file:line` evidence structure required by `CLAUDE.md`; any statement about current runtime must cite source verifiable in this checkout.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if a merge item would require asserting a current-runtime fact not verifiable against local source.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

If the canonical document's §12-§15 cannot absorb the increments without restating current runtime, option B is the wrong shape and the increments belong in a separate target-design document. Cheapest proof point: attempt the first merge group (§6 state and consistency models) and check whether it can stand entirely under a target-design marker without amending any current-state claim.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

## Workflow Inventory

- Source plan: `plans/plan-20260807-0931-architecture-merge-gpt-pro.md`
- Decision authority: `docs/researches/gpt-pro-architecture-rewrite-decision.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260807-0931-architecture-merge-gpt-pro.review.md`
- Notes file: `tasks/notes/20260807-0931-architecture-merge-gpt-pro.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Verification command (the milestone gate, per the plan's Verification Boundary):
  - `repo-harness run check-task-workflow --strict`
- Contract verification command: `repo-harness run verify-contract --contract tasks/contracts/20260807-0931-architecture-merge-gpt-pro.contract.md --strict`. Recorded here rather than under `exit_criteria.commands_succeed`, because `verify-contract` executes every `commands_succeed` entry through `bash -c` and would otherwise invoke itself.
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.

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
  - tasks/contracts/20260807-0931-architecture-merge-gpt-pro.contract.md
  - tasks/notes/20260807-0931-architecture-merge-gpt-pro.notes.md
  - tasks/reviews/20260807-0931-architecture-merge-gpt-pro.review.md
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
    - docs/researches/gpt-pro-architecture-rewrite-decision.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260807-0931-architecture-merge-gpt-pro.notes.md
  commands_succeed:
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint: `188dca9`
- Revert strategy: restore `docs/architecture/sdk-architecture.md` to its `188dca9` content and delete the Proposed sprint file added by this slice.
