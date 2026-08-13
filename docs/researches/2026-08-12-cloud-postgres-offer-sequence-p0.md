# P0 Bug Report: Postgres offer sequence is allocated twice

- Date: 2026-08-12
- Status: **CONFIRMED / FIXED ON `codex/cloud-postgres-offer-sequence-hotfix` (not published)**
- Severity: **P0** — the published hosted Postgres composition cannot return a successful `enqueueOffer`
- Affected release: `@byok-sdk/cloud-postgres@0.2.0`, tag `v0.2.0` (`7c04632`)
- Unaffected reference composition: hosted in-memory, but only because two independent counters happen to advance in lockstep

## Root cause

`createByokCloud().enqueueOffer()` allocates a delivery number through `stores.sequence.next()` and then `PostgresMailboxStore.append()` allocates again from the same `device_stream.next_seq` row. The envelope is encoded with `N`, while the outbox row receives `N + 1`; the explicit equality guard therefore throws `mailbox_seq_mismatch` on every call.

## P1 — Architecture map

- Orchestration boundary: `packages/cloud/src/cloud.ts:405-433` builds `task.offer`, appends it, then opens the task attempt.
- Cloud-local sequence authority: `packages/cloud-postgres/src/stores/sequence.ts:25-36` increments `device_stream.next_seq` and returns the allocated number.
- Core mailbox authority: `packages/cloud-postgres/src/stores/core/mailbox.ts:96-149` increments the same `device_stream.next_seq` and stores that second number in `outbox.seq`.
- Database authority: `deploy/sql/0001_cloud_local.sql` defines `device_stream.next_seq`; `deploy/sql/0002_core_domain.sql` explicitly puts `outbox.seq` on that allocator.
- Error boundary: `packages/cloud/src/cloud.ts:425-429` rejects when the opaque envelope's number and mailbox row number differ.

The strong dependency is the cross-port invariant `encoded envelope.seq === outbox.seq`. No current conformance suite exercises that invariant across both port families.

## P2 — Concrete trace

Fresh `(tenant, device)`:

1. `stores.sequence.next(deviceId)` inserts `device_stream(next_seq=2)` and returns `1`.
2. `createEnvelope(..., { seq: 1 })` permanently encodes `seq=1` into the opaque mailbox body.
3. `stores.mailbox.append(...)` conflicts on the same `device_stream` row, increments `next_seq` to `3`, returns `2`, and commits `outbox.seq=2`.
4. `message.seq !== seq` is `2 !== 1`, so `mailbox_seq_mismatch` escapes through the host route as HTTP 500.
5. `tasks.open()` is never reached. The mailbox write has already committed, so this is a 500-after-side-effect, not a clean rejection.

The same arithmetic repeats forever: after each failed call the allocator has advanced twice, so later calls produce `(3,4)`, `(5,6)`, and so on. The mailbox number is always exactly one above the number encoded in that call's envelope.

### Real Postgres 17 reproduction

Substrate:

```sh
docker compose -f docker-compose.test.yml up -d --wait postgres
```

A one-off Node probe migrated a fresh schema, instantiated the published `PostgresDeviceSequenceStore` and `PostgresMailboxStore`, then called `sequence.next()` followed by `mailbox.append()` for the same tenant/device. Observed output:

```json
{
  "sequenceAllocated": 1,
  "envelopeSeq": 1,
  "mailboxSeq": 2,
  "mismatch": true,
  "deviceStream": {
    "nextSeq": "3",
    "ackedSeq": "0"
  }
}
```

This is the probe that would have disproved the hypothesis: if the two stores did not share the allocator, or if append reused the reserved number, `mismatch` would be false. It was true on a fresh real database.

## Why the existing suites passed

- Cloud behavior tests call `createByokCloud()` with in-memory stores. `InMemoryDeviceSequenceStore` owns `#next`, while `InMemoryMailboxStore` owns an unrelated `DeviceMailbox.nextSeq`; both start at `1` and happen to advance once per happy-path offer.
- Postgres cloud conformance tests `PostgresDeviceSequenceStore` independently.
- Postgres core conformance tests `PostgresMailboxStore` independently.
- Each independent suite correctly observes `1, 2, 3`; none composes the two stores through `enqueueOffer()` and asserts the cross-port equality.

