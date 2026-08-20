> **Archived**: 2026-08-21 02:20
> **Related Plan**: plans/archive/plan-20260821-0215-todo-ledger-prune-2.md
> **Outcome**: Superseded
> **Lifecycle**: contract
> **Parent Run ID**: run-20260821-0220

# Task Contract: todo-ledger-prune-2

> **Status**: Fulfilled
> **Plan**: plans/plan-20260821-0215-todo-ledger-prune-2.md
> **Task Profile**: ledger-closeout
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-21 02:15
> **Review File**: `tasks/reviews/20260821-0215-todo-ledger-prune-2.review.md`
> **Notes File**: `tasks/notes/20260821-0215-todo-ledger-prune-2.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

`tasks/todos.md` currently mixes eleven observed deferred gaps with three solution-shaped patterns imported from Hermes/Buzz research. Keeping untriggered research patterns in the ledger presents optional inspiration as an SDK commitment and makes the authoritative backlog noisier.

## Goal

Remove exactly the scheduled-dispatch, assertion-conditions, and session-single-flight rows while retaining all eleven evidence-backed deferred gaps and the canonical research that describes the removed patterns.

## Scope

- In scope: the three-row ledger deletion, plan/contract/review/notes evidence, derived harness closeout state, architecture-request archival, and completion of the already-open Bun 1.4 documentation projection in `docs/spec.md` and `docs/architecture/sdk-architecture.md`.
- Out of scope:
  - product code, protocol schemas, releases, deployments, other worktrees, and the other eleven deferred rows.
- Taste constraints: preserve the external-research assessment as the canonical source; do not replace deleted rows with aliases, compatibility wording, or another backlog authority.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if a current downstream consumer, protocol contract, or second trigger source is found for any of the three deletion candidates.
- Destructive boundary: delete only the three named Markdown table rows and archive generated workflow artifacts; do not delete product data, branches, worktrees, releases, or source files.

## Falsifier

Any live consumer or current code path requires scheduled dispatch, assertion conditions, or shared-session single-flight semantics. Cheapest proof: repository and Salesko source search plus the existing research assessment; none currently supplies such a trigger.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260821-0215-todo-ledger-prune-2.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260821-0215-todo-ledger-prune-2.review.md`
- Notes file: `tasks/notes/20260821-0215-todo-ledger-prune-2.notes.md`
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
  - docs/spec.md
  - docs/architecture/
  - plans/
  - tasks/todos.md
  - tasks/current.md
  - tasks/archive/
  - tasks/contracts/20260821-0215-todo-ledger-prune-2.contract.md
  - tasks/reviews/20260821-0215-todo-ledger-prune-2.review.md
  - tasks/notes/20260821-0215-todo-ledger-prune-2.notes.md
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
    - docs/researches/2026-08-12_hermes-buzz-extraction-assessment.md
  artifacts_exist:
    - tasks/notes/20260821-0215-todo-ledger-prune-2.notes.md
  commands_succeed:
    - test "$(grep -c '^|' tasks/todos.md)" -eq 13
    - bash -lc '! rg -n "Scheduled dispatch|Assertion 条件文法|会话级单飞行调度纪律" tasks/todos.md'
    - rg -n "cron 职责切分" docs/researches/2026-08-12_hermes-buzz-extraction-assessment.md
    - rg -n "R2 assertion 条件文法" docs/researches/2026-08-12_hermes-buzz-extraction-assessment.md
    - rg -n "R3 会话级单飞行调度纪律" docs/researches/2026-08-12_hermes-buzz-extraction-assessment.md
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: deferred-goal count becomes eleven; no product behavior changes.
- Edge cases: the removed patterns remain searchable in the canonical research assessment and archived workflow history.
- Regression risks: accidental deletion of an observed gap or loss of the research source.

## Rollback Point

- Commit / checkpoint: `53f50f543d95cc2a839f6946fe38099a33df2ebb` before this batch.
- Revert strategy: restore the three table rows from this plan or the research assessment.
