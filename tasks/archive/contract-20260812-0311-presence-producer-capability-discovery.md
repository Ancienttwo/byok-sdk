> **Archived**: 2026-08-12 03:11
> **Related Plan**: plans/archive/plan-20260812-0201-presence-producer-capability-discovery.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260812-0311

# Task Contract: presence-producer-capability-discovery

> **Status**: Fulfilled
> **Plan**: plans/plan-20260812-0201-presence-producer-capability-discovery.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-12 02:07
> **Review File**: `tasks/reviews/20260812-0201-presence-producer-capability-discovery.review.md`
> **Notes File**: `tasks/notes/20260812-0201-presence-producer-capability-discovery.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

salesko 集成 handoff（`docs/researches/2026-08-12-salesko-integration-handoff.md` 条目 1）唯一 P0：cloud 已宣称 `presence.hints` capability 并挂好 `PUT /byok/presence` 路由与 store 语义，client daemon 却没有任何 producer——真实 daemon 配对后 presence 列表永远为空，所有 host 产品的「设备在线」指示（salesko Phase C pairing UX）没有可靠信号源，capability 宣称当前无第一方实现背书。同时 daemon 尚未消费 `GET /byok/capabilities`（`packages/cloud/src/capabilities.ts:12` 自述），publisher 必须建立在 declaration 之上（ADR-010 declaration-not-probe），两件事构成一个不可拆的 slice。跳过或做错的下游后果：host 被迫绕过 daemon 走 protocol 层 HTTP 自证（salesko 已发生），或 publisher 以 404 探测违反 ADR-010。

## Goal

`@byok-sdk/client` daemon 在启动/重连后消费并校验 hosted capability declaration，且仅当 declaration 含 `presence.hints` 时周期性发布 `{level:'online'}` heartbeat 到 `PUT /byok/presence`（device bearer，AuthManager token lifecycle）；停机停发，离线由 TTL 过期表达。declaration 获取失败 fail-closed：不启动 publisher、留下可观测降级记录、不影响 daemon 其余功能。`@byok-sdk/protocol`、`@byok-sdk/cloud`、`@byok-sdk/cloud-postgres`、`deploy/` 零 diff。

## Scope

- In scope: `packages/client/src/daemon/capabilities-client.ts`（新增，declaration 拉取 + `CapabilityDeclarationSchema` 校验）、`packages/client/src/daemon/presence-publisher.ts`（新增，capability-gated online heartbeat，401 续签一次 / revoked 永久停止）、`packages/client/src/daemon/create-daemon.ts`（lifecycle 接线）、client 新增测试（gating/cadence/401/revoked/shutdown/fail-closed + cloud composition 集成）、presence 语义文档段（online = 最近 N 秒内有 heartbeat；expiry = absence）。
- Out of scope: `thinking/working/error` 等 level 映射（等产品消费证据）、停机显式发布 offline、presence 参与任务生命周期决策、wire 协议任何改动、cloud/server 侧任何改动、版本 bump 与发版。
- Taste constraints: 跟随 client 包现有注释密度与命名习惯；心跳间隔配置默认值必须在代码里断言 `minimumIntervalMs < interval < TTL` 关系。

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if honoring ADR-010 需要 404 探测才能工作（即真实 composition 不提供 `GET /byok/capabilities`）——这证明设计前提错误，交回 parent。

## Falsifier

方向性证伪：若对真实 cloud composition 的集成测试表明 declaration-gated 设计无法工作（capabilities 路由缺失或 schema 不含 `presence.hints` 宣称途径），则「publisher 建立在 declaration 之上」前提被推翻。最便宜的先验证点：先写对 cloud composition 的集成测试骨架——`GET /byok/capabilities` 返回可被 `CapabilityDeclarationSchema` 校验且含 `presence.hints` 的 declaration——再动 daemon 代码。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260812-0201-presence-producer-capability-discovery.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260812-0201-presence-producer-capability-discovery.review.md`
- Notes file: `tasks/notes/20260812-0201-presence-producer-capability-discovery.notes.md`
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
  - packages/client/src/
  - packages/client/package.json
  - docs/
  - plans/plan-20260812-0201-presence-producer-capability-discovery.md
  - tasks/todos.md
  - tasks/contracts/20260812-0201-presence-producer-capability-discovery.contract.md
  - tasks/reviews/20260812-0201-presence-producer-capability-discovery.review.md
  - tasks/notes/20260812-0201-presence-producer-capability-discovery.notes.md
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
# tests_pass 在本 harness 语义下用 `bun test` 执行；presence 两个测试文件是
# vitest 专属（bun 兼容层缺 vi.waitFor），故以 files_exist 钉存在性，执行面由
# 下方 commands_succeed 的 vitest 全套命令（本仓 canonical runner）承担。
exit_criteria:
  files_exist:
    - packages/client/src/daemon/capabilities-client.ts
    - packages/client/src/daemon/presence-publisher.ts
    - packages/client/src/__tests__/capabilities-client.test.ts
    - packages/client/src/__tests__/presence-publisher.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260812-0201-presence-producer-capability-discovery.notes.md
  commands_succeed:
    - pnpm --filter @byok-sdk/client run typecheck
    - pnpm --filter @byok-sdk/client run test
    - git diff --quiet main -- packages/protocol packages/cloud packages/cloud-postgres packages/server deploy
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: declaration 含 `presence.hints` 时一个 interval 内 `list` 可见 hint；不含时零 presence 请求；停发后 TTL 到期 hint 消失。
- Edge cases: 401 续签一次成功继续；revoked 永久停止不重试；declaration 获取失败仅停 publisher；心跳间隔与 `minimumIntervalMs`/TTL 关系在配置边界断言。
- Regression risks: create-daemon lifecycle 接线影响停机序列（M5 runShutdownSequence 单序列纪律）；publisher 不得读写任务状态。

## Rollback Point

- Commit / checkpoint: `4627f2e`（plan/handoff 落仓提交，本 slice 起点）
- Revert strategy: revert 本 slice 的 client-only commits；无持久化数据或 migration 回滚。
