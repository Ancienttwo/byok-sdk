-- #654 E2c: E2EE member state. The Host keeps signed values and ciphertext
-- as the canonical JSON text the writer sent, so a replay compares by bytes.
-- It holds no key and verifies no signature: members do (design §7.3).
-- Migrations are forward-only. Roll back the application; these tables stay.
-- Every instant comes from the injected clock, so no column defaults to now().

-- First writer wins per (tenant_id, seq). The store appends only at head + 1.
CREATE TABLE e2ee_member_chain_entry (
  tenant_id text NOT NULL,
  seq bigint NOT NULL CHECK (seq > 0),
  entry text NOT NULL,
  PRIMARY KEY (tenant_id, seq)
);

-- One bundle per device, one device per member.
CREATE TABLE e2ee_member_key (
  tenant_id text NOT NULL,
  device_id text NOT NULL,
  member_id text NOT NULL,
  bundle text NOT NULL,
  PRIMARY KEY (tenant_id, device_id),
  UNIQUE (tenant_id, member_id)
);

-- The first package of a scope epoch fixes its keyId for every recipient.
-- This row is the one place two concurrent writers of a new epoch meet.
CREATE TABLE e2ee_scope_epoch (
  tenant_id text NOT NULL,
  scope_id text NOT NULL,
  epoch bigint NOT NULL CHECK (epoch > 0),
  key_id text NOT NULL,
  PRIMARY KEY (tenant_id, scope_id, epoch)
);

CREATE TABLE e2ee_scope_key_package (
  tenant_id text NOT NULL,
  scope_id text NOT NULL,
  epoch bigint NOT NULL CHECK (epoch > 0),
  recipient text NOT NULL,
  key_id text NOT NULL,
  sender text NOT NULL,
  package text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, scope_id, epoch, recipient),
  FOREIGN KEY (tenant_id, scope_id, epoch) REFERENCES e2ee_scope_epoch (tenant_id, scope_id, epoch)
);
CREATE INDEX e2ee_scope_key_package_recipient ON e2ee_scope_key_package (tenant_id, recipient);

-- Pairing MACs live for one pairing window. Reads skip an expired row and the
-- next write replaces it, so no sweep is needed. Device cleanup deletes them.
CREATE TABLE e2ee_pairing_mac (
  tenant_id text NOT NULL,
  device_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('device', 'client')),
  body text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, device_id, kind)
);
