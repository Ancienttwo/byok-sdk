# Plan: Skill-pack cloud-postgres persistence (R1 Phase 2)

> **Status**: Executing
> **Created**: 20260813-0339
> **Slug**: skill-pack-postgres-phase2
> **Planning Source**: waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: survey:A-1
> **Artifact Level**: work-package
> **Promotion Reason**: multi_package_store_contract_and_migration
> **Verification Boundary**: core/cloud-postgres/conformance/cloud tests; freeze-guard zero diff; conformance port-inventory now requires PostgresSkillPackStore; dataplane vs real Postgres green; full recursive typecheck/test/build; strict workflow gate
> **Rollback Surface**: forward-only migration 0005; revert PR reverts CORE_STORE_NAMES change too; migration only creates new tables, rollback-safe
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260813-0339-skill-pack-postgres-phase2.contract.md`
> **Task Review**: `tasks/reviews/20260813-0339-skill-pack-postgres-phase2.review.md`
> **Implementation Notes**: `tasks/notes/20260813-0339-skill-pack-postgres-phase2.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from waza-think planning output.
- Source ref: survey:A-1
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260813-0339-skill-pack-postgres-phase2.md`
- Sprint contract: `tasks/contracts/20260813-0339-skill-pack-postgres-phase2.contract.md`
- Sprint review: `tasks/reviews/20260813-0339-skill-pack-postgres-phase2.review.md`
- Implementation notes: `tasks/notes/20260813-0339-skill-pack-postgres-phase2.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260813-0339-skill-pack-postgres-phase2.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260813-0339-skill-pack-postgres-phase2.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260813-0339-skill-pack-postgres-phase2.md`.

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
- Contract file: `tasks/contracts/20260813-0339-skill-pack-postgres-phase2.contract.md`
- Review file: `tasks/reviews/20260813-0339-skill-pack-postgres-phase2.review.md`
- Implementation notes file: `tasks/notes/20260813-0339-skill-pack-postgres-phase2.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260813-0339-skill-pack-postgres-phase2.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260813-0339-skill-pack-postgres-phase2.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: forward-only migration 0005; revert PR reverts CORE_STORE_NAMES change too; migration only creates new tables, rollback-safe
- **Verification boundary**: core/cloud-postgres/conformance/cloud tests; freeze-guard zero diff; conformance port-inventory now requires PostgresSkillPackStore; dataplane vs real Postgres green; full recursive typecheck/test/build; strict workflow gate
- **Review/acceptance boundary**: `tasks/reviews/20260813-0339-skill-pack-postgres-phase2.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: multi_package_store_contract_and_migration

## Evidence Contract

- **State/progress path**: `plans/plan-20260813-0339-skill-pack-postgres-phase2.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260813-0339-skill-pack-postgres-phase2.contract.md`, `tasks/reviews/20260813-0339-skill-pack-postgres-phase2.review.md`, and `tasks/notes/20260813-0339-skill-pack-postgres-phase2.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260813-0339-skill-pack-postgres-phase2.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: forward-only migration 0005; revert PR reverts CORE_STORE_NAMES change too; migration only creates new tables, rollback-safe

## Captured Planning Output

## Goal

给 skill-pack 交付通道补上持久化(Phase 2):新增 `PostgresSkillPackStore`(镜像 `InMemorySkillPackStore`),一条 `deploy/sql/0005` migration,把 `skillPacks` 从临时 bridge 转为 `CoreStores` 强制成员并清空 `CORE_NON_COMPOSITION_PORT_NAMES`,接进 `createPostgresCoreStores`,补 conformance 覆盖。wire 层 route/capability 仍走 `includeSkillPacks` 可选。

## Design Decision(已定稿)

Phase 1 在 `packages/core/src/ports-contract.ts:34-42` 自声明:Phase 2 把 skillPacks 移入 `CORE_STORE_NAMES` 且该常量归空。**裁决:采纳此契约——skillPacks 成为 `CoreStores` 强制成员**(每个 composition 都提供、Postgres 永远建表,能力未声明时空表),**wire 层的 route/capability 保持可选**(`cloud/src/cloud.ts:361-374` 的 `includeSkillPacks` 不变)。理由:存储在场 ≠ 能力广告;把存储做成强制、能力做成可选,是干净分离,兑现 Phase 1 承诺,消除永久性 port-inventory 例外。`conformance/src/core/port-inventory.ts:39` 读 `CORE_STORE_NAMES`,flip 后自动把 skillPacks 纳入组合断言,强制 Postgres 实现存在——TS + conformance 使机械部分 enforced-complete。

## Change

