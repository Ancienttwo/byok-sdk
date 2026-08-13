# Task Contract: shutdown-lease-order

> **Status**: Fulfilled
> **Plan**: plans/plan-20260813-2201-shutdown-lease-order.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-13 22:01
> **Review File**: `tasks/reviews/20260813-2201-shutdown-lease-order.review.md`
> **Notes File**: `tasks/notes/20260813-2201-shutdown-lease-order.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

root-cause-prover 实测证实（CI job 94465898325 + scratchpad/rcp-unpair/ 四件套）：`runShutdownSequence`（`create-daemon.ts:1816-1826`）先关 control 端点（unlink control.sock+control.token——外部唯一存活信号）再释放 store-mutation lease，产生 11-46ms 窗口：`isControlDaemonGone` 为真但 mutex 仍被持有，此间任何 acquire（unpair/start/doctor）probe 到 'holder' 即抛 `DaemonOwnerActiveError('unknown')`。缺陷早于 PR #64（旧 TCP 竞争者同窗口同样拒绝）；ubuntu CI 上 300ms 轮询相位与窗口对齐后变现为 ipc-smoke 间歇红,且已在 main。

## Goal

不变量（守卫机检）：**「已退出」信号为真 ⇒ lease 已释放**——daemon 持有 lease 期间 control 端点必须保持可观察。实现：拆 control teardown 为「停服 RPC/断开连接（保留 mutation-barrier 的 close-失败⇒疑似残余写者⇒保锁耦合）→ release lease → 关 listener + unlink socket/token」；`mutationBarrierComplete===false` 分支（:1820，现同样先删信号后永久持锁）一并修，使该路径下 unpair 得到 `UnpairExitUnconfirmedError` 而非 DaemonOwnerActiveError。守卫（`daemon-stop-shutdown-parity.test.ts` 新 case，prover 已给设计）：shutdown 后紧采样断言不存在 `controlGone && mutexHeld` 样本，且首个 gate-true 时刻 `acquireDaemonOwner('doctor')` 必成功；修前确定性红、修后按时序不可证伪，bun/vitest 双 runner 绿。

## Scope

- In scope: `packages/client/src/daemon/create-daemon.ts`（runShutdownSequence 两分支）；`packages/client/src/daemon/control-server.ts`（仅当需要分步关闭 API 的配合改动）；`packages/client/src/__tests__/`；notes。
- Out of scope: `packages/client/src/daemon/daemon-owner.ts` 零 diff（触碰其拒绝分支即越界）；unpair 重试/提前 unlink mutex.sock（prover 证死：TOCTOU/双写）；其余包零 diff。
- Taste constraints: 优先拆式关闭；整体后移 close 仅当论证拆式不可行且写明 post-teardown RPC 不可再变更 store。

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

- 方向证伪：若拆序后守卫仍观察到 `controlGone && mutexHeld` 样本，说明还有第二个删信号点或 lease 释放路径未覆盖——回证据阶段，不叠补丁。
- 最便宜的先验证点：新守卫 case 在未修代码上必须确定性红（窗口 11-46ms，紧采样必中）；若不红先修采样谓词。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260813-2201-shutdown-lease-order.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260813-2201-shutdown-lease-order.review.md`
- Notes file: `tasks/notes/20260813-2201-shutdown-lease-order.notes.md`
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
  - plans/plan-20260813-2201-shutdown-lease-order.md
  - tasks/todos.md
  - tasks/contracts/20260813-2201-shutdown-lease-order.contract.md
  - tasks/reviews/20260813-2201-shutdown-lease-order.review.md
  - tasks/notes/20260813-2201-shutdown-lease-order.notes.md
  - packages/client/src/daemon/create-daemon.ts
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
    - packages/client/src/__tests__/daemon-stop-shutdown-parity.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260813-2201-shutdown-lease-order.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/daemon-stop-shutdown-parity.test.ts
  commands_succeed:
    - pnpm -r run typecheck
    - pnpm --filter @byok-sdk/client run test
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint: main @ `ef42daa`（worktree 基点）
- Revert strategy: 单 PR revert；零迁移。
