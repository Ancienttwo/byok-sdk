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
client retry/redelivery horizon.

## What one job may delete

- acknowledged mailbox rows past policy; mailbox accounting is reduced in the
  same Postgres transaction;
- used/expired auth nonces and pairing codes, old request receipts, expired
  presence/activity rows;
- expired reservations (a state change; reserved bytes are derived, not a
  counter);
- R2 objects whose tenant-scoped manifest has no reference rows, no active
  reservation, has aged past grace, and was durably changed to
  `delete_pending` first.

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
| `ttl_rows_deleted` | nonce/receipt/hint TTL reclaim | informational |
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
sequence, binds the new row to the exact source via `replay_source_seq`, applies
mailbox quota, and keeps the original as evidence.
`discardDeadLetter` is the only explicit delete; it removes one expired row and
settles mailbox usage transactionally. Automatic cleanup never calls discard.

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

R2 LIST is never billing authority. Rebuild does not touch inline or mailbox
usage.
