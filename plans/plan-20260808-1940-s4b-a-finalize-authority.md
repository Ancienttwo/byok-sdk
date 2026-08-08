# Plan: Sprint S4B-a: Finalize Authority Contract

> **Status**: Executing
> **Created**: 20260808-1940
> **Slug**: s4b-a-finalize-authority
> **Artifact Level**: work-package
> **Promotion Reason**: ADR-024 已解除 S4B 唯一 hard prerequisite，但 `StorageFinalizeInput` 仍要求 `observedContentHash`，两套 composition 也仍把 reservation 声明值冒充 object-store observation。该 shared contract 跨 `@byok/core`、InMemory、Postgres 与唯一 conformance 断言源，必须先单独收口，后续 reservation-bound presign 与 GC 才不会建立在虚假证据上。
> **Verification Boundary**: compose dataplane hard gate 下运行 `pnpm -r run typecheck`、`pnpm -r run test`、`pnpm -r run build`、`pnpm run check:deploy-sql`、`repo-harness run check-task-workflow --strict`；InMemory 与 Postgres 两个 composition 复用同一 quota conformance；`observedContentHash` 在 `packages/**` 零命中；`deploy/sql/0001_cloud_local.sql`、`0002_core_domain.sql` 与所有 runtime route/schema 零 diff。
> **Rollback Surface**: 回滚本 PR 恢复旧的 finalize type/实现/测试调用形状；无 migration、R2 object、数据库或外部状态需要回滚。
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/r2-hash-authority-decision.md`、`docs/researches/s4a-dataplane-design.md` §3/§6/§11、platform sprint D-9 / S4B
> **Task Contract**: `tasks/contracts/20260808-1940-s4b-a-finalize-authority.contract.md`
> **Task Review**: `tasks/reviews/20260808-1940-s4b-a-finalize-authority.review.md`
> **Implementation Notes**: `tasks/notes/20260808-1940-s4b-a-finalize-authority.notes.md`

## Agentic Routing

- Selected route: parent-agent, bounded code-change
- Routing reason: 变更面只有一个 shared type、两个实现和一个 conformance 断言源；无需 broad research 或并行 delegation。风险来自语义而非代码量，主线程可以完整 trace、实现并验证。
- Due diligence:
  - P1 map: daemon 声明 canonical hash；`QuotaStore` 持 reservation/usage；InMemory 与 `PostgresQuotaStore` 实现同一 port；R2 adapter 的 `HEAD` 只产生 size/type；`runQuotaConformance` 是两套 composition 的单一行为断言源。`0002_core_domain.sql` 已冻结并含 reservation/manifest 四态基础表。
  - P2 trace: daemon 声明 hash/size/type → `reserve()` 保存 declaration → object store PUT → composition `HEAD` 观测 size/type → `finalizeReservation()` 对照 reservation → reservation `reserved → committed`，dedupe/accounting 读取 reservation 的 declared hash。当前压力点是 input 还要求 `observedContentHash`，调用者只能复制 declaration，造成 cloud 验证 digest 的假象。
  - P3 decision rationale: 删除该字段；size/type 仍由 observation 驱动，hash identity/dedupe 只读 reservation declaration。保持四态和 0002 不动，不新增 compatibility overload。10x 时先失败的是后续 ListObjects/GC 扫描与 quota lock contention，不是这个 type cut；本刀只消除错误 authority，不提前设计 GC worker。

## Workflow Inventory

- Active plan: `plans/plan-20260808-1940-s4b-a-finalize-authority.md`
- Sprint contract: `tasks/contracts/20260808-1940-s4b-a-finalize-authority.contract.md`
- Sprint review: `tasks/reviews/20260808-1940-s4b-a-finalize-authority.review.md`
- Implementation notes: `tasks/notes/20260808-1940-s4b-a-finalize-authority.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: contract `allowed_paths`
- Concurrency rule: 本 plan 临时借用 active-plan 槽位；验收归档后切回 `plans/plan-20260805-1659-byok-keys-package.md`。
- Execution isolation: `repo-harness run plan-to-todo --plan plans/plan-20260808-1940-s4b-a-finalize-authority.md` 后，在独立 contract worktree 与 `codex/s4b-a-finalize-authority` 分支执行。

## Approach

### Strategy

1. 修改 `StorageFinalizeInput`：只保留 reservation id、observed byte size 与 observed content type；文档明确 hash 来自 authenticated daemon declaration。
2. InMemory 与 Postgres finalize 删除 hash comparison；dedupe/accounting 改为显式读取 reservation 的 `contentHash`。
3. 同步 quota conformance 的全部 finalize 调用，保留 success、expiry、mismatch、dedupe、downgrade assertions；增加 source audit，保证 `packages/**` 不再出现 `observedContentHash`。
4. platform sprint 将 S4B 拆为可追踪的 S4B-a/b/c，关闭 S4B-a，后续 reservation-bound cloud surface 与 GC/migration 仍留待独立 contract。
5. 运行 compose hard gate、acceptance/PR/CI，归档并归还 K-line active plan。

