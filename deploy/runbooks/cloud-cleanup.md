# Cloud cleanup and reconciliation

Operational contract for S4B-c on the Postgres + R2 composition. Authorities:
`deploy/sql/0003_cloud_cleanup.sql`, `PostgresCloudCleanup`, architecture
§12.7.5–§12.7.8, and ADR-024.

## Preconditions and scheduler

1. Apply the ordered migrations and write the tenant's retention policy.
   `storage_entitlement.retention_policy_id` selects that policy. A missing
   policy fails with `cleanup_policy_missing`; an invalid stored duration fails
   the policy read with `cleanup_invalid_input`.
2. Bind real bytes into the serving core composition:
   `createPostgresCoreStores({ pool, clock, objectStorage })` accepts the same
   immutable R2 configuration/key prefix as the blob store. Standalone
   `PostgresObjectStore` construction requires a physical deletion authority.
3. Call the kernel from one hosted scheduler per tenant:

```ts
import { PostgresRetentionPolicyStore } from '@byok-sdk/cloud-dataplane/runtime';

const policies = new PostgresRetentionPolicyStore(pool, clock);
const policy = await policies.readRetentionPolicy(tenant);
const report = await cloud.runMaintenance({ tenant, now, policy, limit: 500 });
```

There is no policy translator: `TenantRetentionPolicyInput` extends the kernel
`RetentionPolicy`. Its fields are positive bigint milliseconds:
`mailboxAckedRetentionMs` (default 24h), `mailboxUnackedRetentionMs` (7d),
`mailboxDeadLetterRetentionMs` (30d), `requestReceiptRetentionMs` (24h),
`objectOrphanGraceMs` (24h). The reference
server uses these defaults every 5 minutes ±20%, always enabled. Hosted code
supplies the stored policy directly and owns scheduling.

The fixed steps are mailbox, receipts, nonces, pairing codes, presence,
activity, approvals, device assertion replay, quota and objects. Each receives
one positive limit (kernel range 1–5000, default 500), mutates at most that many
distinct rows/objects, and reports an actual eligible remainder. Steps commit
independently; one failure does not suppress the others. The kernel does not
loop on `more`; the Host may schedule further bounded passes.

`runTenant` and its job writer are removed. The installed `cleanup_job` schema
has no writer and is not maintenance authority. Drop it only in a later forward
migration after no supported Host consumes its historical rows.

## What a pass may collect

- Acked mailbox rows past policy are deleted; old pending rows become dead
  letters. A dead letter stays queryable for `mailboxDeadLetterRetentionMs`
  after it expired (cutoff on `appended_at`: now minus the unacked plus the
  dead-letter window), then it is deleted, except each device's highest-seq
  dead letter, which stays as that device's `recoverableFrom` floor. Reaped
  dead letters count in `removed`. One budget covers the pass: acked deletes
  first, then dead-letter reaps, then new expiries. Mailbox collection reports
  `releasedBytes: 0n` and touches no usage counter.
- Spent or strictly expired nonces, strictly expired **unused** pairing codes,
  and expired presence/activity/approval tails are deleted. Redeemed pairing
  codes remain protected identity state: all drivers require the code row to
  reach their completion fence. They are removed by tenant erasure.
- The quota step expires reserved admissions first, reporting their released
  `expectedBytes`, then removes old eligible settled rows with the remaining
  budget. Deleting a settled row releases no additional bytes.
- The object step retries tombstones and fills remaining slots with eligible
  orphans. It deletes bytes and settles accounted object bytes/count once.
  Its `expired` count is zero and `removed` counts settled objects.

Receipt classification has one frozen kernel table: all 11 SDK families and
unknown keys are `identity`. `REQUEST_RECEIPT_PREFIXES` is derived and empty,
so production receipt collection removes zero rows. There is no caller prefix
argument, registration hook or constructor injection. Request/completion names
alone do not make a receipt disposable. Task identity fences, egress, truth,
memory and profile remain outside automatic collection.

