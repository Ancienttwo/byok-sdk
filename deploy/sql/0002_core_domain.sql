-- 0002_core_domain.sql — the eleven core-domain port tables.
--
-- Frozen at merge, like 0001. Migrations are forward-only (sprint S4A.6): a
-- correction is a NEW file, never an edit to this one, and the runner
-- checksums every applied file against its ledger row
-- (packages/cloud-postgres/src/migrate.ts). 0001 is not touched here, by
-- construction and by a machine-checked zero diff.
--
-- Key design follows docs/researches/s4a-dataplane-design.md §5 and the
-- tenant-first discipline in docs/architecture/sdk-architecture.md §12.6.2.
-- The rule 0001 states and this file inherits:
--
--   EVERY unique index or constraint on a tenant-owned table starts with
--   tenant_id.
--
-- This file adds no exception to it. The two whitelisted ones both live in
-- 0001 (device.device_id, pairing_code.code) and both are single-step
-- pre-tenant resolutions of a cloud-minted credential.
-- tests/sql/control_plane_invariants.sql turns that rule into an executable
-- catalog assertion with the same two-entry whitelist.
--
-- ---------------------------------------------------------------------------
-- Two type decisions that apply to every table below
-- ---------------------------------------------------------------------------
--
-- 1. Canonical instants are `text`, not `timestamptz`. Every instant that
--    crosses a `@byok/core` port is a canonical ISO-8601 UTC string
--    (YYYY-MM-DDTHH:mm:ss.sssZ) and the contract compares them
--    lexicographically -- `packages/core/src/time.ts` exists to pin exactly
--    that and to REJECT anything else rather than normalize it. `text` stores
--    what the port produced, byte for byte, and `<` / `>=` over it is the same
--    comparison the in-memory reference performs. `timestamptz` would round
--    trip through Postgres' own serializer, so every read would owe a proof
--    that the canonical form survived, and a formatting divergence between the
--    two compositions would be silent rather than loud. The conformance
--    suite's `canonical instants` dimension asserts a composition's own output
--    feeds straight back in; `text` makes that unrepresentably true.
--
--    0001 stores its instants as `timestamptz` on purpose and that stays
--    correct: those are cloud-local expiry fields with no cross-composition
--    string contract behind them.
--
-- 2. Byte counts are `bigint`. `byteSize`, `expectedBytes`, `hardLimitBytes`,
--    `releasedBytes` and the whole usage surface are declared `bigint` in
--    `@byok/core`, and the pool installs an int8 parser so they arrive as JS
--    `bigint` rather than strings (packages/cloud-postgres/src/pool.ts).
--    `integer` would put a silent 2^31 ceiling under a storage quota; a string
--    comparison would answer a different question than `>` without throwing.
--
-- Row counts the port types declare as `number` (`rev`, `refCount`, `dropped`,
-- `capacity`) stay `integer` for the same reason in reverse: they are small by
-- contract, and decoding them as `bigint` would force a cast at every boundary.

-- ---------------------------------------------------------------------------
-- device_stream.acked_at — the one column 0001 could not foresee
-- ---------------------------------------------------------------------------
--
-- 0001 created `device_stream.acked_seq` ahead of its consumer precisely so
-- this slice would not have to widen a frozen table. It did not create a
-- companion instant, and `MailboxCursorState` carries a required `updatedAt`
-- (packages/core/src/mailbox.ts). There are exactly three ways to supply it:
-- add the column here, invent a second per-device table that would leave
-- `device_stream.acked_seq` half-owned, or return the reader's own clock and
-- call a value that was never written "the instant the cursor moved".
--
-- The third is a fabricated fact, and the second contradicts the §5 mapping
-- that puts the mailbox cursor on `device_stream`. So: one additive, nullable
-- column. Additive in the forward-only sense -- 0001's bytes are untouched, and
-- a row written before this migration simply has no recorded ack instant until
-- its next `advanceCursor`.
ALTER TABLE device_stream ADD COLUMN acked_at text;

