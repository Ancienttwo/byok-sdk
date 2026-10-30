-- #1113 A2a. Apply only with old activity writers/readers stopped.
-- No conversion: pre-cutover activity history is intentionally discarded.
-- 0033 is reserved for the independently held #1164 migration.
CREATE TABLE activity_log_head (
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  generation text NOT NULL DEFAULT gen_random_uuid()::text,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  floor bigint NOT NULL DEFAULT 0 CHECK (floor >= 0 AND floor <= revision),
  dropped bigint NOT NULL DEFAULT 0 CHECK (dropped BETWEEN 0 AND 9007199254740991),
  source_dropped bigint NOT NULL DEFAULT 0 CHECK (source_dropped BETWEEN 0 AND 9007199254740991),
  capacity integer NOT NULL DEFAULT 1000 CHECK (capacity BETWEEN 1 AND 1000),
  byte_capacity integer NOT NULL DEFAULT 4194304 CHECK (byte_capacity BETWEEN 1 AND 4194304),
  retained_bytes integer NOT NULL DEFAULT 0 CHECK (retained_bytes BETWEEN 0 AND byte_capacity),
  ttl_ms integer NOT NULL DEFAULT 600000 CHECK (ttl_ms BETWEEN 1 AND 600000),
  terminal_at text,
  expires_at text,
  removed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, task_id),
  CHECK ((terminal_at IS NULL) = (expires_at IS NULL))
);
CREATE INDEX activity_log_expiry ON activity_log_head (tenant_id, expires_at, task_id)
  WHERE retained_bytes > 0 AND expires_at IS NOT NULL;

-- A null body is the immutable source identity fence after eviction/expiry.
CREATE TABLE activity_log_entry (
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  source_envelope_id text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  body jsonb,
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 0 AND 4194304),
  PRIMARY KEY (tenant_id, task_id, revision),
  UNIQUE (tenant_id, task_id, source_envelope_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES activity_log_head (tenant_id, task_id) ON DELETE CASCADE,
  CHECK ((body IS NULL AND byte_size = 0) OR (body IS NOT NULL AND byte_size > 0))
);
CREATE INDEX activity_log_retained ON activity_log_entry (tenant_id, task_id, revision) WHERE body IS NOT NULL;
DROP TABLE activity_tail;
