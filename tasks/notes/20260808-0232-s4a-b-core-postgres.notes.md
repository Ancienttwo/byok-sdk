# Implementation Notes: s4a-b-core-postgres

> **Status**: Active
> **Plan**: plans/plan-20260808-0232-s4a-b-core-postgres.md
> **Contract**: tasks/contracts/20260808-0232-s4a-b-core-postgres.contract.md
> **Review**: tasks/reviews/20260808-0232-s4a-b-core-postgres.review.md
> **Last Updated**: 2026-08-08 03:15
> **Lifecycle**: notes

## Design Decisions

- **Canonical instants are `text` in 0002, `timestamptz` stays right in 0001.** The plan's P3 call held up without qualification. Core's timestamp contract is a canonical ISO-8601 UTC string compared lexicographically, so `text` stores it byte-for-byte and owes no round-trip proof. 0001's `timestamptz` columns are cloud-local expiry fields with no cross-composition string contract behind them, so nothing there needed revisiting.
- **`storage_usage` has no `reserved_bytes` column.** `TenantStorageUsage.reservedBytes` is a `SUM(expected_bytes)` over the tenant's `reserved` rows. A stored counter has to be decremented on all three of finalize / abort / expire, and a settle path that forgets leaves the tenant permanently short of quota it actually released — durable drift, invisible until an audit. Deriving makes that class unrepresentable and turns settlement into a pure state transition on one row.
- **`object_manifest.ref_count` is recomputed, never incremented,** for the same reason and with a sharper failure: a drifted count strands the object forever behind `markDeletePending`'s zero-reference guard. `object_reference`'s primary key already makes the write idempotent; the count just reads it.
- **`board_seq` is allocated in its own autocommitted statement, not a data-modifying CTE.** As a CTE inside the board write, two concurrent claimers can lock `tenant_stream` and `board_item` in orders the planner chose independently, which is a deadlock rather than a conflict. Allocating first gives every writer one lock order. Cost: a rejected write burns a number. `boardSeq` is contractually monotonic and never contractually gapless, and the incremental feed reads `> afterSeq` either way. `outbox.seq` makes the same trade for the same reason.
- **`advanceCursor` marks rows in the same statement as the cursor move.** Split across two round trips, a crash between them leaves the cursor ahead of the rows it acked and `readAfter` re-serves work the device already ran. When the monotonic guard rejects, the scalar subquery feeding the marker is `NULL` and `seq <= NULL` marks nothing, so the rejection is total rather than partial.
- **Presence and activity expiry is a read filter, not a lazy delete.** The in-memory reference drops the entry on read; the same observable answer here comes from a predicate, and a `SELECT` does not write to answer itself.
- **`COLLATE "C"` on the two ordered listings** (`truth.listManifest`, `objects.list`). Byte order is what the in-memory reference's `localeCompare` produces for these keys and, unlike the server's default collation, does not depend on how the cluster was initialized.

## Deviations From Plan Or Spec

Three, all reported rather than absorbed.

1. **`reserve` opens a transaction with `FOR UPDATE`; the plan's Code Snippets show a lone guarded `INSERT`.** The plan's shape oversells. Admission's guard is an aggregate over live reservations, and under READ COMMITTED a statement's snapshot is fixed at statement start, so N concurrent reservers all read a pre-insert world and all pass. Postgres' EvalPlanQual re-check — the mechanism that makes `UPDATE ... WHERE status = $x` a genuine CAS everywhere else in this package — re-evaluates only against the updated *target* row and leaves a subquery over another table on the original snapshot. No single statement over this shape serializes reservers.

   This is not the stop condition the contract names ("a CAS or quota path ... seems to need read-then-write"). Nothing is read into TypeScript and compared before a write: the admission decision is still entirely inside one guarded SQL statement. What the transaction adds is a lock, so that statement's snapshot is acquired behind it. `packages/core/src/in-memory/quota.ts:9-10` already names "a row-locked transaction" as the Postgres shape, so this follows core's own reference rather than departing from it. The rejected alternative — a `reserved_bytes` counter CAS'd in place, which *is* expressible in one statement — trades an oversell window for permanent accounting drift, which is worse.

   Verified, not asserted: with the lock removed, eight racers against a five-slot limit admit six and the tenant is oversold by 200 bytes. With it, exactly five.

2. **0002 contains one `ALTER TABLE`: `device_stream ADD COLUMN acked_at text`.** 0001 created `acked_seq` ahead of its consumer precisely so this slice would not widen a frozen table, but `MailboxCursorState` also carries a required `updatedAt` and 0001 has no companion instant. The three options were this column, a second per-device table that would leave `device_stream.acked_seq` half-owned and contradict design §5's mapping, or returning the reader's own clock as "the instant the cursor moved" — a fabricated fact. 0001's bytes are untouched and the change is additive and nullable. A `device_stream` row created by `cloud.sequence` rather than by the mailbox has `acked_at` NULL and `acked_seq` 0; `readCursor` then reports the read's own clock, which is the one case where the two compositions can differ on a field nothing asserts.

3. **Two Postgres-local tests were added beyond the plan's file list**, both because a named mitigation turned out not to exist.
   - `src/__tests__/quota-concurrency.test.ts`. The plan's risk table credits "the suite's quota dimension (36 expects incl. concurrency)" as the no-oversell mitigation. The quota dimension has no concurrency case — every one of its ten cases is sequential, and it has to stay that way to remain composition-agnostic, since an in-memory store cannot fail the thing a SQL store gets wrong. Without this test, deleting `FOR UPDATE` leaves every gate in the repository green.
   - The second case in `src/__tests__/invariants.test.ts`. A file of `DO $$` blocks that assert nothing passes exactly as loudly as one that asserts everything. The case introduces one violating index and expects rejection; it does not ask which rule fired or what the whitelist contains, so it is a mutation check rather than the duplicated assertion the contract forbids. The SQL file was separately verified against five violation classes (unmigrated schema, naked unique index, unique expression index, missing `tenant_id`, nullable `tenant_id`) and raises on all five.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| `reserve` as a lone aggregate-guarded `INSERT` | Rejected | Oversells under READ COMMITTED; the aggregate's snapshot predates a competitor's insert and EvalPlanQual does not fix it |
| `reserve` via a `reserved_bytes` counter CAS'd in place | Rejected | Expressible in one statement, but three settle paths must each decrement it, and a duplicate-id retry double-counts — permanent drift beats a race window in badness |
| `reserve` behind `FOR UPDATE` on the entitlement row | **Use** | Drift-free and oversell-free; the decision stays in the SQL guard; matches what core's in-memory reference documents |
| A second per-device table for the mailbox cursor instant | Rejected | Leaves `device_stream.acked_seq` half-owned and contradicts design §5 |
| Returning the reader's clock as `MailboxCursorState.updatedAt` | Rejected | Reports a write that never happened |
| `ALTER TABLE device_stream ADD COLUMN acked_at` in 0002 | **Use** | Additive, nullable, 0001 untouched; smallest coherent change that keeps §5's mapping |
| Board seq allocation as a data-modifying CTE | Rejected | Two claimers can take `tenant_stream` and `board_item` in opposite orders — a deadlock, not a conflict |
| Storing `object_manifest.ref_count` as an increment | Rejected | A drifted count strands the object forever behind the zero-reference tombstone guard |

## Open Questions

- None blocking. `readCursor`'s `updatedAt` for a `device_stream` row that `cloud.sequence` created and the mailbox has never acked falls back to the read's own clock, since no instant was ever written. Nothing in the contract or the suite asserts that field, and `ackedSeq` is 0 in exactly that case, so the value is reported rather than invented — but a later slice that gives `updatedAt` meaning should revisit it.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Core conformance on Postgres: `packages/cloud-postgres/src/__tests__/core-conformance.test.ts` (56/56)
- No-oversell under real concurrency: `packages/cloud-postgres/src/__tests__/quota-concurrency.test.ts`
- Catalog assertions: `tests/sql/control_plane_invariants.sql`, run by `packages/cloud-postgres/src/__tests__/invariants.test.ts`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- **Candidate for `tasks/lessons.md`** (hold until a second occurrence): "a guarded single statement is a CAS only when the guard reads the row it writes". EvalPlanQual re-checks the update's target tuple, not a subquery over another table, so an aggregate-guarded insert is not serialized by anything. This is the kind of correctness claim that passes every test and fails in production, and the repository's single-statement-CAS idiom makes it easy to over-generalize.
- Not promoted: the `text`-vs-`timestamptz` call is already argued at length in `deploy/sql/0002_core_domain.sql` and in design §5, and repeating it would create a third copy.
