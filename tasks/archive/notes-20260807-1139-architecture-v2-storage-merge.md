> **Archived**: 2026-08-07 11:39
> **Related Plan**: plans/archive/plan-20260807-1058-architecture-v2-storage-merge.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260807-1139

# Implementation Notes: architecture-v2-storage-merge

> **Status**: Active
> **Plan**: plans/plan-20260807-1058-architecture-v2-storage-merge.md
> **Contract**: tasks/contracts/20260807-1058-architecture-v2-storage-merge.contract.md
> **Review**: tasks/reviews/20260807-1058-architecture-v2-storage-merge.review.md
> **Last Updated**: 2026-08-07 10:59
> **Lifecycle**: notes

## Design Decisions

权威 rubric 是两份 bundle diff，不是 bundle 文件本身：

```bash
diff -u _ref/byok-architecture-rewrite/docs/architecture/sdk-architecture.md \
        _ref/byok-architecture-rewrite-v2/docs/architecture/sdk-architecture.md
diff -u _ref/byok-architecture-rewrite/plans/sprints/20260807-byok-platform-raft-aligned.sprint.md \
        _ref/byok-architecture-rewrite-v2/plans/sprints/20260807-byok-platform-raft-aligned.sprint.md
```

repo 段落编号与 bundle 不同，对映靠内容不靠编号。

### B1 `docs/architecture/sdk-architecture.md`

所有改动落在 §11.2 及之后（`git diff -U0` 的首个 hunk 是 `@@ -902,0 +903,2 @@`），§0–§11.1 的 current-state 骨架逐字节未动。

| 段落 | 改动 |
| --- | --- |
| §11.2 目标平台缺口 | 新增 GAP-015（SQLite journal + 水位 + 安全 cleanup）、GAP-016（Postgres + R2 quota/GC） |
| §12.1 目标 package graph | Node composition 改 `Postgres + R2（主生产）`；Workers 节点改 `可选 D1 compatibility adapter` 且边改虚线；graph 后补一句主生产组合裁定 |
| §12.2 目标模块表 | 新增 core `quota.ts`、cloud storage handlers、cloud cleanup workers 三行；store ports 行补 Quota/StorageUsage；compositions 行改 Postgres + R2 主生产 + optional D1 |
| §12.4 Cloud data categories | Object 节点改 R2 tenant-scoped；新增 Quota 节点与两条边；补一段 quota/control 是第五类数据、无跨系统 transaction 的说明 |
| §12.6.6 Composition contracts | 四 composition 改三 composition + optional D1；新增 `committed + reserved <= entitlement` 一条 |
| §12.7 段首 | 新增主生产组合定案段（Postgres 权威、R2 只存 bytes、Node 与 R2 可跨供应商、D1 可选） |
| §12.7.1 | 四类 → 五类，新增 quota/control 行；存储列 SQL → Postgres / Postgres + R2；本地连续态改 SQLite + 文件系统 |
| §12.7.2 | 全部改写为 SQLite canonical：`SqliteLocalTaskJournal`、8 张表、PRAGMA 与同 transaction 前置、不得静默降级、SQLite 只存 metadata |
| §12.7.2.1（新增） | `LocalStoragePolicy` 四档水位表、五步清理顺序、永不自动删除清单 |
| §12.7.4 | 改写为 Postgres + R2 object storage：tenant-scoped key、`object_manifest.state = committed`、reservation-bound presign、无跨系统 transaction |
| §12.7.5 | Retention 表新增「自动删除条件」列，新增 pairing/auth nonce、R2 orphan、board/truth 用户数据三行 |
| §12.7.6（新增） | entitlement/usage 的 TS 契约、计量边界、Postgres 新增表清单 |
| §12.7.7（新增） | reservation/finalize 七步流程、admission 预留、5 个稳定错误码表 |
| §12.7.8（新增） | 满额行为表、自动 cleanup 白名单、R2 tombstone/reconcile 五步 |
| §12.7.9（新增） | 储存控制面端点表（usage/entitlement/reservation 三态 + presign） |
| §12.8 | P2 行、S3/S4 crosswalk 行、mermaid 节点标签、排序原则一条 |
| §14.2 10x 表 | 新增「本机磁盘增长」「tenant storage 增长」两行，均带**目标设计**标记 |
| §14.4 不变量 | 新增 11–14，并加一句说明这四条是目标设计不变量 |
| §15.2 必备指标 | 新增本机 store/WAL/compaction、tenant committed/reserved/limit、reservation 结果、R2 orphan/drift 四条 |
| 附录 A ADR | 新增 ADR-019~022 |

