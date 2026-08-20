> **Archived**: 2026-08-21 01:06
> **Related Plan**: plans/archive/plan-20260820-2324-one-command-publish.md
> **Outcome**: Superseded
> **Lifecycle**: contract
> **Parent Run ID**: run-20260821-0106

# Task Contract: one-command-publish

> **Status**: Active
> **Plan**: plans/plan-20260820-2324-one-command-publish.md
> **Task Profile**: ledger-closeout
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-21
> **Review File**: `tasks/reviews/20260820-2324-one-command-publish.review.md`
> **Notes File**: `tasks/notes/20260820-2324-one-command-publish.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

`be5b16f` and the 0.5.0 release exist, but the captured code-change contract has an invalid risk input, paths that omit the required closeout artifacts, a nonexistent test, and no AcceptanceReceipt. Leaving it active would present stale workflow state as executable work.

## Goal

Rebind the stale active workflow to an evidence-only ledger closeout, preserve the verified release and downstream-consumption facts, and archive the unusable original workflow without manufacturing product-test or acceptance evidence.

## Scope

- In scope: historical evidence projection, deferred-ledger correction, architecture request archival, harness-derived closeout state, and workflow artifact archive.
- Out of scope: product code, package manifests, `scripts/release/publish.mjs`, tag/publish/deploy, and a new `--execute` run.

## Stop Conditions

- Stop if release or downstream evidence contradicts the recorded commits or public readbacks.
- Stop if closeout needs an AcceptanceReceipt that is not already present.

## Falsifier

`git merge-base --is-ancestor be5b16f87808add4b71e7b25ac51e858c741d658 v0.5.0` or the equivalent Salesko main ancestry check fails.

## Workflow Inventory

- Source plan: `plans/plan-20260820-2324-one-command-publish.md`
- Deferred-goal ledger: `tasks/todos.md`
- Research evidence: `docs/researches/2026-08-12-salesko-consumption-evidence.md`
- Review and notes: paths above.
- Architecture request: `docs/architecture/requests/root.md`.

## Change Assessment

```json
{"protocol":1,"oracles":[]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"unavailable","user_waiver":"not_requested"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/
  - tasks/todos.md
  - tasks/current.md
  - tasks/archive/
  - tasks/contracts/20260820-2324-one-command-publish.contract.md
  - tasks/reviews/20260820-2324-one-command-publish.review.md
  - tasks/notes/20260820-2324-one-command-publish.notes.md
  - docs/researches/2026-08-12-salesko-consumption-evidence.md
  - docs/architecture/
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
    - scripts/release/publish.mjs
    - docs/researches/2026-08-12-salesko-consumption-evidence.md
  commands_succeed:
    - git merge-base --is-ancestor be5b16f87808add4b71e7b25ac51e858c741d658 v0.5.0
    - git -C /Users/kito/Projects/salesko-new merge-base --is-ancestor 18771502724ca9383d55c097723e112979102bac main
```

## Acceptance Notes (Human Review)

- No typed AcceptanceReceipt exists for the original code-change workflow.
- This contract proves archive eligibility only; it does not certify the already published release anew.

## Rollback Point

- Commit / checkpoint: `be5b16f87808add4b71e7b25ac51e858c741d658`.
- Revert strategy: no product change in this closeout; preserve the archive and correct evidence only with a follow-up ledger task.
