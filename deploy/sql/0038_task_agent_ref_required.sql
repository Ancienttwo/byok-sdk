-- #1780, step 1 of 2: the fence for task ids retired without an Agent identity.
--
-- Up to v0.30.2 the legacy `enqueueOffer` / `enqueueToolsetOffer` wrote task
-- rows with NULL `agent_id` and `agent_profile_revision`; no build since
-- v0.31.0 writes one, and this build reads such a row as an error
-- (`task_attempt_agent_ref_missing`). After this file, the operator runs
-- `retireAgentlessTasks` (@byok-sdk/cloud-dataplane): it archives each terminal
-- such task as the archive step does, removes its board item, and moves its
-- row, whole, into this table. A retired row is the task id's identity fence:
-- the Agent offer reservation refuses an id stored here, in the statement that
-- would insert it. 0039 then makes the task Agent columns NOT NULL.
-- docs/releases/host-upgrade-next-minor.md has the procedure.

CREATE TABLE task_agentless_retired (
  LIKE task INCLUDING DEFAULTS,
  retired_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, task_id)
);
