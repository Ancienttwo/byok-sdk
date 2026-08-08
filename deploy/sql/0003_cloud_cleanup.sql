-- 0003_cloud_cleanup.sql — S4B-c retention and cross-system GC authority.
--
-- Forward-only and additive. 0001/0002 are immutable and checksum-locked by
-- the migration runner. This file adds no hash-verification state: ADR-024
-- remains authoritative, so cleanup may observe only key/existence/size/type.
--
-- Every table below is tenant-owned and every unique key starts with
-- tenant_id. tests/sql/control_plane_invariants.sql enforces that catalog rule.

-- The host names a retention policy in storage_entitlement. Missing policy is
-- an operator error and cleanup fails closed; there is no hidden default that
-- can delete data under a window nobody selected.
CREATE TABLE tenant_retention_policy (
  tenant_id                    text   NOT NULL,
  policy_id                    text   NOT NULL,
  mailbox_acked_retention_ms   bigint NOT NULL,
  mailbox_unacked_retention_ms bigint NOT NULL,
  request_receipt_retention_ms bigint NOT NULL,
  object_orphan_grace_ms       bigint NOT NULL,
  updated_at                   text   NOT NULL,
  PRIMARY KEY (tenant_id, policy_id),
  CONSTRAINT tenant_retention_policy_nonnegative CHECK (
    mailbox_acked_retention_ms >= 0
    AND mailbox_unacked_retention_ms >= 0
    AND request_receipt_retention_ms >= 0
    AND object_orphan_grace_ms >= 0
  )
);

-- One durable readback row per host-issued job id. The counters are the
-- provider-neutral metrics surface; a deployment may export them to its own
-- telemetry system without making that system the cleanup authority.
CREATE TABLE cleanup_job (
  tenant_id                text   NOT NULL,
  job_id                   text   NOT NULL,
  kind                     text   NOT NULL,
  state                    text   NOT NULL,
  started_at               text   NOT NULL,
  finished_at              text,
  mailbox_deleted_count    bigint NOT NULL DEFAULT 0,
  mailbox_expired_count    bigint NOT NULL DEFAULT 0,
  mailbox_released_bytes   bigint NOT NULL DEFAULT 0,
  reservations_expired     bigint NOT NULL DEFAULT 0,
  ttl_rows_deleted         bigint NOT NULL DEFAULT 0,
  objects_tombstoned       bigint NOT NULL DEFAULT 0,
  objects_deleted          bigint NOT NULL DEFAULT 0,
  object_released_bytes    bigint NOT NULL DEFAULT 0,
  orphan_witnesses_created bigint NOT NULL DEFAULT 0,
  missing_objects          bigint NOT NULL DEFAULT 0,
  shape_drift              bigint NOT NULL DEFAULT 0,
  invalid_object_keys      bigint NOT NULL DEFAULT 0,
  operation_errors         bigint NOT NULL DEFAULT 0,
  error_message            text,
  PRIMARY KEY (tenant_id, job_id)
);

CREATE INDEX cleanup_job_state_idx
  ON cleanup_job (tenant_id, state, started_at);

-- Opaque cursor values only. R2 continuation tokens and manifest hashes are
-- not interchangeable, so cursor_kind is part of the tenant-first key.
CREATE TABLE gc_cursor (
  tenant_id    text NOT NULL,
  cursor_kind  text NOT NULL,
  cursor_value text,
  updated_at   text NOT NULL,
  PRIMARY KEY (tenant_id, cursor_kind)
);

-- `gc_accounted_bytes` records the accounting fact at the moment a manifest
-- becomes a tombstone: committed -> byte_size, pending -> 0. It stays NULL for
-- any legacy/manual delete_pending row whose origin is unknowable, which makes
-- the worker fail closed instead of guessing whether usage should be reduced.
-- It is metadata, not a fifth manifest state.
ALTER TABLE object_manifest
  ADD COLUMN gc_accounted_bytes bigint;

ALTER TABLE object_manifest
  ADD COLUMN gc_accounted_object boolean;

ALTER TABLE object_manifest
  ADD CONSTRAINT object_manifest_gc_accounted_nonnegative
  CHECK (gc_accounted_bytes IS NULL OR gc_accounted_bytes >= 0);

-- Candidate scan: tenant, state and age; the partial predicate keeps live
-- referenced objects out of the maintenance index. Reference rows are still
-- scanned again before tombstoning — ref_count alone is not the safety proof.
CREATE INDEX object_manifest_gc_candidate_idx
  ON object_manifest (tenant_id, state, updated_at, hash)
  WHERE ref_count = 0;
