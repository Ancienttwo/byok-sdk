-- Durable first-message admission serialized with task cancellation.
--
-- This one row records both the admission and the immutable final disposition:
-- exactly one new agent.message.publish may cross from a live task into the
-- product consumer. A pending row is deliberately fail-closed: elapsed time
-- cannot prove that an external consumer stopped, so retries never invoke it
-- again or synthesize a terminal result. The task row is locked by the
-- application transaction before inserting here, so cancellation and first
-- message admission have one durable winner.

CREATE TABLE agent_message_admission (
  tenant_id text NOT NULL,
  device_id text NOT NULL,
  task_id text NOT NULL,
  message_id text NOT NULL,
  payload_body text NOT NULL,
  terminal_body text,
  PRIMARY KEY (tenant_id, device_id, task_id),
  UNIQUE (tenant_id, device_id, message_id),
  FOREIGN KEY (tenant_id, task_id)
    REFERENCES task (tenant_id, task_id)
    ON DELETE CASCADE
);
