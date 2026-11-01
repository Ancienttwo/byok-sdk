-- #1113 A3: a task's activity log and approval timeline close in the same
-- transaction as the task update that first closes its output, whichever
-- statement writes it: recordStatus, Host cancellation (claimed or not),
-- abandonment, device retirement. The output closes at the task's first
-- terminal instant, or at an accepted Host cancellation, whichever comes
-- first. Admission ends there and each deadline (that instant + ttl) is
-- frozen; reads, replays and later terminals never renew it. An open
-- approval timeline no longer idle-expires.
--
-- Lock order: the updated task row, then its activity_log_head and
-- approval_timeline_tail rows, the same order as redaction and the archive.
-- Append locks only the head or tail. The approval adapter reads terminal_at,
-- so its reads and writes fail until this runs: deploy the two together.

ALTER TABLE approval_timeline_tail ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE approval_timeline_tail ADD COLUMN terminal_at text;
-- The idle expiry goes; every retained observation stays.
UPDATE approval_timeline_tail SET expires_at = NULL;

CREATE FUNCTION task_output_closed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  closed_at timestamptz := COALESCE(NEW.terminal_at, NEW.cancel_requested_at);
  closed_text text := to_char(closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  -- A task that recorded nothing still gets closed rows, so a later append is refused.
  INSERT INTO activity_log_head (tenant_id, task_id) VALUES (NEW.tenant_id, NEW.task_id)
  ON CONFLICT (tenant_id, task_id) DO NOTHING;
  UPDATE activity_log_head
     SET terminal_at = closed_text,
         expires_at = to_char((closed_at + ttl_ms * interval '1 millisecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   WHERE tenant_id = NEW.tenant_id AND task_id = NEW.task_id AND terminal_at IS NULL AND NOT removed;
  INSERT INTO approval_timeline_tail (tenant_id, task_id, entries, next_revision, dropped, capacity)
  VALUES (NEW.tenant_id, NEW.task_id, '[]'::jsonb, 1, 0, 50)
  ON CONFLICT (tenant_id, task_id) DO NOTHING;
  UPDATE approval_timeline_tail
     SET terminal_at = closed_text,
         expires_at = to_char((closed_at + interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   WHERE tenant_id = NEW.tenant_id AND task_id = NEW.task_id AND terminal_at IS NULL;
  RETURN NULL;
END;
$$;

CREATE TRIGGER task_output_closed
AFTER UPDATE OF status, terminal_at, cancel_requested_at ON task
FOR EACH ROW
WHEN (COALESCE(OLD.terminal_at, OLD.cancel_requested_at) IS NULL
  AND COALESCE(NEW.terminal_at, NEW.cancel_requested_at) IS NOT NULL)
EXECUTE FUNCTION task_output_closed();

-- One-shot: a task whose output closed before this migration gets closed
-- rows at its original deadlines, never a new ten minutes. A terminal task
-- from before terminal_at was recorded closes at its last update.
CREATE TEMPORARY TABLE closed_task ON COMMIT DROP AS
SELECT tenant_id, task_id, COALESCE(terminal_at, cancel_requested_at,
  CASE WHEN status IN ('complete', 'failed', 'cancelled') THEN updated_at END) AS closed_at
FROM task;
DELETE FROM closed_task WHERE closed_at IS NULL;

INSERT INTO activity_log_head (tenant_id, task_id)
SELECT tenant_id, task_id FROM closed_task
ON CONFLICT (tenant_id, task_id) DO NOTHING;
UPDATE activity_log_head AS head
   SET terminal_at = to_char(closed.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       expires_at = to_char((closed.closed_at + head.ttl_ms * interval '1 millisecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  FROM closed_task AS closed
 WHERE head.tenant_id = closed.tenant_id AND head.task_id = closed.task_id
   AND head.terminal_at IS NULL AND NOT head.removed;

INSERT INTO approval_timeline_tail (tenant_id, task_id, entries, next_revision, dropped, capacity)
SELECT tenant_id, task_id, '[]'::jsonb, 1, 0, 50 FROM closed_task
ON CONFLICT (tenant_id, task_id) DO NOTHING;
UPDATE approval_timeline_tail AS tail
   SET terminal_at = to_char(closed.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       expires_at = to_char((closed.closed_at + interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  FROM closed_task AS closed
 WHERE tail.tenant_id = closed.tenant_id AND tail.task_id = closed.task_id AND tail.terminal_at IS NULL;

ALTER TABLE approval_timeline_tail
  ADD CONSTRAINT approval_timeline_tail_closed CHECK ((terminal_at IS NULL) = (expires_at IS NULL));
CREATE INDEX approval_timeline_tail_expiry ON approval_timeline_tail (tenant_id, expires_at)
  WHERE expires_at IS NOT NULL AND entries <> '[]'::jsonb;
