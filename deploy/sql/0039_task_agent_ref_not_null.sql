-- #1780, step 2 of 2: every task row carries its Agent identity.
--
-- Preflight under the task table lock: a row with a NULL `agent_id` stops the
-- migration before any change and names the count. Each migration file is its
-- own transaction, so 0001-0038 stay applied. A terminal such task is retired
-- by `retireAgentlessTasks` (@byok-sdk/cloud-dataplane), run on this build
-- before rerunning the migrations. A task that is not terminal is settled first
-- on v0.41.0 (cancelTask, abandonTask), the build that matches 0001-0037: this
-- build cannot read it (docs/releases/host-upgrade-next-minor.md).
-- `task_agent_ref_pair` (0012) makes `agent_profile_revision` NULL exactly when
-- `agent_id` is. Locks: ACCESS EXCLUSIVE on `task` until commit; SET NOT NULL
-- scans the table once.

LOCK TABLE task IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  missing bigint;
BEGIN
  SELECT count(*) INTO missing FROM task WHERE agent_id IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION '0039_task_agent_ref_not_null: % task(s) have no Agent identity; nothing was changed. Run retireAgentlessTasks (@byok-sdk/cloud-dataplane) on this build, after settling any that are not terminal on v0.41.0 with cancelTask or abandonTask, then rerun the migrations.', missing;
  END IF;
END;
$$;

ALTER TABLE task ALTER COLUMN agent_id SET NOT NULL;
ALTER TABLE task ALTER COLUMN agent_profile_revision SET NOT NULL;
