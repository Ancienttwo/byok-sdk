-- Agent reliability identities are exact to the attempt's AgentRef. The
-- task-bound primary key already supplies that authority through `task`; a
-- device-wide message-id uniqueness constraint would instead let one Agent
-- suppress another active Agent on the same device.

ALTER TABLE agent_message_admission
  DROP CONSTRAINT agent_message_admission_tenant_id_device_id_message_id_key;
