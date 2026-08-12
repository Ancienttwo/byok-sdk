# Task Contract: result-document-channel

> **Status**: Active
> **Plan**: plans/plan-20260812-0351-result-document-channel.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-12 03:56
> **Review File**: `tasks/reviews/20260812-0351-result-document-channel.review.md`
> **Notes File**: `tasks/notes/20260812-0351-result-document-channel.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

结构化终态结果在 wire 上没有位置（salesko handoff 条目 2）：`TaskCompletePayload` 只有 `summary?/sessionRef/artifactRefs?`，`TaskResult` 同构。下游被迫用 inline artifact JSON 约定传结构化结果并自建校验。做错的下游后果：静默 strip（旧 server 剥未知字段）会让产品的主结果无声消失；截断会产出非法 JSON。消费证据（`docs/researches/2026-08-12-salesko-consumption-evidence.md` §1/§2）已给出 cap 包络与 reject-at-boundary 要求。协议级 additive，IP 锁定级，双轨验收。

## Goal

`task.complete` 获得 optional `document`（schema-neutral JSON-only unknown，cap = `RESULT_DOCUMENT_MAX_BYTES` = 1 MiB，度量 = canonical JSON UTF-8 bytes，超限 reject-at-boundary）；`CAPABILITY_FLAGS` 增 server-advertised `'result-document'`；hub 把 document 投影进 `TaskResult.document`；client 提供 `DaemonConfig.resultDocument.extract` 接缝并按 flag 门控发送，三个 fail-closed 分支（超限/extractor 抛错/server 无 flag 且有 document → task.fail，retryable false）。金样本 deliberate 重生成且旧语义零漂移；`PROTOCOL_VERSION` 不变；`packages/cloud`、`packages/cloud-postgres`、`deploy/` 零 diff；无 extractor 配置时行为与改动前一致。

## Scope

- In scope: `packages/protocol/src/messages.ts`、`version.ts`、金样本与 protocol 测试；`packages/server/src/hub.ts`、`types.ts`、store parity 与 server 测试；`packages/client/src/daemon/create-daemon.ts`、`task-runner.ts` 与 client 测试；`docs/protocol.md`。
- Out of scope: `.strict()` 面（PermissionPolicy/instruction blob-ref）、`PROTOCOL_VERSION`、cloud 侧 hosted 投影、artifactRefs 语义、版本 bump 与发版、任何静默降级路径。
- Taste constraints: cap 度量函数单一导出、两端复用；flag 注释比照 `approval_resolved` 的 N/N-1 说明写全。

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if freeze-guard 表明本改动并非纯 additive（旧金样本除新增字段外任何断言失败）。

## Falsifier

方向性证伪：若宽容 z.object 在解析时并不剥未知字段（即旧 server 原样透传 document），则 flag 门控的必要性前提被推翻——先写一个针对当前 schema 的剥离行为测试（旧 schema 解析含 document 的 payload，断言 document 被 strip），跑红/绿确认前提，再动实现。若前提不成立，STOP 并回报（门控设计需重议）。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code.

## Workflow Inventory

- Source plan: `plans/plan-20260812-0351-result-document-channel.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260812-0351-result-document-channel.review.md`
- Notes file: `tasks/notes/20260812-0351-result-document-channel.notes.md`
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
  - packages/protocol/src/
  - packages/server/src/
  - packages/client/src/
  - docs/
  - plans/plan-20260812-0351-result-document-channel.md
  - tasks/todos.md
  - tasks/contracts/20260812-0351-result-document-channel.contract.md
  - tasks/reviews/20260812-0351-result-document-channel.review.md
  - tasks/notes/20260812-0351-result-document-channel.notes.md
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
# tests_pass 在本 harness 用 bun test 执行(与本仓 vitest 不兼容,见 presence slice 教训);
# 新测试的存在性以 files_exist 钉住,执行面由 commands_succeed 的 vitest 命令承担。
exit_criteria:
  files_exist:
    - packages/protocol/src/__tests__/result-document.test.ts
    - packages/server/src/__tests__/result-document-projection.test.ts
    - packages/client/src/__tests__/result-document-gating.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260812-0351-result-document-channel.notes.md
  commands_succeed:
    - pnpm --filter @byok-sdk/protocol run typecheck
    - pnpm --filter @byok-sdk/protocol run test
    - pnpm --filter @byok-sdk/server run typecheck
    - pnpm --filter @byok-sdk/server run test
    - pnpm --filter @byok-sdk/client run typecheck
    - pnpm --filter @byok-sdk/client run test
    - git diff --quiet main -- packages/cloud packages/cloud-postgres deploy packages/keys
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: 恰好 1 MiB 通过、超 1 字节拒绝;flag 广播时 document 端到端到 `TaskResult.document`;未广播且有 document → task.fail(retryable false)。
- Edge cases: 非 JSON 可序列化拒绝;extractor 抛错 → task.fail 不吞;无 extractor 配置零行为变化;旧 daemon(不发 document)对新 server 零影响。
- Regression risks: 金样本重生成正当性;`.strict()` 面零接触;task store parity 不造第二权威。

## Rollback Point

- Commit / checkpoint: `3d66543c`(main 合并点,本 worktree 基点)
- Revert strategy: revert 本 slice commits;PROTOCOL_VERSION 不变,无迁移回滚。
