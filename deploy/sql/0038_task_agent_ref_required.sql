-- #1780: every task attempt carries its Agent identity.
--
-- Up to v0.30.2 the legacy `enqueueOffer` / `enqueueToolsetOffer` wrote task
-- rows with NULL `agent_id` and `agent_profile_revision`. No build since
-- v0.31.0 writes one, and this build reads such a row as an error
-- (`task_attempt_agent_ref_missing`). No Agent identity is invented for them.
--
-- 1. Preflight, under the task table lock: a NULL-identity row that is not
--    terminal (complete, failed, cancelled) stops the migration before any
--    change and names the count. The operator settles or cancels those tasks
--    with the previous build first (docs/releases/host-upgrade-next-minor.md).
--
-- 2. Every terminal NULL-identity row moves, whole, into
--    `task_agentless_retired` and leaves `task`. A NOTICE reports the count.
--    The retired row is the task id's identity fence from now on: the Agent
--    offer reservation refuses an id stored there, in the same statement that
--    would insert it. The task's receipts, mailbox rows, activity and
--    approval history are not touched. `agent_message_admission` cascades on
--    the task row, but no build ever admitted a message for a task without an
--    Agent identity, so the cascade has nothing to remove.
--
-- 3. `task.agent_id` and `task.agent_profile_revision` become NOT NULL.
--
-- A rerun finds nothing to move and the columns already NOT NULL: a no-op.
-- The runner applies this file in one transaction (packages/cloud-dataplane
-- `src/migrate.ts`); a refusal rolls all of it back. Locks: ACCESS EXCLUSIVE on
-- `task` until commit, so task reads and writes wait; SET NOT NULL scans the
-- table once. Count first with the read-only query in the upgrade guide.

LOCK TABLE task IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  live bigint;
BEGIN
  SELECT count(*) INTO live FROM task
   WHERE agent_id IS NULL AND status NOT IN ('complete', 'failed', 'cancelled');
  IF live > 0 THEN
    RAISE EXCEPTION '0038_task_agent_ref_required: % task(s) without an Agent identity are not terminal; nothing was changed. Settle or cancel them with the previous build, then rerun.', live;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS task_agentless_retired (
  LIKE task INCLUDING DEFAULTS,
  retired_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, task_id)
);

DO $$
DECLARE
  retired bigint;
BEGIN
  INSERT INTO task_agentless_retired
  SELECT task.*, now() FROM task WHERE agent_id IS NULL;
  GET DIAGNOSTICS retired = ROW_COUNT;
  DELETE FROM task WHERE agent_id IS NULL;
  RAISE NOTICE '0038_task_agent_ref_required: retired % terminal task(s) without an Agent identity into task_agentless_retired.', retired;
END;
$$;

ALTER TABLE task ALTER COLUMN agent_id SET NOT NULL;
ALTER TABLE task ALTER COLUMN agent_profile_revision SET NOT NULL;
