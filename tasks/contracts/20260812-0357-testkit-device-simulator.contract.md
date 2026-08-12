# Task Contract: testkit-device-simulator

> **Status**: Active
> **Plan**: plans/plan-20260812-0357-testkit-device-simulator.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-12 04:00
> **Review File**: `tasks/reviews/20260812-0357-testkit-device-simulator.review.md`
> **Notes File**: `tasks/notes/20260812-0357-testkit-device-simulator.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

下游被迫手写协议级 device 身份细节做冒烟（Ed25519/jwk/`byok-nonce-v1\n`/pair/challenge/token/presence/revoke,15 断言）,上游改 nonce domain 或 pairing schema 时所有 host 的 smoke 静默失效。同时 `NONCE_SIGNING_DOMAIN` 已在 client/cloud/server 三处重复定义——drift 隐患已成事实。simulator 落地即成为协议级盲点的共享回归面(教训进 conformance 的第一批载体)。

## Goal

新可发布包 `@byok-sdk/testkit`(仅依赖 core+protocol,无测试框架依赖,headless)导出 `createDeviceSimulator`:身份生成、pair/challenge/token/publishPresence/revoke 五原语、四类内置负向断言(未认证 admin 401、配对码单次使用、未域分隔签名被拒、撤销后 challenge 401)。`NONCE_SIGNING_DOMAIN` + `nonceSigningBytes` 上移 `@byok-sdk/core`(单一权威),client/cloud/server 三处改引用并保留原导出。conformance 新增 simulator 套件对 in-memory cloud composition 全面走通(= 下游删除手写协议段的替换条件)。conformance 保持 private。`packages/protocol`、`packages/cloud-postgres`、`deploy/`、`scripts/` 零 diff。

## Scope

- In scope: `packages/core/src/`(pairing 常量/函数+测试)、`packages/client/src/daemon/device-keys.ts`、`packages/cloud/src/auth/verify.ts`、`packages/server/src/auth.ts`(引用重构)、`packages/testkit/**`(新包)、`packages/conformance/**`(新套件+devDep)、根 workspace 接线所需最小改动。
- Out of scope: release 打包清单(scripts/release 零改动,入 train 归 owner)、protocol 任何改动、conformance 身份翻转、simulator 之外的新断言域。
- Taste constraints: 新包 package.json 形态逐项对齐 cloud-postgres;simulator 代码无任何独立签名实现——字节全部经 core 导出。

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if 三处既有常量在字节层不一致(说明已有 drift,须先上报)。

## Falsifier

先写域等价测试:core 新常量与三处旧常量逐字节相等、与 `DEVICE_PROOF_DOMAIN_PREFIX` 互不为前缀——若三处旧常量彼此已不等,前提被推翻,STOP 上报。negative 断言必须各自被证明「能红」:对着关闭对应防线的输入或伪造签名跑一次失败,再转正常路径跑绿。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause / repro / regression_guard / pre_fix_failure_artifact: n/a

## Workflow Inventory

- Source plan: `plans/plan-20260812-0357-testkit-device-simulator.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260812-0357-testkit-device-simulator.review.md`
- Notes file: `tasks/notes/20260812-0357-testkit-device-simulator.notes.md`
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
  - packages/core/src/
  - packages/client/src/daemon/device-keys.ts
  - packages/cloud/src/auth/verify.ts
  - packages/server/src/auth.ts
  # Widened during execution: `@byok-sdk/server` had no `@byok-sdk/core`
  # dependency, so the auth.ts reference refactor is unbuildable without
  # declaring the workspace edge (Scope already admits "根 workspace 接线所需最小改动").
  - packages/server/package.json
  # Same reason: a new workspace package and one new devDependency both change
  # the lockfile. `packages/protocol`, `packages/cloud-postgres`, `deploy/`, and
  # `scripts/` remain untouched.
  - pnpm-lock.yaml
  - packages/testkit/
  - packages/conformance/
  - docs/
  - plans/plan-20260812-0357-testkit-device-simulator.md
  - tasks/todos.md
  - tasks/contracts/20260812-0357-testkit-device-simulator.contract.md
  - tasks/reviews/20260812-0357-testkit-device-simulator.review.md
  - tasks/notes/20260812-0357-testkit-device-simulator.notes.md
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
# tests_pass 用 bun test 执行,与本仓 vitest 不兼容;存在性入 files_exist,执行走 commands_succeed。
exit_criteria:
  files_exist:
    - packages/testkit/package.json
    - packages/testkit/src/index.ts
    - packages/core/src/pairing.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260812-0357-testkit-device-simulator.notes.md
  commands_succeed:
    - pnpm -r run build
    - pnpm --filter @byok-sdk/core run test
    - pnpm --filter @byok-sdk/client run typecheck
    - pnpm --filter @byok-sdk/cloud run test
    - pnpm --filter @byok-sdk/server run test
    - pnpm --filter @byok-sdk/testkit run typecheck
    - pnpm --filter @byok-sdk/testkit run test
    - pnpm --filter @byok-sdk/conformance run test
    - git diff --quiet main -- packages/protocol packages/cloud-postgres deploy scripts
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: conformance simulator 套件对 in-memory composition:pair→challenge→token→presence→revoke 全通;四负向各自独立红过后转绿。
- Edge cases: testkit 无 private、运行时依赖仅 core+protocol、无 vitest/测试框架依赖;三处重构后各包行为零变化。
- Regression risks: 签名字节等价;conformance 既有套件不受新 devDep 影响。

## Rollback Point

- Commit / checkpoint: `3d66543c`
- Revert strategy: revert 本 slice;新包删除即回滚,三处常量恢复本地定义。
