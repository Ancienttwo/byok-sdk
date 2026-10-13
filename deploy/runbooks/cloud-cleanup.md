# Cloud cleanup and reconciliation

Operational contract for S4B-c on the Postgres + R2 composition. Authorities:
`deploy/sql/0003_cloud_cleanup.sql`, `PostgresCloudCleanup`, architecture
§12.7.5–§12.7.8, and ADR-024.

## Preconditions and scheduler

1. Apply all ordered migrations. Never edit `0001`/`0002`; `0003` is additive
   and forward-only.
2. Write a `tenant_retention_policy`, then point the tenant's versioned
   entitlement at its `policyId`. Missing policy makes cleanup fail closed.
3. The host scheduler calls `runTenant(tenant, uniqueJobId)`. The SDK starts no
   timer. One tenant is advisory-locked at a time; work is page/batch bounded
   (default 100, maximum 1000).

The policy has four explicit durations: acknowledged mailbox retention,
unacknowledged mailbox expiry, request-receipt retention, and object-orphan
grace. Use at least 24 hours for object grace unless a reviewed deployment
contract says otherwise. Receipt retention must cover proof skew plus the full
client retry/redelivery horizon. `runTenant` currently deletes **no** request
receipt (see below), so the receipt duration is stored but not yet applied.

## What one job may delete

- acknowledged mailbox rows past policy. Mailbox usage is the sum of the
  retained `outbox` rows, so deleting a row is the whole release; there is no
  counter to reduce and no `cleanup_accounting_drift` from the mailbox;
- used/expired auth nonces and pairing codes, expired presence/activity rows
  and expired approval-timeline tails;
- expired reservations (a state change; reserved bytes are derived, not a
  counter);
- R2 objects whose tenant-scoped manifest has no reference rows, no active
  reservation, has aged past grace, and was durably changed to
  `delete_pending` first.