The `tasks` step (#1120) archives terminal tasks whose `archive_after` is older
than the policy's `terminalTaskArchiveMs` (default 90 days; the policy store
refuses less than the unacked plus dead-letter windows). In one transaction per
task it tombstones the offer and terminal receipts, the Agent message
admission and the acked or expired mailbox bodies, fences an absent terminal
receipt, deletes the ephemeral rows and the task's object references, and sets
`archived_at`. It never deletes a mailbox row, so each device's recovery-floor
dead letter stays. The object step reclaims the released objects after orphan
grace. Then the board item is removed and `archive_settled_at` is set; a crash
before that leaves `archived_at` set, and the next run settles the task before
it archives new ones. The task row and the tombstoned receipts stay forever as
the task's identity fence, about 1.2 KB of heap per task plus index entries
(the `task` row, three tombstone receipts and, for an Agent message task, its
admission row); tenant deletion is the only way to remove them. Archived
tasks leave the board, and their content reads fail with
`task_content_redacted`.

`ByokCloudOptions.proofReceiptRetention` is required: the `proofReceipts` step
always runs. Pass `PostgresProofReceiptRetentionAuthority`.

Device assertion replay lives outside the ordinary cloud store bundle. Pass
the exact auth authority as `ByokCloudOptions.deviceAssertionReplay` to collect
it. An absent authority reports `not-configured` without count fields; it does
not report fake zero success or make the overall maintenance event fail.

## Tombstone and crash recovery

The state sequence remains the four existing states:

`pending|committed → delete_pending → deleted`

At tombstone time, Postgres records whether the manifest contributed committed
bytes/object count. The collector holds that manifest row under `FOR UPDATE` across R2 DELETE; only then does one Postgres statement
move the tombstone to `deleted` and reduce usage. A zero-byte committed object still reduces object count once. Same-hash state
writers/recreation wait on this lock; unrelated tenant admission does not. The
maintenance R2 adapter aborts each HTTP attempt after `requestTimeoutMs`
(default 10000ms), with the existing three-attempt retry/backoff bound.

| Crash | Durable readback | Next pass |
| --- | --- | --- |
| before tombstone | original manifest and R2 object | re-evaluate eligibility |
| after tombstone, before DELETE | `delete_pending`, usage unchanged | retry DELETE |
| DELETE succeeded, response/DB failed | `delete_pending`, R2 absent | DELETE replay succeeds (S3 may return 204 or 404), then settle once |
| after settlement | `deleted`, usage reduced | no longer selected |

An R2 key with no manifest is never deleted from a LIST result. A valid
tenant/hash key first becomes a new `pending` witness with the observed
size/type and must age through a fresh grace. An invalid key is counted as
drift and requires operator action; cleanup will not invent a hash identity.

## Reconciliation and ADR-024

Manifest scan uses HEAD to detect missing objects and observed size/type drift.
R2 scan uses tenant-prefixed ListObjectsV2 and an opaque persisted cursor. A
truncated XML page without a continuation token fails the operator call; there is no
restart-from-page-one or alternate-parser fallback.

HEAD does not verify SHA-256. The worker does not read bytes back, does not add
checksum headers/fallbacks, and cannot detect a same-size/type substitution.
That is the accepted tenant-internal risk in ADR-024.

## Reports, fairness and operator reconciliation

Use `MaintenanceReport.steps` and `observer.onMaintenance` as the current
counts-only readback. The server emits `maintenance.completed`, or
`maintenance.failed` if any step failed. Failed object collection includes
`committed` counts plus `failedRows`; failed deletions retain tombstones. A
step-level fault reports `failedRows: 0`. Counts and `more` are omitted when
unknown; a failed final remainder probe preserves already committed counts.
Report tenant, step, counts, bytes and typed error code, never object keys or
bodies. Alert on any expired mailbox work, repeated failed steps, or a growing
`more` backlog that the configured schedule cannot drain.

Object work uses one distinct-object budget. It tries `delete_pending` hashes
after the delete cursor, then fresh orphans, then wrapped tombstones with any
unused slots. The cursor advances only over retries, or resets when no retry
was selected. This gives both poisoned tombstones and fresh orphans progress,
even at limit one. PG persists the existing `gc_cursor`; embedded cursors are
process-local.