### Trade-offs

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| 删除 `observedContentHash`，dedupe 读 reservation | 事实诚实；最小 shared-contract cut；无 migration | 不能声称 cloud 验证 digest | **采用**，ADR-024 的直接后果 |
| 保留字段但改名为 declared hash | 调用形状变化小 | 同一事实在 reservation 与 finalize input 出现两源，允许冲突 | 拒绝 |
| 保留 optional deprecated 字段 | 给旧 caller 迁移窗口 | 无已发布 wire migration 要求；制造 steady-state compatibility path | 拒绝 |
| 本刀顺带做 `0003` + GC worker | 一次覆盖更多 S4B | 删除风险与 ListObjects 分页显著扩大验收面 | 拒绝；独立 S4B-c |

## Detailed Design

### File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/core/src/quota.ts` | Edit | 删除 `StorageFinalizeInput.observedContentHash`；修正文档 |
| `packages/core/src/in-memory/quota.ts` | Edit | size/type observation；dedupe/accounting 读取 reservation hash |
| `packages/cloud-postgres/src/stores/core/quota.ts` | Edit | 同步 Postgres finalize guard/comments；SQL dedupe 继续基于 reservation row |
| `packages/conformance/src/core/quota.ts` | Edit | 单一断言源移除虚假 observed hash；两 composition 同步认证 |
| `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` | Edit | 记录 S4B-a 交付边界与后续 b/c，不宣称整个 S4B 完成 |
| workflow artifacts | Create/Edit | contract、review、notes、plan 状态与 evidence |
| `deploy/sql/**` | Do not touch | 0001/0002 immutable；本刀无 0003 |
| `packages/cloud/**`, `packages/protocol/**` | Do not touch | 不新增/修改 route 或 wire DTO |

### Data Flow

`reserve({ contentHash, expectedBytes, contentType })` 保存 daemon declaration → storage `HEAD` 产生 `{ observedByteSize, observedContentType }` → `finalizeReservation()` 只比较可观测 shape → reservation row 自身的 `contentHash` 驱动 tenant-scoped dedupe/accounting → committed。缺失/size/type mismatch 仍释放 reservation 并报 `storage_integrity_mismatch`；digest 不进入 observation。

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| 某 composition 仍偷偷依赖 observed hash | 中 | 高 | 单一 conformance 同时跑 InMemory/Postgres；repo-wide zero-match audit |
| dedupe 改坏导致 usage 重计 | 中 | 高 | 既有 same-hash test 保留，result replay 与 Postgres concurrency suites 全跑 |
| 把 S4B-a 误写成完整 S4B | 中 | 中 | sprint 显式列 b/c 未完成；acceptance 只认本 contract |
| 修改 frozen migration | 低 | 极高 | checksum/zero-diff gate；database-migrations skill 的 immutable migration 规则 |
| 为兼容旧 caller 留 optional 字段 | 低 | 高 | exit audit 零命中；不提供 overload/fallback |

## Task Contracts

- Contract file: `tasks/contracts/20260808-1940-s4b-a-finalize-authority.contract.md`
- Review file: `tasks/reviews/20260808-1940-s4b-a-finalize-authority.review.md`
- Implementation notes file: `tasks/notes/20260808-1940-s4b-a-finalize-authority.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260808-1940-s4b-a-finalize-authority.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: 一个 S4B-a PR；shared type、两实现、单一 conformance 与 sprint projection 不可拆。
- **Rollback surface**: Revert PR；无 migration 或 external state。
- **Verification boundary**: compose hard gate + required checks + frozen migration/wire-surface zero diff + `observedContentHash` zero-match。
- **Review/acceptance boundary**: receipt 必须确认 declared/observed/verified 三者不再混淆，并复核同 hash dedupe 仍按 tenant reservation declaration。
- **High-risk surface**: shared storage integrity contract 与 usage accounting。
- **Why not checklist row**: 一个字段跨四个模块且决定后续 S4B GC 的 evidence semantics。

## Evidence Contract

- **State/progress path**: 下方 Task Breakdown 与 platform sprint S4B/D-9。
- **Verification evidence**: `.ai/harness/checks/latest.json`、contract verification、PR CI、zero-match/zero-diff commands。
- **Evaluator rubric**: finalize input 无 hash observation；两 composition 仍通过相同 quota conformance；dedupe/accounting 读取 reservation hash；migrations/routes 零 diff。
- **Stop condition**: 需要修改 wire route/schema、需要新增 migration、需要 compatibility fallback，或任一 composition 不能用相同 assertions 通过。
- **Rollback surface**: Revert PR。

## Annotations

已核对 ADR-024 与 sprint D-9：本刀删除字段是首个实现提交的硬要求；GC 只冻结 authority input，不在本刀执行对象删除。

## Task Breakdown

- [ ] 建立/批准 contract worktree，切到 `codex/s4b-a-finalize-authority`
- [ ] 删除 `StorageFinalizeInput.observedContentHash`，同步 InMemory/Postgres finalize 与 dedupe/accounting
- [ ] quota conformance 两 composition 全绿；`packages/**` 对 `observedContentHash` 零命中
- [ ] sprint 投影 S4B-a 已交付、b/c 待执行；full hard gate 与 frozen-surface audit 通过
- [ ] acceptance/PR/CI 合入，归档 workflow 并归还 K-line active-plan