It never deletes request receipts. Every receipt family the SDK writes is
either a task-identity fence (`task-offer:`, `task-offer-delivered:`,
`task:<id>:terminal`, `agent-message-offer:`), an Agent request/completion
record (`agent-content-*`, `agent-home-projection-*`,
`agent-input-preparation-*`), or the enrollment authority
`pairing-completion:v1:`. Deleting one by TTL turns a retry into
`claim_offer_mismatch`/`recovery_offer_mismatch` or lets a completed task id
run again. Hosted cleanup resumes receipt expiry only for the prefixes the
receipt classification (#412) registers as TTL-bound requests.

It never deletes durable truth, board, memory, profile or terminal data to make
room. Hard-limit pressure changes admission only. Reads, reference removal,
exports, usage reads and entitlement updates remain available.

## Tombstone and crash recovery

The state sequence remains the four existing states:

`pending|committed → delete_pending → deleted`

At tombstone time, Postgres records whether the manifest contributed committed
bytes/object count. R2 DELETE runs next; only then does one Postgres statement
move the tombstone to `deleted` and reduce usage. A zero-byte committed object
still reduces object count once.

| Crash | Durable readback | Next job |
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
truncated XML page without a continuation token fails the job; there is no
restart-from-page-one or alternate-parser fallback.

HEAD does not verify SHA-256. The worker does not read bytes back, does not add
checksum headers/fallbacks, and cannot detect a same-size/type substitution.
That is the accepted tenant-internal risk in ADR-024.

## Metrics and alerts

`cleanup_job` is the provider-neutral metric/readback source. Export these
counters with tenant and job kind labels, never object keys or bodies:

| Column | Metric meaning | Alert condition |
| --- | --- | --- |
| `mailbox_expired_count` | unacknowledged work moved to dead-letter | any non-zero |
| `mailbox_deleted_count`, `mailbox_released_bytes` | acknowledged retention | unexpected sustained zero with mailbox growth |
| `reservations_expired` | abandoned admissions released | sustained rise |
| `ttl_rows_deleted` | nonce/pairing/presence/activity/approval TTL reclaim | informational |
| `objects_tombstoned`, `objects_deleted`, `object_released_bytes` | GC progress | tombstoned grows while deleted stays zero |
| `orphan_witnesses_created` | R2 key had no live manifest | any unexplained non-zero |
| `missing_objects` | committed manifest has no R2 bytes | any non-zero, page immediately |
| `shape_drift` | HEAD size/type disagrees with manifest | any non-zero, page immediately |
| `invalid_object_keys` | tenant prefix contains a non-canonical key | any non-zero |
| `operation_errors` / `state=failed` | R2/SQL/accounting failure | any non-zero/failed |

Support inspection:

```sql
SELECT * FROM cleanup_job
 WHERE tenant_id = $1
 ORDER BY started_at DESC
 LIMIT 20;

SELECT hash, state, ref_count, updated_at, delete_pending_at,
       gc_accounted_bytes, gc_accounted_object
  FROM object_manifest
 WHERE tenant_id = $1 AND state IN ('delete_pending', 'committed')
 ORDER BY updated_at, hash;
```

## Dead-letter operator surface

`listDeadLetters` pages `expired` rows. `replayDeadLetter` requires an
operator-issued idempotency key, clones the original bytes to a new monotonic
sequence, binds the new row to the exact source via `replay_source_seq`, and
keeps the original as evidence. The clone is a limited mailbox append: it is
refused with `storage_quota_exceeded` when it does not fit `mailboxLimitBytes`,
and with `storage_entitlement_missing` when the tenant has no entitlement.
`discardDeadLetter` is the only explicit delete; it removes one expired row,
which is all it takes to free its bytes. Automatic cleanup never calls discard.
A dead letter counts toward the mailbox limit until it is discarded.

## Rollback and usage rebuild

Rollback means stop the host scheduler and revert application code. Do not run
a down migration, rewrite tombstones, or delete R2 objects. The additive tables
may remain unused.

Before re-enabling writes after suspected accounting drift:

1. run reconciliation and require zero `missing_objects`, `shape_drift` and
   `operation_errors`;
2. stop concurrent cleanup/admission for the tenant;
3. call `rebuildObjectUsage(tenant)`, which recomputes committed object bytes
   and count only from `object_manifest.state='committed'`;
4. read usage and entitlement back, then resume admission.

R2 LIST is never billing authority. Rebuild does not touch inline usage, and
mailbox usage has nothing to rebuild: it is read from the retained rows.

## Mailbox usage authority and upgrade check (#411)

From this release, mailbox bytes have one authority: the retained `outbox`
rows. Usage is `SUM(byte_size)` over every retained row of the tenant in any
state (`pending`, `acked`, `expired`), read with `MailboxStore.readUsage`. Every
`limited` append — offers, approvals, steering, server replies such as egress
acknowledgements and dispositions, and dead-letter replay — is admitted only
while `used + new <= mailbox_limit_bytes`, in the same serialized unit that
inserts the row. A refusal is `storage_quota_exceeded` (HTTP 507 on
`POST /byok/messages`); a tenant with no entitlement is refused with
`storage_entitlement_missing`. Only a task's one cancellation row is exempt,
so `cancelTask` always succeeds; it is still counted.

`storage_usage.mailbox_bytes` is no longer read or written. It stays in the
schema for one release so a rollback to the previous application still finds
the column it reads; a later migration drops it once no supported rollback
target reads it. Its value is meaningless from now on.

Migration `0023_mailbox_usage_index.sql` builds a covering index for that sum.
It runs inside the migration transaction (no `CONCURRENTLY`), so outbox writes
block while it builds; the build time grows with the retained outbox.

Before upgrading, run this audit. Every tenant it returns has its next limited
append refused right after the upgrade, so raise its `mailboxLimitBytes`,
issue its missing entitlement, or drain its mailbox first:

```sql
WITH usage AS (
  SELECT tenant_id, SUM(byte_size)::bigint AS mailbox_bytes, count(*) AS rows
    FROM outbox
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

The query above only sees tenants that already hold retained rows. A tenant with
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
