# Task Contract: control-socket-fallback

> **Status**: Fulfilled
> **Plan**: plans/plan-20260813-1925-control-socket-fallback.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-13 19:25
> **Review File**: `tasks/reviews/20260813-1925-control-socket-fallback.review.md`
> **Notes File**: `tasks/notes/20260813-1925-control-socket-fallback.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

`controlSocketPath`（`packages/client/src/daemon/control-protocol.ts:66-70`）带 O-1 已实证的同款缺陷：fallback 用 `os.tmpdir()`，(a) 深 TMPDIR 下 fallback 比被逃逸的路径更长、超 `sun_path` 预算，control server bind `EINVAL` 走 degrade——CLI 控制路径静默不可用（credential-isolation smoke 日志 `control socket failed to start (continuing without it)` 是现行证据，该 job 从未真正覆盖 CLI 控制面）；(b) 地址随环境变——同 store 在 service manager 与 operator shell 下派生不同地址，CLI 连不上活 daemon。修复形状已由 PR #64 的 mutex 修复验证（固定 `/tmp` 根 + 守卫 E/F 同型）。

## Goal

fallback 根改固定 `/tmp` 字面量，地址只由 canonical storeDir 派生：永不超 `sun_path` 预算、不随 TMPDIR/环境漂移。正常路径 `<storeDir>/control.sock` 逐字节不变；degrade 语义（bind 失败继续跑）零变化；win32 named pipe 分支零变化。附守卫测试（O-1 E/F 同型）：对旧实现红、新实现绿，含深 TMPDIR 拓扑下 control socket 真实可用（daemon bind 成功 + 客户端可 connect）与地址环境无关两条断言。0700 一级嵌套目录 + 属主/symlink 校验的既有保护形状保留（world-writable /tmp 下更关键）。

## Scope

- In scope: `packages/client/src/daemon/control-protocol.ts` 的 fallback 派生；必要时 `control-server.ts` 的 stale-socket/目录创建配合改动；`packages/client/src/__tests__/` 新守卫；notes。
- Out of scope: 其余包零 diff；degrade→fail-closed 语义改动；双地址探测/旧地址兼容读（纪律禁止）；win32 分支；daemon-owner.ts（已修，除非逐字节同构的 helper 提取需要，且仅当两处预算/命名/校验完全一致才共享）。
- Taste constraints: 不为一次复用造抽象；对齐 control-protocol.ts 现有注释密度与口吻。

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

- 方向证伪：若正常场景（短 storeDir）任何既有测试观察到 control.sock 路径或行为变化，则改动越界——正常路径必须逐字节不变。
- 最便宜的先验证点：新守卫在未修代码上必须红（深 TMPDIR 下派生地址超预算/随环境变）；若旧实现上守卫绿，说明缺陷复现拓扑没搭对，先修测试再动源码。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260813-1925-control-socket-fallback.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260813-1925-control-socket-fallback.review.md`
- Notes file: `tasks/notes/20260813-1925-control-socket-fallback.notes.md`
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
  - plans/plan-20260813-1925-control-socket-fallback.md
  - tasks/todos.md
  - tasks/contracts/20260813-1925-control-socket-fallback.contract.md
  - tasks/reviews/20260813-1925-control-socket-fallback.review.md
  - tasks/notes/20260813-1925-control-socket-fallback.notes.md
  - packages/client/src/daemon/control-protocol.ts
  - packages/client/src/daemon/control-server.ts
  - packages/client/src/__tests__/
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
    - packages/client/src/__tests__/control-socket-fallback.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260813-1925-control-socket-fallback.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/control-socket-fallback.test.ts
  commands_succeed:
    - pnpm -r run typecheck
    - pnpm --filter @byok-sdk/client run test
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint: main @ `46ad69b`（worktree 基点）
- Revert strategy: 单 PR revert；零迁移；正常路径逐字节不变故回滚零残留。
