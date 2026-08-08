# Implementation Notes: r2-hash-authority-adr

> **Status**: Active
> **Plan**: plans/plan-20260808-1542-r2-hash-authority-adr.md
> **Contract**: tasks/contracts/20260808-1542-r2-hash-authority-adr.contract.md
> **Review**: tasks/reviews/20260808-1542-r2-hash-authority-adr.review.md
> **Last Updated**: 2026-08-08 15:56
> **Lifecycle**: notes

## Design Decisions

- ADR-024 selects the authenticated daemon declaration as canonical SHA-256 authority. Cloud observes only object existence, byte size, and content type through R2 `HEAD`; `committed` is not a cloud-verified digest claim.
- Same-tenant key identity, deduplication, and accounting use the declaration. The residual risk is explicit: a valid paired device can mislabel same-size/type bytes within its own tenant, and reconciliation cannot detect that without a full read-back.
- S4B is constrained to remove `StorageFinalizeInput.observedContentHash`, retain the four existing manifest states, avoid `hash_verified` in `0003`, and build GC from tenant key + manifest + reservation + reference + grace/tombstone only.
- `docs/architecture/sdk-architecture.md` Appendix A remains the sole ADR number/status index; the decision body lives under `docs/researches/` rather than creating `docs/adr/`.

## Deviations From Plan Or Spec

- No scope deviation. The first full workspace test run hit the repository's known timing-sensitive `packages/client/src/__tests__/daemon-control-socket.test.ts` 10-second timeout. `packages/client/**` had zero diff; the package immediately passed standalone at 934/934, and the immediate full dataplane rerun passed all 2,136 tests. No source or timeout change was made.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| daemon declaration authority | Accepted | Matches paired-device tenant trust, preserves direct upload, and requires no invented verification state |
| cloud read-back SHA-256 | Rejected | Adds a second O(n) byte transfer/hash pass, finalize latency, worker backpressure, and new crash semantics |
| R2 checksum authority | Rejected for current capability | R2 supports SHA-256 `COMPOSITE`, not the PutObject `FULL_OBJECT` shape; MinIO-only success would be a false production guarantee |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Official capability source: `https://developers.cloudflare.com/r2/api/s3/api/`
- Fresh substrate: `docker compose -f docker-compose.test.yml up -d --wait` (Postgres and MinIO healthy)
- Install/bootstrap: `pnpm install --frozen-lockfile`; bootstrap `pnpm -r run build`
- Required gates: `pnpm -r run typecheck`; hard-env `pnpm -r run test` (2,136/2,136); `pnpm -r run build`; `repo-harness run check-task-workflow --strict`
- Additional gates: `pnpm run check:deploy-sql` (`[deploy-sql] OK`); `git diff --check`; `git diff --exit-code main -- packages/ deploy/sql/`; canonical stale-phrase audit

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- The durable decision is already promoted as ADR-024 in `docs/researches/r2-hash-authority-decision.md` and indexed in the canonical architecture. No lesson or harness change is warranted from this docs-only slice.
