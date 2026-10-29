# Mailbox retention

How the hosted mailbox is bounded, who runs the sweep, and the two things an
operator can get wrong that nothing will warn them about.

Authority: `docs/architecture/sdk-architecture.md` §12.7.3 and §12.7.5, the port
contract in `packages/core/src/mailbox.ts`, and the Postgres implementation in
`packages/cloud-dataplane/src/stores/core/mailbox.ts`.

## What the sweep does

`MailboxStore.collectExpired(tenant, { now, limit, ackedBefore, expireUnackedBefore, reapDeadLettersBefore })`
is the tenant-wide mailbox collector. One call mutates at most `limit` rows:
acked rows are deleted first, then old dead letters are reaped, then the
remaining slots mark old pending rows `expired`. Only rows that were already
`expired` when the call started can be reaped. `more` reports a further
eligible row, including one this call's expiry made reapable; reaching the
limit alone does not imply a remainder.

| Row state | Cutoff | Action | Report field |
| --- | --- | --- | --- |
| `acked` | `ackedBefore` | delete | `removed` |
| `expired` | `reapDeadLettersBefore` | delete, except the device's highest-seq `expired` row | `removed` |
| `pending` | `expireUnackedBefore` | mark `expired`, retain the row | `expired` |

The device's highest-seq dead letter is never reaped: `recoverableFrom` is one
past it, so keeping that row keeps the floor where it was. Once a newer row of
the same device expires, the old floor row becomes an ordinary dead letter and
is reaped after its own cutoff.

Mailbox usage is `SUM(byteSize)` over `pending` rows. The collector never reads
or writes an accounting counter, and **`releasedBytes` is always `0n`**. `acked`
and `expired` rows hold no quota (#1115): a row stops counting when the device
acks it or when the collector dead-letters it, and deleting it later changes
nothing in usage.

`now` and all three cutoffs must be canonical ISO-8601 UTC
(`YYYY-MM-DDTHH:mm:ss.sssZ`). `limit` must be a positive safe integer. Validation
precedes mutations. There is no device-specific collection argument.

## Who runs it

`ByokCloud.runMaintenance({ tenant, now, policy, limit })` computes the three
cutoffs and calls this collector as one of its ten fixed steps. The defaults
are 24 hours for acked rows, 7 days for unacked rows, 30 more days for dead
letters (`mailboxDeadLetterRetentionMs`, so the reap cutoff is
`now - mailboxUnackedRetentionMs - mailboxDeadLetterRetentionMs` on
`appended_at`) and 500 rows per step. Unacked expiry is evidence of lost work;
the dead-letter window is how long that evidence stays queryable.

The reference server schedules maintenance every 5 minutes with ±20% jitter.
`server.maintenance.runNow()` joins an in-flight pass; `server.close()` stops
the timer and awaits collection before closing SQLite. There is no separate
`server.mailbox` retention façade and no disable option.

Hosted deployments call the same kernel entry point from their scheduler,
with their explicitly stored policy and caller-owned clock. Use one scheduler
per tenant and export its returned report or `observer.onMaintenance` report.
A missing hosted policy fails closed; embedded defaults do not substitute for
it. See [cloud-cleanup.md](cloud-cleanup.md) for the other steps and operator
reconciliation.

The SQL collector has bounded tenant/state/cutoff predicates. The existing
outbox indexes remain installed; assess a large tenant with `EXPLAIN` and its
actual distribution before choosing an additional index.

## Capacity-bounded rings are not time-bounded retention

§12.7.5 requires this to be written down, and it is the clause most likely to be
skimmed:

> A capacity-bounded ring and a time-bounded SQL retention behave differently.
> The first drops the **oldest by count**; the second expires **by age**. They
> are not interchangeable, and an operator must not treat one as a
> configuration of the other.

Concretely in this SDK:

- `InMemoryInboundDedupStore` (and `PostgresInboundDedupStore`'s reclaim) is
  count-bounded: `DEDUP_RING_CAPACITY = 1024` ids per device, oldest evicted
  first. Its window in *time* is whatever 1024 envelopes happens to span — an
  hour for a chatty device, a month for a quiet one.
- `collectExpired` is age-bounded: a row survives on its `appended_at`, whatever
  the volume.

So "we keep 1024" and "we keep 24 hours" are answers to different questions. A
chatty device can push a ring's effective window below the mailbox redelivery
window while the configuration still reads as generous, and nothing in either
component notices — the ring is doing exactly what it was told. When you size
one against the other, convert to the same unit first and size for the **peak**
rate, not the mean.

## `expired` rows and the operator dead-letter flow

`expired` remains the dead-letter row; it is not silently moved to a second
queue. It stays queryable for the dead-letter window after it expired, then
the sweep reaps it, except each device's highest-seq dead letter, which stays
as the recovery floor. S4B-c adds a Postgres maintenance surface:

- `listDeadLetters` pages expired rows for operator inspection, so inspect
  and replay within the dead-letter window;
- `replayDeadLetter` requires a new operator idempotency key and clones the
  bytes to a new monotonic sequence; `replay_source_seq` binds that key to the
  exact expired row while retaining the original evidence;
- `discardDeadLetter` explicitly removes one expired row; a dead letter holds
  no quota, so removing it frees storage but no mailbox quota. Like the reap,
  it never removes a device's highest-seq dead letter: that call fails with
  `cleanup_dead_letter_is_recovery_floor`, so `recoverableFrom` never moves
  back.

Automatic retention calls none of the latter two. A replay clone outlives the
reap of its source: `replay_source_seq` is provenance, not a foreign key. A non-zero
`mailbox_expired_count`/`expiredCount` means work was dropped and must alert.
Direct SQL remains a read-only support surface:

```sql
SELECT device_id, seq, message_id, byte_size, appended_at
  FROM outbox
 WHERE tenant_id = $1 AND state = 'expired'
 ORDER BY device_id, seq;
```

The host-wide scheduling, metrics, crash recovery and rollback contract is in
`deploy/runbooks/cloud-cleanup.md`.

## Evidence gap: `noteSkippedSeq`

One case where the mailbox retires a row that left **no local trace on the
device**, and it is not a bug in retention — it is a known gap recorded in
`tasks/todos.md`.

`packages/client/src/daemon/connection-manager.ts:695-702` (`noteSkippedSeq`)
advances the persisted cursor for an envelope the daemon classified as `task.*`
but could not parse — a message type from a newer cloud that this build cannot
execute. The skip path calls `advanceCursor` **without** routing the envelope
through `onEnvelope`, so nothing is written to the local journal.

In hosted mode the consequence lands here: the cloud sees the advanced cursor,
`advanceCursor` marks the row `acked`, and the next `collectExpired` sweep
**deletes** it as consumed. The row is gone from the mailbox and was never
recorded on the device.

What that does and does not mean:

- Nothing executable was lost. The envelope was, by construction, of a type this
  build cannot run.
- The architecture's claim that "the ack hangs behind the journal commit" holds
  for every envelope that reaches `onEnvelope`, and does **not** hold for this
  path.
- An operator reconstructing what a device was told, from the device's journal,
  will not see these envelopes. If you are diagnosing a version-skew incident,
  the cloud-side record is the only record, and retention will have deleted it
  on the normal schedule. **Widen the mailbox window before rolling a cloud that
  introduces new `task.*` types**, or you will be diagnosing skew against
  evidence that has already aged out.

Design §10 ruled that closing this properly means changing `connection-manager.ts`
— a client-side file under a zero-diff contract for the slice that found it —
so the fix waits for the protocol version bump that adds the new `task.*` types,
which is the single remaining revisit trigger on the ledger row. Documenting the
gap is what S4A owed; the code change is not S4A's to make.
