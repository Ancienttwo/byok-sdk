# Task Contract: cloud-postgres-sql-projection

> **Status**: Active
> **Plan**: plans/plan-20260812-0201-cloud-postgres-sql-projection.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-12 02:29
> **Review File**: `tasks/reviews/20260812-0201-cloud-postgres-sql-projection.review.md`
> **Notes File**: `tasks/notes/20260812-0201-cloud-postgres-sql-projection.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

已证实的发布完整性缺口（`docs/researches/2026-08-12-salesko-integration-handoff.md` 条目 3）：`@byok-sdk/cloud-postgres@0.2.0` tarball 宣称提供 migration runner 却不携带 runner 所需的 SQL——npm `files` 只有 `dist/README/LICENSE`，`deploy/sql/` 四个 migration 不在包里。每个外部 host 被迫从 git checkout 逐字 vendor SQL 并自建 provenance（salesko 已被迫落地 sha256 表），这是一整类可消除的 drift 风险。现有 `scripts/release/pack-and-smoke.mjs` 只验证安装与 import，永远抓不到发布资产缺失。下游消费方已书面确认本方案（`docs/researches/2026-08-12-salesko-consumption-evidence.md`），落地后 salesko 删 vendored SQL 改用 `migrationsDir()`。

## Goal

从精确 tarball fresh install 后，不访问源码 checkout 即可定位全部 migration：`deploy/sql` 保持唯一 authoring authority；cloud-postgres build 末尾确定性复制 `deploy/sql/*.sql` → `dist/sql/`（生成物，先清后拷）；包导出 `migrationsDir(): string` 解析安装后包内 `dist/sql`；`pack-and-smoke.mjs` 增第一层断言（tarball 内 `dist/sql` 文件名集合与逐文件 SHA-256 双向等于 `deploy/sql`，隔离安装里 `migrationsDir()` 可解析且文件齐全），保持脚本零外部服务依赖；CI 增 PG service container 第二层（精确 tarball fresh install → 空库迁移全部 applied → 重跑幂等）。`deploy/sql`、`deploy/scripts/migrate`、现有 cloud-postgres 测试、`packages/protocol|client|server|cloud` 零 diff。不 bump 版本、不发版。

## Scope

- In scope: `packages/cloud-postgres/package.json`（build script 复制步骤）、`packages/cloud-postgres/src/`（`migrationsDir()` 导出 + 单测）、`scripts/release/pack-and-smoke.mjs`（第一层断言）、`.github/workflows/`（第二层 PG service container 任务）、`packages/cloud-postgres/README.md`（`migrationsDir()` 用法，host 不再 vendor 字节）。
- Out of scope: `deploy/sql/` 与 `deploy/scripts/` 任何改动、SQL 字符串数组导出、postinstall 网络拉取、版本号与发版、其他包任何改动、runtime 双位置回退读取。
- Taste constraints: smoke 断言以 `deploy/sql` 实际内容为基准动态比对（多/少/改都必须 fail），不写死文件数量；跟随 pack-and-smoke 现有代码风格（同步 node:fs + 显式 throw）。

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if `files: ["dist"]` 的 npm 打包机制无法携带非 JS 资产（`dist/sql/*.sql` 不进 tarball）——这推翻 projection 前提，交回 parent 而不是改用其他分发机制。

## Falsifier

方向性证伪：若 pnpm pack 产出的 tarball 无法携带 `dist/sql/*.sql`，或隔离安装后 `migrationsDir()` 因 ESM 路径解析无法定位包内目录，则 build projection 前提被推翻。最便宜的先验证点（test-first）：先在 pack-and-smoke 里写 tarball 内容断言并跑红（当前包确实无 SQL），再实现复制与导出让它变绿——断言本身即 drift check，红→绿即证明链路成立。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260812-0201-cloud-postgres-sql-projection.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260812-0201-cloud-postgres-sql-projection.review.md`
- Notes file: `tasks/notes/20260812-0201-cloud-postgres-sql-projection.notes.md`
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
  - packages/cloud-postgres/
  - scripts/release/
  - .github/workflows/
  - plans/plan-20260812-0201-cloud-postgres-sql-projection.md
  - tasks/todos.md
  - tasks/contracts/20260812-0201-cloud-postgres-sql-projection.contract.md
  - tasks/reviews/20260812-0201-cloud-postgres-sql-projection.review.md
  - tasks/notes/20260812-0201-cloud-postgres-sql-projection.notes.md
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
    - scripts/release/pack-and-smoke.mjs
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260812-0201-cloud-postgres-sql-projection.notes.md
  tests_pass:
    - path: packages/cloud-postgres/src/__tests__/migrations-dir.test.ts
  commands_succeed:
    - pnpm --filter @byok-sdk/cloud-postgres run build
    - pnpm --filter @byok-sdk/cloud-postgres run typecheck
    - node scripts/release/pack-and-smoke.mjs
    - git diff --quiet main -- packages/protocol packages/client packages/server packages/cloud deploy
    - repo-harness run check-deploy-sql-order
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: fresh install 精确 tarball 后 `migrationsDir()` 定位全部 migration；文件名集合与逐文件 SHA-256 双向等于 `deploy/sql`；空库迁移全部 applied 且重跑幂等（PG CI 层）。
- Edge cases: 注入缺失/篡改/多余 SQL 文件时 smoke 必红；dist/sql 残留旧文件被先清后拷消除；Windows 路径经 `fileURLToPath` 标准化（windows CI 跑 smoke）。
- Regression risks: `deploy/scripts/migrate` 与现有真实 PG 测试必须零 diff 仍绿；release 硬门不得引入外部服务依赖（PG 只在 CI 第二层）。

## Rollback Point

- Commit / checkpoint: `a58b158`（sprint 与 plan 批准提交，本 slice 起点）
- Revert strategy: revert 本 slice commits（build 复制/导出/断言/CI 任务）；`deploy/sql` 与全部现有消费方零改动，无数据回滚。
