# Task Contract: ci-stability-flakes

> **Status**: Fulfilled
> **Plan**: plans/plan-20260813-1028-ci-stability-flakes.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-13 10:31
> **Review File**: `tasks/reviews/20260813-1028-ci-stability-flakes.review.md`
> **Notes File**: `tasks/notes/20260813-1028-ci-stability-flakes.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

两个既有 flake（`packages/client` daemon-owner mutex 端口碰撞抛 `DaemonOwnerActiveError`；cloud-postgres dataplane MinIO teardown 阶段 503）让每一刀的完成门/CI 都靠隔离重跑绕过。不修则假红常态化，真回归信号被重跑习惯掩盖——这是后续所有刀的公共成本。daemon-owner 是 owner/reclaim 安全权威，修复必须 evidence-first，不许弱化 fail-closed 语义。

## Goal

两个 flake 各自：(1) 根因被探针/结构性证据证实（四字段 Root Cause Evidence 记入 notes）；(2) 直击根因的最小修复落地，附回归守卫测试；(3) 加压复现面修前红（或结构性证明碰撞必然性）、修后 ≥3 轮全绿。生产 fail-closed **不变量**零变化；MinIO 侧按 Scope amendment 落 CI 配置。

Goal amendment (2026-08-13, evidence-triggered): mutex 根因证实为第三方回环监听者占据 hash band 端口 → probe `uncertain` → `:324` 无候选行走即抛（证据 scratchpad/rcp-mutex/，含 lsof 归因与双进程结构证明；同时是终端用户 lockout 缺陷，非仅测试 flake）。裁决：mutex 机制由共享 TCP 端口命名空间改为 store-scoped lock（POSIX UDS / Windows named pipe，复用 control-server.ts 先例），使 `uncertain` 不可达；「本 store 存在 conforming holder ⇒ 拒绝」不变量原样保留（守卫测试 B 为机检形式）。禁止形状不变：不得实现为「uncertain → 继续行走」（重开 stale-owner TOCTOU）。同一 work-package 删除 vitest band seam 全套（`defaultVitestStoreMutexPort`/`resolveStoreMutexPort`/`__setStoreMutexPortProviderForTests`/`AcquireDaemonOwnerOptions.mutexPort`）——该 seam 只为躲避本次消除的碰撞而存在，且自身有缺陷（0-based worker id、per-file seq 重置，实测 band 内碰撞）。

## Scope

- In scope: `packages/client` daemon mutex 端口供给/探测路径与其测试；`packages/cloud-postgres` 测试 support（dataplane/teardown）；复现探针脚本；两份 Root Cause Evidence。
- Out of scope: `packages/protocol` 与其余包（零 diff）；`r2-blobs.ts` 等产品语义；vitest 全局 retry；任何 uncertain→放行的语义弱化。
- Scope amendment (2026-08-13, evidence-triggered): root-cause-prover 证明 "MinIO teardown 503" 系误归因——真根因是 `.github/workflows/ci.yml:159/:287` 的 `oven-sh/setup-bun@v2` 未 pin `bun-version`，每 run 从 GitHub release CDN 重新下载，CDN 503/reset 三连败让测试已全绿的 job 假红（证据：jobs 94208317693/94247380112/94236390428，`@actions/tool-cache` `tool-cache.ts:19`；含无 MinIO 的 packageability job 同样报错的阴性对照）。据此触发原 Out-of-scope 预留的 escape hatch：`.github/workflows/ci.yml` 纳入 allowed_paths，仅限 `bun-version` pin；MinIO/测试 support 层的"有界重试"方向作废。
- Taste constraints: 修复直击根因，不加"顺手"防御层；测试 support 的重试必须有界（次数+总时长）并注释触发证据。

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

- 方向证伪：若修复合入后加压复现面（≥3 轮满仓并发级压测）仍出现同型 flake，则根因判定错误——回 evidence 阶段重判，不叠加第二层修补。
- 最便宜的先验证点（mutex）：给每个 daemon 注入保证唯一的 mutex 端口后若碰撞仍复现，则根因不在端口重叠而在 probe 超时（a），反之在端口供给（b/c）。
- 最便宜的先验证点（MinIO）：捕获 503 的确切抛点与时刻——若发生在 compose down 已启动之后，属 teardown 顺序问题；若在套件运行中，属容器负载/启动竞态。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260813-1028-ci-stability-flakes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260813-1028-ci-stability-flakes.review.md`
- Notes file: `tasks/notes/20260813-1028-ci-stability-flakes.notes.md`
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
  - plans/plan-20260813-1028-ci-stability-flakes.md
  - tasks/todos.md
  - tasks/contracts/20260813-1028-ci-stability-flakes.contract.md
  - tasks/reviews/20260813-1028-ci-stability-flakes.review.md
  - tasks/notes/20260813-1028-ci-stability-flakes.notes.md
  - packages/client/src/daemon/daemon-owner.ts
  - packages/client/src/daemon/create-daemon.ts
  - packages/client/src/__tests__/
  - packages/client/scripts/
  - packages/cloud-postgres/src/__tests__/
  - .github/workflows/ci.yml
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
    - packages/client/src/__tests__/daemon-owner-mutex-collision.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260813-1028-ci-stability-flakes.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/daemon-owner-mutex-collision.test.ts
  commands_succeed:
    - pnpm -r run typecheck
    - pnpm --filter @byok-sdk/client run test
    - pnpm --filter @byok-sdk/cloud-postgres run test
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint: main @ `9277b4e`（origin/main 同步点，worktree 基点）
- Revert strategy: 单 PR revert；不动生产语义与迁移，回滚零残留。