### B2 `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md`

| 段落 | 改动 |
| --- | --- |
| Crosswalk S4A/S4B 行 | 改为 Postgres + R2 composition；S4A 数据面 / S4B quota+GC |
| 「对已决事项的显式改动」 | 「两处」改「三处」；新增 **D-3**（主生产组合裁定为 Postgres + R2，D1 降 optional）。原 D-1/D-2 与原 backend 选型记录原样保留 |
| §0 计划目标第 6 条 | SQL/object storage → Postgres + R2、entitlement/usage/reservation、quota 与 cleanup |
| §1.1 Workstreams O 轨 | 责任列补 R2 composition 与 quota/GC |
| §1.2 critical path | S4A/S4B 节点改名；S4B 段落改为「不阻塞 S5 实现，但是 Beta 闸硬依赖」 |
| §4 里程碑表 | S3 加 SQLite；S4A/S4B 结果与 release signal 重写 |
| S2.1 | 插入 `C-008 StorageEntitlement/Usage/Reservation/Retention`，原 C-008~C-010 顺移为 C-009~C-011 |
| S2.2 / S2.3 / S2.4 | 各加 quota 约束测试两条、`quota.ts`、acceptance 一条 |
| S3 全节 | 标题、目标、风险等级、可并行；S3.1 L-001/L-002 改述 + 新增 L-003；S3.2 时序图；S3.3 契约加 4 个方法并重写 properties；S3.4 加 6 个 disk-pressure 注入点；S3.5 加 5 条 acceptance；S3.6 rollback |
| S4A 全节 | 重切为 Postgres + R2 数据面：目标/已裁定行、O-001~O-006、schema 只留 domain、conformance 表列名、object tests、acceptance、rollback |
| S4B 全节 | 重切为 quota/reservation/GC：O-007~O-012、storage schema、entitlement 契约、reservation/object 测试、cleanup 与满额行为、acceptance、rollback，并新增 **S4B.8** 记录 D1 降为 optional post-Beta adapter |
| S5 依赖行 | SQL semantics → Postgres semantics |
| S7.1 / S7.4 | L-003~L-006 顺移 L-004~L-007，O-010~O-013 顺移 O-013~O-016；RC 闸「含 S4B parity」改为 shipped compositions |
| §5 安全矩阵 | 新增 storage quota / deletion safety 行 |
| §6 测试矩阵 | 新增本机 SQLite cleanup 行、R2 object contract 行、quota/GC 行；后端 parity 两行删除 |
| §7 风险表 | R-008/R-009 整行替换；R-018 改述；新增 R-022/R-023（v2 的 R-021/R-022 因 repo 已占用 R-021 而顺移） |
| §8 决策 deadline | primary backend 行改为已裁定；新增 quota accounting unit、downgrade policy、local watermarks 三行 |
| §9 slugs | `s4a-primary-store-composition`/`s4b-second-backend-parity` → `s4a-postgres-r2-data-plane`/`s4b-storage-quota-cleanup` |
| §12 release gates | Alpha/Beta/RC 三节按 v2 改写 |
| §13 最终成功标准 | 新增 21/22 |

### B3 `docs/researches/gpt-pro-architecture-rewrite-decision.md`

文末追加「v2 supersede 記錄」一节，沿用原文繁体行文：bundle 路径与 ZIP SHA-256、delta 主题一段、四条裁定、本 slice 的 plan/contract/notes 路径。

## Deviations From Plan Or Spec

### 跳过或适配的 charter hunk

