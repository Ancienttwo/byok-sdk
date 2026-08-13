# Plan: shutdown teardown order — liveness signal outlives the lease

> **Status**: Executing
> **Created**: 20260813-2201
> **Slug**: shutdown-lease-order
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: ci:job-94465898325 + scratchpad/rcp-unpair 证据
> **Artifact Level**: work-package
> **Promotion Reason**: CI job 94465898325 暴露 + prover 实测证实:runShutdownSequence 先删 control 存活信号再释放 lease,11-46ms 窗口内「已退出」为真但锁仍握——unpair/start/doctor 全在竞态;缺陷早于 #64,ubuntu 轮询相位对齐后变现
> **Verification Boundary**: client 全量 + 守卫红→绿(bun+vitest) + ipc-smoke ×3 + typecheck;daemon-owner.ts 与其余包零 diff
> **Rollback Surface**: revert;零迁移
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260813-2201-shutdown-lease-order.contract.md`
> **Task Review**: `tasks/reviews/20260813-2201-shutdown-lease-order.review.md`
> **Implementation Notes**: `tasks/notes/20260813-2201-shutdown-lease-order.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: ci:job-94465898325 + scratchpad/rcp-unpair 证据
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260813-2201-shutdown-lease-order.md`
- Sprint contract: `tasks/contracts/20260813-2201-shutdown-lease-order.contract.md`
- Sprint review: `tasks/reviews/20260813-2201-shutdown-lease-order.review.md`
- Implementation notes: `tasks/notes/20260813-2201-shutdown-lease-order.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260813-2201-shutdown-lease-order.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260813-2201-shutdown-lease-order.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260813-2201-shutdown-lease-order.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/20260813-2201-shutdown-lease-order.contract.md`
- Review file: `tasks/reviews/20260813-2201-shutdown-lease-order.review.md`
- Implementation notes file: `tasks/notes/20260813-2201-shutdown-lease-order.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260813-2201-shutdown-lease-order.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260813-2201-shutdown-lease-order.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: revert;零迁移
- **Verification boundary**: client 全量 + 守卫红→绿(bun+vitest) + ipc-smoke ×3 + typecheck;daemon-owner.ts 与其余包零 diff
- **Review/acceptance boundary**: `tasks/reviews/20260813-2201-shutdown-lease-order.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: CI job 94465898325 暴露 + prover 实测证实:runShutdownSequence 先删 control 存活信号再释放 lease,11-46ms 窗口内「已退出」为真但锁仍握——unpair/start/doctor 全在竞态;缺陷早于 #64,ubuntu 轮询相位对齐后变现

## Evidence Contract

- **State/progress path**: `plans/plan-20260813-2201-shutdown-lease-order.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260813-2201-shutdown-lease-order.contract.md`, `tasks/reviews/20260813-2201-shutdown-lease-order.review.md`, and `tasks/notes/20260813-2201-shutdown-lease-order.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260813-2201-shutdown-lease-order.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: revert;零迁移

## Captured Planning Output

# Plan: shutdown teardown order — liveness signal outlives the lease

> **Spec**: `docs/spec.md`
> **Research**: root-cause-prover 实测(scratchpad/rcp-unpair/:probe-race.mjs 4/4 复现、probe-window.mjs 53 run 窗口 11-46ms、CI job 94465898325)

## Agentic Routing
- Selected route: deep-worker 执行(teardown 顺序重排,mutation-barrier 语义敏感,需一次落对),gatekeeper 验收。
- Routing reason: 证据链已闭合,修复面单文件但时序不变量微妙。
- Due diligence:
  - P1 map: 权威在 `create-daemon.ts:1816-1826` `runShutdownSequence`:`controlServerHandle.close()`(:1817,unlink control.sock+control.token)先于 `daemonOwnerLease.release()`(:1823,mutex.close 才解绑 mutex.sock)。外部判「已退出」的谓词 `isControlDaemonGone`(`bin/control-client.ts:376-394`)= token 消失 + control connect 拒绝;`unpair.ts:371-388` 据此立刻 re-acquire。
  - P2 trace(实测): shutdown ack → :1817 control 端点消失(gate-true)→ **11-46ms 后** :1823 lease 释放 → ~5ms 后进程退出。gate-true 与 lease-free 之间任何 acquire → probe 'holder'(identity 即回,非超时)→ `daemon-owner.ts:379` 抛 `DaemonOwnerActiveError('unknown')`。CI 失败串一致;(b) probe 超时、(c) 非优雅退出、(d) TCP/UDS 差异均已证伪——缺陷早于 #64,旧代码同窗口同样拒绝,只是 macOS 上 300ms 轮询相位恒躲开窗口。
  - P3 decision rationale: ① 不变量:**daemon 持有 lease 期间,control 端点(存活信号)必须可观察**——「已退出」信号为真必须蕴含 lease 已释放。早到的竞争者看到活 control 端点会安全地继续等,方向 fail-safe。② 实现形状:拆 control teardown 为「停服 RPC/断连(保 mutation-barrier 耦合)→ release lease → 关 listener + unlink socket/token」;`mutationBarrierComplete===false` 分支(:1820)现同样先删信号后永久持锁,一并修(该路径下 unpair 应得 `UnpairExitUnconfirmedError` 而非 DaemonOwnerActiveError)。③ 拒绝 unpair 有界重试(acquire 无法区分「我刚令其退出的 daemon」与「2ms 前新起的 daemon」,重开 stale-owner TOCTOU;且 start/doctor 同窗口竞态不获解);拒绝提前 unlink mutex.sock(bind 新 inode + 旧 listener 仍绑 = 双写)。④ daemon-owner.ts 零 diff——任何触碰其拒绝分支的 diff 即越界。

## Approach
1. deep-worker:重排 `runShutdownSequence` teardown(含 barrier-false 分支),必要时给 controlServerHandle 增加分步关闭能力(stop-serving vs close-listener)——若 control-server.ts 需要增分步 API,属配合改动,允许。
2. 回归守卫:`packages/client/src/__tests__/daemon-stop-shutdown-parity.test.ts` 增一例(prover 已给出精确设计):shutdown 后紧采样,断言不存在 `controlGone && mutexHeld` 的样本,且首个 gate-true 时刻的 `acquireDaemonOwner('doctor')` 必成功。修前确定性红(窗口 11-46ms,数百次采样必中),修后按时序不可证伪。
3. 全量 client 测试(vitest)+ 守卫 bun/vitest 双 runner + `pnpm -r typecheck` + 本地 `ipc-smoke` ×3。
4. gatekeeper 验收。

## Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| unpair 对同 store 'holder' 有界重试 | 改动最小 | 无法区分新旧 daemon,重开 TOCTOU;start/doctor 不获解 | 拒绝(prover 证死) |
| 提前 unlink mutex.sock | 简单 | POSIX 下双 inode 双写 | 拒绝(prover 证死) |
| 整体后移 controlServerHandle.close() | 不用拆 API | 反转 mutation-barrier 语义(close 失败=疑似残余写者应保锁) | 仅当 executor 论证后拆式不可行且写明 post-teardown RPC 不可再变更 store 时才可退用 |

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| 重排破坏 mutation-barrier 语义 | Med | High | 拆式关闭保留 close-失败→保锁耦合;gatekeeper 显式核对 :1816-1826 新序 |
| 守卫按时序采样在慢 CI 上假绿 | Low | Med | 断言的是「不存在坏样本」+首个 gate-true 即 acquire 成功,非窗口大小 |

## Promotion Gate
- **Merge/PR unit**: 单 PR。
- **Rollback surface**: revert;零迁移。
- **Verification boundary**: client 全量 + 守卫红→绿(双 runner)+ ipc-smoke ×3 + typecheck;其余包零 diff;daemon-owner.ts 零 diff。
- **Review/acceptance boundary**: gatekeeper 单轨。
- **High-risk surface**: 关机序:mutation barrier 与 lease 生命周期。
- **Why not checklist row**: 安全权威 teardown 序 + 独立回滚面。

## Evidence Contract
- **State/progress path**: 本 plan + contract + notes。
- **Verification evidence**: prover 四件套(已在 scratch)、守卫红→绿、smoke 输出。
- **Evaluator rubric**: 不变量「gate-true ⇒ lease 已释放」被守卫机检;barrier-false 分支同修;daemon-owner.ts 零 diff。
- **Stop condition**: 任何 retry/提前 unlink 形状,或触碰 daemon-owner.ts 拒绝分支。
- **Rollback surface**: revert commit。

## Annotations

- 已解决:修复方向三选一已由 prover 证据裁死。无遗留注释。

## Task Breakdown
- [ ] deep-worker: teardown 重排(含 barrier-false 分支)+ 守卫红→绿
- [ ] ipc-smoke ×3 + 双 runner 验证
- [ ] gatekeeper 验收

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] deep-worker: teardown 重排(含 barrier-false 分支)+ 守卫红→绿
- [ ] ipc-smoke ×3 + 双 runner 验证
- [ ] gatekeeper 验收
