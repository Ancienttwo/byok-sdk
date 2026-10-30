# One-shot activity log cutover

Migration `0034_activity_log.sql` replaces `activity_tail` with
`activity_log_head` and `activity_log_entry`. This is a breaking change with
**no row conversion and no pre-cutover progress history carried forward**.
Task, approval, mailbox and terminal-receipt authorities remain intact.
Migration 0033 is reserved for #1164; no placeholder file is created for it.

## One-shot cutover

1. Obtain final A1–A5 acceptance. A2a supplies the Postgres adapter but is not
   an independently deployable or mergeable head of the stack. A2b's in-place
   SQLite step waits for #1164; A3–A5 supply lifecycle/wake/union integration.
2. Inventory external clients and complete the
   [direct-route removal](../../docs/migrations/1113-activity-envelope-only.md).
   Stop all old activity readers/writers and fence old binaries from traffic.
   A TTL drain alone does not establish this boundary.
3. Take the operator's recovery snapshot and explicitly accept loss of the
   bounded old activity history. Apply the normal checksummed migration runner.
   Migration 0034 creates empty log tables and drops `activity_tail` in one
   transaction; a failed migration leaves the prior schema/ledger intact.
4. Start only the accepted new stack. Old batch/event or relay cursors must
   produce a typed gap, not silently reset. An explicit fresh read starts at
   the new generation; there is no fallback to the obsolete table.
5. Verify per-task progress, plaintext artifacts and opaque sealed progress
   through the new log, including a restarted process with the same cursor.
   Confirm count/byte bounds and source fences after eviction; confirm task
   redaction clears content while leaving the removed-history fence, and tenant
   erasure removes both new tables' rows in child-before-parent order.

## Retention and rollback

The log retains at most 1,000 envelope payloads / 4 MiB per task. An entry over
its byte cap is rejected atomically. Payload expiry/eviction leaves source
hashes and revision-floor metadata; the source hash uses the shared C3
comparison projection, so resealing does not defeat idempotency. Tenant quotas
and task retirement are needed to bound task/fence cardinality.

The first terminal deadline is fixed, never renewed. A3 integrates this
store-owned settlement boundary with all canonical lifecycle paths. Do not
mistake the A2a adapter's unit-level settlement for that completed integration.
No migration grants an existing terminal task a new activity lifetime.

There is no application-only rollback after `activity_tail` is dropped. A
rollback requires an operator-approved recovery snapshot under downtime, with
an explicit decision about writes made after cutover, or a forward fix. Never
add a dual reader or reconstruct legacy rows from new entries.

The same unreleased Postgres manifest item also covers migration 0031's
[mailbox dead-letter retention](mailbox-retention.md#expired-rows-and-the-operator-dead-letter-flow).
That policy and the 0032 task archive behavior are unchanged by 0034. Store
acceptance is `accept`: existing databases migrate in place, with the bounded
activity-history loss explicitly described above.

## Verification surface

- Shared contract: `packages/conformance/src/cloud/activity.ts`
- Real Postgres/cutover: `packages/cloud-dataplane/src/__tests__/activity-conformance.test.ts`
- Independent-process restart and byte/count boundaries: `packages/cloud-dataplane/src/__tests__/activity-log-restart.test.ts`
- Concurrent arrival ordering: `packages/cloud-dataplane/src/__tests__/board-concurrency.test.ts`
- Content removal and fences: `task-redaction.test.ts`, `task-archive.test.ts`
- Tenant ownership and plaintext inventory: `tenant-erasure.test.ts`, `hosted-plaintext-inventory.test.ts`

Run with real Postgres/S3 and `BYOK_REQUIRE_DATAPLANE=1`; skipped suites are not
acceptance evidence. The hosted plaintext inventory is `activity_log_entry.body`;
source fences contain hashes, not retained output content.
