> **Archived**: 2026-08-13 04:04
> **Related Plan**: plans/archive/plan-20260813-0339-skill-pack-postgres-phase2.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260813-0404

# Task Contract: skill-pack-postgres-phase2

> **Status**: Fulfilled
> **Plan**: plans/plan-20260813-0339-skill-pack-postgres-phase2.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-13 03:39
> **Review File**: `tasks/reviews/20260813-0339-skill-pack-postgres-phase2.review.md`
> **Notes File**: `tasks/notes/20260813-0339-skill-pack-postgres-phase2.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

skill-pack 交付通道 Phase 1（已 ship，commit 0fbb538）只有 in-memory 存储;真实下游（salesko 内容资产下发）需要持久化才能用。Phase 1 在 `packages/core/src/ports-contract.ts:34-42` 自声明 Phase 2 会把 `skillPacks` 移入 `CORE_STORE_NAMES` 并清空临时 bridge `CORE_NON_COMPOSITION_PORT_NAMES`——不做则该 port-inventory 例外永久固化，违反单一真相源。

## Goal

skillPacks 成为 `CoreStores` 强制成员(Postgres 永远建表、能力未声明时空表),`CORE_NON_COMPOSITION_PORT_NAMES` 归空;新增 `PostgresSkillPackStore` 镜像 in-memory 实现并接进 `createPostgresCoreStores`;一条 `deploy/sql/0005` forward-only migration;conformance port-inventory 自动纳入并验证该 store。wire 层 route/capability 保持 `includeSkillPacks` 可选(存储强制、能力可选)。

## Scope

- In scope: `packages/core`（CORE_STORE_NAMES / ports-contract / constraints 导出）、`packages/cloud-postgres`（PostgresSkillPackStore + wire 进 createPostgresCoreStores）、`deploy/sql/`（0005 migration）、`packages/conformance`（组合断言）、`packages/cloud`（验证 includeSkillPacks 可选路径）。
- Out of scope: `packages/protocol` 任何改动（freeze-guard 零 diff）；client 侧安装管线（Phase 1 已定）；把 skill-pack 能力改成强制广告（只有存储强制）；多源/marketplace/扫描器。
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

设计假设:skillPacks 应作为 `CoreStores` 强制成员(存储强制、能力可选)。证伪证据:发现某个真实 composition 无法提供 skill-pack 存储却必须运行(如一个只读或部分实现的 host),使强制成员成为破坏性要求。最便宜验证点:确认 conformance port-inventory flip 后所有既有 composition(in-memory + Postgres)都能满足;若 in-memory 已有实现、Postgres 新增实现即覆盖全部 composition,则假设成立。若出现无法提供的 composition,回到 Phase 1 的 optional-port 形状并记录 `ports-contract.ts:34-40` 注释需修正。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260813-0339-skill-pack-postgres-phase2.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260813-0339-skill-pack-postgres-phase2.review.md`
- Notes file: `tasks/notes/20260813-0339-skill-pack-postgres-phase2.notes.md`
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
  - docs/spec.md
  - plans/plan-20260813-0339-skill-pack-postgres-phase2.md
  - tasks/todos.md
  - tasks/contracts/20260813-0339-skill-pack-postgres-phase2.contract.md
  - tasks/reviews/20260813-0339-skill-pack-postgres-phase2.review.md
  - tasks/notes/20260813-0339-skill-pack-postgres-phase2.notes.md
  - packages/core/
  - packages/cloud-postgres/
  - packages/conformance/
  - packages/cloud/
  - deploy/sql/
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
    - packages/core/src/stores.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260813-0339-skill-pack-postgres-phase2.notes.md
  tests_pass:
    - path: packages/protocol/src/__tests__/freeze-guard.test.ts
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
