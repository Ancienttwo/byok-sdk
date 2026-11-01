-- #1113 A3: a task's activity log closes in the same transaction as the task
-- update that first closes its output, whichever statement writes it:
-- recordStatus, Host cancellation (claimed or not), abandonment, device
-- retirement. The output closes at the task's first terminal instant, or at
-- an accepted Host cancellation, whichever comes first. Admission ends there
-- and the terminal deadline (that instant + ttl_ms) is frozen; reads, replays
-- and later terminals never renew it.
--
-- Lock order: the updated task row, then its activity_log_head row, the same
-- order as redaction and the archive. Append locks only the head.
-- Code-first deployment is safe but leaves admission open until this runs.
CREATE FUNCTION activity_log_output_closed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  closed_at timestamptz := COALESCE(NEW.terminal_at, NEW.cancel_requested_at);
BEGIN
  -- A task that logged nothing still gets a closed head, so a later append is refused.
  INSERT INTO activity_log_head (tenant_id, task_id) VALUES (NEW.tenant_id, NEW.task_id)
  ON CONFLICT (tenant_id, task_id) DO NOTHING;
  UPDATE activity_log_head
     SET terminal_at = to_char(closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         expires_at = to_char((closed_at + ttl_ms * interval '1 millisecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   WHERE tenant_id = NEW.tenant_id AND task_id = NEW.task_id AND terminal_at IS NULL AND NOT removed;
  RETURN NULL;
END;
$$;

CREATE TRIGGER activity_log_output_closed
AFTER UPDATE OF status, terminal_at, cancel_requested_at ON task
FOR EACH ROW
WHEN (COALESCE(OLD.terminal_at, OLD.cancel_requested_at) IS NULL
  AND COALESCE(NEW.terminal_at, NEW.cancel_requested_at) IS NOT NULL)
EXECUTE FUNCTION activity_log_output_closed();

-- One-shot: a task whose output closed before this migration gets a closed
-- head at its original deadline, never a new ten minutes. A terminal task
-- from before terminal_at was recorded closes at its last update.
CREATE TEMPORARY TABLE closed_task ON COMMIT DROP AS
SELECT tenant_id, task_id, COALESCE(terminal_at, cancel_requested_at,
  CASE WHEN status IN ('complete', 'failed', 'cancelled') THEN updated_at END) AS closed_at
FROM task;

INSERT INTO activity_log_head (tenant_id, task_id)
SELECT tenant_id, task_id FROM closed_task WHERE closed_at IS NOT NULL
ON CONFLICT (tenant_id, task_id) DO NOTHING;

UPDATE activity_log_head AS head
   SET terminal_at = to_char(closed.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       expires_at = to_char((closed.closed_at + head.ttl_ms * interval '1 millisecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  FROM closed_task AS closed
 WHERE head.tenant_id = closed.tenant_id AND head.task_id = closed.task_id
   AND closed.closed_at IS NOT NULL AND head.terminal_at IS NULL AND NOT head.removed;
