# Task Contract: wp3-charge-once-wiring

> **Status**: Active
> **Plan**: plans/plan-20260917-1628-wp3-charge-once-wiring.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-17 16:30
> **Review File**: `tasks/reviews/20260917-1628-wp3-charge-once-wiring.review.md`
> **Notes File**: `tasks/notes/20260917-1628-wp3-charge-once-wiring.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

RED 测试（daf46c47）已证明双扣：vendor 无条件 +1 使 print 物理 depth 2，冻结表契约 1。不修接线则 charge-once 契约无法成立，WP4 五边闭合与 S2 递归运行时全部悬空；修在错误位置（fork/vendored 补丁）则破坏已裁 helper 改道架构与 provenance 冻结。

## Goal

按 Option A 接线（deep-reasoner HIGH 建议 + Fable 裁决）：`PI_SUBAGENT_PI_BINARY` 接缝指向 SDK print 预置入口，入口做 argv 模板门 + bootstrap re-stamp（parent+0）+ attested 启动（assertDescendantSpawn 首个真实调用者），单一 exec 点，dispatcher print 分支预置。RED 测试转绿（:200 print 观测 `'1'`）且链健康断言与三条负路径全过，vendored 树零字节改动。

## Scope

- In scope: packages/client/src/custody/**（新入口）、sdk-reserved-helper-host.ts（print 分支）、packages/implementation-identity/src/**（BYOK_* 枚举与 glue）、custody-charge-once-double-charge.test.ts（探针重定位）、相关 pin 测试更新、plan/contract 三件套。
- Out of scope: vendored 树、node_modules、runner 边启用、五边闭合、maxDepth/root、CI/workflow 层（WP1 面）、push。
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- 确认点③被证不可行（vendor 注入剥离 env commitment 无法穿透）→ BLOCKED 上报，禁止改 vendor 或走私道。
- 需要 packages/client/package.json 变更（bin 注册等）→ 停下上报，不得自行改版本权威面。

## Falsifier

转绿若来自断言弱化/探针捷径（如 stub 直接写死 '1'、跳过 attested exec 点）而非真实 re-stamp 链路，gate 复核会抓到；assertDescendantSpawn 调用者仍为 0 则接线未发生。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.（本切片即修复实施；regression_guard = packages/client/src/__tests__/custody-charge-once-double-charge.test.ts，pre_fix 产物 = tasks/notes/20260917-1545-wp3-charge-once-red.red-run.txt，RED_EXIT=1。）

- root_cause: pi-subagents src/shared/types.ts:2712-2716 getSubagentDepthEnv 对每个物理子进程无条件 +1，bootstrap 边（runner→print=0）被计 1，一次逻辑委派扣 2。
- repro: bun test packages/client/src/__tests__/custody-charge-once-double-charge.test.ts（未修接线上 exit 1，Expected "1" Received "2"）。
- regression_guard: packages/client/src/__tests__/custody-charge-once-double-charge.test.ts
- pre_fix_failure_artifact: tasks/notes/20260917-1545-wp3-charge-once-red.red-run.txt

## Workflow Inventory

- Source plan: `plans/plan-20260917-1628-wp3-charge-once-wiring.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260917-1628-wp3-charge-once-wiring.review.md`
- Notes file: `tasks/notes/20260917-1628-wp3-charge-once-wiring.notes.md`
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
  - plans/plan-20260917-1628-wp3-charge-once-wiring.md
  - tasks/contracts/20260917-1628-wp3-charge-once-wiring.contract.md
  - tasks/reviews/20260917-1628-wp3-charge-once-wiring.review.md
  - tasks/notes/20260917-1628-wp3-charge-once-wiring.notes.md
  - packages/client/src/custody/
  - packages/client/src/sdk-reserved-helper-host.ts
  - packages/client/src/__tests__/custody-charge-once-double-charge.test.ts
  - packages/client/src/__tests__/sdk-reserved-helper-host.test.ts
  - packages/client/src/__tests__/fixtures/
  - packages/implementation-identity/src/
  - tasks/todos.md
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
missing or malformed plan fails closed. Populate artifact requirements only
for deliverables this task actually owns; do not create a spec, notes or report
merely to fill this template.

```yaml
exit_criteria:
  files_exist:
    - packages/client/src/custody/pi-subagent-print-entry.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260917-1628-wp3-charge-once-wiring.notes.md
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "double-charge-green",
      "kind": "command",
      "command": "bun test packages/client/src/__tests__/custody-charge-once-double-charge.test.ts",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "RED→GREEN：修线后该测试必须 exit 0（:200 断言 print 观测 PI_SUBAGENT_DEPTH === '1'，链健康断言保持）。",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "implementation-identity-tests",
      "kind": "command",
      "command": "bun run --filter @byok-sdk/implementation-identity test",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "共享包（BYOK_* 枚举/descendant glue 改动面）既有测试全绿。",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "client-tests",
      "kind": "command",
      "command": "bun run --filter @byok-sdk/client test",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "client 套件无新红（既有 S2 tripwire 红除外，按 7ae976ad 口径）。",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "typecheck",
      "kind": "command",
      "command": "bun run typecheck",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "全仓类型绿。",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "api-surface",
      "kind": "command",
      "command": "bun run check:api-surface",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "公共 API 面变更受控。",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "version-authority",
      "kind": "command",
      "command": "bun run check:version-authority",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "版本权威未被触碰。",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "vendored-zero-byte",
      "kind": "command",
      "command": "git diff --stat daf46c47..HEAD -- packages/client/vendor/ packages/client/node_modules/",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "输出必须为空：vendored 树与 node_modules 零字节改动。",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "assert-descendant-wired",
      "kind": "command",
      "command": "grep -rn \"assertDescendantSpawn(\" packages/client/src packages/implementation-identity/src --include='*.ts' | grep -v __tests__ | grep -v 'export ' | wc -l | grep -v '^0$'",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "assertDescendantSpawn 获得至少一个产品代码调用者（接线发生）。",
      "inputs": {
        "env": []
      }
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
      "inputs": {
        "env": []
      }
    }
  ]
}
```

Author the actual checks using [Testing Policy and Artifact Standards](../../docs/reference-configs/sprint-contracts.md#testing-policy-and-artifact-standards).
The empty array is not permission to omit required repository checks: retain it
only when no executable criterion applies and explain why in Acceptance Notes.
Prefer existing covering tests; creating a task-named test or adding typecheck
is not a template requirement. For each selected check declare `id`, `kind`,
`cwd`, `phase`, `cost`, `evidence_policy`, `necessity`, `inputs.env`, and its
`command` or `path`. Declare the same execution once, including checks nested
inside aggregate scripts. Use `baseline_with_delta` only with an immutable
baseline and named current delta checks; never infer it from paths or command text.

## Acceptance Notes (Human Review)

- Changed behavior/boundary, existing covering tests and remaining gap: charge-once 接线（print 预置入口）；剩余 gap = runner 边、五边闭合、生产启用（WP4）。
- New test case/file rationale, or why existing coverage is sufficient: 复用 1545 RED 测试作 regression guard；新增三条负路径断言。
- Selected check IDs and why their coverage is sufficient; omitted coverage: double-charge-green（产品判据）+ 两包测试 + 全仓 typecheck + api-surface/version-authority + vendored-zero-byte + assert-descendant-wired + diff-whitespace；`bun run build` 由 typecheck/test 前置跑（dist 需先在）。
- Full/expensive check justification and expected cost, if applicable: client 全量测试必要（dispatcher/枚举变更影响面）。
- Execution/baseline references, subject, current delta and disposition: 基线 daf46c47（RED），期望终态 green。
- Residual risks and incomplete observations: Windows seam spawn 形态（确认点②）；若 POSIX-only 需显式 skip + todos 登记。

## Rollback Point

- Commit / checkpoint: 分支 claude/wp3-custody-wiring 本地 commits（基线 daf46c47）。
- Revert strategy: revert 本切片全部 commits 回 daf46c47（RED 状态恢复）；无 vendored/node_modules 改动需清理。
