-- 0013_agent_egress_contract.sql — first-write-wins reliable Agent egress facts.
--
-- The typed policy never authorizes raw workspace/transcript/artifact bytes to
-- this table. `payload_json` is the daemon's sanitized JSON projection; exact
-- AgentRef, session, cursor, content hash, and cloud receipt identity remain
-- independently addressable so a readback never has to reinterpret an opaque
-- envelope body.

CREATE TABLE agent_egress_event (
  tenant_id              text        NOT NULL,
  device_id              text        NOT NULL,
  event_id               uuid        NOT NULL,
  agent_id               text        NOT NULL,
  agent_profile_revision text        NOT NULL,
  session_ref            text        NOT NULL,
  policy_revision        text        NOT NULL,
  cursor                 bigint      NOT NULL,
  payload_json           jsonb       NOT NULL,
  content_hash           text        NOT NULL,
  byte_count             integer     NOT NULL,
  receipt_id             uuid        NOT NULL,
  recorded_at            timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, device_id, event_id),
  CONSTRAINT agent_egress_event_cursor_positive CHECK (cursor > 0 AND cursor <= 2147483647),
  CONSTRAINT agent_egress_event_byte_count CHECK (byte_count >= 0 AND byte_count <= 262144),
  CONSTRAINT agent_egress_event_hash_shape CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT agent_egress_event_agent_ref_bounded CHECK (
    octet_length(agent_id) BETWEEN 1 AND 160
    AND octet_length(agent_profile_revision) BETWEEN 1 AND 160
    AND agent_id !~ '[[:cntrl:]]'
    AND agent_profile_revision !~ '[[:cntrl:]]'
  ),
  CONSTRAINT agent_egress_event_session_bounded CHECK (
    octet_length(session_ref) BETWEEN 1 AND 512
    AND session_ref !~ '[[:cntrl:]]'
  ),
  CONSTRAINT agent_egress_event_policy_bounded CHECK (
    octet_length(policy_revision) BETWEEN 1 AND 160
    AND policy_revision !~ '[[:cntrl:]]'
  )
);

-- Readback and operational inspection preserve the same tenant/device/session
-- partition as the wire cursor. This is intentionally not unique: event id is
-- the reliable idempotency authority, and cursor is an exact observation.
CREATE INDEX agent_egress_event_cursor_idx
  ON agent_egress_event (tenant_id, device_id, agent_id, agent_profile_revision, session_ref, cursor);
