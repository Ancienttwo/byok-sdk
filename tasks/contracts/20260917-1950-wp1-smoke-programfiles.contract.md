# Task Contract: wp1-smoke-programfiles

> **Status**: Fulfilled
> **Plan**: plans/plan-20260917-1950-wp1-smoke-programfiles.md
> **Task Profile**: code-change
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-17 23:55
> **Review File**: `tasks/reviews/20260917-1950-wp1-smoke-programfiles.review.md`
> **Notes File**: `tasks/notes/20260917-1950-wp1-smoke-programfiles.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why
Round 10 (35210911450) exposed the custody-probe bash frame failing with pi's `No bash shell found` and an empty Git Bash candidate list. Pi 0.85.1005 shell.js derives candidates only from `process.env.ProgramFiles`/`ProgramFiles(x86)`; the smoke's win32 synthetic ambient omits `ProgramFiles`, so the keys projection (allowlist includes PROGRAMFILES) carries nothing and the PATH fallback finds no bash.exe. Product allowlist has no gap; the smoke ambient is unrepresentative of a real Windows host.

## Goal
`scripts/release/pi-launcher-smoke.mjs` win32 ambient spread gains `ProgramFiles: process.env.ProgramFiles` (one name on the existing line). Keys custody bash probe resolves Git Bash via `C:\Program Files\Git\bin\bash.exe` in CI round 11.

## Scope

- In scope: scripts/release/pi-launcher-smoke.mjs (one name), plan/contract trio, tasks/todos.md.
- Out of scope: product packages, implementation-identity allowlist, pi config shellPath, budgets/timeouts, ci.yml.

## Stop Conditions
- Stop if the change would touch anything beyond that ambient line or the trio artifacts.
- Stop if round 11 fails this scenario again: fresh diagnosis, no further ambient-name iteration without a new root cause.

## Falsifier
If the failure persists with ProgramFiles present in the ambient, the empty-candidate theory is falsified; revert and re-diagnose.

## Workflow Inventory

- Source plan: `plans/plan-20260917-1950-wp1-smoke-programfiles.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260917-1950-wp1-smoke-programfiles.review.md`
- Notes file: `tasks/notes/20260917-1950-wp1-smoke-programfiles.notes.md`

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
  - plans/plan-20260917-1950-wp1-smoke-programfiles.md
  - tasks/contracts/20260917-1950-wp1-smoke-programfiles.contract.md
  - tasks/reviews/20260917-1950-wp1-smoke-programfiles.review.md
  - tasks/notes/20260917-1950-wp1-smoke-programfiles.notes.md
  - scripts/release/pi-launcher-smoke.mjs
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
    - plans/plan-20260917-1950-wp1-smoke-programfiles.md
  artifacts_exist:
    - tasks/notes/20260917-1950-wp1-smoke-programfiles.notes.md
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "parse-check",
      "kind": "command",
      "command": "node --check scripts/release/pi-launcher-smoke.mjs",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "语法可解析（行为门在 CI round 11）。",
      "inputs": {"env": []}
    },
    {
      "id": "ambient-programfiles",
      "kind": "command",
      "command": "/usr/bin/grep -q \"COMSPEC: process.env.COMSPEC, ProgramFiles: process.env.ProgramFiles\" scripts/release/pi-launcher-smoke.mjs && /usr/bin/grep -q \"SystemRoot: process.env.SystemRoot\" scripts/release/pi-launcher-smoke.mjs && echo AMBIENT_OK",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "win32 ambient 携带三个标准名；其余 ambient 不变。",
      "inputs": {"env": []}
    },
    {
      "id": "allowlist-untouched",
      "kind": "command",
      "command": "git diff --quiet 240f697a -- packages/implementation-identity/src/environment.ts && echo ALLOWLIST_OK",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "产品白名单零改动（根因在 smoke ambient，不在投影面）。",
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

- One ambient name; product bytes untouched; root cause read from pi 0.85.1005 dist/utils/shell.js + round-10 log (empty candidate list).
- Behavioral gate = Windows CI round 11.

## Rollback Point

- Commit / checkpoint: 240f697a; revert this slice's commit restores the round-10 state.
