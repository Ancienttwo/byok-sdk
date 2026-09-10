# Task Contract: downstream-issue-intake

> **Status**: Active
> **Plan**: plans/plan-20260910-0214-downstream-issue-intake.md
> **Task Profile**: docs-only
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-10 02:14
> **Review File**: `tasks/reviews/20260910-0214-downstream-issue-intake.review.md`
> **Notes File**: `tasks/notes/20260910-0214-downstream-issue-intake.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Downstream integrators need a discoverable, structured upstream feedback entrypoint.

## Goal

Provide one native GitHub issue form and linked browser/CLI submission guidance.

## Scope

- In scope: issue form, submission guide, README/diagnostics entrypoints, approved default-branch landing and GitHub page readback.
- Out of scope: runtime code, automated reporting, creating real issues, package publication and existing WIP.
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

What observable evidence would prove this task's direction wrong, and the cheapest proof point to check first. Leave as-is if not applicable.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260910-0214-downstream-issue-intake.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260910-0214-downstream-issue-intake.review.md`
- Notes file: `tasks/notes/20260910-0214-downstream-issue-intake.notes.md`
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
  - .github/ISSUE_TEMPLATE/downstream-integration.yml
  - docs/upstream-requests.md
  - README.md
  - docs/agent-diagnostics-integration.md
  - plans/
  - tasks/contracts/20260910-0214-downstream-issue-intake.contract.md
  - tasks/reviews/20260910-0214-downstream-issue-intake.review.md
  - tasks/notes/20260910-0214-downstream-issue-intake.notes.md
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
    - .github/ISSUE_TEMPLATE/downstream-integration.yml
    - docs/upstream-requests.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260910-0214-downstream-issue-intake.notes.md
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "diff-whitespace",
      "kind": "command",
      "command": "git diff --check",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Validate changed text formatting.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "form-yaml",
      "kind": "command",
      "command": "bun -e 'const f=Bun.YAML.parse(await Bun.file(\".github/ISSUE_TEMPLATE/downstream-integration.yml\").text()); if (!f.name || !f.description || f.body.length !== 10) throw new Error(\"Invalid issue form\");'",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Parse the GitHub issue form using Bun YAML.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "version-authority",
      "kind": "command",
      "command": "bun run check:version-authority",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Ensure README edits preserve published version authority.",
      "inputs": {
        "env": []
      }
    }
  ]
}
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint:
- Revert strategy:
