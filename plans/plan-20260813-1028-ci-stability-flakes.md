# Plan: CI Stability — daemon-owner mutex + MinIO teardown 503 flakes

> **Status**: Executing
> **Created**: 20260813-1028
> **Slug**: ci-stability-flakes
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: todos:tasks/todos.md#CI加固两条(overnight 实证)
> **Artifact Level**: work-package
> **Promotion Reason**: O-1 CI 稳定性刀(handoff §2 最高杠杆):两个既有 flake 让每刀 CI 靠重跑绕过,掩盖真实信号;安全相邻(daemon-owner 是 owner/reclaim 权威),需 evidence-first 与独立回滚面
> **Verification Boundary**: packages/client 全量测试 + cloud-postgres dataplane(真 MinIO/PG) + 加压复现前红后绿;protocol 与其余包零 diff
> **Rollback Surface**: revert;不动生产语义,零迁移
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260813-1028-ci-stability-flakes.contract.md`
> **Task Review**: `tasks/reviews/20260813-1028-ci-stability-flakes.review.md`
> **Implementation Notes**: `tasks/notes/20260813-1028-ci-stability-flakes.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: todos:tasks/todos.md#CI加固两条(overnight 实证)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260813-1028-ci-stability-flakes.md`
- Sprint contract: `tasks/contracts/20260813-1028-ci-stability-flakes.contract.md`
- Sprint review: `tasks/reviews/20260813-1028-ci-stability-flakes.review.md`
- Implementation notes: `tasks/notes/20260813-1028-ci-stability-flakes.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260813-1028-ci-stability-flakes.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260813-1028-ci-stability-flakes.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260813-1028-ci-stability-flakes.md`.

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
- Contract file: `tasks/contracts/20260813-1028-ci-stability-flakes.contract.md`
- Review file: `tasks/reviews/20260813-1028-ci-stability-flakes.review.md`
- Implementation notes file: `tasks/notes/20260813-1028-ci-stability-flakes.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260813-1028-ci-stability-flakes.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260813-1028-ci-stability-flakes.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: revert;不动生产语义,零迁移
- **Verification boundary**: packages/client 全量测试 + cloud-postgres dataplane(真 MinIO/PG) + 加压复现前红后绿;protocol 与其余包零 diff
- **Review/acceptance boundary**: `tasks/reviews/20260813-1028-ci-stability-flakes.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: O-1 CI 稳定性刀(handoff §2 最高杠杆):两个既有 flake 让每刀 CI 靠重跑绕过,掩盖真实信号;安全相邻(daemon-owner 是 owner/reclaim 权威),需 evidence-first 与独立回滚面

## Evidence Contract

- **State/progress path**: `plans/plan-20260813-1028-ci-stability-flakes.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260813-1028-ci-stability-flakes.contract.md`, `tasks/reviews/20260813-1028-ci-stability-flakes.review.md`, and `tasks/notes/20260813-1028-ci-stability-flakes.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260813-1028-ci-stability-flakes.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: revert;不动生产语义,零迁移

## Captured Planning Output

# Plan: CI Stability — Two Known Flakes (daemon-owner mutex, MinIO teardown 503)

> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/2026-08-13-byok-optimization-handoff.md` §2 O-1；`tasks/todos.md` 两条 CI 加固条目（overnight 运行实证）

## Agentic Routing
- Selected route: root-cause-prover 先证根因（两个 flake 各一份 Root Cause Evidence），fast-worker 落最小修复，gatekeeper 验收。
- Routing reason: flake 修复的头号风险是"看起来合理但没治根"，evidence-first 是硬前置（instrument before fix）。
- Due diligence:
  - P1 map: mutex 权威在 `packages/client/src/daemon/daemon-owner.ts`（`acquireStoreMutex` :307-344，fail-closed 抛点 :324/:343）；测试端口注入 seam 已存在（`create-daemon.ts:596-641`：`__setStoreMutexPortProviderForTests` + vitest band 30000..32687，band=worker id）。MinIO 侧测试支撑在 `packages/cloud-postgres/src/__tests__/support/dataplane.ts`（bucket 创建 :209 只判 `created.ok`）与 `disable-fetch-keepalive.ts`（B-1 已修 keep-alive reset）；`Unexpected HTTP response: 503` 字符串不在仓内源码，来自依赖层（待 evidence 定位确切抛点）。
  - P2 trace (mutex): `pnpm -r run test` 满仓并发 → `createDaemon` → `resolveStoreMutexPort()`（vitest band 或 undefined→hash band）→ `acquireStoreMutex` bind EADDRINUSE → `probeStoreMutex`（1s 超时）→ `uncertain` 或同 identity → **立抛 `DaemonOwnerActiveError` 无重试**（:324）。候选根因：(a) CPU 饥饿下 probe 1s 超时→`uncertain`；(b) 跨 vitest 进程 band 重叠（`VITEST_WORKER_ID` 在不同包/不同 vitest 进程重复,`vitestDaemonSeq` 是各进程独立的 module state）；(c) 非 vitest 子进程（smoke 脚本产的真 daemon）落 hash band 撞测试。root-cause-prover 必须用探针区分 a/b/c，禁止盲选。
  - P2 trace (MinIO): dataplane 套件全过 → teardown/相邻 scope 建 bucket 阶段 MinIO 返 503（server 主动拒绝,非 socket reset；B-1 的 keep-alive 修复不覆盖）。A-1 ship 时 4 次 dataplane 撞 1 次。
  - P3 decision rationale: ① 生产语义不动——`acquireStoreMutex` 的 fail-closed（uncertain→拒绝）是 owner/reclaim 安全权威，修复只允许发生在"结论正确性"层（如有界 re-probe 后仍 fail-closed）或测试端口供给层，不允许把 uncertain 改成放行。② 产品代码禁新增兼容/重试回退（No Compatibility Fallbacks）——MinIO 503 修复落在测试 support（scope 创建/teardown 的有界重试或先 drain/close），不动 `r2-blobs.ts` 语义。③ 修复必须由复现探针背书：修前能复现（或有结构性证明），修后 N 次并发全绿。

