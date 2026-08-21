-- Host cancellation tombstone and durable delivery identity.
-- Additive and forward-only: existing task rows remain uncancelled.
ALTER TABLE task
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN cancel_reason text,
  ADD COLUMN cancel_message_id text;
