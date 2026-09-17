# Task Contract: wp1-smoke-observer-import-url

> **Status**: Active
> **Plan**: plans/plan-20260917-2130-wp1-smoke-observer-import-url.md
> **Task Profile**: code-change
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-17 21:30
> **Review File**: `tasks/reviews/20260917-2130-wp1-smoke-observer-import-url.review.md`
> **Notes File**: `tasks/notes/20260917-2130-wp1-smoke-observer-import-url.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why
Round 11 (35218215293) cleared every prior frame and failed only at the tools-observer stage: the smoke generates `tools-observer.mjs` whose STATIC import specifiers are raw absolute paths (`piEntry`, `sdkMcpExtension`; generated at pi-launcher-smoke.mjs:218-219). On win32 an ESM specifier `C:\...` parses as protocol `c:` -> `ERR_UNSUPPORTED_ESM_URL_SCHEME` at module load; POSIX resolves `/abs` as a file URL, so all other legs are green. The smoke's own sealed/todo probes (:269/:278) already use the correct `pathToFileURL(...).href` idiom.

## Goal
Both generated observer import specifiers become `pathToFileURL(<path>).href` (two line edits, no other change). Windows CI round 12 runs the observer stage to completion in the lowpriv lane.

## Scope

- In scope: scripts/release/pi-launcher-smoke.mjs (the two specifier expressions at :218-219 only), plan/contract/review/notes trio, tasks/todos.md.
- Out of scope: product packages, ambient names, budgets/timeouts, ci.yml, the sealed/todo probe entries (already correct).

## Stop Conditions
- Stop if the fix needs more than the two specifier expressions.
- Stop if round 12 fails the observer stage again: fresh diagnosis, no speculative iteration.

## Falsifier
If the observer still crashes with ERR_UNSUPPORTED_ESM_URL_SCHEME (or any module-load failure) with URL specifiers in place, the specifier theory is falsified; revert and re-diagnose. A pass that weakens the observer assertions (status/e2e coverage) instead of fixing the specifier is not a pass.

## Workflow Inventory

- Source plan: `plans/plan-20260917-2130-wp1-smoke-observer-import-url.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260917-2130-wp1-smoke-observer-import-url.review.md`
- Notes file: `tasks/notes/20260917-2130-wp1-smoke-observer-import-url.notes.md`
- Scope gate: edit only paths listed under `allowed_paths`.

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
  - plans/plan-20260917-2130-wp1-smoke-observer-import-url.md
  - tasks/contracts/20260917-2130-wp1-smoke-observer-import-url.contract.md
  - tasks/reviews/20260917-2130-wp1-smoke-observer-import-url.review.md
  - tasks/notes/20260917-2130-wp1-smoke-observer-import-url.notes.md
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
    - plans/plan-20260917-2130-wp1-smoke-observer-import-url.md
  artifacts_exist:
    - tasks/notes/20260917-2130-wp1-smoke-observer-import-url.notes.md
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
      "necessity": "语法可解析（行为门在本地 darwin 全量 smoke + CI round 12）。",
      "inputs": {"env": []}
    },
    {
      "id": "specifier-url-form",
      "kind": "command",
      "command": "/usr/bin/grep -cF 'from ${JSON.stringify(pathToFileURL(piEntry).href)}' scripts/release/pi-launcher-smoke.mjs | /usr/bin/grep -qE '^1$' && /usr/bin/grep -cF 'from ${JSON.stringify(pathToFileURL(sdkMcpExtension).href)}' scripts/release/pi-launcher-smoke.mjs | /usr/bin/grep -qE '^1$' && echo SPECIFIER_URL_OK",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "两个生成式 import specifier 使用 file URL 形态（各恰一次）。",
      "inputs": {"env": []}
    },
    {
      "id": "no-raw-path-specifier",
      "kind": "command",
      "command": "! /usr/bin/grep -qF 'from ${JSON.stringify(piEntry)}' scripts/release/pi-launcher-smoke.mjs && ! /usr/bin/grep -qF 'from ${JSON.stringify(sdkMcpExtension)}' scripts/release/pi-launcher-smoke.mjs && echo NO_RAW_SPECIFIER",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "不再存在裸路径 specifier 残留。",
      "inputs": {"env": []}
    },
    {
      "id": "product-bytes-untouched",
      "kind": "command",
      "command": "git diff --quiet 26651ba2 -- packages/ && echo PRODUCT_OK",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "产品字节零改动（根因在 smoke 生成代码，不在产品面）。",
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

- Two specifier expressions; product bytes untouched; root cause = round-11 log (ERR_UNSUPPORTED_ESM_URL_SCHEME protocol 'c:' at generated observer entry load) + source read (:218-219 vs the correct :269/:278 idiom).
- Behavioral gates: local darwin packed smoke (observer stage on POSIX) + Windows CI round 12 lowpriv lane.

## Rollback Point

- Commit / checkpoint: 26651ba2; revert this slice's commit restores the round-11 state.
