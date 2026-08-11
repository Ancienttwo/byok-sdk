# Plan: cloud-postgres SQL Build Projection + Two-Tier Release Smoke

> **Status**: Draft
> **Created**: 20260812-0201
> **Slug**: cloud-postgres-sql-projection
> **Artifact Level**: work-package
> **Promotion Reason**: 已证实的发布完整性缺口：`@byok-sdk/cloud-postgres@0.2.0` tarball 宣称提供 migration runner 却不携带 runner 所需的 SQL（`files` 只有 `dist/README/LICENSE`），每个外部 host 被迫从 git checkout vendor 4 个 SQL 文件并自建 provenance；现有 release smoke 只验证安装与 import，永远抓不到这类资产缺失。
> **Verification Boundary**: `pnpm -r build/test/typecheck`、`scripts/release/pack-and-smoke.mjs`（新增确定性 SQL 断言，保持零外部服务依赖）、CI PG service container 的真库迁移冒烟、`repo-harness run check-deploy-sql-order`、现有 deploy 脚本与 cloud-postgres 测试全部不变仍绿。
> **Rollback Surface**: revert cloud-postgres build 复制步骤、`migrationsDir()` 导出与 smoke 断言；`deploy/sql/` 权威目录、deploy 脚本、测试、harness policy 全程零改动。
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/2026-08-12-salesko-integration-handoff.md` 条目 3
> **Task Contract**: `tasks/contracts/20260812-0201-cloud-postgres-sql-projection.contract.md`
> **Task Review**: `tasks/reviews/20260812-0201-cloud-postgres-sql-projection.review.md`
> **Implementation Notes**: `tasks/notes/20260812-0201-cloud-postgres-sql-projection.notes.md`

## Agentic Routing
- Selected route: contract worktree + fast-worker 执行，gatekeeper 验收；计划与最终裁决留主循环。
- Routing reason: 跨 build/release/CI 三个面的多文件变更，含发布完整性契约，达到验收门槛。
- Due diligence:
  - P1 map: authoring authority 是 `deploy/sql/`（0001-0004 四个文件）。真实消费方三类，全部保持不动：① `deploy/scripts/migrate:40` 把 `$repo_root/deploy/sql` 传给 runner；② cloud-postgres 真实 Postgres 测试从根目录加载（如 `conformance.test.ts:37` 的 `DEPLOY_SQL`）；③ repo-harness 把 `deploy/sql` 列为 workflow-contract 必需目录并由 `check-deploy-sql-order` 检查命名顺序。npm 侧：`packages/cloud-postgres/package.json:30` 的 `files` 只有 `dist/README/LICENSE`；`migrate(pool, dir)` 收目录参数；`scripts/release/pack-and-smoke.mjs` 无任何 SQL 断言。
  - P2 trace（目标链路）: build（tsup + tsc）末尾确定性复制 `deploy/sql` → `packages/cloud-postgres/dist/sql`（生成物，永不手工编辑）→ `files` 已含 `dist`，tarball 自动携带 → 新导出 `migrationsDir()` 以 `import.meta.url` 解析安装后包内 `dist/sql` → host：npm install 精确 tarball → `migrate(pool, migrationsDir())`，全程不接触源码 checkout。smoke 第一层（永久在线，零外部依赖）：解包 tarball 比对文件名集合 + SHA-256 与 `deploy/sql` 一致，并在隔离安装里 import `migrationsDir()` 断言目录存在且含全部 migration；第二层（CI PG service container）：从精确 tarball fresh install，对空库真实迁移，断言 ledger 与幂等重跑。
  - P3 decision rationale: `deploy/sql` 保持唯一 authoring authority——三类消费方 + harness contract 使「搬目录进包」成为无收益的多面 cutover（上一轮已被证据纠正并否决）。`dist/sql` 是 deterministic build projection 而非第二 authoring path，drift check 由 smoke 第一层的 SHA-256 比对承担，符合 one-source-of-truth + 投影必须带 drift check 的仓库纪律。release gate 保持零外部服务依赖（这是 pack-and-smoke 作为硬门的价值），真库迁移放 CI 分层。不改版本号、不发版——release 时机归 owner。
    此计划落地后 salesko 删除 vendored SQL 与 sha256 provenance 表（下游胶水按 core/glue 裁决原则移除）。

## Workflow Inventory

- Active plan: `plans/plan-20260812-0201-cloud-postgres-sql-projection.md`
- Sprint contract: `tasks/contracts/20260812-0201-cloud-postgres-sql-projection.contract.md`
- Sprint review: `tasks/reviews/20260812-0201-cloud-postgres-sql-projection.review.md`
- Implementation notes: `tasks/notes/20260812-0201-cloud-postgres-sql-projection.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: contract `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260812-0201-cloud-postgres-sql-projection.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260812-0201-cloud-postgres-sql-projection.md`.