-- ---------------------------------------------------------------------------
-- outbox (core.mailbox) — the hosted mailbox rows
-- ---------------------------------------------------------------------------
--
-- `seq` is allocated from `device_stream.next_seq`, the same allocator
-- `cloud.sequence` uses, because the daemon's redelivery cursor IS that number
-- (0001's note on that table). Gaps are legal and expected: the allocator bumps
-- in its own statement, so a rejected append (a replayed `message_id`) burns a
-- number rather than reusing one. A reused number would make the cursor
-- ambiguous, which is the failure the allocator exists to prevent; a gap is
-- merely a gap.
--
-- `state` carries MAILBOX_MESSAGE_STATES. Deliberately no CHECK constraint
-- restating that list -- the port type is the vocabulary's single authority and
-- a copy here could drift from it silently (the same call 0001 makes for
-- `task.status`).
--
-- UNIQUE (tenant_id, device_id, message_id) is the producer-supplied
-- idempotency key from `MailboxAppendInput`. Tenant-first, so it is not an
-- exception to the rule above: a second append of the same envelope returns the
-- row that already exists instead of enqueuing a duplicate the device would
-- execute twice.
CREATE TABLE outbox (
  tenant_id   text   NOT NULL,
  device_id   text   NOT NULL,
  seq         bigint NOT NULL,
  message_id  text   NOT NULL,
  body        text   NOT NULL,
  body_hash   text   NOT NULL,
  byte_size   bigint NOT NULL,
  state       text   NOT NULL,
  appended_at text   NOT NULL,
  PRIMARY KEY (tenant_id, device_id, seq),
  CONSTRAINT outbox_tenant_device_message_key UNIQUE (tenant_id, device_id, message_id)
);

-- The retention sweep's index: `collectRetired` deletes acked rows older than
-- one cutoff and marks unacked rows older than another, both scoped to a tenant
-- and optionally a device. Not unique -- an index that made
-- (tenant, device, state, instant) unique would forbid two messages appended in
-- the same millisecond.
CREATE INDEX outbox_retention_idx
  ON outbox (tenant_id, device_id, state, appended_at);

-- ---------------------------------------------------------------------------
-- tenant_stream (core.board) — the per-tenant board sequence
-- ---------------------------------------------------------------------------
--
-- `board_seq` is monotonic PER TENANT and bumps on every board mutation, which
-- is what makes `list({ afterSeq })` an incremental feed. A global sequence
-- would work mechanically and leak every other tenant's write rate through the
-- gaps, which is why §12.3 pins it per tenant.
--
-- Allocation is its own statement (`INSERT ... ON CONFLICT DO UPDATE SET
-- board_seq = board_seq + 1 RETURNING board_seq`), deliberately NOT a
-- data-modifying CTE inside the board write it feeds. Two concurrent claims
-- would then lock this row and `board_item` in an order the planner chooses,
-- and two sessions choosing opposite orders is a deadlock. Allocating first, in
-- an autocommitted statement that releases its lock immediately, gives every
-- writer the same lock order and no deadlock edge. The cost is that a rejected
-- board write burns a number -- the same trade `outbox.seq` makes, and for the
-- same reason: monotonic is the contract, gapless is not.
CREATE TABLE tenant_stream (
  tenant_id text   NOT NULL,
  board_seq bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id)
);

