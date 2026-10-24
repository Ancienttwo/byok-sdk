-- #654 E5b-2 (owner batch §77a): key packages name the KEM epoch of their
-- recipient (`recipientKemEpoch` in the signed v2 package text), and the Host
-- refuses a package wrapped to a KEM key older than the recipient's latest
-- `rotate` entry on the member chain. The append that stores a `rotate` entry
-- raises its member's floor in the same transaction; a package put compares
-- each recipient's floor under the member's lock.
-- Migrations are forward-only. Roll back the application; these stay.
-- Rolling the application back to 0.30.1 fails closed for v2 packages: its
-- reads accept v1 packages only, so a read that meets a stored v2 package
-- fails with e2ee_member_state_unreadable until the Host is upgraded again.
-- Every instant comes from the injected clock, so no column defaults to now().

-- One row per member that rotated its KEM key. kem_epoch only rises;
-- chain_seq is the seq of the `rotate` entry that set it.
CREATE TABLE e2ee_member_kem_floor (
  tenant_id text NOT NULL,
  member_id text NOT NULL,
  kem_epoch bigint NOT NULL CHECK (kem_epoch > 0),
  chain_seq bigint NOT NULL CHECK (chain_seq > 0),
  PRIMARY KEY (tenant_id, member_id)
);

-- The device's paged read of its own packages of one scope.
CREATE INDEX e2ee_scope_key_package_own_epoch
  ON e2ee_scope_key_package (tenant_id, scope_id, recipient, epoch);
