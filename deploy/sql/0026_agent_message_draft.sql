-- Display-only snapshots. The accepted Agent message remains product truth.
-- Migrations are forward-only. Roll back the application and let rows expire.
CREATE TABLE agent_message_draft (
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  device_id text NOT NULL,
  agent_ref jsonb NOT NULL,
  -- The wire permits safe integers above the 32-bit integer range.
  revision bigint NOT NULL CHECK (revision >= 1),
  -- JSON string fragment without outer quotes; NUL is escaped, never lost.
  text text NOT NULL,
  byte_count integer NOT NULL CHECK (byte_count >= 0),
  state text NOT NULL CHECK (state IN ('open', 'overflow', 'gap')),
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, task_id)
);
CREATE INDEX agent_message_draft_expiry ON agent_message_draft (expires_at);