-- ---------------------------------------------------------------------------
-- board_item (core.board) — the coordination lifecycle
-- ---------------------------------------------------------------------------
--
-- `status` and `holder_id` are two columns, not one enum, because "where it is"
-- and "who holds it" change independently (§12.3). Every mutation is a
-- compare-and-set expressed as an `UPDATE ... WHERE` guard whose zero-row
-- result is the typed rejection; there is no last-write-wins path, and a loser
-- re-reads the row it lost to so it can re-decide against real state.
--
-- `held_since` is NULL exactly when `holder_id` is NULL: the pair is
-- `BoardAssignee`, and an unheld item has no assignee rather than an assignee
-- with an empty holder.
--
-- No CHECK on `status` -- BOARD_STATUSES and BOARD_TRANSITIONS in
-- packages/core/src/board.ts are the vocabulary's authority, and the legality
-- of a move is a two-value question (from, to) that a column constraint cannot
-- express anyway.
CREATE TABLE board_item (
  tenant_id  text   NOT NULL,
  item_id    text   NOT NULL,
  channel    text   NOT NULL,
  title      text   NOT NULL,
  status     text   NOT NULL,
  holder_id  text,
  held_since text,
  board_seq  bigint NOT NULL,
  created_at text   NOT NULL,
  updated_at text   NOT NULL,
  PRIMARY KEY (tenant_id, item_id)
);

-- The incremental feed's ordering index. Not unique: nothing in the contract
-- promises two items never share a seq, and a unique index here would turn a
-- harmless allocation race into a write failure.
CREATE INDEX board_item_feed_idx ON board_item (tenant_id, board_seq);

-- ---------------------------------------------------------------------------
-- attested_record (core.truth) — two write models, one table
-- ---------------------------------------------------------------------------
--
-- `task.terminal` is first-write-wins and immutable; `profile`/`memory` are
-- per-key snapshots under an `expectedRev` CAS. Both are keyed
-- (tenant_id, kind, subject_id), so the terminal path's "first fact is never
-- overwritten" (§12.6.4) is enforced by the primary key itself:
-- `INSERT ... ON CONFLICT DO NOTHING` plus an equality re-read, never an upsert
-- that would restamp history while passing a naive "write twice" check.
--
-- `subject_id` is the port's `recordKey` -- the task id for a terminal, the
-- host's key for a snapshot. Named for what the column IS rather than for the
-- port's accessor, so `kind` reads as the discriminator it is.
--
-- The body is stored as a discriminated pair rather than as JSON: `body_kind`
-- is 'inline' or 'object', and exactly one of `body_inline` /
-- `body_object_hash` is populated. `TruthBodyRef` is a two-case union in the
-- contract, and a JSON blob here would let the store hold shapes the contract
-- cannot name.
CREATE TABLE attested_record (
  tenant_id        text    NOT NULL,
  kind             text    NOT NULL,
  subject_id       text    NOT NULL,
  rev              integer NOT NULL,
  content_hash     text    NOT NULL,
  byte_size        bigint  NOT NULL,
  body_kind        text    NOT NULL,
  body_inline      text,
  body_object_hash text,
  label            text,
  request_id       text,
  written_at       text    NOT NULL,
  PRIMARY KEY (tenant_id, kind, subject_id)
);

-- ---------------------------------------------------------------------------
-- device_presence (core.presence) — lossy, TTL-bounded hints
-- ---------------------------------------------------------------------------
--
-- One row per device, overwritten on every publish: presence is a hint, not a
-- history, and §12.3 forbids deriving coordination, execution, authorization,
-- billing or recovery state from it.
--
-- `expires_at` is authoritative and expiry means ABSENCE. Reads filter on it
-- rather than deleting the row, so an expired hint is indistinguishable from
-- one that was never written -- and a read path stays a read path. The
-- in-memory reference drops the entry lazily on read; both produce the same
-- observable answer, and only one of them writes to satisfy a `SELECT`.
CREATE TABLE device_presence (
  tenant_id   text NOT NULL,
  device_id   text NOT NULL,
  level       text NOT NULL,
  detail      text,
  observed_at text NOT NULL,
  expires_at  text NOT NULL,
  PRIMARY KEY (tenant_id, device_id)
);

