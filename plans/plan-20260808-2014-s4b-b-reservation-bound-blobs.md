# Plan: Sprint S4B-b: Reservation-bound Blob Surface

> **Status**: Executing
> **Created**: 20260808-2014
> **Slug**: s4b-b-reservation-bound-blobs
> **Artifact Level**: work-package
> **Promotion Reason**: S4B-a 已消除虚假 hash observation，但当前 hosted blob path 仍绕过 `QuotaStore`：`POST /byok/blobs` 直接建 manifest/签 PUT，`GET .../url` 隐式 `HEAD`+commit，daemon 上传后没有 finalize。该缺口跨 frozen HTTP surface、cloud tenant facade、core quota/object transaction authority、两套 blob composition 与 daemon client，必须作为一个可回滚 contract 收口。
> **Verification Boundary**: compose hard env 下 `pnpm -r run typecheck/test/build`、`pnpm run check:deploy-sql`、workflow strict；InMemory/Postgres 共用 core + cloud conformance 零 composition 分支；HTTP route/client/self-hosted tests 覆盖 create→PUT→finalize→GET、quota refusal、reservation/resource collision、missing/shape mismatch、response-lost replay；`deploy/sql/**`、现有 protocol body schemas/golden 与 object 四态零 diff。
> **Rollback Surface**: Revert 本 PR 恢复 lazy download finalize 与非 quota-bound upload；无 migration、R2 delete、GC 或外部 schema 需要回滚。测试 R2/MinIO 对象只存在于 compose 临时 substrate。
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/r2-hash-authority-decision.md`、`docs/researches/s4a-dataplane-design.md` §3/§6/§11、platform sprint D-9 / S4B.4
> **Task Contract**: `tasks/contracts/20260808-2014-s4b-b-reservation-bound-blobs.contract.md`
> **Task Review**: `tasks/reviews/20260808-2014-s4b-b-reservation-bound-blobs.review.md`
> **Implementation Notes**: `tasks/notes/20260808-2014-s4b-b-reservation-bound-blobs.notes.md`

## Agentic Routing
- Selected route: parent-agent, bounded shared-contract change
- Routing reason: 该刀需要一个 end-to-end transaction/HTTP trace，但实现顺序强耦合，无法安全拆成并行写入面；不需要 broad external research。
- Due diligence:
  - P1 map: `BlobClient` 是 daemon 入口；protocol `CreateBlob*` body 已 frozen；`@byok/cloud` handler/tenant facade 编排 bearer-auth route；`CloudBlobStore` 铸造/观测 capability；`QuotaStore` 与 `ObjectStore` 是 core authority；InMemory 与 Postgres+R2 必须跑同一 conformance；`0002_core_domain.sql` 已冻结。
  - P2 trace: daemon 计算 hash + idempotency key → bearer `POST /byok/blobs` → quota reserve → manifest pending + reservation-bound PUT → bytes upload → bearer `POST /byok/blobs/:id/finalize` → blob observation (exists/size/type) → Postgres 单 transaction/statement 同时 commit manifest、reservation 与 usage → committed-only GET。当前压力点是 reserve/finalize 两步完全缺失，且 GET 暗中替 daemon finalize。
  - P3 decision rationale: 以 `Idempotency-Key` 作 reservation/request id，不改 frozen request/response body；`CloudBlobStore.createUpload` 只接受已建立的 object reservation，并新增 observation method；`QuotaStore.readReservation` 让 finalize 把 bearer request id 与 blob resource 显式绑定；Postgres finalize 在同一 data-modifying CTE 内提交 manifest/accounting，InMemory 共享同一 `ObjectStore`。不保留 lazy finalize 或 optional compatibility path。10x 首个压力仍是 tenant entitlement-row contention；这是无超卖所需 serialization point，后续可分片但不能移出 transaction。

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260808-2014-s4b-b-reservation-bound-blobs.md`
- Sprint contract: `tasks/contracts/20260808-2014-s4b-b-reservation-bound-blobs.contract.md`
- Sprint review: `tasks/reviews/20260808-2014-s4b-b-reservation-bound-blobs.review.md`
- Implementation notes: `tasks/notes/20260808-2014-s4b-b-reservation-bound-blobs.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260808-2014-s4b-b-reservation-bound-blobs.contract.md` `allowed_paths`
- Concurrency rule: 本 plan 临时借用 active-plan 槽位；验收归档后切回 `plans/plan-20260805-1659-byok-keys-package.md`。
- Execution isolation: `repo-harness run plan-to-todo --plan plans/plan-20260808-2014-s4b-b-reservation-bound-blobs.md` 后，在独立 contract worktree 与 `codex/s4b-b-reservation-bound-blobs` 分支执行。

