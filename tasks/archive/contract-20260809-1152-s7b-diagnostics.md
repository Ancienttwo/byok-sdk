> **Archived**: 2026-08-09 11:52
> **Related Plan**: plans/archive/plan-20260809-0638-s7b-diagnostics.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260809-1152

# Task Contract: s7b-diagnostics

> **Status**: Fulfilled
> **Plan**: plans/plan-20260809-0638-s7b-diagnostics.md
> **Task Profile**: code-change
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-09 06:38
> **Review File**: `tasks/reviews/20260809-0638-s7b-diagnostics.review.md`
> **Notes File**: `tasks/notes/20260809-0638-s7b-diagnostics.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

S7-a 已提供 health/crash authority，但 operator 仍没有可信的 runtime/store/quarantine 汇总、隐私安全的 support bundle 或显式修复入口。若把这些拖到 publish，corrupt state 会只能靠人工删文件，support 请求也容易直接打包 token、prompt 或本机路径。

## Goal

交付 headless `doctor` 与 `support-bundle`：默认只读、typed、bounded、redaction-first；唯一初始 `doctor --fix --yes` 行为是把已确认 corrupt 的 health state无损搬入 quarantine 并写 digest manifest。同步 hosted/self-hosted operations 与 host-owned signing/updater/rollback runbooks，并跑 load/reconnect/retention drills。

## Scope

- In scope: client diagnostics collector；doctor plain/JSON；explicit health quarantine fix；bounded JSON support bundle；runtime/control/journal/health/quarantine checks；operations/release-responsibility runbooks；tests/docs/evidence。
- Out of scope: automatic quarantine cleanup；journal rebuild/repair；wire/cloud/core/keys behavior；SQL migrations；npm names/version/publish；SDK updater/supervisor。
- Taste constraints: one typed collector；allowlist serialization；no raw config/audit dump；default commands write nothing；fix requires both `--fix` and `--yes` and never deletes evidence。

## Stop Conditions

- Stop if diagnostics requires weakening control-socket authentication or reading provider credentials。
- Stop if an honest fix requires rebuilding journal/domain state rather than preserving evidence。
- Stop if protocol、migration or package identity must change。
- Stop if hard dataplane gates cannot run。

## Falsifier

Place unique sentinel secrets in config、audit、token and local paths, run both doctor and support-bundle, then byte-search outputs；any sentinel appears, or a report-only run changes any store file digest, disproves the design。For fix, quarantined bytes must hash exactly to the pre-fix file and no fresh healthy file may appear。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: not-applicable
- repro: not-applicable
- regression_guard: not-applicable
- pre_fix_failure_artifact: not-applicable

## Workflow Inventory

- Source plan: `plans/plan-20260809-0638-s7b-diagnostics.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260809-0638-s7b-diagnostics.review.md`
- Notes file: `tasks/notes/20260809-0638-s7b-diagnostics.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt, then run `verify-sprint`；review Markdown is projection only。

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - .github/workflows/ci.yml
  - docs/architecture/sdk-architecture.md
  - deploy/runbooks/
  - plans/plan-20260809-0638-s7b-diagnostics.md
  - plans/plan-20260809-0520-s7a-fleet-health.md
  - plans/sprints/20260807-byok-platform-raft-aligned.sprint.md
  - tasks/current.md
  - tasks/todos.md
  - tasks/contracts/20260809-0638-s7b-diagnostics.contract.md
  - tasks/contracts/20260809-0520-s7a-fleet-health.contract.md
  - tasks/reviews/20260809-0638-s7b-diagnostics.review.md
  - tasks/notes/20260809-0638-s7b-diagnostics.notes.md
  - tasks/notes/20260809-0520-s7a-fleet-health.notes.md
  - packages/client/
  - pnpm-lock.yaml
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
    verifier:
      mode: read_only
      purpose: exact_sha_review
  runner:
    preferred:
      - main-thread
    fallback: main-thread
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - packages/client/src/diagnostics/diagnostics.ts
    - packages/client/src/diagnostics/support-bundle.ts
    - packages/client/src/bin/commands/doctor.ts
    - packages/client/src/bin/commands/support-bundle.ts
    - deploy/runbooks/hosted-operations.md
    - deploy/runbooks/self-hosted-operations.md
    - deploy/runbooks/release-responsibility.md
  artifacts_exist:
    - tasks/notes/20260809-0638-s7b-diagnostics.notes.md
  commands_succeed:
    - pnpm --filter @byok/client exec vitest run src/__tests__/diagnostics.test.ts src/__tests__/support-bundle.test.ts
    - pnpm --filter @byok/client run typecheck
    - pnpm --filter @byok/client run test
    - pnpm --filter @byok/client run build
    - pnpm -r run typecheck
    - BYOK_REQUIRE_DATAPLANE=1 BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 pnpm -r run test
    - pnpm -r run build
    - git diff --exit-code origin/main -- packages/protocol deploy/sql packages/core packages/keys packages/cloud packages/cloud-postgres packages/server
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: report-only commands remain useful with daemon offline；fix is explicit and evidence-preserving。
- Edge cases: corrupt/oversized health state、missing files、unreachable control、invalid quarantine manifest、large audit/quarantine inventories、output overwrite refusal。
- Regression risks: CLI parser drift、path/secret leakage、unbounded file reads、Windows rename semantics。

## Rollback Point

- Commit / checkpoint: `origin/main@489255baab10a51173302984fac0ef524734fa42`
- Revert strategy: revert S7-b client/docs files；never delete quarantine produced by an already-run fix。
