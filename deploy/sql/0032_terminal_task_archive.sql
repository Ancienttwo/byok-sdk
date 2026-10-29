-- #1120: terminal tasks are archived after a retention window.
--
-- 1. `tenant_retention_policy.terminal_task_archive_ms` is how long a terminal
--    task keeps its bodies, at least mailbox_unacked_retention_ms +
--    mailbox_dead_letter_retention_ms. Each stored policy gets 90 days, or
--    that sum when it is longer; its other columns are not changed. The
--    column is NOT NULL with no default: the application writes it
--    explicitly, and an application from before #1120 cannot write a policy
--    on this schema, so stop those writers before migrating
--    (deploy/runbooks/cloud-cleanup.md).
--
--    Preflight, under the table lock: every stored policy row, referenced by
--    an entitlement or not, must already hold windows the application accepts
--    (each 0 < ms <= 9007199254740991, Number.MAX_SAFE_INTEGER) with a sum of
--    the two mailbox windows that is itself at most 9007199254740991. A row
--    that does not stops the migration before any change and names the
--    tenant and policy; the operator corrects those windows first.
--
-- 2. `task.archive_after` is the instant a terminal task becomes eligible:
--    its terminal instant, set with `terminal_at` from now on. `archived_at`
--    is set by the archive transaction, which replaces the task's bodies with
--    tombstones; the row stays as the task's identity fence and is never
--    deleted. `archive_settled_at` is set once the board item is gone.
--
-- 3. One-shot backfill. A task that ended before 0030 has no `terminal_at`
--    ("not recorded", and it stays that way). Its `updated_at` is never
--    earlier than its terminal instant, so it is used as `archive_after`:
--    such a task is archived no earlier than its real window allows. The
--    UPDATE touches every terminal row stored before this migration, once.
--
-- 4. Two partial indexes give the archive step its two lists: eligible rows
--    by `archive_after`, and archived rows not yet settled.
--
-- Locks and duration. `CONCURRENTLY` is not available here: the runner
-- applies each file in one transaction (packages/cloud-dataplane
-- `src/migrate.ts`). The policy table stays locked until commit; it holds one
-- row per tenant policy. The task ADD COLUMNs are catalog-only. The backfill UPDATE
-- rewrites every terminal task row and holds ROW EXCLUSIVE on `task` with row
-- locks on those rows until commit, so a status write to an already terminal
-- task waits for it; new tasks are not blocked. Each index build scans the
-- `task` heap under a SHARE lock, so task writes wait for it while reads
-- continue. Count first: SELECT count(*) FROM task WHERE status IN
-- ('complete', 'failed', 'cancelled'); deploy/runbooks/cloud-cleanup.md has
-- the procedure. Migrations are forward-only: an application from before
-- #1120 cannot write a retention policy on this schema.

LOCK TABLE tenant_retention_policy IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  rejected text;
BEGIN
  SELECT string_agg(tenant_id || '/' || policy_id, ', ' ORDER BY tenant_id, policy_id) INTO rejected
    FROM tenant_retention_policy
   WHERE NOT (mailbox_acked_retention_ms BETWEEN 1 AND 9007199254740991
     AND mailbox_unacked_retention_ms BETWEEN 1 AND 9007199254740991
     AND mailbox_dead_letter_retention_ms BETWEEN 1 AND 9007199254740991
     AND request_receipt_retention_ms BETWEEN 1 AND 9007199254740991
     AND object_orphan_grace_ms BETWEEN 1 AND 9007199254740991
     AND mailbox_unacked_retention_ms::numeric + mailbox_dead_letter_retention_ms::numeric <= 9007199254740991);
  IF rejected IS NOT NULL THEN
    RAISE EXCEPTION '0032: these retention policies hold a window outside 1..9007199254740991 ms, or unacked plus dead-letter windows above it, so no archive window can cover them: %', rejected;
  END IF;
END $$;

ALTER TABLE tenant_retention_policy ADD COLUMN terminal_task_archive_ms bigint;

UPDATE tenant_retention_policy
   SET terminal_task_archive_ms = GREATEST(7776000000::numeric,
         mailbox_unacked_retention_ms::numeric + mailbox_dead_letter_retention_ms::numeric)::bigint;

ALTER TABLE tenant_retention_policy ALTER COLUMN terminal_task_archive_ms SET NOT NULL;

ALTER TABLE tenant_retention_policy
  DROP CONSTRAINT tenant_retention_policy_nonnegative;

ALTER TABLE tenant_retention_policy
  ADD CONSTRAINT tenant_retention_policy_nonnegative CHECK (
    mailbox_acked_retention_ms >= 0
    AND mailbox_unacked_retention_ms >= 0
    AND mailbox_dead_letter_retention_ms >= 0
    AND request_receipt_retention_ms >= 0
    AND object_orphan_grace_ms >= 0
    AND terminal_task_archive_ms >= 0
  );

ALTER TABLE task ADD COLUMN archive_after timestamptz;
ALTER TABLE task ADD COLUMN archived_at timestamptz;
ALTER TABLE task ADD COLUMN archive_settled_at timestamptz;

UPDATE task
   SET archive_after = COALESCE(terminal_at, updated_at)
 WHERE status IN ('complete', 'failed', 'cancelled');

CREATE INDEX task_archive_eligible_idx
  ON task (tenant_id, archive_after, task_id)
  WHERE archived_at IS NULL AND archive_after IS NOT NULL;

CREATE INDEX task_archive_unsettled_idx
  ON task (tenant_id, task_id)
  WHERE archived_at IS NOT NULL AND archive_settled_at IS NULL;
