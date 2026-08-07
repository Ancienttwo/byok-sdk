# Implementation Notes: s3b-local-journal

> **Status**: Active
> **Plan**: plans/plan-20260807-2242-s3b-local-journal.md
> **Contract**: tasks/contracts/20260807-2242-s3b-local-journal.contract.md
> **Review**: tasks/reviews/20260807-2242-s3b-local-journal.review.md
> **Last Updated**: 2026-08-08 02:30
> **Lifecycle**: notes

## Story → Commit Map

| Story | Commit | Content |
| --- | --- | --- |
| Ride-alongs | `2915f88` | S3a-gate P2s: receipt-seam comments corrected to "re-encoded canonically under the frozen v1 codec" (three sites incl. the fixture), fetch-identity guard test, GAP-015 label S3→S3b |
| L-001 | `c4c86b5` | `LocalTaskJournal` port (S3.3 ten methods verbatim + `close()`); `SqliteLocalTaskJournal`: single `<storeDir>/daemon.db`, eight §12.7.2 tables, PRAGMA order `auto_vacuum=INCREMENTAL` (pre-table) → WAL → foreign_keys → FULL, forced schema read at open (corrupt files fail at open, not mid-append), single-writer queue, repo-first `BEGIN IMMEDIATE` multi-table transactions, idempotency by envelope/transition id, bounded record sizes, timestamped corrupt-DB quarantine with manifest (never deletes); client-local `sqlite-support.ts` mirroring the server's shape |
| L-002 | `31e98db` | `hostedJournal` opt-in config (gitWorkspace three-part idiom); journal append at the head of the `onEnvelope` chain — ack-after-commit is structural (cursor advances only on handler success; `connection-manager.ts` untouched); fail-closed `JournalUnavailableError` without `node:sqlite` (runs on every Node version); `TaskRunnerDeps.admissionGuard?` seam; terminal → `recordTerminal`; start-time recovery scan (`listRecoverable`/`markRecovered`, no protocol impersonation) |
| Crash 1-6 | `5d8a4a6` | Six-point matrix: fault seams + drop-and-reopen; points 5/6 against the real cloud fixture with fresh envelope ids (forcing the receipt, not the transport dedup, to absorb the replay); zero wall-clock assertions |
| L-003a | `1dc6e24` | `LocalStoragePolicy` + `computePressureState` (pure, worst-first: emergency latch / hard ≥90% or free<min / pressure ≥80% or free<soft-min / normal); classified GC engine — §12.7.2.1 order 1-5 at normal, truncated to `expired-temp`/`rotated-log` under pressure (deleting durable records is the wrong reflex on a nearly-full disk); compact-before-confirmed-journal-prune; real `compact()` (bounded `wal_checkpoint(TRUNCATE)` + `incremental_vacuum(N)`) |
| L-003b | `d8872d2` | Production admission guard (hard pressure → retryable decline); emergency → append throws → cursor frozen (the existing stall semantics doing exactly their job); `ControlStatusResult.storage?` (named `storage*`, no `queueWatermarks` collision) rendered via `format.ts`; library exports |
| Pressure 7-12 | `1374bed` | Six-point disk-pressure matrix + policy unit suite; checkpoint-vs-append FIFO proof on a logical clock (five concurrent appends consume exactly five ticks — zero starvation); cleanup-crash both orders converge idempotently |
| docs | (docs commit, see git log) | GAP-006/GAP-015 closure, §12.7.2/§12.7.2.1 CURRENT + implementation alignment, §12.5/§14.4 marks, sprint S3.5 boxes 3-9 + alpha-gate note |

## Design Decisions

