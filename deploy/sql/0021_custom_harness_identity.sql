-- Additive custom-harness contract. Existing runtime columns retain their enum meaning.
ALTER TABLE device ADD COLUMN harnesses jsonb;
ALTER TABLE task ADD COLUMN claimed_harness_id text;
ALTER TABLE task ADD CONSTRAINT task_claimed_identity_exclusive
  CHECK (claimed_runtime IS NULL OR claimed_harness_id IS NULL);