The tests therefore certify two locally correct allocators while missing that the production composition made both authoritative for the same datum.

## P3 — Fix decision boundary

Preserve one invariant: one `(tenant, device)` delivery has exactly one allocated sequence, and that exact value is present in both the encoded envelope and `outbox.seq`.

The fix removes the separate `DeviceSequenceStore` authority. `MailboxStore.append`
now accepts a protocol-free `materialize(seq)` callback; each composition
serializes one per-device unit of work: allocate the next number, let the
protocol-aware producer build opaque bytes around it, insert the row, then make
both visible together. Postgres holds the `device_stream` row lock until the
outbox insert commits; in-memory uses a per-device promise tail. A failed
materializer rolls back and does not consume a number.

Passing a preallocated `seq` into the old mailbox API was rejected after a
concurrency falsifier: two calls could allocate 1 and 2, commit row 2 first,
let the daemon ack 2, then commit row 1 too late to ever be read. The body
factory transaction closes that ordering hole rather than merely fixing the
observed +1 arithmetic.

Required regression guard:

- Run `createByokCloud()` against the real Postgres cloud + core composition.
- Assert the first and second `enqueueOffer()` both resolve.
- Assert returned `seq`, decoded `envelope.seq`, and persisted `outbox.seq` are identical for each offer.
- Assert the task attempt is opened only after a matching mailbox row exists.
- Run red/green against the unfixed/fixed implementation.

At 10x concurrency, a split read/allocate/insert design fails first through interleaving. The durable fix must retain the database allocator's serialization and make the binding atomic at the mailbox write boundary.

## Sibling sweep

Three production `device_stream.next_seq` allocation sites were inspected:

1. `stores/sequence.ts` + `stores/core/mailbox.ts`: **same bug when composed by `enqueueOffer()`**.
2. `cleanup.ts:477-498` dead-letter replay: **same invariant is broken in a second form**. It allocates a new `outbox.seq` but copies the original opaque `body` unchanged, so the replay row's number differs from the envelope number inside the body. The long-poll response advances by the row cursor while the daemon journals the envelope cursor; this path needs a regression guard in the same fix boundary or must remain an explicit release blocker.
3. Schema/comments: no additional runtime allocator.

The Postgres allocator SQL now lives in one internal helper shared by normal
append and replay. Replay decodes the expired server-to-daemon envelope,
rebinds it to the new row `seq`, and recomputes canonical body/hash/byte-size
before quota accounting. An existing replay row whose bytes do not match that
deterministic projection fails closed; no compatibility rewrite path was added.

## Verification

- Red (unfixed): the real Postgres composition regression failed with
  `Mailbox numbered this offer 2 while the delivery sequence allocated 1`.
  Durable output: `tasks/notes/20260812-0347-cloud-postgres-offer-sequence-hotfix.pre-fix.md`.
- Green (fixed): the same test delivered two offers with row/envelope sequences
  `[1, 2]` and opened both task attempts.
- Core conformance: in-memory `66/66`; full real-dataplane package
  `204/204`.
- Replay regression: decoded envelope `seq`, row `seq`, SHA-256, byte size, and
  quota delta all agree after cloning.
- Deep review exposed two additional interleavings before commit. Cursor
  advancement now waits behind an in-flight in-memory materializer, matching
  the Postgres row-lock behavior. Dead-letter replay now rechecks its shared
  `messageId` after taking the device allocator lock; a normal append winner
  produces typed `cleanup_invalid_input`, and the replay transaction rolls back
  its unused allocation instead of leaking a gap or raw `23505`.

## Handoff

Release handling remains: treat `@byok-sdk/cloud-postgres@0.2.0` as unsuitable
for hosted offer delivery and publish a corrected release before resuming the
blocked delivery-chain dogfood. This branch fixes source and tests only; it does
not publish.
