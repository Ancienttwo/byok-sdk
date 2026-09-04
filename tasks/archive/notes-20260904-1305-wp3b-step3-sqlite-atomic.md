> **Archived**: 2026-09-04 13:05
> **Related Plan**: plans/archive/plan-20260904-1237-wp3b-step3-sqlite-atomic.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260904-1305
> **Archive Projection V1**: `plans/plan-20260904-1237-wp3b-step3-sqlite-atomic.md` => `plans/archive/plan-20260904-1237-wp3b-step3-sqlite-atomic.md`
> **Archive Projection V1**: `tasks/notes/20260904-1237-wp3b-step3-sqlite-atomic.notes.md` => `tasks/archive/notes-20260904-1305-wp3b-step3-sqlite-atomic.md`
> **Archive Projection V1**: `tasks/contracts/20260904-1237-wp3b-step3-sqlite-atomic.contract.md` => `tasks/archive/contract-20260904-1305-wp3b-step3-sqlite-atomic.md`
> **Archive Projection V1**: `tasks/reviews/20260904-1237-wp3b-step3-sqlite-atomic.review.md` => `tasks/archive/review-20260904-1305-wp3b-step3-sqlite-atomic.md`

# Implementation Notes: wp3b-step3-sqlite-atomic

> **Status**: Completed
> **Plan**: plans/archive/plan-20260904-1237-wp3b-step3-sqlite-atomic.md
> **Contract**: tasks/archive/contract-20260904-1305-wp3b-step3-sqlite-atomic.md
> **Review**: tasks/archive/review-20260904-1305-wp3b-step3-sqlite-atomic.md
> **Last Updated**: 2026-09-04 13:00
> **Lifecycle**: notes

## Design Decisions

- One `SqliteCoordinator` owns the `DatabaseSync` handle and serializes every operation; cancellation appends the mailbox row and updates the task attempt inside one `BEGIN IMMEDIATE` transaction.
- The durable boundary is exactly task attempts, cancellations, mailbox, object manifest, blob grants, and blob bytes. The in-memory quota store is deliberately constructed against the SQLite `ObjectStore`, avoiding a hidden second manifest authority while keeping quota counters process-local as approved.
- `CreateByokServerOptions.storage` is the sole mode selector. SQLite open/schema errors propagate; no memory fallback or dual write exists.
- Schema version `1` is checked before schema mutation when metadata already exists. Unknown or unversioned metadata fails closed.
- Existing synchronous `stop()` remains source-compatible; new `close(): Promise<void>` provides deterministic database-handle release.

## Deviations From Plan Or Spec

- The design packet's original four-interface boundary was corrected to six after tracing the current cancellation contract. Owner approved the correction on 2026-09-04; the packet now records it.
- Full core conformance initially exposed that `createInMemoryCoreStores()` had bound quota to its private in-memory object store. The final composition constructs `InMemoryQuotaStore(clock, sqliteObjects)` instead; quota remains non-durable without duplicating object authority.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Persist all 21 core/cloud ports | Reject | Unrelated scope and migration surface. |
| Mirror SQLite task/object facts into memory | Reject | Dual authority and restart drift. |
| Six durable interfaces plus in-memory remainder | Use | Smallest coherent atomic boundary approved by owner. |

## Open Questions

- None.

## Verification Results

- SQLite conformance: `bun run --cwd packages/server test -- stores/sqlite --reporter=dot` — 2 files, 144 tests passed after adding the schema-version guard.
- Server SQLite composition: `bun run --cwd packages/server test -- sqlite-composition --reporter=dot` — explicit selection, façade restart readback, idempotent close, and memory default passed.
- Server package: 31 files, 335 passed, 20 skipped.
- Repository: `bun run build`, `bun run typecheck`, and final `bun run test` passed. Final test totals include client 1607, cloud 316, cloud-dataplane 74, conformance 156, core 252, protocol 349, server 335, and the remaining package suites.
- Surface/release checks: `bun run check:api-surface`, `bun run check:version-authority`, and `node scripts/release/check-package-graph.mjs` passed.
- Example smoke: `PORT=0 BYOK_STORE=sqlite BYOK_SQLITE_PATH=<temp>/example.sqlite bun run --filter @byok-sdk/example-basic dev`; startup reported `storage=sqlite`, shutdown completed, DB mode read back as `0600`.
- Atomic/restart guard: injected SQLite trigger failure after cancellation delivery insertion rolled back both delivery and task tombstone; close/reopen read back task, mailbox, committed manifest, blob grant, and exact bytes.

## Residual Risk

- Quota/accounting and device enrollment are intentionally in-memory. Restart preserves stored objects but resets quota counters and requires re-pairing; README states this boundary. Expanding quota durability is a separate work package, not a compatibility path in this one.
- One synchronous SQLite handle serializes all durable operations. At 10x embedded write load, queue latency is the first pressure point; this adapter is a reference embedded mode, not the hosted dataplane.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- The corrected atomic boundary is already promoted into the WP3B design packet. No harness-level lesson is warranted from a single adapter implementation.