`maintenance.reconcileObjectStorage(tenant)` remains an explicit operator
API. It scans manifests with HEAD, scans R2 with its persisted LIST cursor,
and returns missing/shape-drift/untracked-key counters. Missing or malformed
keys do not authorize deletion; an untracked valid object becomes a fresh
pending witness and waits grace before kernel GC can collect it. Reconciliation
is distinct from the scheduled ten-step pass. `rebuildObjectUsage` and the
list/replay/discard dead-letter APIs remain explicit operator operations.

Support inspection:

```sql
SELECT hash, state, ref_count, updated_at, delete_pending_at,
       gc_accounted_bytes, gc_accounted_object
  FROM object_manifest
 WHERE tenant_id = $1 AND state IN ('delete_pending', 'committed')
 ORDER BY updated_at, hash;
```

## Dead-letter operator surface

`listDeadLetters` pages `expired` rows: every dead letter until its grace
passes, then each device's highest-seq dead letter. `replayDeadLetter` requires an
operator-issued idempotency key, clones the original bytes to a new monotonic
sequence, binds the new row to the exact source via `replay_source_seq`, and
keeps the original as evidence. The clone is a limited mailbox append: it is
refused with `storage_quota_exceeded` when it does not fit `mailboxLimitBytes`,
and with `storage_entitlement_missing` when the tenant has no entitlement.
`discardDeadLetter` is the only explicit delete; it removes one expired row.
Automatic cleanup never calls discard; it reaps old dead letters itself. Both
keep each device's highest-seq dead letter, the `recoverableFrom` floor:
discarding that row is refused with `cleanup_dead_letter_is_recovery_floor`
and nothing is deleted, while a missing row is
`cleanup_dead_letter_not_found`. The floor check and the delete are one
statement. Tenant erasure removes every row, floor rows included. After a
reap, a replay of the reaped row is refused with
`cleanup_dead_letter_not_found`; a clone made earlier stays, since
`replay_source_seq` is provenance, not a foreign key. A dead letter holds no
mailbox quota (#1115), so discarding it frees no quota; only stored rows go
away.

## Rollback and usage rebuild

Rollback means stop the host scheduler and revert application code. Do not run
a down migration, rewrite tombstones, or delete R2 objects. The additive tables
may remain unused.

Migration 0025 is not additive: it drops `storage_usage.mailbox_bytes`, which
applications up to and including 0.26.1 still read and write in cleanup. To
roll back to such a release, restore the pre-upgrade database backup, or stop
every writer and run
`ALTER TABLE storage_usage ADD COLUMN mailbox_bytes bigint NOT NULL DEFAULT 0;`
before starting it. The restored counter starts at zero, so that older
cleanup reports `cleanup_accounting_drift` exactly as it did before #411.

Before re-enabling writes after suspected accounting drift:

1. run reconciliation and require zero `missing_objects`, `shape_drift` and
   `operation_errors`;
2. stop concurrent cleanup/admission for the tenant;
3. call `rebuildObjectUsage(tenant)`, which recomputes committed object bytes
   and count only from `object_manifest.state='committed'`;
4. read usage and entitlement back, then resume admission.

R2 LIST is never billing authority. Rebuild does not touch inline usage, and
mailbox usage has nothing to rebuild: it is read from the `pending` rows.

## Mailbox usage authority and upgrade check (#411)

Mailbox bytes have one authority: the retained `outbox` rows. Usage is
`SUM(byte_size)` over the tenant's `pending` rows, read with
`MailboxStore.readUsage`. `acked` and `expired` rows stay retained but hold no
quota (#1115): an ack releases a row's bytes, and so does dead-lettering it.
Every
`limited` append — offers, approvals, steering, server replies such as egress
acknowledgements and dispositions, and dead-letter replay — is admitted only
while `used + new <= mailbox_limit_bytes`, in the same serialized unit that
inserts the row. A refusal is `storage_quota_exceeded` (HTTP 507 on
`POST /byok/messages`); a tenant with no entitlement is refused with
`storage_entitlement_missing`. Only a task's one cancellation row is exempt,
so `cancelTask` always succeeds; it is still counted.

The old `storage_usage.mailbox_bytes` counter is gone: migration
`0025_drop_storage_usage_mailbox_bytes.sql` drops the column (#387). See
"Rollback and usage rebuild" before rolling the application back past this
release.

Migration `0031_mailbox_dead_letter_retention.sql` replaces 0023's covering
index over every retained row with `outbox_tenant_pending_bytes_idx`, a partial
covering index on `(tenant_id) INCLUDE (byte_size) WHERE state = 'pending'`
that matches that sum. Like 0023, it runs inside the migration transaction (no
`CONCURRENTLY`). The build scans the whole outbox heap, every row in every
state, and dead letters were never deleted before this release, so its time
grows with the retained outbox, not the pending rows. Outbox writes wait for
the build (SHARE lock); reads continue. The old index is dropped after the new
one is built, so reads block only briefly at that final drop. 0031 also adds
`tenant_retention_policy.mailbox_dead_letter_retention_ms`; existing policies
take 30 days. That column is added first, so `tenant_retention_policy` stays
locked for the whole build: maintenance and tenant erasure wait for the
migration to commit, while device and Host requests do not read that table.

Before upgrading, run this audit. Every tenant it returns has its next limited
append refused right after the upgrade, so raise its `mailboxLimitBytes`,
issue its missing entitlement, or drain its mailbox first:

```sql
WITH usage AS (
  SELECT tenant_id, SUM(byte_size)::bigint AS mailbox_bytes, count(*) AS rows
    FROM outbox
   WHERE state = 'pending'
   GROUP BY tenant_id
)
SELECT u.tenant_id,
       u.mailbox_bytes,
       u.rows,
       e.mailbox_limit_bytes,
       CASE WHEN e.tenant_id IS NULL THEN 'entitlement_missing'
            ELSE 'over_mailbox_limit' END AS finding
  FROM usage u
  LEFT JOIN storage_entitlement e ON e.tenant_id = u.tenant_id
 WHERE e.tenant_id IS NULL
    OR u.mailbox_bytes > e.mailbox_limit_bytes
 ORDER BY u.tenant_id;
```

A tenant at exactly its limit is not returned but will refuse its next limited
append too; compare `mailbox_bytes` with `mailbox_limit_bytes` for headroom.

The query above only sees tenants that already hold pending rows. A tenant with
paired devices but no entitlement and an empty mailbox is not in it, yet its
first limited append is refused with `storage_entitlement_missing` too. Audit
those separately:

```sql
SELECT d.tenant_id, count(*) AS devices
  FROM device d
  LEFT JOIN storage_entitlement e ON e.tenant_id = d.tenant_id
 WHERE e.tenant_id IS NULL
 GROUP BY d.tenant_id
 ORDER BY d.tenant_id;
```

Issue each returned tenant an entitlement before upgrading.

Committed reservations of both kinds remain protected accounting identity: PG uses them as dedup witnesses and stored finalize-replay answers. The settled-row collector deletes only old expired/aborted rows. Removing a committed row would change later accounting while leaving the committed byte counter intact. No new accounting table or fallback is added. Cross-kind dedup differences between drivers are a pre-existing boundary, not corrected by this maintenance change.

## Terminal-task archive migration (#1120)

Migration `0032_terminal_task_archive.sql` adds
`tenant_retention_policy.terminal_task_archive_ms` (existing policies take 90
days) and the `task` columns `archive_after`, `archived_at` and
`archive_settled_at`. It backfills `archive_after` once for every terminal row:
`terminal_at` where 0030 recorded it, and otherwise `updated_at`, which is
never earlier than the real terminal instant, so no task is archived early.
`terminal_at` stays NULL for those rows. The backfill UPDATE rewrites every
terminal task row inside the migration transaction: a status write to a
terminal task waits for it, new tasks do not. The two partial index builds
then scan the `task` heap under a SHARE lock, so task writes wait while reads
continue. Count the rows first and schedule the upgrade for the window that
count needs:

```sql
SELECT count(*) AS terminal_tasks FROM task WHERE status IN ('complete', 'failed', 'cancelled');
```

The first maintenance runs after the upgrade archive at most the step limit
(default 500) per tenant per pass, oldest first; `more: true` in the `tasks`
step report means a backlog remains.
