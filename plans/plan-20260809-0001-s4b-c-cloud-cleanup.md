# Plan: Sprint S4B-c: Cloud Cleanup, Retention, and Reconciliation

> **Status**: Approved
> **Created**: 20260809-0001
> **Slug**: s4b-c-cloud-cleanup
> **Artifact Level**: work-package
> **Promotion Reason**: S4B-a/b 已交付 reservation/finalize，但当前没有 retention policy、dead-letter operator surface、R2 DELETE/LIST/reconcile worker 或 GC accounting settlement；这是 hosted durable storage 进入 Beta 的最后一个容量安全缺口。
> **Verification Boundary**: fresh compose + hard dataplane env 下 workspace typecheck/test/build、migration order/catalog invariants、Postgres+MinIO cleanup/crash matrix、strict workflow；`0001`/`0002` 与 frozen protocol corpus 零 diff。
> **Rollback Surface**: migration forward-only additive；回滚 application code 只停 cleanup worker，保留 `0003` 表、tombstone 与对象，不自动恢复或删除数据；usage 可由 committed manifests 重建。
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/s4b-c-cleanup-design.md`、ADR-024、`docs/researches/s4a-dataplane-design.md` §3/§10
> **Task Contract**: `tasks/contracts/20260809-0001-s4b-c-cloud-cleanup.contract.md`
> **Task Review**: `tasks/reviews/20260809-0001-s4b-c-cloud-cleanup.review.md`
> **Implementation Notes**: `tasks/notes/20260809-0001-s4b-c-cloud-cleanup.notes.md`

## Agentic Routing
- Selected route: main-thread migration contract；独立 worktree `codex/s4b-c-cloud-cleanup`
- Routing reason: 跨 Postgres/R2 的删除与计量必须作为一个 reviewable PR；无独立可安全并行的写路径，且 migration、adapter 与 crash matrix 共享同一 invariant。
- Due diligence:
  - P1 map: `@byok/core` 固定 manifest 四态；`@byok/cloud-postgres` 持 Postgres manifest/quota 与 R2 adapter；host scheduler 调用 maintenance service；`deploy/sql` 与 runbook 是 schema/operations authority。范围外是 S5 board/SSE、S6 proof/truth 与任何 runtime HTTP 新端点。
  - P2 trace: host 以 tenant+job id 启动 cleanup → Postgres entitlement 解析 retention policy → 同 statement 退休 mailbox/过期 reservation并结算 mailbox usage → manifest/reference/reservation scan 先标 `delete_pending` → tenant-scoped R2 DELETE → Postgres 单 statement 标 `deleted` 并扣 committed usage；LIST/HEAD reconcile 只观测 key/existence/size/type。
  - P3 decision rationale: Postgres 继续是 transaction/accounting authority；R2 无跨系统 transaction，所以 tombstone 是唯一可重试边界。未追踪 R2 key 先投影为 pending manifest并重新走 grace，不直接删。10x 首个压力是 per-tenant LIST/HEAD 成本，因此 worker 分页、有 cursor、有 batch 上限；不加入 read-back digest 或第二套 hash authority。

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260809-0001-s4b-c-cloud-cleanup.md`
- Sprint contract: `tasks/contracts/20260809-0001-s4b-c-cloud-cleanup.contract.md`
- Sprint review: `tasks/reviews/20260809-0001-s4b-c-cloud-cleanup.review.md`
- Implementation notes: `tasks/notes/20260809-0001-s4b-c-cloud-cleanup.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260809-0001-s4b-c-cloud-cleanup.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260809-0001-s4b-c-cloud-cleanup.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260809-0001-s4b-c-cloud-cleanup.md`.

## Approach
### Strategy
新增一个 Postgres-specific maintenance composition，而不扩大 `CoreStores` 的七 port inventory。`0003` 只增加 retention/job/cursor 表及 GC accounting metadata；现有 manifest 四态不变。R2 adapter 增加窄的 maintenance surface（LIST/HEAD/DELETE），数据面 CloudBlobStore surface 不变。所有操作由 host scheduler 显式调用，SDK 不自建常驻 scheduler。

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| 直接删 ref_count=0 的 R2 bytes | 少一阶段 | crash 后 usage/manifest 漂移；并发 reference 风险 | 拒绝 |
| R2 LIST 后无 manifest key 立即删除 | 回收快 | PUT/finalize 窗口与扫描竞态会吃掉合法 bytes | 拒绝；先建 pending witness，再等 grace |
| 扩大 core `ObjectStore`/`MailboxStore` | composition-neutral | 强迫 InMemory 与所有未来 adapter 承担 hosted operator 语义 | 拒绝；maintenance 属 Postgres+R2 composition |
| `aws4fetch` + 窄 XML parser | 保留现有签名/故障注入，依赖增量小 | 需显式验证分页/XML shape | 采用 |
| 完整 read-back 重算 SHA-256 | 可发现同 shape 字节替换 | 双倍带宽/CPU，违反 ADR-024 | 拒绝 |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `deploy/sql/0003_cloud_cleanup.sql` | Add | tenant retention policy、cleanup job、GC cursor、tombstone accounting metadata/index；纯 additive DDL |
| `tests/sql/control_plane_invariants.sql` | Edit | 声明 0003 并提高 fresh-schema table floor |
| `packages/cloud-postgres/src/stores/r2-blobs.ts` | Edit | tenant-scoped LIST/HEAD/DELETE maintenance surface，bounded retry，fail-closed XML paging |
| `packages/cloud-postgres/src/cleanup.ts` | Add | retention/dead-letter operator、tombstone/delete/reconcile、job/cursor/metrics authority |
| `packages/cloud-postgres/src/index.ts` | Edit | 导出 maintenance factory/types |
| `packages/cloud-postgres/src/stores/core/objects.ts` | Edit | tombstone 时记录待扣减 accounted bytes；只允许 pending upload grant |
| `packages/cloud-postgres/src/__tests__/cleanup.test.ts` | Add | hard-limit/non-destructive、dead-letter、orphan grace、crash/reconcile matrix |
| `packages/cloud-postgres/src/__tests__/r2-blobs.test.ts` | Edit | LIST XML/paging、DELETE idempotency、invalid XML refusal |
| `deploy/runbooks/cloud-cleanup.md` | Add | scheduler、metrics、alerts、rollback/rebuild、operator replay/runbook |
| `deploy/runbooks/mailbox-retention.md` | Edit | dead-letter list/replay surface 与 accounting atomicity |
| architecture/sprint/task artifacts | Edit | S4B-c delivery projection、验收勾选与证据 |