| bundle hunk | 处理 | 理由 |
| --- | --- | --- |
| `@@ -23,7` `@byok/cloud` 一句话职责 | **适配**：落到 §12.1 graph + §12.2 compositions 行 | repo 的对应句在 §0「阅读约定与结论」，属 current-state framing 区块；同一事实的目标设计权威表述在 §12，不动 §0 |
| `@@ -37,6` 顶部不变量表新增 3 行（本地持久化/云端储存/超限行为） | **适配**：落到 §14.4 不变量 11–14 与 §12.7 正文 | repo 没有 bundle 那张顶部不变量表；repo 的不变量权威面是 §14.4 编号清单 |
| `@@ -64,7` 「不宣称为当前实现」清单的 adapter 行 | **跳过**，内容由 §12.1 节点标签承载 | repo 无该清单；repo 用 §0 状态标记 + §12 标题「尚未实现」表达同一约束 |
| `@@ -615,10` composition mermaid 重画 | **适配**：拆进 §12.1 graph 标签 + §12.4 Quota 节点 + §12.7 段首定案段 | repo 无 TenantFacade→stores 那张图；硬塞会与 §12.1/§12.4 形成第二套 composition 真相 |
| `@@ -1308,22` §14.2 Hosted Node 部署拓扑图（Postgres/S3 → Postgres + R2） | **适配**：新增的散文并入 §12.7 段首 | repo 在 v1 併入时就未收录部署拓扑节（bundle §14.2/§14.3），repo §14.2 是「10x 时先失败的地方」，不是同一段落 |
| `@@ -1486,7` 「10x 前必须量化」清单两条 | **适配**：落到 §14.2 新增的两行 | repo 无该清单；§14.2 表是 repo 侧的 10x 压力权威面 |

### 跳过或适配的 sprint hunk

| bundle hunk | 处理 | 理由 |
| --- | --- | --- |
| S2 建议容量 36→40、S3 42→49、S4 44→55 point 数 | **跳过** | repo 头部第 12 行明确「本文件不含工期、人力或 story point 估算」，且 `docs/researches/gpt-pro-architecture-rewrite-decision.md:48` 把「刪 story points 與人力假設」记为已决事项。v2 的 55 points 规模改以 story 分配到 S4A/S4B 表达 |
| S4 story 表整表（O-001~O-010 带 points） | **适配**：按语义拆到 S4A（O-001~O-006）与 S4B（O-007~O-012），保留 repo 的「相对复杂度」列 | v2 自身建议「两人团队拆 S4A 数据面 / S4B quota+GC」，与 repo 已有的 S4A/S4B 结构同构；points 列按上一行的裁决不加回 |
| S3 的 `L-003`、S4 的 `O-010` | **适配**：S7 的 L-003~L-006 顺移 L-004~L-007，O-010~O-013 顺移 O-013~O-016 | v2 bundle 自身有 ID 撞名（S3 的 L-003 与 S7 的 L-003、S4 的 O-010 与 S7 的 O-010）。repo 不继承坏 ID 空间；已确认这些 ID 在 repo 其它文件零引用 |
| 风险表 R-021/R-022 | **适配**：编号顺移为 R-022/R-023 | repo 的 R-021 已被 D-2 的 I3/I4/I6 延后风险占用（v1 併入时的 repo 侧增项） |
| S4 决策闸行「已裁定」 | **适配**：原 §8 决策行与原 S4B parity 记录保留，改动以 D-3 追记 | 任务约束：与 v2 冲突的已决事项补一条更新记录，不删原记录 |

无跳过是因为「断言 current runtime 事实而本地源码无法验证」——v2 delta 逐 hunk 筛查后全部为目标设计增量，无新的 current-runtime 宣称。

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| S4B 保留「第二后端 parity」并另开 S4C 做 quota | 否 | v2 把 parity 明确降为 optional post-Beta；再开一个 sprint 会让 Beta 闸依赖一个已被降级的目标 |
| 直接删除原 backend 选型决策行与 R-018 | 否，改为 D-3 追记 + R-018 改述 | 「对已决事项的显式改动」段的既定体例是追记而非静默重排 |
| 把 v2 的 points 一并带回 sprint | 否 | 与 repo 头部声明和已归档 slice 的裁决直接冲突 |
| 在 canonical 新增 bundle 的 composition mermaid | 否，拆进已有三处 | 会形成第二套 composition 真相，违反单一事实源 |

## Open Questions

- `_ref/byok-architecture-rewrite-v2/` 只有解包目录，仓库内没有对应 ZIP，SHA-256 `5ee566...48d95` 是派发方给出的值，本 slice 未能就地复算。

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