1. `packages/core/src/stores.ts`:`CORE_STORE_NAMES` 加入 `skillPacks`;`packages/core/src/ports-contract.ts`:`CORE_NON_COMPOSITION_PORT_NAMES` 归空数组,并移除随之多余的 `CORE_PORT_NAMES`/`CorePortName` 分叉(若它们只为容纳该例外而存在)——回到单一 `CORE_STORE_NAMES` 权威。更新 `constraints.test.ts` 的公开导出清单。
2. `packages/cloud-postgres`:新增 `src/stores/core/skill-pack.ts` = `PostgresSkillPackStore`,镜像 `InMemorySkillPackStore`(`core/src/in-memory/skill-pack.ts:37-128`),复用 core 校验器 `checkSkillPackManifest`/`checkSkillPackEntry`/尺寸常量,tenant-first,int8/bytea 处理与既有 store 一致;接进 `src/stores/index.ts` 的 `createPostgresCoreStores`。
3. `deploy/sql/0005_skill_packs.sql`:forward-only migration,建 skill-pack manifest/files 表(tenant 前缀、content-hash、bytea/文本内容、字节尺寸 bigint),与 `PostgresSkillPackStore` 的读写形状一致;进 `migrationsDir()` SQL 投影,保持 `deploy/sql` 与 `dist/sql` 字节一致(既有 build copy)。
4. `packages/conformance`:确认 port-inventory 自动纳入 skillPacks;补该 store 的组合断言向量(in-memory 与 Postgres 同套断言源),覆盖 install→list→read→tenant 隔离。
5. `cloud/src/cloud.ts`:验证 `includeSkillPacks` 可选路径不受影响(存储强制、能力可选);如需,补一条测试证明未声明能力时存储仍在场且路由不挂载。

## Non-scope

- 不改 wire envelope / protocol(freeze-guard 零 diff)。
- 不把 skill-pack 能力改成强制广告(只有存储强制)。
- 不引入多源/marketplace/扫描器(那是更后的事)。
- 不动 client 侧安装管线(Phase 1 已交付且不变)。

## Task Breakdown

- [ ] core:`CORE_STORE_NAMES` 加 skillPacks、`CORE_NON_COMPOSITION_PORT_NAMES` 归空、收敛多余分叉、更新 constraints 导出清单。
- [ ] cloud-postgres:`PostgresSkillPackStore` 镜像 in-memory 实现,接进 `createPostgresCoreStores`。
- [ ] `deploy/sql/0005_skill_packs.sql` migration,与 store 形状一致,SQL 投影与 dist 字节一致。
- [ ] conformance:skillPacks 组合断言(in-memory + Postgres 同源),含 tenant 隔离。
- [ ] cloud:验证/测试 includeSkillPacks 可选路径不受强制存储影响。
- [ ] 全量验证(pnpm -r typecheck/test/build)+ freeze-guard 零 diff + conformance 绿;dataplane 套件对真实 Postgres 绿。
- [ ] Commit, push, open PR, merge to main on green CI, verify merged revision。

## Verification Boundary

core/cloud-postgres/conformance/cloud 包测试;freeze-guard 零 diff;conformance port-inventory 现在要求并验证 Postgres SkillPackStore;`pnpm -r run typecheck && test && build`;CI dataplane(真实 Postgres)Node 22+24 绿;`repo-harness run check-task-workflow --strict`。

## Rollback Surface

Phase 2 引入 forward-only migration `0005`,按既有 migration 纪律;revert PR 需同时回滚 `CORE_STORE_NAMES` 变更(否则 conformance 要求 Postgres 实现)。migration 只建新表,无既有数据变更,回滚安全。

## Open Item(显式延迟)

pack 的 tenant 归属粒度沿用 Phase 1 的 tenant-scoped(走既有 port 惯例);product-global 共享包仍等第二个真实分发场景再裁。

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] core:`CORE_STORE_NAMES` 加 skillPacks、`CORE_NON_COMPOSITION_PORT_NAMES` 归空、收敛多余分叉、更新 constraints 导出清单。
- [ ] cloud-postgres:`PostgresSkillPackStore` 镜像 in-memory 实现,接进 `createPostgresCoreStores`。
- [ ] `deploy/sql/0005_skill_packs.sql` migration,与 store 形状一致,SQL 投影与 dist 字节一致。
- [ ] conformance:skillPacks 组合断言(in-memory + Postgres 同源),含 tenant 隔离。
- [ ] cloud:验证/测试 includeSkillPacks 可选路径不受强制存储影响。
- [ ] 全量验证(pnpm -r typecheck/test/build)+ freeze-guard 零 diff + conformance 绿;dataplane 套件对真实 Postgres 绿。
- [ ] Commit, push, open PR, merge to main on green CI, verify merged revision。