## Approach
### Strategy
1. cloud-postgres build 末尾加确定性复制步骤：`deploy/sql/*.sql` → `dist/sql/`（先清后拷，保证无残留旧文件）。
2. 包导出 `migrationsDir(): string`：`fileURLToPath(new URL('./sql', import.meta.url))`，从安装后的 `dist/index.js` 解析同级 `sql/`。
3. `pack-and-smoke.mjs` 增第一层断言：tarball 内 `dist/sql` 文件名集合与逐文件 SHA-256 等于 `deploy/sql`；隔离安装里 `migrationsDir()` 可解析且文件齐全。保持脚本零外部服务依赖。
4. CI 增 PG service container 任务（第二层）：从本次 pack 的精确 tarball fresh install，空库执行 `migrate(pool, migrationsDir())`，断言全部 applied 且重跑幂等。
5. cloud-postgres README 更新：host 拥有 migration 的执行时机，不再拥有字节副本；用法示例改为 `migrationsDir()`。

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| authoring authority 搬进包目录、删根 `deploy/sql` | 无投影层 | 破坏 deploy 脚本、十余个测试、workflow-contract 必需目录与 `check-deploy-sql-order` 根假设，多面 cutover 无收益 | 拒绝（上轮证据已否决） |
| build-time deterministic projection → `dist/sql` | 消费方零改动；drift 由 smoke hash 兜住 | 多一个生成步骤 | 采纳 |
| 导出 SQL 字符串数组替代目录 | 无文件系统依赖 | runner API 收目录；字符串导出制造第二种消费形态 | 拒绝 |
| postinstall 拉取 SQL | 包更小 | 安装期网络依赖，违反 fail-closed | 拒绝 |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/cloud-postgres/package.json` | Modify | build script 增复制步骤（或引一个小 build mjs） |
| `packages/cloud-postgres/src/index.ts`（或新 `src/migrations-dir.ts`） | Modify/Add | 导出 `migrationsDir()` |
| `scripts/release/pack-and-smoke.mjs` | Modify | 第一层断言：文件名集合 + SHA-256 + 隔离安装解析 |
| `.github/workflows/…` | Modify | 第二层：PG service container 真库迁移冒烟 |
| `packages/cloud-postgres/README.md` | Modify | `migrationsDir()` 用法；host 不再 vendor 字节 |

### Data Flow
`deploy/sql`（唯一 authoring authority）→ build 复制 → `dist/sql`（生成物）→ npm tarball → 安装后 `migrationsDir()` → `migrate(pool, dir)`；drift check：smoke 第一层 SHA-256 比对 authoring dir 与 tarball 内容。

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| 复制步骤遗漏新增 migration 或残留已删文件 | Medium | High | 先清后拷 + smoke 按文件名集合双向比对（多、少、改都 fail） |
| `import.meta.url` 路径解析跨平台差异（Windows） | Low | Medium | `fileURLToPath` 标准化；现有 windows CI 跑 smoke |
| dist/sql 被误当 authoring path 手工编辑 | Low | High | 生成物注记 + smoke hash 比对 fail-closed；checksum 停机语义与 runner ledger 一致 |
| 第二层 PG 冒烟拖慢 release 流程 | Low | Low | 分层：release 硬门只含第一层；PG 层在 CI 并行 |
| smoke 断言写死文件数导致加 migration 即红 | Medium | Low | 断言以 `deploy/sql` 实际内容为基准动态比对，不写死数量 |

## Task Contracts
- Contract file: `tasks/contracts/20260812-0201-cloud-postgres-sql-projection.contract.md`
- Review file: `tasks/reviews/20260812-0201-cloud-postgres-sql-projection.review.md`
- Implementation notes file: `tasks/notes/20260812-0201-cloud-postgres-sql-projection.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260812-0201-cloud-postgres-sql-projection.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: 一个 PR：build 复制 + `migrationsDir()` + 两层 smoke + README。
- **Rollback surface**: revert 复制步骤/导出/断言；`deploy/sql` 与全部现有消费方零改动。
- **Verification boundary**: workspace 全套 + pack-and-smoke（含新断言）+ PG CI 冒烟 + `check-deploy-sql-order`。
- **Review/acceptance boundary**: gatekeeper 验收；salesko 下轮升级采用 `migrationsDir()` 并删 vendored SQL 作为 dogfood 消费证据。
- **High-risk surface**: 发布完整性断言的双向性（多/少/改都必须 fail）、生成物与权威目录的 drift。
- **Why not checklist row**: 发布物完整性是独立契约，有自己的 falsifier（smoke 红）与回滚面。
- **版本/发版**: 本 slice 不 bump 版本、不发版；何时出 0.2.x 归 owner 决定。

## Evidence Contract

- **State/progress path**: 本 plan Task Breakdown、contract、notes、review。
- **Verification evidence**: pack-and-smoke 输出（含新断言）、PG CI 任务日志、现有 deploy 脚本与 cloud-postgres 测试保持绿、`check-deploy-sql-order` 通过。
- **Evaluator rubric**: 从精确 tarball fresh install 且不访问源码 checkout：`migrationsDir()` 定位全部 migration；文件名集合与逐文件 SHA-256 等于 `deploy/sql`；空库迁移全部 applied 且重跑幂等；人为注入缺失/篡改/多余 SQL 文件时 smoke 必红；`deploy/scripts/migrate` 与现有测试无 diff 仍绿。
- **Stop condition**: 出现第二个 authoring path（手改 `dist/sql`）、任何运行时双位置回退读取、或 release 硬门引入外部服务依赖。
- **Rollback surface**: revert 本 slice commits；无数据迁移回滚。

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] build 确定性复制 `deploy/sql` → `dist/sql`（先清后拷）
- [ ] 导出 `migrationsDir()`（含类型与 README 用法）
- [ ] pack-and-smoke 第一层断言：文件名集合 + SHA-256 双向比对 + 隔离安装解析
- [ ] CI 第二层：PG service container，从精确 tarball fresh install → 空库迁移 → 幂等重跑
- [ ] README/docs 更新：host 拥有执行时机，不再 vendor 字节副本
- [ ] salesko 采用 `migrationsDir()` 并删 vendored SQL 的 dogfood 证据落账
