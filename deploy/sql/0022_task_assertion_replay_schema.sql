-- Replay-key schema discriminator segment (contract §8.2(2), disposition R2-B09).
--
-- `byok-task-assertion-v1` shares this single-use ledger with
-- `byok-device-assertion-v1` rather than getting a second table: one replay
-- authority, one atomicity story, one retention sweep. What the two lanes must
-- NOT share is a key slot — the same `jti` presented under both envelope kinds
-- has to be consumable exactly once per kind, and the two consumption ledgers
-- have to stay distinguishable for audit. So the primary key gains a `schema`
-- segment and becomes
-- `(tenant_id, issuer, product_id, device_id, audience, schema, jti)`.
--
-- The DEFAULT here is a one-shot backfill, not a steady-state fallback: every
-- row that exists when this runs is a device assertion (the task envelope has
-- no writer before this migration), and the default is dropped in the same
-- transaction so every subsequent INSERT must state its lane explicitly. A
-- writer that forgets now fails; it does not silently land in the device lane.

ALTER TABLE device_assertion_replay
  ADD COLUMN schema TEXT NOT NULL DEFAULT 'byok-device-assertion-v1';

ALTER TABLE device_assertion_replay
  ALTER COLUMN schema DROP DEFAULT;

ALTER TABLE device_assertion_replay
  ADD CONSTRAINT device_assertion_replay_schema_shape CHECK (
    schema IN ('byok-device-assertion-v1', 'byok-task-assertion-v1')
  );

ALTER TABLE device_assertion_replay DROP CONSTRAINT device_assertion_replay_pkey;
ALTER TABLE device_assertion_replay
  ADD PRIMARY KEY (tenant_id, issuer, product_id, device_id, audience, schema, jti);
