# Task Contract: byok-018-d2-task-assertion

> **Status**: Active
> **Plan**: plans/plan-20260912-1540-byok-018-d2-task-assertion.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-12
> **Review File**: `tasks/reviews/20260912-1540-byok-018-d2-task-assertion.review.md`
> **Notes File**: `tasks/notes/20260912-1540-byok-018-d2-task-assertion.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

契约 `salesko.bot-centric-chat.v1` draft-3（frozen SHA-256 `c7288bdbf399d71af6ec131fc86047ced363fb7541af5493c74cf990ae5c6678`）的 C05 以「C03 在 `B/` 侧完成 allowlist 登记」为硬前置。没有这份精确边界，D2 实施只能从宽目录推断授权，§14 末段明确禁止；replay 键的 `schema` 判别段也会只落到接口而漏掉 Postgres 实现。

## Goal

在 `B/` 侧登记 D2 SDK 工作包的精确写入边界与验证面，使 C05 获得 SDK 实施授权后可直接在此契约内执行，无需再推断 allowlist。

## Scope

- In scope: 契约 §8 / §13 C05·C09 / §14「SDK D2」行 / §15 / §16 在 `B/` 侧的执行元数据登记；`allowed_paths` 精确枚举；验证计划固定。
- Out of scope: 不改任何包版本或 lock 文件（§14 末段「包版本/lock 改动只能消费经验证的 D2 artifact；本轮不改」）；不发布、不升级设备、不触生产（§16「SDK release / native / prod 未授权」）；不动 `S/` 仓任何文件；不接管或修改 `plans/plan-20260910-0214-downstream-issue-intake.md` 及其 `.ai/harness/active-plan` marker；不复制契约正文进本仓。
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if `shasum -a 256` on the契约正文 does not match the frozen hash recorded above.

## Falsifier

若 §14「SDK D2」行在 `B/` 的实际实现面与本 `allowed_paths` 不一致（例如 replay 的 Postgres 实现不在 `packages/cloud-dataplane/src/stores/device-assertion-replay.ts`），本登记方向即错。最便宜的验证点：`grep -rn "DeviceAssertionReplayConsumeInput" packages/` 看消费者是否全部落在已枚举路径内。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear as a `package_test` check in Verification Plan).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260912-1540-byok-018-d2-task-assertion.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260912-1540-byok-018-d2-task-assertion.review.md`
- Notes file: `tasks/notes/20260912-1540-byok-018-d2-task-assertion.notes.md`
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
{"protocol":2,"reviewer":"Codex","source":"codex-review","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  # --- 契约 §14「SDK D2」行：八个源文件 ---
  - packages/core/src/device-assertion.ts
  - packages/cloud/src/auth/device-assertion.ts
  - packages/client/src/daemon/assertion-client.ts
  - packages/client/src/daemon/control-protocol.ts
  - packages/client/src/daemon/create-daemon.ts
  - packages/client/src/daemon/device-assertion-signer.ts
  - packages/client/src/daemon/task-runner.ts
  - packages/client/src/daemon/toolset-registry.ts
  # --- 对应真实测试与 fixture（按 C03 盘点的实际文件名，非一一对应） ---
  - packages/core/src/__tests__/device-assertion.test.ts
  - packages/core/src/in-memory/device-assertion-replay.ts
  - packages/core/src/__tests__/golden/device-assertion-v1.canonical.json
  # --- C05 slice 1 补登：§14「SDK D2」行的「对应测试/public export」在实施时的确切落点。
  #     C03 以 `grep DeviceAssertionReplayConsumeInput` 枚举，漏掉了 (a) 新 envelope 的
  #     golden fixture、(b) core 的 public-export 冻结守卫、(c) 必填 `schema` 字段在
  #     §14 未列包中的两个编译点。四条都不是新产品职责，按 §14:430 与本契约
  #     Workflow Inventory 的 scope gate 先修订 allowlist 再写入。 ---
  - packages/core/src/__tests__/golden/task-assertion-v1.canonical.json
  - packages/core/src/__tests__/constraints.test.ts
  - packages/conformance/src/device-assertion-replay.ts
  - packages/cloud-dataplane/src/__tests__/device-revocation.test.ts
  - packages/cloud/src/__tests__/device-assertion-auth.test.ts
  - packages/client/src/__tests__/assertion-client.test.ts
  - packages/client/src/__tests__/control-protocol.test.ts
  - packages/client/src/__tests__/device-assertion-broker.test.ts
  - packages/client/src/__tests__/mcp-toolsets.test.ts
  - packages/client/src/__tests__/task-runner-admission-limits.test.ts
  - packages/client/src/__tests__/task-runner-approval-resolved.test.ts
  - packages/client/src/__tests__/task-runner-approval.test.ts
  - packages/client/src/__tests__/task-runner-bounded-collections.test.ts
  - packages/client/src/__tests__/task-runner-cancel-race.test.ts
  - packages/client/src/__tests__/task-runner-environment.test.ts
  - packages/client/src/__tests__/task-runner-event-spill.test.ts
  - packages/client/src/__tests__/task-runner-queue-watermarks.test.ts
  - packages/client/src/__tests__/task-runner-resource-limits.test.ts
  - packages/client/src/__tests__/task-runner-runtime-failure.test.ts
  - packages/client/src/__tests__/task-runner-runtime-selection.test.ts
  - packages/client/src/__tests__/task-runner-shutdown.test.ts
  - packages/client/src/__tests__/task-runner-terminal-inference-usage.test.ts
  # --- 枚举补项：§14 未列，C03 按 §14:430 枚举补登，Owner 在 C05 实施授权时确认 ---
  - packages/cloud-dataplane/src/stores/device-assertion-replay.ts
  - packages/cloud-dataplane/src/__tests__/device-assertion-replay.test.ts
  # --- 候选新增迁移（§14「候选新迁移 <next>」，当前最大 0021 → 0022） ---
  - deploy/sql/0022_task_assertion_replay_schema.sql
  # 新迁移的准入前提：`repo-harness run check-deploy-sql-order` 要求每个
  # deploy/sql 文件在此不变量文件中被认领，否则新迁移本身不可合入。只加认领行，
  # 不改任何既有断言（0022 不新增表，port_tables 下界不变）。
  - tests/sql/control_plane_invariants.sql
  # --- public export ---
  - packages/core/src/index.ts
  - packages/cloud/src/index.ts
  - packages/client/src/index.ts
  - packages/cloud-dataplane/src/index.ts
  # --- api-surface golden ---
  - api-surface/core.d.ts
  - api-surface/cloud.d.ts
  - api-surface/client.d.ts
  - api-surface/cloud-dataplane.d.ts
  # --- capability / 文档耦合元数据 ---
  - docs/spec.md
  - CHANGELOG.md
  # --- 工作流文件 ---
  - plans/plan-20260912-1540-byok-018-d2-task-assertion.md
  - tasks/contracts/20260912-1540-byok-018-d2-task-assertion.contract.md
  - tasks/notes/20260912-1540-byok-018-d2-task-assertion.notes.md
  - tasks/reviews/20260912-1540-byok-018-d2-task-assertion.review.md
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

This block contains only non-executable artifact requirements. Define every
executable check once in the canonical Verification Plan below. Each check must
state its phase, cost, evidence policy, necessity, and input environment; a
missing or malformed plan fails closed.

```yaml
exit_criteria:
  files_exist:
    - deploy/sql/0022_task_assertion_replay_schema.sql
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260912-1540-byok-018-d2-task-assertion.notes.md
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "build",
      "kind": "command",
      "command": "bun run build",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "SDK root required check (contract §15 implementation phase).",
      "inputs": { "env": [] }
    },
    {
      "id": "typecheck",
      "kind": "command",
      "command": "bun run typecheck",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "SDK root required check (contract §15 implementation phase).",
      "inputs": { "env": [] }
    },
    {
      "id": "test",
      "kind": "command",
      "command": "bun run test",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "SDK root required check; carries the AC11/AC12 focused regressions.",
      "inputs": { "env": [] }
    },
    {
      "id": "api-surface",
      "kind": "command",
      "command": "bun run check:api-surface",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Public export changes must land in the api-surface golden files.",
      "inputs": { "env": [] }
    },
    {
      "id": "version-authority",
      "kind": "command",
      "command": "bun run check:version-authority",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Guards the single version authority; §14 forbids package version/lock changes this round.",
      "inputs": { "env": [] }
    },
    {
      "id": "task-workflow",
      "kind": "command",
      "command": "repo-harness run check-task-workflow --strict",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "SDK root required workflow check (contract §15 implementation phase).",
      "inputs": { "env": [] }
    },
    {
      "id": "release-pack",
      "kind": "command",
      "command": "bun run check:release-pack",
      "cwd": ".",
      "phase": "verification",
      "cost": "expensive",
      "evidence_policy": "current_exact",
      "necessity": "AC13 G2 候选 artifact 证据：本地 packed artifact（subject-bound 指纹），只标 candidate，不冒充 released。",
      "inputs": { "env": [] }
    }
  ]
}
```

This is the sole executable verification authority. Use `baseline_with_delta`
only when a referenced immutable baseline plus named current delta checks prove
the intended coverage; do not infer that choice from paths or command text.

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint: 未发布源码；base = `main` @ `4e5c8cd8`（C03 登记时的冻结 subject）
- Revert strategy: 丢弃本 contract worktree 分支即完成回退；无已发布 artifact、无包版本/lock 改动、无生产数据迁移已执行
