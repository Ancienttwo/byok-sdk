-- #1113 A4: lossy, content-free hints that a task's state, activity log or
-- approval timeline changed. The payload is md5(tenant || '\n' || task), never
-- content; readers re-read the sources. PostgreSQL delivers NOTIFY only at
-- commit, rollback emits nothing, and duplicate payloads within one
-- transaction are coalesced. Every writer, in any process and maintenance
-- included, signals through these triggers; there is no application NOTIFY.
-- The listener needs a session-mode DSN (not Hyperdrive/transaction PgBouncer).
-- Trigger-first deployment is harmless; code-first deployment reads at its
-- configured fallback interval until this migration is installed.
CREATE FUNCTION task_events_wake() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('byok_task_events_wake', md5(OLD.tenant_id || E'\n' || OLD.task_id));
  ELSE
    PERFORM pg_notify('byok_task_events_wake', md5(NEW.tenant_id || E'\n' || NEW.task_id));
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER task_events_wake AFTER INSERT OR UPDATE OR DELETE ON task
FOR EACH ROW EXECUTE FUNCTION task_events_wake();
CREATE TRIGGER task_events_wake AFTER INSERT OR UPDATE OR DELETE ON activity_log_head
FOR EACH ROW EXECUTE FUNCTION task_events_wake();
CREATE TRIGGER task_events_wake AFTER INSERT OR UPDATE OR DELETE ON approval_timeline_tail
FOR EACH ROW EXECUTE FUNCTION task_events_wake();
