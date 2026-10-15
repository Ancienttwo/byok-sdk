-- Drop the retired mailbox byte counter (issue #387, follow-up of #411).
--
-- Since 0023 the retained `outbox` rows are the only authority for mailbox
-- bytes, and the application neither reads nor writes
-- `storage_usage.mailbox_bytes`. 0023 kept the column so a rollback to the
-- previous application would still find it. That rollback window is closed by
-- owner decision: this migration removes the column, and an application
-- older than the #424 release (it still reads the column in cleanup) can no
-- longer run against this schema. See deploy/runbooks/cloud-cleanup.md
-- "Rollback and usage rebuild" for the operator step before such a rollback.

ALTER TABLE storage_usage DROP COLUMN mailbox_bytes;