## Approach
1. root-cause-prover（两个 flake 并行两份 dispatch）：
   - mutex：写复现/探针脚本（满负载并发 or 直接对 `acquireStoreMutex`/band 派生做碰撞注入），判定 a/b/c 哪个是真根因，产出四字段 Root Cause Evidence + 候选回归守卫。
   - MinIO 503：定位确切抛点（依赖层错误串），判定 503 属于 bucket create、对象操作还是 teardown 序列中哪一步，以及 MinIO 何时返 503（compose down 竞态/启动竞态/负载）。
2. fast-worker 按 evidence 落最小修复：
   - mutex：按根因选——(a) 真根因是 probe 超时→有界 re-probe（如 3 次）后仍 fail-closed，语义注释更新；(b) band 重叠→端口供给去重（如 PID 混入 band 派生或 port 0 + 注册表）；(c) hash band 撞→smoke 脚本走注入 seam。附回归守卫测试。
   - MinIO：测试 support 内对确切失败步骤做有界重试（次数+上限时长明确）或调整 teardown 顺序（先 close client 再 down）。
3. 复现验证：修复前后各跑加压复现面（至少 3 次 `pnpm -r run test` 级并发或等价定向压测），前红后绿才算数。
4. gatekeeper 验收。

## Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| 测试竞争下 skipIf | 最小改动 | 掩盖信号,mutex 语义失去并发覆盖 | 仅当 evidence 证明碰撞不可根治时兜底 |
| uncertain→放行 | flake 消失 | 破坏 fail-closed 安全权威 | 拒绝 |
| r2-blobs.ts 产品层加 503 重试 | 顺手 | 产品代码兼容回退,纪律禁止 | 拒绝,修复限测试 support |
| CI 全局 retry(vitest retry) | 一刀切 | 掩盖一切真回归信号 | 拒绝 |

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| 修了症状没治根,flake 换形态再现 | Medium | Medium | root-cause-prover 硬前置 + 修后加压复现 |
| mutex 改动弱化 owner/reclaim 安全语义 | Low | High | 生产 fail-closed 路径零语义变化为 exit criterion,gatekeeper 显式核对 |
| 复现不稳定导致证据链断 | Medium | Low | 允许结构性证明(代码路径+碰撞概率论证)替代活复现,但须在 evidence 里显式标注 |

## Promotion Gate
- **Merge/PR unit**: 一个 PR(两个 flake 同刀,同属 CI 稳定性回滚面)。
- **Rollback surface**: revert;不动生产语义,零迁移。
- **Verification boundary**: `packages/client` 全量测试 + cloud-postgres dataplane 套件(真 MinIO/PG)+ 加压复现面前红后绿;`packages/protocol` 与其余包零 diff。
- **Review/acceptance boundary**: gatekeeper 单轨。
- **High-risk surface**: daemon-owner 是 owner/reclaim 安全权威,fail-closed 语义不许弱化。
- **Why not checklist row**: 安全相邻路径 + 需 evidence-first 流程 + 独立回滚面。

## Evidence Contract
- **State/progress path**: 本 plan + contract + notes。
- **Verification evidence**: 两份 Root Cause Evidence、修复前后加压复现输出、常规套件输出。
- **Evaluator rubric**: mutex 根因被探针证实且修复直击该根因;生产 fail-closed 语义零变化;MinIO 503 确切抛点被定位且修复限测试 support;加压复现修后全绿。
- **Stop condition**: 任何把 uncertain 改放行、产品层加重试、或全局 vitest retry 的方案。
- **Rollback surface**: revert commits。

## Annotations

- 已解决:方向来自 owner 排序的 O-1(handoff §2);两 flake 合一刀是 todos 里已有的建议("可合并为一个 CI 稳定性刀")。无遗留注释。

## Task Breakdown
- [x] root-cause-prover: mutex flake 根因证明(a/b/c 判定 + 复现探针)——判定为 (c) 变体:第三方回环监听者占 hash band 端口,probe uncertain 即抛;(a)(b) 证伪为触发因,(b) 确认为独立缺陷并同刀删除
- [x] root-cause-prover: MinIO teardown 503 抛点定位 + 触发条件——证实为误归因:真根因是 ci.yml setup-bun 未 pin 版本的 CDN 下载假红,与 MinIO 无关(contract Scope amendment 记录 escape-hatch 触发)
- [x] fast-worker: MinIO 侧修复(按 evidence 改道)——ci.yml 两处 bun-version pin + constraints.test.ts 结构守卫,红→绿证据齐
- [x] deep-worker: mutex 最小修复 + 回归守卫——store-scoped lock(UDS/named pipe),vitest seam 同刀删净,守卫 A/B/C/D
- [x] 加压复现前红后绿证据——两份 no-pipe 前红 artifact + 修后 client 全量 3+3 轮全绿(executor 与 gatekeeper 各 3 轮)
- [x] gatekeeper 验收——PASS,硬不变量逐条核实,非阻塞观察 O1-O6 记录于 review
