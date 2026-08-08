# Implementation Notes: s4b-b-reservation-bound-blobs

> **Status**: Active
> **Plan**: plans/plan-20260808-2014-s4b-b-reservation-bound-blobs.md
> **Contract**: tasks/contracts/20260808-2014-s4b-b-reservation-bound-blobs.contract.md
> **Review**: tasks/reviews/20260808-2014-s4b-b-reservation-bound-blobs.review.md
> **Last Updated**: 2026-08-08 21:14
> **Lifecycle**: notes

## Design Decisions

- `Idempotency-Key` 是 frozen body 之外唯一 reservation/request id；create/finalize 必须复用同一值，collision fail-closed。
- `CloudBlobStore` 只从 `reserved` object reservation 铸造 PUT，并以 `observeUpload` 返回存在性/size/type；download route 只读 committed manifest。
- Postgres finalize 使用一个 data-modifying CTE 同步 `object_manifest`、`storage_reservation`、`storage_usage`；对象缺失/shape mismatch 在同一 statement abort reservation。
- InMemory quota 与 blob store 共享一个 `ObjectStore`，从而让同一 conformance 的 manifest/accounting 断言可执行。
- daemon finalize 对 network/5xx 只重试一次并复用 request id；下载端在返回 instruction 前自行复核 SHA-256 与 byte size。
- Postgres object dedupe 以 `pending → committed` 的唯一成功 UPDATE 为 authority；不能从 statement-start snapshot 的 manifest state 推断，否则同 hash 并发 finalizer 会重复计量。
- quota admission 在 tenant entitlement lock 内先回收已过期 reservation；这让 daemon 在 grant 后消失也不会永久占用 hard limit，且无需等待 S4B-c 的对象 GC scheduler。

## Deviations From Plan Or Spec

- plan 原设想仅在 cloud adapter/HTTP tests 中覆盖 lifecycle；实现时发现下载端会直接信任 bytes，按 ADR-024 downstream constraint 同刀补了 client-side SHA-256/size verification。
- self-hosted 没有 hosted quota authority；它实现相同 header/finalize surface，以 `tenant + reservation` 推导稳定 blob id。SQLite BlobStore 因而可跨 restart 重放 create/finalize，LocalDisk 仍保持其既有的单进程参考边界。
- 收口复审时补出一个 SQL 并发缺陷：多个同 hash reservation 可同时读到 pending manifest。现改为仅一个 finalizer 能更新 pending row，其余由零行 UPDATE 判为 deduplicated，并以真实 row-lock race test 固化。
- 独立 Claude acceptance 首轮抓出 abandoned reservation 泄漏、无消费者的 R2 query metadata、self-hosted Map 的无界/重启失忆与 entitlement 错误面遗漏；全部落成产品修复或 canonical docs 纠正后再送复审。

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| 改 frozen `CreateBlobRequest` body | 拒绝 | optional/required 新字段都会制造 v1 wire drift；header 已有标准 idempotency 语义 |
| GET lazy finalize | 拒绝 | 上传计量不能取决于是否被下载 |
| quota/manifest 两 transaction | 拒绝 | crash 会产生 committed-but-unaccounted 或 accounted-but-pending |
| checksum/read-back fallback | 拒绝 | ADR-024 已裁定；R2 单次 PUT 无 SHA-256 FULL_OBJECT，read-back 成本翻倍 |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Hard dataplane test: 9 files / 167 tests passed against Postgres + MinIO；其中 same-hash finalizer race 先锁住 pending manifest，确认四个 statement 同时阻塞后再释放，只允许一次计量。
- Full hard-env workspace test: core 112、keys 328、protocol 189、cloud 91、server 217、client 935、conformance 111、cloud-postgres 167，全部通过。
- Frozen audit: `deploy/sql/**` 与 `packages/protocol/src/**` 相对 `main` 零 diff；body schemas/golden 未改。

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
