# Task Contract: pg-pool-error-and-flake

> **Status**: Fulfilled
> **Plan**: plans/plan-20260813-0259-pg-pool-error-and-flake.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-13 02:59
> **Review File**: `tasks/reviews/20260813-0259-pg-pool-error-and-flake.review.md`
> **Notes File**: `tasks/notes/20260813-0259-pg-pool-error-and-flake.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

`createByokPool`（`packages/cloud-postgres/src/pool.ts:46-48`）是 bare `new pg.Pool`，全仓无 pool `'error'` handler。pg 要求 pool 必须挂 error handler，否则 idle backend 被重置（failover / `pg_terminate_backend` / 网络瞬断）会抛未处理 `'error'` 直接崩宿主 SaaS 进程。同一 reset 类在 CI（`docker compose down -v`）表现为 Node 22 dataplane job 测试后 `socket hang up` flake（R1 ship 期间反复出现）。做错/跳过的代价：生产宿主随机崩溃 + CI 持续 flaky 拖累后续 PR。

## Goal

`createByokPool` 挂 pool `'error'` handler（可观测默认 + 可选 `onPoolError` 注入），消除未处理 pool error 崩溃；先插桩确认 dataplane `socket hang up` 来自 pg pool 还是 undici→MinIO keep-alive，据实修确认源；pg handler 无论如何落地（独立生产 bug）。验收面是此前 flaky 的 Node 22+24 dataplane CI job 连续绿。

## Scope

- In scope: `packages/cloud-postgres/`（`pool.ts` 主改，测试，MinIO 套件的 undici dispatcher teardown）；`packages/cloud-postgres/package.json`（加 `undici` devDep）；`pnpm-lock.yaml`（devDep 引入的锁文件更新）。
- Out of scope: 其他包的 pg 使用（cloud-postgres 是唯一消费者）；pool 所有权模型；int8 parser；任何 wire/schema/migration 改动。
- Scope amendment（2026-08-13）：instrument-first 调查证伪 pg-pool 假设、定位 flake 为 undici→MinIO keep-alive；真因修复需 `undici` 控制面（`setGlobalDispatcher`/`getGlobalDispatcher().close()`），只能经 `undici` devDep 引入，故扩 Allowed Paths 含 `pnpm-lock.yaml` 与 cloud-postgres `package.json`。pg pool handler（Part 1）已独立完成。
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

假设:dataplane `socket hang up` 源于未处理的 pg pool idle-reset。证伪证据:插桩显示 reset 来自 undici→MinIO keep-alive(对象套件 `globalThis.fetch`,`r2-blobs.ts:277,600`)而非 pg backend——`socket hang up` 恰是 undici/http 的签名文案而非 pg 的 `Connection terminated unexpectedly`。最便宜验证点:插桩记录 socket reset 来源后跑一次 dataplane 套件。若证伪,flake 修复移到对象套件 fetch dispatcher teardown,但 pg pool error handler 仍作为独立生产修复保留。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260813-0259-pg-pool-error-and-flake.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260813-0259-pg-pool-error-and-flake.review.md`
- Notes file: `tasks/notes/20260813-0259-pg-pool-error-and-flake.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260813-0259-pg-pool-error-and-flake.md
  - tasks/todos.md
  - tasks/contracts/20260813-0259-pg-pool-error-and-flake.contract.md
  - tasks/reviews/20260813-0259-pg-pool-error-and-flake.review.md
  - tasks/notes/20260813-0259-pg-pool-error-and-flake.notes.md
  - packages/cloud-postgres/
  - pnpm-lock.yaml
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
      - codex-exec
      - main-thread
    fallback: main-thread
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - packages/cloud-postgres/src/pool.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260813-0259-pg-pool-error-and-flake.notes.md
  tests_pass:
    - path: packages/cloud-postgres/src/__tests__/pool.test.ts
  commands_succeed:
    - pnpm -r run typecheck
    - pnpm -r run test
    - pnpm -r run build
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint:
- Revert strategy:
