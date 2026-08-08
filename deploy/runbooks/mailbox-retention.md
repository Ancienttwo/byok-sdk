# Mailbox retention

How the hosted mailbox is bounded, who runs the sweep, and the two things an
operator can get wrong that nothing will warn them about.

Authority: `docs/architecture/sdk-architecture.md` §12.7.3 and §12.7.5, the port
contract in `packages/core/src/mailbox.ts`, and the Postgres implementation in
`packages/cloud-postgres/src/stores/core/mailbox.ts`.

## What the sweep does

`MailboxStore.collectRetired(tenant, { deviceId?, ackedBefore, expireUnackedBefore })`
is the only retention entry point. It performs two disjoint sweeps in one
statement:

| Row state | Cutoff | Action | Reported as |
| --- | --- | --- | --- |
| `acked` | `ackedBefore` | **deleted** | `deletedCount`, `releasedBytes` |
| `pending` | `expireUnackedBefore` | **marked `expired`** | `expiredCount` |

The asymmetry is the contract, not an optimization. A row the device
acknowledged has been durably journaled on the device, so deleting it loses
nothing. A row that aged out **before anyone consumed it** is work that was
dropped, and §12.7.5 requires it to stay visible — deleting it would make "we
lost work" indistinguishable from "there was no work". No path in the
implementation deletes an unacked row, and the conformance suite asserts an
unacked row survives a sweep whose cutoffs are far in the future.

Both cutoffs must be **canonical ISO-8601 UTC** (`YYYY-MM-DDTHH:mm:ss.sssZ`).
Anything else is rejected with `timestamp_not_canonical` before the sweep runs,
so a malformed cutoff deletes nothing rather than a wrong prefix of history.
The instants are compared against the stored `appended_at` as text, which is a
time comparison only for that canonical form.

Predicates and index, for capacity planning: both sweeps filter
`(tenant_id, device_id, state, appended_at)`, which is exactly
`outbox_retention_idx` in `deploy/sql/0002_core_domain.sql`. Omitting
`deviceId` widens the sweep to the whole tenant and drops `device_id` from the
prefix, so a tenant-wide sweep scans more of the index — prefer per-device
sweeps on large tenants.

## Who runs it

**The SDK ships no scheduler.** Nothing in `@byok/core`, `@byok/cloud` or
`@byok/cloud-postgres` starts a timer, and nothing calls `collectRetired` on its
own. The host runs it: a cron job, a queue consumer, a Cloudflare cron trigger,
a Kubernetes CronJob — whatever the deployment already has. Two consequences
worth stating plainly:

- **A deployment that never calls it never expires anything.** The mailbox grows
  until `mailboxLimitBytes` refuses new appends with `storage_quota_exceeded`.
  That is a working failure mode (bounded, typed, visible) and it is not the one
  you want to discover in production.
- **The cutoffs are the caller's**, computed against the caller's clock. The
  store reads no clock of its own for retention, which is what makes the sweep
  assertable under a test clock and what makes a wrong cutoff entirely the
  host's to own.

Suggested defaults, from the §12.7.5 table:

| Data | Suggested default | Deletion condition |
| --- | --- | --- |
| mailbox | time-bounded window, configured per tenant/device | acked; unacked past expiry moves to `expired` and is not silently dropped |
| inbound dedup | at least the mailbox's maximum redelivery window | expiry |
| request receipts | at least proof clock skew plus the client retry horizon | expiry |
| pairing / auth nonce | order of 10 minutes | used or expired |
| presence | 60–120 s | TTL |
| activity tail | 5–15 minutes | TTL |

The dedup window is the coupled one: `inbound_dedup` must remember an envelope
id for at least as long as the mailbox can still redeliver it. Set the mailbox
window wider than the dedup window and a redelivered envelope can be processed
twice.

Presence and activity are not swept by this runbook. Their TTL is enforced as a
read filter (`expires_at > now`), so an expired hint is invisible the moment it
expires whether or not anything reclaims the row.

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
- `collectRetired` is age-bounded: a row survives on its `appended_at`, whatever
  the volume.

So "we keep 1024" and "we keep 24 hours" are answers to different questions. A
chatty device can push a ring's effective window below the mailbox redelivery
window while the configuration still reads as generous, and nothing in either
component notices — the ring is doing exactly what it was told. When you size
one against the other, convert to the same unit first and size for the **peak**
rate, not the mean.

## `expired` rows and the operator dead-letter flow

`expired` remains the durable dead-letter row; it is not silently moved to a
second queue. S4B-c adds a Postgres maintenance surface:

- `listDeadLetters` pages expired rows for operator inspection;
- `replayDeadLetter` requires a new operator idempotency key and clones the
  bytes to a new monotonic sequence; `replay_source_seq` binds that key to the
  exact expired row while retaining the original evidence;
- `discardDeadLetter` explicitly removes one expired row and releases mailbox
  accounting in the same transaction.

Automatic retention calls none of the latter two. A non-zero
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
`advanceCursor` marks the row `acked`, and the next `collectRetired` sweep
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