-- ---------------------------------------------------------------------------
-- activity_tail (core.activity) — a bounded, explicitly lossy tail
-- ---------------------------------------------------------------------------
--
-- The whole tail is one row. `entries` is `jsonb` because the tail is read and
-- written as a unit and is bounded by `capacity` -- a row-per-entry table would
-- buy per-entry queries the port does not expose and cost a trim on every
-- append.
--
-- `dropped` is the point of the design: lossiness is IN the data, so a reader
-- can tell "nothing happened" from "we lost the middle" instead of inferring it
-- from a gap it has to notice. The append is a single upsert that recomputes
-- both `entries` and `dropped` from the stored row; a concurrent second append
-- can lose an entry, which is within contract for a store §12.3 declares lossy
-- and non-authoritative, and is emphatically not within contract anywhere else
-- in this file.
CREATE TABLE activity_tail (
  tenant_id  text    NOT NULL,
  task_id    text    NOT NULL,
  entries    jsonb   NOT NULL,
  dropped    integer NOT NULL,
  capacity   integer NOT NULL,
  expires_at text    NOT NULL,
  PRIMARY KEY (tenant_id, task_id)
);

-- ---------------------------------------------------------------------------
-- object_manifest (core.objects) — metadata only, no bytes
-- ---------------------------------------------------------------------------
--
-- The manifest is the transaction authority; the object store holds the payload
-- (§12.7.4, §12.7.8). `pending` exists because Postgres and R2 have no shared
-- transaction: the row is written before the bytes land, and only `committed`
-- rows may be referenced. `delete_pending` is the tombstone the GC worker
-- drives, so a failed object-store delete is retryable instead of leaving usage
-- silently wrong.
--
-- PK (tenant_id, hash) -- never (hash). A global content-address key space
-- would deduplicate better and turn object existence into a cross-tenant
-- oracle, which is why §12.7.4 forbids it. Two tenants holding the same bytes
-- get two rows and are billed twice, on purpose.
--
-- `ref_count` is DERIVED, never incremented: every reference mutation
-- recomputes it as `count(*)` over `object_reference`. An increment can drift
-- -- a retried `addReference` inflates it and strands the object forever, which
-- is exactly the bug the "idempotent per (hash, refKind, refId)" contract
-- exists to prevent. A recomputation cannot.
CREATE TABLE object_manifest (
  tenant_id         text    NOT NULL,
  hash              text    NOT NULL,
  byte_size         bigint  NOT NULL,
  content_type      text    NOT NULL,
  state             text    NOT NULL,
  ref_count         integer NOT NULL DEFAULT 0,
  created_at        text    NOT NULL,
  updated_at        text    NOT NULL,
  delete_pending_at text,
  PRIMARY KEY (tenant_id, hash)
);

-- The GC sweep's index: list by state, and by tombstone age within
-- `delete_pending`. Not unique.
CREATE INDEX object_manifest_state_idx
  ON object_manifest (tenant_id, state, delete_pending_at);

-- ---------------------------------------------------------------------------
-- object_reference (core.objects) — what points at an object
-- ---------------------------------------------------------------------------
--
-- `ref_kind` / `ref_id` are opaque to core. The primary key IS the idempotency
-- contract: re-adding the same reference conflicts instead of double-counting,
-- which is what lets `ref_count` be a recomputation rather than a guess.
CREATE TABLE object_reference (
  tenant_id  text NOT NULL,
  hash       text NOT NULL,
  ref_kind   text NOT NULL,
  ref_id     text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (tenant_id, hash, ref_kind, ref_id)
);

-- ---------------------------------------------------------------------------
-- storage_entitlement (core.quota) — the host-issued numeric entitlement
-- ---------------------------------------------------------------------------
--
-- The SDK does not know what a plan is: no tier name, no price, no currency
-- (§12.7.6, and `packages/core/src/__tests__/constraints.test.ts` asserts the
-- same about the port source). What crosses this boundary is numbers plus a
-- monotonic `version` that is CAS-checked on write, so a delayed control-plane
-- update cannot resurrect an older plan over a newer one.
--
-- `downgrade_grace_until` is a canonical instant compared as a string, per the
-- type note at the top of this file. It is also the column that decides
-- `blocked` (507, over limit but inside grace) from `suspended` (423, over
-- limit and grace has ended), so a comparison that read it differently than the
-- in-memory reference does would change an HTTP status.
CREATE TABLE storage_entitlement (
  tenant_id             text   NOT NULL,
  version               bigint NOT NULL,
  hard_limit_bytes      bigint NOT NULL,
  max_object_bytes      bigint NOT NULL,
  max_inline_bytes      bigint NOT NULL,
  mailbox_limit_bytes   bigint NOT NULL,
  retention_policy_id   text   NOT NULL,
  downgrade_grace_until text,
  PRIMARY KEY (tenant_id)
);