### Code Snippets
不复制实现；权威代码位于上述 source 与 migration。

### Data Flow
`runTenant(jobId)` → tenant advisory lock → load entitlement/policy → mailbox/reservation retention transaction → mark eligible manifest tombstones → R2 DELETE (404=already deleted) → manifest+usage atomic settlement → manifest HEAD scan + R2 ListObjectsV2 scan → drift metrics/job row + persisted cursor。delete 后 DB crash 的重跑通过 `delete_pending + R2 404` 完成 settlement；DB tombstone 后 delete crash 通过同一 DELETE 重试。

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| 删除仍被 reference/reservation 使用的对象 | 低 | 极高 | manifest row lock + state/ref/reference/reservation guards + grace + concurrency test |
| R2 delete 成功但 DB 未结算 | 中 | 高 | `delete_pending` 保留；404 视为幂等成功，下一次单 statement 结算 |
| 未追踪 key 与正在 finalize 的 PUT 竞态 | 中 | 极高 | create 前已有 pending manifest；真正无 manifest key 只建 witness，不直接删 |
| usage 重复扣减/变负 | 低 | 极高 | tombstone 记录 accounted bytes；`delete_pending → deleted` 唯一成功 UPDATE 驱动一次扣减并 clamp/assert |
| XML/continuation 解析漂移 | 中 | 高 | 专用 parser、truncated 必须有 token、fixture + MinIO 实测、无 heuristic fallback |
| cleanup 无界占用 DB/R2 | 中 | 中 | per-tenant lock、batch/page limit、cursor、job metrics |

## Task Contracts
- Contract file: `tasks/contracts/20260809-0001-s4b-c-cloud-cleanup.contract.md`
- Review file: `tasks/reviews/20260809-0001-s4b-c-cloud-cleanup.review.md`
- Implementation notes file: `tasks/notes/20260809-0001-s4b-c-cloud-cleanup.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260809-0001-s4b-c-cloud-cleanup.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: 一个 S4B-c PR；migration、maintenance adapter、worker、crash matrix、metrics/runbook不可拆，否则会留下可删不可结算或可迁移不可运行的中间态。
- **Rollback surface**: revert application commit stops worker；migration remains additive；不做 down/delete。
- **Verification boundary**: real Postgres+MinIO hard gate、shared existing conformance、catalog/order、full workspace commands。
- **Review/acceptance boundary**: 独立 Claude semantic receipt 或用户 waiver；删除与 accounting 必须逐 crash point review。
- **High-risk surface**: cross-system delete、usage decrement、tenant key/list isolation、dead-letter replay。
- **Why not checklist row**: 新 migration + exported maintenance API + external byte deletion，必须有 contract/rollback/evidence authority。

## Evidence Contract

- **State/progress path**: plan task breakdown、contract、notes、review、sprint S4B backlog row。
- **Verification evidence**: `.ai/harness/checks/latest.json`、hard-env Vitest output、migration/catalog checks、git zero-diff audit。
- **Evaluator rubric**: no durable user-data capacity eviction；grace+tombstone before DELETE；R2 absence replay-safe；usage settles once；untracked keys wait grace；dead-letter visible/replayable；no hash verification claim。
- **Stop condition**: any path requires manifest fifth state/checksum fallback, migration edit to 0001/0002, or cannot make delete/accounting crash-idempotent。
- **Rollback surface**: stop host scheduler/revert code；tables/tombstones retained；run reconciler before re-enable。

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] 建立独立 worktree/branch、完成 P1/P2/P3 与 migration contract
- [x] 新增 additive `0003` 与 catalog/order invariants
- [x] 落 R2 maintenance LIST/HEAD/DELETE 与分页/失败测试
- [x] 落 retention/dead-letter/tombstone/delete/reconcile/job/cursor/metrics service
- [x] 跑 hard-limit/non-destructive 与全 crash matrix
- [x] 更新 runbook、architecture、sprint、notes/review
- [x] fresh compose hard-env 全仓验证与 strict harness
- [ ] commit、push、独立 acceptance、PR、CI、merge/readback
