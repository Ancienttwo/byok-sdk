-- 0014_agent_memory_projection.sql — bounded hosted Agent-memory projection.
--
-- The head is one redacted, bounded snapshot per (tenant, agent). It is not a
-- transcript, audit log, or raw-source store: replacing it discards the prior
-- bytes in the same transaction that records the accepted metering receipt.
-- The receipt deliberately has no body column, so durable metering cannot
-- become a second content authority.

CREATE TABLE agent_memory_projection_head (
  tenant_id              text        NOT NULL,
  agent_id               text        NOT NULL,
  writer_epoch           integer     NOT NULL,
  source_seq             integer     NOT NULL,
  mutation_id            uuid        NOT NULL,
  device_id              text        NOT NULL,
  task_id                text        NOT NULL,
  agent_profile_revision text        NOT NULL,
  session_ref            text        NOT NULL,
  runtime_id             text        NOT NULL,
  grant_ref              text        NOT NULL,
  policy_revision        text        NOT NULL,
  redacted_hash          text        NOT NULL,
  redacted_snapshot      bytea       NOT NULL,
  redacted_byte_count    integer     NOT NULL,
  committed_at           timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, agent_id),
  CONSTRAINT agent_memory_projection_head_epoch_positive
    CHECK (writer_epoch > 0),
  CONSTRAINT agent_memory_projection_head_seq_positive
    CHECK (source_seq > 0),
  CONSTRAINT agent_memory_projection_head_snapshot_bounded
    CHECK (
      redacted_byte_count >= 0
      AND redacted_byte_count <= 524288
      AND octet_length(redacted_snapshot) = redacted_byte_count
    ),
  CONSTRAINT agent_memory_projection_head_hash_shape
    CHECK (redacted_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT agent_memory_projection_head_agent_bounded
    CHECK (
      octet_length(agent_id) BETWEEN 1 AND 160
      AND agent_id !~ '[[:cntrl:]]'
      AND octet_length(agent_profile_revision) BETWEEN 1 AND 160
      AND agent_profile_revision !~ '[[:cntrl:]]'
    ),
  CONSTRAINT agent_memory_projection_head_binding_bounded
    CHECK (
      octet_length(device_id) BETWEEN 1 AND 160
      AND device_id !~ '[[:cntrl:]]'
      AND octet_length(task_id) BETWEEN 1 AND 2048
      AND octet_length(session_ref) BETWEEN 1 AND 512
      AND session_ref !~ '[[:cntrl:]]'
      AND octet_length(runtime_id) BETWEEN 1 AND 160
      AND runtime_id !~ '[[:cntrl:]]'
      AND octet_length(grant_ref) BETWEEN 1 AND 512
      AND grant_ref !~ '[[:cntrl:]]'
      AND octet_length(policy_revision) BETWEEN 1 AND 160
      AND policy_revision !~ '[[:cntrl:]]'
    )
);

-- Metering retains immutable acceptance facts but no body. A sequence key is
-- unique within one writer epoch; mutation_id is independently unique there so
-- a reused mutation cannot silently account for two sequence positions.
CREATE TABLE agent_memory_projection_metering_receipt (
  tenant_id           text        NOT NULL,
  agent_id            text        NOT NULL,
  writer_epoch        integer     NOT NULL,
  source_seq          integer     NOT NULL,
  mutation_id         uuid        NOT NULL,
  device_id           text        NOT NULL,
  task_id             text        NOT NULL,
  agent_profile_revision text     NOT NULL,
  session_ref         text        NOT NULL,
  runtime_id          text        NOT NULL,
  grant_ref           text        NOT NULL,
  policy_revision     text        NOT NULL,
  redacted_hash       text        NOT NULL,
  redacted_byte_count integer     NOT NULL,
  metering_receipt_id uuid        NOT NULL,
  recorded_at         timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, agent_id, writer_epoch, source_seq),
  UNIQUE (tenant_id, agent_id, writer_epoch, mutation_id),
  CONSTRAINT agent_memory_projection_metering_epoch_positive
    CHECK (writer_epoch > 0),
  CONSTRAINT agent_memory_projection_metering_seq_positive
    CHECK (source_seq > 0),
  CONSTRAINT agent_memory_projection_metering_bytes_bounded
    CHECK (redacted_byte_count >= 0 AND redacted_byte_count <= 524288),
  CONSTRAINT agent_memory_projection_metering_hash_shape
    CHECK (redacted_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT agent_memory_projection_metering_agent_bounded
    CHECK (
      octet_length(agent_id) BETWEEN 1 AND 160
      AND agent_id !~ '[[:cntrl:]]'
      AND octet_length(agent_profile_revision) BETWEEN 1 AND 160
      AND agent_profile_revision !~ '[[:cntrl:]]'
    ),
  CONSTRAINT agent_memory_projection_metering_binding_bounded
    CHECK (
      octet_length(device_id) BETWEEN 1 AND 160
      AND device_id !~ '[[:cntrl:]]'
      AND octet_length(task_id) BETWEEN 1 AND 2048
      AND octet_length(session_ref) BETWEEN 1 AND 512
      AND session_ref !~ '[[:cntrl:]]'
      AND octet_length(runtime_id) BETWEEN 1 AND 160
      AND runtime_id !~ '[[:cntrl:]]'
      AND octet_length(grant_ref) BETWEEN 1 AND 512
      AND grant_ref !~ '[[:cntrl:]]'
      AND octet_length(policy_revision) BETWEEN 1 AND 160
      AND policy_revision !~ '[[:cntrl:]]'
    )
);

CREATE INDEX agent_memory_projection_metering_receipt_readback
  ON agent_memory_projection_metering_receipt (tenant_id, agent_id, writer_epoch, source_seq);
