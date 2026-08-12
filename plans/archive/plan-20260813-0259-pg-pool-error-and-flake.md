# Plan: pg Pool error handler + CI teardown flake (B-1)

> **Status**: Archived
> **Created**: 20260813-0259
> **Slug**: pg-pool-error-and-flake
> **Planning Source**: waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: survey:B-1
> **Artifact Level**: work-package
> **Promotion Reason**: production_crash_and_ci_flake_fix
> **Verification Boundary**: cloud-postgres package tests; Node 22+24 dataplane CI job green across reruns; full recursive typecheck/test/build; strict workflow gate
> **Rollback Surface**: single package, revert single PR; no migration/wire/schema change
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260813-0259-pg-pool-error-and-flake.contract.md`
> **Task Review**: `tasks/reviews/20260813-0259-pg-pool-error-and-flake.review.md`
> **Implementation Notes**: `tasks/notes/20260813-0259-pg-pool-error-and-flake.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from waza-think planning output.
- Source ref: survey:B-1
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260813-0259-pg-pool-error-and-flake.md`
- Sprint contract: `tasks/contracts/20260813-0259-pg-pool-error-and-flake.contract.md`
- Sprint review: `tasks/reviews/20260813-0259-pg-pool-error-and-flake.review.md`
- Implementation notes: `tasks/notes/20260813-0259-pg-pool-error-and-flake.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260813-0259-pg-pool-error-and-flake.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260813-0259-pg-pool-error-and-flake.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260813-0259-pg-pool-error-and-flake.md`.

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
- Contract file: `tasks/contracts/20260813-0259-pg-pool-error-and-flake.contract.md`
- Review file: `tasks/reviews/20260813-0259-pg-pool-error-and-flake.review.md`
- Implementation notes file: `tasks/notes/20260813-0259-pg-pool-error-and-flake.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260813-0259-pg-pool-error-and-flake.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260813-0259-pg-pool-error-and-flake.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: single package, revert single PR; no migration/wire/schema change
- **Verification boundary**: cloud-postgres package tests; Node 22+24 dataplane CI job green across reruns; full recursive typecheck/test/build; strict workflow gate
- **Review/acceptance boundary**: `tasks/reviews/20260813-0259-pg-pool-error-and-flake.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: production_crash_and_ci_flake_fix

## Evidence Contract

- **State/progress path**: `plans/plan-20260813-0259-pg-pool-error-and-flake.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260813-0259-pg-pool-error-and-flake.contract.md`, `tasks/reviews/20260813-0259-pg-pool-error-and-flake.review.md`, and `tasks/notes/20260813-0259-pg-pool-error-and-flake.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260813-0259-pg-pool-error-and-flake.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: single package, revert single PR; no migration/wire/schema change

## Captured Planning Output

## Goal

给 `createByokPool` 加 pool-level `'error'` 处理,消除未处理 idle-backend-reset 崩溃(生产宿主风险);并先插桩确认 Node 22 dataplane `socket hang up` CI flake 的真实来源(pg pool vs undici/MinIO teardown),再修确认的那一处。pg pool handler 无论 flake 来源如何都要落地——它是独立的真实生产 bug。

证据:`packages/cloud-postgres/src/pool.ts:46-48` 是 bare `new pg.Pool({...})`,全仓无任何 pool `error` handler;pg 官方要求 pool 必须挂 error handler,否则 idle backend 被重置(failover / `pg_terminate_backend` / 网络瞬断)会抛出未处理的 `'error'` 事件直接崩宿主进程。CI 里 `docker compose down -v` 拆除容器时同类 reset 表现为 R1 ship 期间反复出现的 test 之后 `socket hang up`(Node 22 dataplane job,测试本身全过)。

## Design Constraints

