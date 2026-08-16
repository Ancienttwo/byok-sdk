-- Bounded, lossy approval lifecycle observations for host-side projection.
-- This is deliberately separate from activity_tail: approval envelopes have
-- no authoritative order key shared with task.progress batches.
CREATE TABLE approval_timeline_tail (
  tenant_id     text    NOT NULL,
  task_id       text    NOT NULL,
  entries       jsonb   NOT NULL,
  next_revision bigint  NOT NULL,
  dropped       integer NOT NULL,
  capacity      integer NOT NULL,
  expires_at    text    NOT NULL,
  PRIMARY KEY (tenant_id, task_id)
);
