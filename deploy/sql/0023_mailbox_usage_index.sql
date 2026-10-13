-- Mailbox usage is derived from the retained rows (issue #411).
--
-- Mailbox bytes now have one authority: the `outbox` rows themselves. A
-- tenant's usage is `SUM(byte_size)` over every retained row in any state, and
-- a limited append checks `used + new <= mailbox_limit_bytes` in the same
-- serialized unit that inserts the row (packages/cloud-dataplane
-- `stores/core/outbox-writer.ts`). This covering index keeps that sum an
-- index-only scan instead of a heap scan of the tenant's rows.
--
-- `CONCURRENTLY` is not available here: the runner applies each file in one
-- transaction (packages/cloud-dataplane `src/migrate.ts`). Outbox writes are
-- blocked while the index builds; the build is proportional to the retained
-- outbox, so schedule the upgrade accordingly.
--
-- `storage_usage.mailbox_bytes` (0002) is intentionally NOT dropped here. The
-- application no longer reads or writes it, but rollback is "revert the
-- application, leave the tables", and the previous release still reads it. A
-- later migration drops it once no supported rollback target reads it.

CREATE INDEX outbox_tenant_bytes_idx ON outbox (tenant_id) INCLUDE (byte_size);
