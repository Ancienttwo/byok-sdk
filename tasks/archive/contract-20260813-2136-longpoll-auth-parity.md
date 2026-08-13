> **Archived**: 2026-08-13 21:36
> **Related Plan**: plans/archive/plan-20260813-2106-longpoll-auth-parity.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260813-2136

# Task Contract: longpoll-auth-parity

> **Status**: Fulfilled
> **Plan**: plans/plan-20260813-2106-longpoll-auth-parity.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-13 21:06
> **Review File**: `tasks/reviews/20260813-2106-longpoll-auth-parity.review.md`
> **Notes File**: `tasks/notes/20260813-2106-longpoll-auth-parity.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

WS `conn.hello` 门（`ws-server.ts:104-128`）传递性保证 row.productId == 本实例 productId，而全部 bearer-authed HTTP 路由（长轮询 `/byok/events`、`/byok/messages` + blob 三路由）只查 row==claims，从不查实例等值。同一 server 可为其他 productId 铸 pairing code（`createPairingCode` 逐码传 productId）——这类设备 WS 被 hello 拒（`productId mismatch`），HTTP 却可 poll 事件、注入 envelope、建 blob。安全相关的校验面不对称（todos S0 D-4 条目），且不止长轮询。

## Goal

裁决已定（plan P3）：(1) `authenticateBearer`（`packages/server/src/auth.ts:341`）增第四条检查——row.productId 与本实例 productId 不等 → undefined，与既有失败同型：401 不可区分，不新增任何 existence oracle；单源修全类（长轮询+blob+WS upgrade 前置）。(2) WS hello 门的宣告验证零变化。(3) protocolVersions 在长轮询上写显式豁免注释（每请求独立、envelope 逐条过 schema+handleInbound 门，版本 skew 已在逐 envelope 面显形；加宣告头是仪式非安全）。(4) 守卫测试红→绿：异 product row 的有效 token 此前在 `/byok/events`、`/byok/messages`、`POST /byok/blobs` 得 200/非 401，修后 401；同 product 全路由零回归。(5) 零 wire 契约改动、零 client 改动、`packages/protocol` 零 diff。

## Scope

- In scope: `packages/server/src/auth.ts`（AuthDeps + authenticateBearer）、`packages/server/src/index.ts`（productId 接线）、`packages/server/src/http.ts`（仅豁免注释）、`packages/server/src/__tests__/`、todos 销账 + cloud 平行缺口新条目、notes。
- Out of scope: `packages/protocol` 与其余包零 diff；`packages/cloud` 的 `auth/bearer.ts` 同形状缺口（hosted 多产品部署的实例权威不同，独立裁决，仅记 ledger）；ws-server.ts 行为改动；任何 401 响应体差异化；任何 wire 契约/客户端改动。
- Taste constraints: 检查落在 authenticateBearer 内部而非各路由；注释对齐 auth.ts 现有 no-oracle 论述口吻。

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

- 方向证伪：若存在合法部署形态依赖「异 product row 走 HTTP」（即同一 server 有意为多 product 发码且靠 HTTP 服务它们），则实例等值检查是错的——但 WS 门已禁同场景多年，不存在可工作的既有依赖；若 executor 在测试中发现任何仓内组件（examples、testkit、smoke）靠此路过活，立即停下回报。
- 最便宜的先验证点：写守卫前先手工验证现状——用异 product row 的 token 打 `/byok/events` 得 200（红的前提），若现状已 401 则 P2 判断有误，停。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260813-2106-longpoll-auth-parity.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260813-2106-longpoll-auth-parity.review.md`
- Notes file: `tasks/notes/20260813-2106-longpoll-auth-parity.notes.md`
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
  - plans/plan-20260813-2106-longpoll-auth-parity.md
  - tasks/todos.md
  - tasks/contracts/20260813-2106-longpoll-auth-parity.contract.md
  - tasks/reviews/20260813-2106-longpoll-auth-parity.review.md
  - tasks/notes/20260813-2106-longpoll-auth-parity.notes.md
  - packages/server/src/auth.ts
  - packages/server/src/index.ts
  - packages/server/src/http.ts
  - packages/server/src/__tests__/
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
    - packages/server/src/__tests__/bearer-instance-product.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260813-2106-longpoll-auth-parity.notes.md
  tests_pass:
    - path: packages/server/src/__tests__/bearer-instance-product.test.ts
  commands_succeed:
    - pnpm -r run typecheck
    - pnpm --filter @byok-sdk/server run test
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint: main @ `6d5ac9b`（worktree 基点）
- Revert strategy: 单 PR revert；零迁移；401 语义不可区分保持。
