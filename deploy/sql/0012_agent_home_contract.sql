-- 0012_agent_home_contract.sql — durable Agent capability and attempt identity.
--
-- Additive only. Existing legacy device/task rows remain valid with NULL
-- Agent fields and therefore cannot accidentally acquire Agent semantics.
-- The hosted gate treats a NULL capability snapshot as unknown and refuses an
-- Agent offer before either a mailbox row or a task attempt is created.

ALTER TABLE device
  ADD COLUMN capabilities jsonb;

ALTER TABLE device
  ADD CONSTRAINT device_capabilities_shape
  CHECK (capabilities IS NULL OR jsonb_typeof(capabilities) = 'array');

ALTER TABLE task
  ADD COLUMN agent_id text,
  ADD COLUMN agent_profile_revision text,
  ADD COLUMN terminal_cause text;

ALTER TABLE task
  ADD CONSTRAINT task_agent_ref_pair
  CHECK ((agent_id IS NULL) = (agent_profile_revision IS NULL));

ALTER TABLE task
  ADD CONSTRAINT task_agent_ref_bounded
  CHECK (
    agent_id IS NULL
    OR (
      octet_length(agent_id) BETWEEN 1 AND 160
      AND octet_length(agent_profile_revision) BETWEEN 1 AND 160
      AND position('/' IN agent_id) = 0
      AND position(E'\\\\' IN agent_id) = 0
      AND position(':' IN agent_id) = 0
      AND agent_id NOT IN ('.', '..')
      AND agent_id !~ '[[:cntrl:]]'
      AND agent_profile_revision !~ '[[:cntrl:]]'
    )
  );
