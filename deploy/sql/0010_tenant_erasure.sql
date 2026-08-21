-- 0010_tenant_erasure.sql — package-owned, resumable operator evidence.
--
-- This ledger is deliberately NOT tenant product data. It records one operator
-- operation and its progress so a caller can resume after an R2/database/crash
-- boundary, and a completed receipt remains auditable after every tenant-owned
-- product row and R2 object is gone. The erasure implementation is the only
-- writer; hosts do not receive raw SQL/table-order authority.

CREATE TABLE tenant_erasure_operation (
  tenant_id             text        NOT NULL,
  operation_id          text        NOT NULL,
  state                 text        NOT NULL,
  revision              bigint      NOT NULL DEFAULT 0,
  lease_token           text,
  lease_expires_at      timestamptz,
  r2_cursor             text,
  r2_complete           boolean     NOT NULL DEFAULT false,
  sql_table_index       integer     NOT NULL DEFAULT 0,
  r2_objects_deleted    bigint      NOT NULL DEFAULT 0,
  sql_rows_deleted      bigint      NOT NULL DEFAULT 0,
  started_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  completed_at          timestamptz,
  last_error_code       text,
  PRIMARY KEY (tenant_id, operation_id),
  CONSTRAINT tenant_erasure_operation_state CHECK (state IN ('running', 'completed')),
  CONSTRAINT tenant_erasure_operation_revision_nonnegative CHECK (revision >= 0),
  CONSTRAINT tenant_erasure_operation_sql_table_index_nonnegative CHECK (sql_table_index >= 0),
  CONSTRAINT tenant_erasure_operation_counters_nonnegative CHECK (
    r2_objects_deleted >= 0 AND sql_rows_deleted >= 0
  ),
  CONSTRAINT tenant_erasure_operation_completed_receipt CHECK (
    (state = 'running' AND completed_at IS NULL)
    OR (state = 'completed' AND completed_at IS NOT NULL AND r2_complete)
  )
);

-- At most one unfinished erasure can own a tenant. Completed receipts do not
-- participate, so a future explicitly authorized erasure operation still has
-- an idempotency key of its own without deleting its predecessor's evidence.
CREATE UNIQUE INDEX tenant_erasure_operation_one_running
  ON tenant_erasure_operation (tenant_id)
  WHERE state = 'running';

CREATE INDEX tenant_erasure_operation_readback
  ON tenant_erasure_operation (tenant_id, state, updated_at);