## Approach
### Strategy

1. 强化 core lifecycle：quota reservation 可按 id 读取；成功 finalize 必须同时 commit 对应 manifest；reservation-id collision fail-closed。
2. 强化 cloud port/facade：grant 只从 `reserved` object reservation 铸造；blob observation 显式返回存在性/size/type，不再由 download route 隐式 commit。
3. `POST /byok/blobs` 要求 `Idempotency-Key` 并 reserve 后签发；新增 device-auth `POST /byok/blobs/:id/finalize`，以同 key 读取 reservation、验证 resource binding、观测对象并完成原子 finalize。
4. `BlobClient` 在 PUT 后调用 finalize；self-hosted server 实现相同 route（local PUT 已原子验证/提交，finalize 只确认存在性）；不改 frozen body schemas。
5. 共用 conformance 与 HTTP/client crash/replay tests 固化语义，compose hard gate 后 acceptance/PR/CI 合入并归档。

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| `Idempotency-Key` 作为 reservation id | 不改 frozen body；客户端可在 response-lost 时重放同一请求 | header 成为 load-bearing contract | **采用**，route/tests/docs 全钉住 |
| 以 content hash 兼作 reservation id | 无新 header | expired/aborted 后同 hash 永久不能重传；并发请求无法独立结算 | 拒绝 |
| 继续由首次 GET lazy finalize | 旧 client 不变 | 上传是否计费取决于下载；crash/accounting 漂移不可判定 | 拒绝 |
| quota 与 manifest 分两条 Postgres transaction | 实现较少 | 任一 crash 产生 committed-but-unaccounted 或 accounted-but-pending | 拒绝；同一 CTE 原子提交 |
| 本刀同时落 `0003`/GC | 一次覆盖 orphan 清理 | 删除安全、ListObjects 分页与 tombstone crash matrix 扩大风险面 | 拒绝；留 S4B-c |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/core/src/quota.ts`, `stores.ts` | Edit | 增加 reservation read/port inventory；声明 finalize 同步 manifest authority |
| `packages/core/src/in-memory/{quota,index}.ts` | Edit | quota 与 object store 共享实例；collision guard 与 manifest+usage finalize |
| `packages/cloud/src/{stores/ports,tenant-stores,handlers/blobs,cloud}.ts` | Edit | reservation-bound grant/observe port；create/finalize routes 与 stable error mapping |
| `packages/cloud/src/stores/in-memory/**` | Edit | grant 保存 reservation binding；explicit observation；committed-only download |
| `packages/cloud-postgres/src/stores/{r2-blobs,core/quota,index}.ts` | Edit | HEAD observation 与 atomic manifest/reservation/usage CTE；移除 lazy GET commit |
| `packages/conformance/src/{core/quota,cloud/blobs,cloud/harness,compositions/**}.ts` | Edit | 两 composition 同一 lifecycle assertions，无分支 |
| `packages/client/src/daemon/blob-client.ts` | Edit | 生成/reuse idempotency key，PUT 后显式 finalize |
| `packages/server/src/http.ts` | Edit | self-hosted 同 route；local byte store 已提交时幂等 204 |
| HTTP/client/server/object suites | Edit | quota、binding、missing/mismatch、两 crash replay 矩阵 |
| `docs/protocol.md`, architecture/sprint projection | Edit | 记录 header/finalize surface 与 S4B-b 交付，不改 frozen body schema |
| `deploy/sql/**`, protocol golden/body schemas | Do not touch | `0001/0002` immutable；本刀无 wire body 或 migration 变更 |

### Data Flow

`BlobClient(requestId)` → authenticated declaration → `quota.reserve` → `blobs.createUpload(reservation)` → signed PUT bound to tenant/resource/reservation → PUT bytes → authenticated finalize with same requestId → `quota.readReservation` + `blobs.observeUpload` → atomic manifest/reservation/usage commit → 204 replay-safe → committed-only download.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| request id 与 blob resource 可错配 | 中 | 极高 | finalize 先读 reservation，adapter 验证 tenant/hash/blob binding；跨绑定 regression test |
| manifest 与 usage crash 漂移 | 中 | 极高 | Postgres 单 CTE/transaction；response-lost replay 断言同一结果 |
| grant 先发后 reserve | 低 | 极高 | handler 固定 reserve→grant；grant 输入类型必须是 reserved reservation |
| 旧 lazy finalize 残留 | 中 | 高 | pending GET 明确 404；source/conformance audit |
| frozen wire 被无意改动 | 低 | 高 | protocol golden 零 diff；新增 header + empty-body route only |
| migration 漂移 | 低 | 极高 | deploy/sql zero-diff + checksum/order gate |

## Task Contracts
- Contract file: `tasks/contracts/20260808-2014-s4b-b-reservation-bound-blobs.contract.md`
- Review file: `tasks/reviews/20260808-2014-s4b-b-reservation-bound-blobs.review.md`
- Implementation notes file: `tasks/notes/20260808-2014-s4b-b-reservation-bound-blobs.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260808-2014-s4b-b-reservation-bound-blobs.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: 一个 S4B-b PR；client、HTTP route、port、两 composition、atomic finalize 与共用 conformance 不可拆。
- **Rollback surface**: Revert PR；无 migration/object delete/external state。
- **Verification boundary**: compose hard gate + required checks + protocol/deploy SQL zero diff + lifecycle/crash matrix。
- **Review/acceptance boundary**: receipt 必须确认 reserve precedes grant、resource/reservation binding、atomic manifest/accounting、pending not downloadable、replay idempotency。
- **High-risk surface**: shared device HTTP contract、quota billing、Postgres/R2 cross-system consistency。
- **Why not checklist row**: 一个 route path 跨 daemon、frozen HTTP、tenant auth、两个 storage authorities 与两 composition。

## Evidence Contract

- **State/progress path**: 下方 Task Breakdown 与 platform sprint S4B.4。
- **Verification evidence**: `.ai/harness/checks/latest.json`、contract verification、PR CI、protocol/deploy zero-diff commands。
- **Evaluator rubric**: 无 reservation 不签 PUT；finalize resource/key 绑定；missing/mismatch 释放 reservation；manifest+usage 同 transaction；pending 不下载；两 composition 同断言。
- **Stop condition**: 需要新增 migration/manifest state、改 frozen body schema、加入 compatibility fallback，或两 composition 无法跑同一 assertions。
- **Rollback surface**: Revert PR。

## Annotations

[NOTE]: `api-design` skill 约束本刀使用明确的 device-auth action route、正确 4xx/5xx status 与既有 `{error}` envelope；不引入第二套 API version 或 body envelope。

## Task Breakdown
- [ ] 建立/批准 contract worktree，切到 `codex/s4b-b-reservation-bound-blobs`
- [ ] core reservation read/collision 与 atomic manifest/accounting finalize 两 composition 全绿
- [ ] cloud reservation-bound grant/observe + create/finalize route，pending download fail-closed
- [ ] BlobClient/self-hosted surface 与 crash/idempotency/binding tests 全绿
- [ ] sprint/docs 投影、compose hard gate、protocol/migration frozen audit 通过
- [ ] acceptance/PR/CI 合入，归档 workflow 并归还 K-line active-plan
