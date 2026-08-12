# Task Contract: route-path-constants

> **Status**: Active
> **Plan**: plans/plan-20260813-0423-route-path-constants.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-13 04:23
> **Review File**: `tasks/reviews/20260813-0423-route-path-constants.review.md`
> **Notes File**: `tasks/notes/20260813-0423-route-path-constants.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

~12 个 `/byok/*` 路由路径字面量手写散落在 5 个包(client/cloud/server/testkit/conformance);`protocol/src/http-api.ts` 已用注释记录却导出零常量。这是单一真相源违反(nonce 收敛的同形),testkit 自己的注释已承认这个 drift class。做错/跳过的代价:任一处路由改动需跨 5 包手动同步,漏一处即静默 wire 漂移。

## Goal

把 `/byok/*` 路由路径作为具名常量(带参路由用参数化 helper)从 `@byok-sdk/protocol` 单一导出,client/cloud/server/testkit/conformance 各处改为 import;捎带 B-6 三处小重复(DEVICE_PROOF_HEADER、base64url、dispatchSelection.runtimeId)中依赖图允许的部分。字符串字节一致,零 wire/behavior 改动,freeze-guard 零 diff。

## Scope

- In scope: `packages/protocol`(导出路由常量)、`packages/client`、`packages/cloud`、`packages/server`、`packages/testkit`、`packages/conformance`(字面量→import);`packages/core`(B-6(a) DEVICE_PROOF_HEADER 收敛的落点);B-6 可干净共享的部分。
- Out of scope: 改任何路由的实际路径值/wire 行为(字节一致);capability 词汇(host-owned,不进 protocol);为 B-6 强造跨包依赖;protocol frozen envelope。
- Scope amendment（2026-08-13）：B-6(a) 把 DEVICE_PROOF_HEADER 收敛到 `packages/core/src/attestation.ts`（wire header,与路由同 drift class;cloud re-export 保持公开 API 不变),task-directed 而非静默扩张,故 allowed_paths 补 `packages/core/`。core 的 frozen public-export 清单（constraints.test.ts）随之更新。
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

假设:路由路径是 protocol 拥有的 wire contract,可安全下沉为 protocol 导出。证伪证据:某处路由常量下沉后导致 freeze-guard diff(说明路由在冻结面且导出方式触碰了它),或某包不便依赖 protocol 的路由常量(存在刻意的架构边界,如 ADR-010 禁止 client 从 cloud 引 capability 名)。最便宜验证点:先只在 protocol 加导出并跑 freeze-guard 确认零 diff;若某包边界不允许 import,则该包保留字面量并记录为有意例外,不强行下沉。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260813-0423-route-path-constants.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260813-0423-route-path-constants.review.md`
- Notes file: `tasks/notes/20260813-0423-route-path-constants.notes.md`
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
  - plans/plan-20260813-0423-route-path-constants.md
  - tasks/todos.md
  - tasks/contracts/20260813-0423-route-path-constants.contract.md
  - tasks/reviews/20260813-0423-route-path-constants.review.md
  - tasks/notes/20260813-0423-route-path-constants.notes.md
  - packages/protocol/
  - packages/client/
  - packages/cloud/
  - packages/server/
  - packages/testkit/
  - packages/conformance/
  - packages/core/
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
    - packages/protocol/src/http-api.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260813-0423-route-path-constants.notes.md
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
