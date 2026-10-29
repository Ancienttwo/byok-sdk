-- #1115: dead letters get a retention window, and the mailbox quota sum gets
-- an index that matches it.
--
-- 1. `tenant_retention_policy.mailbox_dead_letter_retention_ms` is how long a
--    dead letter (`outbox.state = 'expired'`) stays after it expired. The
--    sweep reaps dead letters appended before
--    now - mailbox_unacked_retention_ms - mailbox_dead_letter_retention_ms,
--    except each device's highest-seq dead letter, which stays as the
--    `recoverableFrom` floor. Existing policies take the 30-day column
--    default. The application always writes the column; the default stays so
--    a rolled-back application, which does not name it, can still write a
--    policy.
--
-- 2. Mailbox quota sums `byte_size` over `pending` rows only (#1132), so
--    0023's `outbox_tenant_bytes_idx` covers rows that sum never reads. It is
--    replaced by a partial covering index on the same key with the pending
--    predicate, which keeps the sum an index-only scan. Nothing else names or
--    relies on the old index: tenant-scoped scans use the primary key or
--    `outbox_retention_idx` (0002).
--
-- `CONCURRENTLY` is not available here: the runner applies each file in one
-- transaction (packages/cloud-dataplane `src/migrate.ts`). Outbox writes wait
-- while the index builds, in time proportional to the pending rows.
-- Migrations are forward-only. Roll back the application; this stays.

ALTER TABLE tenant_retention_policy
  ADD COLUMN mailbox_dead_letter_retention_ms bigint NOT NULL DEFAULT 2592000000;

ALTER TABLE tenant_retention_policy
  DROP CONSTRAINT tenant_retention_policy_nonnegative;

ALTER TABLE tenant_retention_policy
  ADD CONSTRAINT tenant_retention_policy_nonnegative CHECK (
    mailbox_acked_retention_ms >= 0
    AND mailbox_unacked_retention_ms >= 0
    AND mailbox_dead_letter_retention_ms >= 0
    AND request_receipt_retention_ms >= 0
    AND object_orphan_grace_ms >= 0
  );

DROP INDEX outbox_tenant_bytes_idx;

CREATE INDEX outbox_tenant_pending_bytes_idx
  ON outbox (tenant_id) INCLUDE (byte_size)
  WHERE state = 'pending';
