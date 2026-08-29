-- 0015_device_machine_identity.sql — one physical machine, one active device row.
--
-- Additive only. `machine_id` is the client-hashed physical machine identity
-- from `PairRequest` (protocol §6.1): lowercase hex SHA-256 of the product id
-- and an OS-provided machine identifier, never the raw identifier and never a
-- tenant or product claim. Every device paired before this migration — and
-- every device that cannot identify its machine — keeps a NULL, which is why
-- the uniqueness below is partial rather than a plain unique key: NULLs are
-- not "one shared unidentified machine", they are the absence of the fact.
--
-- The index is the invariant, not the application's good behaviour. Two
-- concurrent pairings from the same machine race on exactly this key, so the
-- second one either supersedes the first inside its own transaction or fails
-- outright. `PostgresDeviceDirectory.register` revokes the prior active rows
-- and inserts in ONE transaction for that reason.

ALTER TABLE device
  ADD COLUMN machine_id text;

ALTER TABLE device
  ADD CONSTRAINT device_machine_id_shape
  CHECK (machine_id IS NULL OR machine_id ~ '^[0-9a-f]{64}$');

-- Tenant-first by construction (§12.6.2 layer 3): the leading column is
-- `tenant_id`, so this key can never become a cross-tenant lookup path — one
-- tenant's machine digest addresses a different key space from another's, even
-- when the same physical machine pairs into both.
CREATE UNIQUE INDEX device_active_machine_key
  ON device (tenant_id, product_id, machine_id)
  WHERE machine_id IS NOT NULL AND NOT revoked;
