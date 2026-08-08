# Implementation Notes: s4b-c-cloud-cleanup

> **Status**: Active
> **Plan**: plans/plan-20260809-0001-s4b-c-cloud-cleanup.md
> **Contract**: tasks/contracts/20260809-0001-s4b-c-cloud-cleanup.contract.md
> **Review**: tasks/reviews/20260809-0001-s4b-c-cloud-cleanup.review.md
> **Last Updated**: 2026-08-09 00:05

## Design Decisions

- Postgres is manifest/accounting/job authority；R2 exposes only tenant-scoped LIST/HEAD/DELETE maintenance operations。
- Existing four manifest states remain unchanged；tombstone records how many committed bytes are eligible for one-time decrement。
- Untracked valid R2 key becomes a pending manifest witness and waits the configured orphan grace；invalid keys are drift only and never heuristically deleted。
- Host owns scheduling；service uses per-tenant advisory serialization, bounded batches and persisted cursors。
- ADR-024 remains binding：HEAD checks only existence/size/type；no digest read-back/checksum fallback。
- `R2ObjectMaintenanceStore` 与 device-facing `R2CloudBlobStore` 分离，避免给 conformance 的 exact blob port inventory 偷加 LIST/HEAD/DELETE capability。
- `gc_accounted_bytes` + `gc_accounted_object` 在 tombstone 时冻结一次 accounting fact；zero-byte committed object 仍只扣一次 object count，pending witness 扣 0。
- request receipt retention 是显式 policy duration；nonce/pairing/presence/activity 使用自身 expiry。无 policy 时 job 失败，不用隐藏默认。

## Deviations From Plan Or Spec

- 最初把 maintenance methods 加在 `R2CloudBlobStore`，existing exact port-inventory gate 立即拒绝 extra methods；改为独立 host-only adapter，保留 device capability honesty。
- 为覆盖 O-009 的 TTL jobs，retention policy 在最初 migration 草案上增加 request-receipt duration；同一未发布 `0003` 内完成，未改 0001/0002、无 data backfill。
- 使用量 rebuild 从单 statement 改为先锁 `storage_usage` 的 transaction，避免与 concurrent finalize 在 statement snapshot 上竞态；runbook 仍要求先停 admission并跑 reconcile。

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Compose: `docker compose -f docker-compose.test.yml up -d --wait`，Postgres/MinIO healthy。
- Hard dataplane package: cloud-postgres 10 files / 176 tests passed；cleanup/object/constraints focused matrix 42 tests passed。
- Full workspace: core 112、keys 330、protocol 189、cloud 91、server 217、client 935、conformance 111、cloud-postgres 176，全部 passed。
- Fresh commands: hard-env `pnpm -r run typecheck`、`test`、`build` passed；`pnpm run check:deploy-sql` 与 `repo-harness run check-task-workflow --strict` passed。
- Migration boundary: `0001`/`0002` 未改；`0003` 被 catalog invariant 声明，fresh schema 21 tenant-owned tables；无 `hash_verified`/checksum/read-back path。

## Promotion Candidates

- None yet.
