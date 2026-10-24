-- #654 E5b-1: scopes the member chain shredded (design §11.2, owner batch
-- §50h A). The append that stores a `shred` entry deletes the scope's key
-- packages and epochs and inserts this row in one transaction. A later
-- package put for the scope is refused. The first shred of a scope keeps its
-- seq; the shred's audit receipt is in device_request_receipts.
-- Migrations are forward-only. Roll back the application; this table stays.
CREATE TABLE e2ee_scope_shred (
  tenant_id text NOT NULL,
  scope_id text NOT NULL,
  chain_seq bigint NOT NULL CHECK (chain_seq > 0),
  PRIMARY KEY (tenant_id, scope_id)
);
