-- Strict Agent reliability identities.
--
-- A device may host many Agents. The old device-plus-envelope/event primary
-- keys therefore let Agent A suppress Agent B when they independently used
-- the same reliable id. This migration cuts those keys forward: physical facts
-- retain the empty Agent scope, while every Agent-bound caller must supply the
-- exact AgentRef. The empty pair is not an AgentRef and is never a read
-- fallback; it is the explicit keyspace for facts such as conn.hello that have
-- no Agent authority.

ALTER TABLE inbound_dedup
  ADD COLUMN agent_id text NOT NULL DEFAULT '',
  ADD COLUMN agent_profile_revision text NOT NULL DEFAULT '';

ALTER TABLE inbound_dedup
  ADD CONSTRAINT inbound_dedup_agent_scope_shape CHECK (
    (agent_id = '' AND agent_profile_revision = '') OR
    (
      octet_length(agent_id) BETWEEN 1 AND 160
      AND octet_length(agent_profile_revision) BETWEEN 1 AND 160
      AND agent_id !~ '[[:cntrl:]]'
      AND agent_profile_revision !~ '[[:cntrl:]]'
    )
  );

ALTER TABLE inbound_dedup DROP CONSTRAINT inbound_dedup_pkey;
ALTER TABLE inbound_dedup
  ADD PRIMARY KEY (tenant_id, device_id, agent_id, agent_profile_revision, envelope_id);

DROP INDEX inbound_dedup_reclaim_idx;
CREATE INDEX inbound_dedup_reclaim_idx
  ON inbound_dedup (tenant_id, device_id, agent_id, agent_profile_revision, recorded_seq);

ALTER TABLE agent_egress_event DROP CONSTRAINT agent_egress_event_pkey;
ALTER TABLE agent_egress_event
  ADD PRIMARY KEY (tenant_id, device_id, agent_id, agent_profile_revision, event_id);
