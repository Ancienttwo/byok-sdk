> **Archived**: 2026-08-08 20:01
> **Related Plan**: plans/archive/plan-20260808-1940-s4b-a-finalize-authority.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260808-2001

# Implementation Notes: s4b-a-finalize-authority

> **Status**: Active
> **Plan**: plans/plan-20260808-1940-s4b-a-finalize-authority.md
> **Contract**: tasks/contracts/20260808-1940-s4b-a-finalize-authority.contract.md
> **Review**: tasks/reviews/20260808-1940-s4b-a-finalize-authority.review.md
> **Last Updated**: 2026-08-08 19:58
> **Lifecycle**: notes

## Design Decisions

- `StorageFinalizeInput` 只保留 R2 `HEAD` 实际能提供的 `observedByteSize` 与 `observedContentType`。Hash authority 不重新进入 finalize input；它留在通过认证的 daemon 建立的 reservation declaration。
- InMemory dedupe 显式改读 `reservation.contentHash`；Postgres SQL 原本已在 guarded transition 内比较 reservation rows 的 `content_hash`，只删除伪 observation guard，不改 transaction shape。
- `0002_core_domain.sql` 保持 immutable；按 `database-migrations` skill 的 forward-only 规则，本刀不创建空壳 `0003`。S4B-c 才以独立 migration contract 增加 retention/cleanup schema。
- S4B 显式拆为 a/b/c：a 是 authority contract，b 是 reservation-bound cloud surface/presign，c 是 migration/GC/reconcile/metrics。a 不冒充完整 S4B。

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Optional/deprecated `observedContentHash` | Rejected | 没有 wire migration window；optional 字段会保留第二个 hash authority 与 steady-state compatibility path。 |
| 本刀连做 `0003` / GC | Rejected | ListObjects paging、tombstone crash matrix 与删除安全需要独立高风险验收面。 |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- CodeGraph trace: `StorageFinalizeInput` → InMemory/Postgres `finalizeReservation` → `runQuotaConformance`; R2 `HeadResult` 只有 present/size/type。
- `pnpm -r run build`: pass。
- `pnpm -r run typecheck`: pass。
- InMemory core conformance: 2 files / 107 tests pass。
- Postgres dataplane targeted run: 9 files / 162 tests pass（含 core conformance 与 quota concurrency）。
- `rg -n observedContentHash packages`: zero match。
- `git diff --exit-code main -- deploy/sql/ packages/cloud/ packages/protocol/`: pass。
- `repo-harness run verify-contract --contract tasks/contracts/20260808-1940-s4b-a-finalize-authority.contract.md --strict`: 27/27 pass，contract `Fulfilled`。
- compose hard env full `pnpm -r run test`: pass；随后 `pnpm -r run build`、`pnpm run check:deploy-sql`、workflow strict、diff check 均 pass。
- Acceptance Receipt：`external_pass`，findings none；PR #27 以 merge commit `bf228a1` 合入 `main`。
- CI：planning baseline 与 PR head 两轮合计 32/32 checks pass；Node 20/22 dataplane、macOS/Linux/Windows IPC、Bun/SEA packageability 与 Windows service/Git 全绿。

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
