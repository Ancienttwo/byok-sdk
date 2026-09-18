# Task Contract: wp1-warmup-restore

> **Status**: Fulfilled
> **Plan**: plans/plan-20260917-1724-wp1-warmup-restore.md
> **Task Profile**: bugfix
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-17 17:26
> **Review File**: `tasks/reviews/20260917-1724-wp1-warmup-restore.review.md`
> **Notes File**: `tasks/notes/20260917-1724-wp1-warmup-restore.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why
Round 5 regressed to the rounds-1-3 module-load failure signature (test 1 slow-fail 5006ms + three fast generic fails; round 3: 4044/398/345/366ms). The Import-Module-only warm-up does not produce the state that round 4's Import-Module + (Get-Command Get-Acl).Name form demonstrably produced for subsequent processes.

## Goal
ci.yml warm-up restored to the round-4 proven form with an exit-code gate; round 6 validates warm-up + translate fix together; lowpriv keys suite expected 4/4 green.

## Scope

- In scope: .github/workflows/ci.yml (warm-up block only), plan/contract trio, tasks/todos.md.
- Out of scope: product code (keys already fixed in 6105f7cf), test files, anything else.

## Stop Conditions
- Stop if the change would touch anything beyond the warm-up block or trio artifacts.
- Stop if round 6 still fails the keys suite (re-instrument stderr under fresh ruling rather than blind iteration; fail->fix->reverify cap 3 rounds per issue: this is round 2 of the warm-up issue).

## Falsifier
If the lane still red after the proven warm-up form returns, the warm-up theory is falsified for round 5's cause and the next step must be instrumentation, not another blind tweak.

## Root Cause Evidence

- root_cause: ci.yml warm-up downgrade (Import-Module without (Get-Command Get-Acl).Name) at eb1a5eca removed the state round 4's warm-up produced; fresh PS 5.1 processes under the synthetic token then fail Microsoft.PowerShell.Security auto-load again.
- repro: Windows CI lowpriv keys step; rounds 1-3 fail, round 4 pass-through, round 5 fail with matching timing signature.
- regression_guard: packages/keys/src/pi-projection-windows.test.ts
- pre_fix_failure_artifact: tasks/notes/20260917-1724-wp1-warmup-restore.round5.red-run.txt

## Workflow Inventory

- Source plan: `plans/plan-20260917-1724-wp1-warmup-restore.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260917-1724-wp1-warmup-restore.review.md`
- Notes file: `tasks/notes/20260917-1724-wp1-warmup-restore.notes.md`

## Change Assessment

```json
{"protocol":1,"oracles":[]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-review","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260917-1724-wp1-warmup-restore.md
  - tasks/contracts/20260917-1724-wp1-warmup-restore.contract.md
  - tasks/reviews/20260917-1724-wp1-warmup-restore.review.md
  - tasks/notes/20260917-1724-wp1-warmup-restore.notes.md
  - tasks/notes/20260917-1724-wp1-warmup-restore.round5.red-run.txt
  - .github/workflows/ci.yml
  - tasks/todos.md
```

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - plans/plan-20260917-1724-wp1-warmup-restore.md
  artifacts_exist:
    - tasks/notes/20260917-1724-wp1-warmup-restore.notes.md
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "warmup-proven-form",
      "kind": "command",
      "command": "grep -q \"(Get-Command Get-Acl).Name\" .github/workflows/ci.yml && grep -q 'Fail 92' .github/workflows/ci.yml && echo WARMUP_FORM_OK",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "round-4 实证形态 + 门控存在。",
      "inputs": {"env": []}
    },
    {
      "id": "keys-suite-guard",
      "kind": "package_test",
      "path": "packages/keys/src/pi-projection-windows.test.ts",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "regression_guard 套件（非 win32 全 skip；行为门在 CI round 8 已 4/4 绿）。",
      "inputs": {"env": []}
    },
    {
      "id": "keys-untouched",
      "kind": "command",
      "command": "git diff --quiet 6105f7cf -- packages/keys/ && echo KEYS_UNTOUCHED",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "本切片不动产品码（6105f7cf 已含 translate 修复）。",
      "inputs": {"env": []}
    },
    {
      "id": "diff-whitespace",
      "kind": "command",
      "command": "git diff --check",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Validate changed text formatting.",
      "inputs": {"env": []}
    }
  ]
}
```

## Acceptance Notes (Human Review)

- ci.yml-only restore; product bytes untouched since 6105f7cf.
- Behavioral gate = round-6 CI (4/4 expected). Warm-up issue round 2 of 3 cap.

## Rollback Point

- Commit / checkpoint: baf0920f; revert this slice's commit returns to round-5 state (known bad warm-up, kept only as reference).
