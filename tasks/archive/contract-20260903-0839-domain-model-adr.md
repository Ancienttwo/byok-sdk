> **Archived**: 2026-09-03 08:39
> **Related Plan**: plans/archive/plan-20260903-0442-domain-model-adr.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260903-0839

# Task Contract: domain-model-adr

> **Status**: Fulfilled
> **Plan**: plans/plan-20260903-0442-domain-model-adr.md
> **Task Profile**: docs-only
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-03 04:50
> **Review File**: `tasks/reviews/20260903-0442-domain-model-adr.review.md`
> **Notes File**: `tasks/notes/20260903-0442-domain-model-adr.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

WP3A/WP3B/WP4 of `docs/researches/2026-09-03_architecture-review.md` will each touch the same vocabulary (Installation / Session / Run / Attempt / Workspace), the same authority boundaries and the same capability model. Without Accepted ADRs, three parallel work packages re-decide those in code and drift; with them, each later contract can cite a normative constraint as an exit criterion.

## Goal

One new ADR file under `docs/architecture/` carrying nine Accepted ADRs (domain vocabulary; one-fact-one-authority matrix; native session locator local-only + SDK-minted sessionId; store-minted Attempt + leaseEpoch fencing; FeatureRegistry with three independent authorities and admission by intersection; AgentHome/SessionState/Workspace separation with mutable-Workspace single writer; coordination kernel single authority with WS retirement; data policy profiles `local-first-v1` / `shared-observability-v1` + SessionResultCommitter; legacy cutover policy), each with Context / Decision (must/must-not) / Consequences / Status and citing the review section plus the current `file:line` it constrains; ledger rows appended to `docs/architecture/sdk-architecture.md` 附录A; one link in `docs/architecture/index.md`.

## Scope

- In scope: the three files above.
- Out of scope: `docs/spec.md` (owned concurrently by WP0), any code, any other section of `sdk-architecture.md`, deciding anything the review left open (record such items as `Proposed` with the open question instead).
- Taste constraints: normative wording; no restating review prose; every ADR ≤ ~40 lines; numbering continues from the current 附录A maximum.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if an ADR would contradict an owner ruling recorded in the review (D1–D5, §12).

## Falsifier

If 附录A already contains an Accepted ADR that decides one of the nine topics differently, do not overwrite it: mark the new ADR `Supersedes ADR-0NN` and say why, citing the review section; if the review itself does not justify superseding, stop and report.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260903-0442-domain-model-adr.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260903-0442-domain-model-adr.review.md`
- Notes file: `tasks/notes/20260903-0442-domain-model-adr.notes.md`
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
  - plans/
  - tasks/todos.md
  - tasks/current.md
  - tasks/contracts/20260903-0442-domain-model-adr.contract.md
  - tasks/reviews/20260903-0442-domain-model-adr.review.md
  - tasks/notes/20260903-0442-domain-model-adr.notes.md
  - docs/architecture/adr-2026-09-03-domain-model-and-authority.md
  - docs/architecture/sdk-architecture.md
  - docs/architecture/index.md
  - docs/researches/2026-09-03_architecture-review.md
  - docs/researches/20260903-GPT-review.md
  - docs/researches/20260903-GPT-review-2.md
  - docs/researches/evidence/2026-09-03-architecture-review/
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
    - docs/architecture/adr-2026-09-03-domain-model-and-authority.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260903-0442-domain-model-adr.notes.md
  tests_pass: []
  commands_succeed:
    - bun run check:version-authority
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: nine ADRs, each Context / Decision / Consequences / Status with a review citation and a current `file:line`; ledger rows and index link present; spec untouched.
- Edge cases: no ADR contradicts D1–D5 or §12 rulings; open questions are `Proposed`, not decided.
- Regression risks: none (docs-only).

## Rollback Point

- Commit / checkpoint: branch base = current `main` at worktree start.
- Revert strategy: revert the single commit.