- **Ack-after-commit is structural, not procedural**: the journal append sits at the head of the daemon's envelope handler chain; `ConnectionManager.process()` already advances the cursor only on handler success, so no transport change exists to get wrong. Proven by a promise-gate test (append blocked ⇒ no adapter start, no `task.claim` on the wire, persisted cursor unmoved) and crash points 1/2.
- **The never-delete list has no spelling**: `CleanableCategory` is a five-member union of cleanable categories only; protected data (unacked envelopes, running tasks, unconfirmed terminals, recovery-marked rows, quarantine) cannot be named by the cleanup path. The journal's only deletion statement re-checks eligibility (`truth_state='confirmed' AND recovery_marker IS NULL`) inside the deleting transaction.
- **Emergency is a latch, not a reading**: one failed ack-critical write pins the state until a computed-normal measurement clears it; emergency refuses acks entirely — the frozen cursor plus mailbox redelivery is the recovery mechanism, not a local retry loop.
- **Pressure-state GC deliberately truncates the order**: under pressure/hard only rebuildable/expired categories are cleaned; the full 1-5 order runs at normal cadence. Durable-record pruning while the disk is nearly full is the named wrong reflex.
- **No zod in the client** (dispatch deviation, ratified): the contract forbids new dependencies and `packages/client/package.json` is outside allowed paths; hand-rolled validation with a typed `LocalStoragePolicyError` matches the file's existing config-validation idiom and is unit-tested.
- **`conn.ack` is journaled too** (opensTask=false): every inbound envelope can advance the cursor, so every one must be durable first.
- **Journal lifetime = daemon object lifetime** (no close in `stop()`): consistent with DeviceStore/CursorStore; the shutdown sequence settles the terminal-journal tail before outbox drain so teardown-time `task.fail` records are not lost.
- **PRAGMA order matters**: `auto_vacuum=INCREMENTAL` must precede table creation or `incremental_vacuum` silently no-ops — captured in `sqlite-support.ts` with a comment and covered by the compaction test.

## Deviations From Plan Or Spec

- Port gained `close()` (beyond the S3.3 minimum; documented). Class-level `reportCategoryUsage`/`enqueueCleanupCandidate`/`pruneConfirmedJournalTask` stay off the port — S3.3 stays verbatim; later slices promote if needed.
- Ride-along touched a third file (`fixtures/real-cloud.ts`) carrying the same overstated comment.
- Status filled in `create-daemon.ts` (where every other status field is sourced), not `control-server.ts`; `bin/commands/status.ts` needed no edit.
- Server/protocol/keys/examples zero-diff machine-checked; `connection-manager.ts` untouched as contracted.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| better-sqlite3 for Node 20 coverage | Rejected | Contract forbids new deps; `node:sqlite` + fail-closed construction is §12.7.2's no-silent-downgrade verbatim |
| Runtime-filtered protected list | Rejected | A filter bug deletes recovery evidence once, in production; type-level absence cannot |
| Priority queue for checkpoint vs append | Rejected (FIFO) | Strict FIFO through the single writer already bounds append latency (proven on a logical clock); priorities add a starvation axis |
| Auto-rebuild after corrupt-DB quarantine | Rejected | Fail closed and surface; rebuilding silently converts evidence into an empty database |

## Open Questions

- None blocking. S7 owns doctor/support-bundle consumption of the quarantine manifest and health surface; S4A owns the durable home for the cloud-side ports.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Worker-run evidence (after `1374bed`): typecheck clean; tests protocol 189 / core 328 / keys 167→(worker A read: 167; B read: 189/328 order varies) / cloud 78 / server 216 / client 933 all green; build 6×; golden clean; zero-diff machine check clean. Crash matrix six points + pressure matrix six points listed green with verbose reporter lines in the worker reports.
- Dual-Node evidence (after `9b1bb9a`, the storage-policy ordering fix): Node 22.22.0 `pnpm -r run test` — core 167 / keys 328 / protocol 189 / cloud 78 / server 216 / client 934, zero failures; Node 20.17.0 `npx vitest run` in `packages/client` — 896 passed / 38 skipped / 0 failed (93 files passed, 3 skipped). The storage-policy rejection test is in the passing set on BOTH legs now, which is the point of the fix: it never depended on `node:sqlite` being available. Supersedes the earlier pre-fix Node 20 reading (884 passed / 27 skipped).
- Full-repo gates re-run by the acceptance chain (see checks file), not hand-claimed here.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- "Protected data must be unspellable by the deletion path, not filtered from it" — candidate for `tasks/lessons.md` when S4B builds the cloud-side GC (same shape, higher stakes).
- "PRAGMA auto_vacuum must precede table creation" — candidate for `docs/researches/` if a second SQLite store hits it.