-- ---------------------------------------------------------------------------
-- storage_usage (core.quota) — measured usage
-- ---------------------------------------------------------------------------
--
-- Note what is NOT here: `reserved_bytes`. `TenantStorageUsage.reservedBytes`
-- is DERIVED as `SUM(expected_bytes)` over this tenant's `reserved` rows in
-- `storage_reservation`. A stored counter has to be incremented on reserve and
-- decremented on every one of finalize / abort / expire, and any path that
-- settles a reservation without the matching decrement leaves a tenant
-- permanently short of quota it has actually released. Deriving it makes that
-- class of drift unrepresentable, and it makes settlement a pure state
-- transition on one row.
--
-- One row per entitled tenant, seeded by `writeEntitlement` in the same
-- statement that accepts the entitlement. The invariant that buys:
-- a `storage_usage` row exists whenever a `storage_entitlement` row does, so
-- every accounting write is an `UPDATE` with a guard rather than an upsert that
-- has to restate the guard twice. A tenant with no entitlement reads as all
-- zeros without a row being written for it.
CREATE TABLE storage_usage (
  tenant_id              text   NOT NULL,
  committed_object_bytes bigint NOT NULL DEFAULT 0,
  committed_inline_bytes bigint NOT NULL DEFAULT 0,
  mailbox_bytes          bigint NOT NULL DEFAULT 0,
  object_count           bigint NOT NULL DEFAULT 0,
  updated_at             text   NOT NULL,
  PRIMARY KEY (tenant_id)
);

-- ---------------------------------------------------------------------------
-- storage_reservation (core.quota) — the no-oversell ledger
-- ---------------------------------------------------------------------------
--
-- Reservation exists because Postgres and the object store have no shared
-- transaction (§12.7.7): every durable write reserves first, uploads second,
-- finalizes third, and the invariant
-- `committed + reserved + expected <= hardLimitBytes` is checked at reserve
-- time. Two concurrent uploads must not both pass that check, which is why the
-- admission query runs behind a `FOR UPDATE` on the tenant's entitlement row --
-- see the header of `packages/cloud-postgres/src/stores/core/quota.ts` for why
-- a lone statement cannot get this right under READ COMMITTED.
--
-- `deduplicated` is stored rather than recomputed because
-- `StorageFinalizeResult.deduplicated` has to answer the same way when a
-- finalize is replayed against an already-committed reservation. Recomputing it
-- then would look at a set that now includes this very row and answer `true`
-- for the write that actually added the bytes.
--
-- `settled_at` is NULL exactly while `state = 'reserved'`.
CREATE TABLE storage_reservation (
  tenant_id      text    NOT NULL,
  reservation_id text    NOT NULL,
  state          text    NOT NULL,
  kind           text    NOT NULL,
  expected_bytes bigint  NOT NULL,
  content_hash   text    NOT NULL,
  content_type   text    NOT NULL,
  created_at     text    NOT NULL,
  expires_at     text    NOT NULL,
  settled_at     text,
  deduplicated   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, reservation_id)
);

-- Two non-unique indexes, one per sweep the port performs: the live-reservation
-- sum and the TTL expiry both scan (tenant_id, state), and the per-tenant hash
-- deduplication check scans (tenant_id, content_hash, state).
CREATE INDEX storage_reservation_state_idx
  ON storage_reservation (tenant_id, state, expires_at);

CREATE INDEX storage_reservation_hash_idx
  ON storage_reservation (tenant_id, content_hash, state);
