-- 0001_cloud_local.sql — the seven cloud-local port tables.
--
-- Frozen at merge. Migrations are forward-only (sprint S4A.6): a correction is
-- a NEW file, never an edit to this one, and the runner enforces that by
-- checksumming every applied file against its ledger row
-- (packages/cloud-postgres/src/migrate.ts).
--
-- Key design follows docs/researches/s4a-dataplane-design.md §5 and the
-- tenant-first discipline in docs/architecture/sdk-architecture.md §12.6.2.
-- The rule this file is written to obey:
--
--   EVERY unique index or constraint on a tenant-owned table starts with
--   tenant_id.
--
-- A naked unique key is what turns "look up by id, then check the tenant" into
-- a reachable code path; when the first column is tenant_id, a cross-tenant
-- read addresses a different key space and finds nothing rather than finding a
-- row it then has to be trusted to reject. Two exceptions are whitelisted
-- below, each justified at its table, and both of them are single-step
-- pre-tenant resolutions of a CLOUD-MINTED credential — never a two-step
-- compare. S4A-b lifts that rule into an executable catalog assertion in
-- tests/sql/control_plane_invariants.sql with the same two-entry whitelist.
--
-- Timestamps are timestamptz. Every instant written here comes from the
-- composition's injected clock rather than the database's now(), so TTL
-- behavior is assertable under a test clock instead of requiring the suite to
-- sleep. The migration ledger's own applied_at is the one exception, and it is
-- not port state.

-- ---------------------------------------------------------------------------
-- devices (cloud.devices) — the device directory
-- ---------------------------------------------------------------------------
--
-- UNIQUE (device_id) is the first whitelisted exception. deviceId is minted by
-- the cloud (`packages/cloud/src/auth/plane.ts` mints `dev_<uuid>`) and is
-- never a wire field a device can choose, so global uniqueness is
-- constructive rather than assumed. It backs `resolveByDeviceId`, one of the
-- three pre-tenant methods `stores/ports.ts` documents: POST /byok/challenge
-- and POST /byok/token carry only a deviceId, and the row this returns CARRIES
-- its tenant, so every step after it is tenant-first.
--
-- If a future protocol ever let a device choose its own id, this constraint
-- becomes a cross-tenant denial of service (one tenant claiming another's id)
-- and would have to go. It is safe only because of the minting rule above.
CREATE TABLE device (
  tenant_id         text    NOT NULL,
  device_id         text    NOT NULL,
  product_id        text    NOT NULL,
  device_name       text    NOT NULL,
  device_public_key text    NOT NULL,
  revoked           boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, device_id),
  CONSTRAINT device_device_id_key UNIQUE (device_id)
);

-- ---------------------------------------------------------------------------
-- pairing_code (cloud.pairingCodes) — single-use tenant-bearing credentials
-- ---------------------------------------------------------------------------
--
-- PRIMARY KEY (code) is the second whitelisted exception, and here the naked
-- key is the point: the code IS the tenant lookup. It was minted out-of-band by
-- the host's control plane, which is the only party that knows which tenant a
-- human is acting for, and `PairRequest` has no tenant field at all — so a
-- device can never name the tenant it lands in. The row carries tenant_id, so
-- redemption resolves the tenant in one step.
--
-- redeemed_at doubles as the consumption guard: redemption is a single
-- `UPDATE ... WHERE redeemed_at IS NULL` whose zero-row result is the typed
-- rejection. A read-then-write would let two concurrent redemptions both
-- observe an unused code, and single-use is exactly what makes the caller's
-- "redeem, then register the device" sequence exclusive.
CREATE TABLE pairing_code (
  code        text        PRIMARY KEY,
  tenant_id   text        NOT NULL,
  product_id  text        NOT NULL,
  expires_at  timestamptz NOT NULL,
  redeemed_at timestamptz
);

-- ---------------------------------------------------------------------------
-- auth_nonce (cloud.nonces) — single-use challenge nonces
-- ---------------------------------------------------------------------------
--
-- No index on nonce alone: a nonce is only ever validated for the (tenant,
-- device) it was issued to, so a global lookup would be a capability nothing
-- needs and a leaked nonce could otherwise be probed against. `markUsed`
-- addresses (tenant_id, nonce), which the primary key's leading column already
-- serves.
CREATE TABLE auth_nonce (
  tenant_id  text        NOT NULL,
  device_id  text        NOT NULL,
  nonce      text        NOT NULL,
  expires_at timestamptz NOT NULL,
  used       boolean     NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, device_id, nonce)
);

