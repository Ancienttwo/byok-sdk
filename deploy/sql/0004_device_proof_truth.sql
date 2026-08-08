-- 0004_device_proof_truth.sql — S6 device proof key and replay authority.
--
-- Forward-only. Existing device_public_key rows are the identity proof key;
-- this migration projects that already-shipped fact into explicit key id and
-- epoch columns. Runtime verification never supplies a missing default.

ALTER TABLE device
  ADD COLUMN proof_key_id text NOT NULL DEFAULT 'identity',
  ADD COLUMN proof_key_epoch integer NOT NULL DEFAULT 0;

ALTER TABLE device
  ALTER COLUMN proof_key_id DROP DEFAULT,
  ALTER COLUMN proof_key_epoch DROP DEFAULT,
  ADD CONSTRAINT device_proof_key_epoch_nonnegative CHECK (proof_key_epoch >= 0);

-- Dedicated request-bound result authority. The older
-- device_request_receipts table is the frozen protocol terminal seam and lacks
-- device/operation/resource/hash fields; widening or reinterpreting it would
-- create two meanings for one row shape.
CREATE TABLE proof_request_receipt (
  tenant_id       text        NOT NULL,
  device_id       text        NOT NULL,
  request_id      text        NOT NULL,
  operation       text        NOT NULL,
  resource        text        NOT NULL,
  body_sha256     text        NOT NULL,
  body_size       bigint      NOT NULL,
  response_status integer     NOT NULL,
  response_body   text        NOT NULL,
  recorded_at     timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, device_id, request_id),
  CONSTRAINT proof_request_receipt_body_size_nonnegative CHECK (body_size >= 0),
  CONSTRAINT proof_request_receipt_status_range CHECK (
    response_status >= 100 AND response_status <= 599
  )
);

CREATE INDEX proof_request_receipt_recorded_idx
  ON proof_request_receipt (tenant_id, recorded_at);
