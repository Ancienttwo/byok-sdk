-- Lossy wake hints: delivery/cursor authority remains in outbox.
-- PostgreSQL delivers NOTIFY only at commit; rollback emits nothing. Duplicate
-- tenant/device payloads within one transaction are coalesced by PostgreSQL.
-- The listener needs a session-mode DSN (not Hyperdrive/transaction PgBouncer).
-- Trigger-first deployment is harmless; code-first deployment reads at its
-- configured fallback interval until this migration is installed.
CREATE FUNCTION outbox_mailbox_wake() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('byok_mailbox_wake', md5(NEW.tenant_id || E'\n' || NEW.device_id));
  RETURN NULL;
END;
$$;

CREATE TRIGGER outbox_mailbox_wake
AFTER INSERT ON outbox
FOR EACH ROW WHEN (NEW.state = 'pending')
EXECUTE FUNCTION outbox_mailbox_wake();