- pool 仍是 caller-owned(`pool.ts:42-45` 明确本包不持有 module-level pool)——本刀不改变所有权模型。
- 不 mutate 进程级 `pg.types`(同一红线,`pool.ts:12-16`)。
- 不吞错到无声:handler 要么路由到 caller 注入的回调,要么走一个可观测的默认(不是静默 no-op)。宿主拥有 policy,本包给安全默认。
- fail-safe 而非 fail-crash:目标是「idle backend reset 不再拖垮宿主」,不是掩盖真实连接错误。
- instrument-first(anti-pattern:no fix without instrument):在声称 flake 修好前,先加临时插桩记录 reset 来自哪个 socket(pg backend vs undici→MinIO keep-alive),确认来源;`socket hang up` 是 undici/http 的签名文案而非 pg 的(`Connection terminated unexpectedly`),对象套件经 `globalThis.fetch` 打 MinIO(`r2-blobs.ts:277,600` undici keep-alive),所以有两个候选 reset 源,不能预设。

## Change

1. `packages/cloud-postgres/src/pool.ts`:`createByokPool` 里对返回的 pool 挂 `pool.on('error', handler)`。新增可选 `onPoolError?: (err: Error, client?: PoolClient) => void` 到 `ByokPoolOptions`;默认 handler 走 `console.error`(可观测,非静默),caller 提供则用 caller 的。评论说明为何必须挂(未处理 pool error = 宿主崩溃)。评估 `allowExitOnIdle`:仅当插桩证明它与 CI teardown 相关时才加,否则不加(避免改变 exit 语义)。
2. 插桩阶段:临时在 cloud-postgres 测试 teardown 与对象套件 fetch 路径记录 socket reset 来源,跑 dataplane 套件复现,确认 flake 来自 pg pool 还是 undici→MinIO。据结果:
   - 若 pg pool:error handler 本身即修复;补一条测试断言 pool `'error'` 事件被处理而非 crash(可用一个会被 reset 的连接或直接 emit 验证 handler 挂上)。
   - 若 undici→MinIO keep-alive:另修对象套件的 fetch dispatcher/agent 在 teardown 前关闭(如显式 `agent.close()` / 禁 keep-alive),pg handler 仍保留为独立生产修复。
3. 移除所有临时插桩后再交付。

## Non-scope

- 不重构 pool 所有权模型、不引入 module-level pool。
- 不动 int8 parser。
- 不改其他包的 pg 使用(cloud-postgres 是唯一 pg 消费者)。

## Task Breakdown

- [ ] 插桩复现 Node 22 dataplane `socket hang up`,记录并报告 reset 来源(pg vs undici/MinIO)。
- [ ] `createByokPool` 加 pool `'error'` handler + 可选 `onPoolError`,评论说明必要性。
- [ ] 据插桩结果修确认的 flake 源(pg handler 已覆盖 / 或补 undici teardown)。
- [ ] 加针对性测试:pool error 被处理不 crash;若改了 undici teardown 则加对应验证。移除临时插桩。
- [ ] 全量验证(pnpm -r typecheck/test/build)+ 本地跑 cloud-postgres dataplane 套件(需本地 Postgres/MinIO;若本地无则声明并依赖 CI 复核)。
- [ ] Commit, push, open PR, merge to main on green CI, verify merged revision.

## Verification Boundary

`pnpm -r run typecheck && pnpm -r run test && pnpm -r run build`;cloud-postgres 包测试;CI 的 Node 22 + Node 24 dataplane job 连续绿(本刀的真实验收面就是这个此前 flaky 的 job);`repo-harness run check-task-workflow --strict`。

## Rollback Surface

单包单文件为主(pool.ts + 可能的对象套件 teardown),revert 单 PR 即净;无 migration、无 wire 改动、无 schema 改动。

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] 插桩复现 Node 22 dataplane `socket hang up`,记录并报告 reset 来源(pg vs undici/MinIO)。
- [ ] `createByokPool` 加 pool `'error'` handler + 可选 `onPoolError`,评论说明必要性。
- [ ] 据插桩结果修确认的 flake 源(pg handler 已覆盖 / 或补 undici teardown)。
- [ ] 加针对性测试:pool error 被处理不 crash;若改了 undici teardown 则加对应验证。移除临时插桩。
- [ ] 全量验证(pnpm -r typecheck/test/build)+ 本地跑 cloud-postgres dataplane 套件(需本地 Postgres/MinIO;若本地无则声明并依赖 CI 复核)。
- [ ] Commit, push, open PR, merge to main on green CI, verify merged revision.
