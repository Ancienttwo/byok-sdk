-- Atomic single-use ledger for device assertions exchanged by hosted consumers.
-- The durable connector/session credential is host-owned and is not stored here.

CREATE TABLE device_assertion_replay (
  tenant_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  product_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, issuer, product_id, device_id, audience, jti)
);

CREATE INDEX device_assertion_replay_expiry_idx
  ON device_assertion_replay (expires_at);