-- ---------------------------------------------------------------------------
-- inbound_dedup (cloud.dedup) — bounded at-most-once processing
-- ---------------------------------------------------------------------------
--
-- The wire is at-least-once (docs/protocol.md §9), so this table makes
-- processing at-most-once. recorded_seq exists to make the retention bound
-- expressible: reclaim deletes everything older than the newest N rows for a
-- device, oldest first, so the ids most likely to be redelivered are the ones
-- still remembered. Without an insertion order there is no defensible answer to
-- "which row do I drop", and an unbounded set lets one chatty device grow the
-- table without limit.
CREATE TABLE inbound_dedup (
  tenant_id    text      NOT NULL,
  device_id    text      NOT NULL,
  envelope_id  text      NOT NULL,
  recorded_seq bigserial NOT NULL,
  PRIMARY KEY (tenant_id, device_id, envelope_id)
);

-- Tenant-first, and it is the reclaim's ordering index — not a unique one.
CREATE INDEX inbound_dedup_reclaim_idx
  ON inbound_dedup (tenant_id, device_id, recorded_seq);

-- ---------------------------------------------------------------------------
-- task (cloud.tasks) — the ownership authority the inbound gate reads
-- ---------------------------------------------------------------------------
--
-- owner_device_id is NULL until the first claim, and the claim is a single
-- `UPDATE ... WHERE owner_device_id IS NULL` so that two devices racing the
-- same offer produce one owner rather than a last writer. Ownership never
-- transfers: an owner reassignment is the one operation that would make the
-- gate's cross-device assertion unfalsifiable.
--
-- status carries the values in TASK_ATTEMPT_STATUSES. Deliberately no CHECK
-- constraint restating that list: the port type is the vocabulary's single
-- authority, and a copy here could drift from it silently.
CREATE TABLE task (
  tenant_id       text        NOT NULL,
  task_id         text        NOT NULL,
  device_id       text        NOT NULL,
  owner_device_id text,
  status          text        NOT NULL,
  updated_at      timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, task_id)
);

-- ---------------------------------------------------------------------------
-- device_request_receipts (cloud.receipts) — the terminal idempotency seam
-- ---------------------------------------------------------------------------
--
-- First write wins, expressed as `INSERT ... ON CONFLICT DO NOTHING`. The first
-- terminal a device reports is the fact (§12.6.4: 不覆写第一份事实), and the
-- retry that the at-least-once wire guarantees must not restamp it. An upsert
-- that updated would pass a naive "record twice" check while rewriting history.
CREATE TABLE device_request_receipts (
  tenant_id   text        NOT NULL,
  key         text        NOT NULL,
  body        text        NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

-- ---------------------------------------------------------------------------
-- device_stream (cloud.sequence, and S4A-b's mailbox cursor)
-- ---------------------------------------------------------------------------
--
-- next_seq is the delivery number allocator: `cloud.sequence.next` bumps it in
-- one statement and returns the pre-bump value, so concurrent allocations
-- cannot hand out the same number twice. The daemon's redelivery cursor IS this
-- number, and two envelopes sharing one make the cursor ambiguous.
--
-- acked_seq belongs to core.mailbox, which S4A-b implements. It is created HERE
-- anyway, on purpose: this file is frozen at merge, and a later slice adding a
-- column would have to either ALTER a frozen file or open 0002 to widen a table
-- 0001 already owns. Creating the row's full shape once costs one unused column
-- for one slice and avoids both.
--
-- next_seq/acked_seq are bigint, not int: a per-device delivery counter that
-- wraps is a redelivery bug, and the pool decodes int8 to a JS bigint (see
-- packages/cloud-postgres/src/pool.ts) rather than to a string.
CREATE TABLE device_stream (
  tenant_id  text   NOT NULL,
  device_id  text   NOT NULL,
  next_seq   bigint NOT NULL DEFAULT 1,
  acked_seq  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, device_id)
);
