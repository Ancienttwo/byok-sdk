# S4B-c Cloud Cleanup Design

> Status: Accepted implementation design
> Date: 2026-08-09
> Authority: sprint S4B.4-S4B.7, architecture §12.7.5-§12.7.8, ADR-024

## P1: map

- `@byok/core` owns the four-state manifest vocabulary and tenant-first object/quota/mailbox contracts.
- Postgres owns manifest, reference, reservation, usage, retention policy, job and cursor truth.
- R2 owns bytes and can only report key/existence/size/content-type; it is not SHA-256 authority.
- `@byok/cloud-postgres` owns the cross-system maintenance composition. The host owns scheduling and operator authentication outside this package.
- S5 board delivery, S6 proof/truth routes, public HTTP control endpoints and D1 are out of scope.

## P2: concrete trace

1. Host invokes a tenant-scoped job id; a Postgres advisory lock prevents overlapping workers for that tenant.
2. Entitlement selects an explicit tenant retention policy. Absence fails closed.
3. One Postgres statement deletes acknowledged mailbox rows, marks old unacknowledged rows `expired`, expires reservations and settles mailbox usage.
4. Candidate manifests must have zero stored references, no active reservation and have aged past orphan grace. The worker writes `delete_pending` before touching R2.
5. R2 DELETE treats absence as idempotent success. A Postgres statement then moves only that tombstone to `deleted` and decrements the tombstone's recorded accounted bytes once.
6. Reconciliation scans manifests with HEAD and tenant-prefixed R2 keys with ListObjectsV2. Missing/shape drift is observed, not repaired by inventing bytes. A valid untracked key becomes a pending witness and waits grace before deletion.
7. Job counters and cursor state persist in Postgres for support/readback.

Crash points:

| Crash point | Durable state | Retry result |
| --- | --- | --- |
| before tombstone | original manifest/R2 untouched | candidate is re-evaluated |
| after tombstone, before DELETE | `delete_pending`, usage unchanged | DELETE retried |
| after DELETE, before DB settle | `delete_pending`, R2 absent | 404 is success; settle runs once |
| after DB settle | `deleted`, usage decremented | candidate no longer selected |
| after LIST sees untracked key | no destructive action until witness insert | scan repeats or witness waits grace |

## P3: decision

The smallest coherent boundary is a Postgres-specific maintenance service, not a new core port. GC is not a domain operation every composition must implement: it coordinates one concrete transaction authority with one concrete byte store and exposes operational counters. Widening `CoreStores` would make the in-memory reference simulate hosted operations and weaken the conformance inventory.

The deletion invariant is: **no byte delete without a durable tenant-scoped tombstone whose eligibility was checked against manifest state, reference rows, active reservations and grace**. Refcount is an optimization; the reference table is scanned again. Capacity pressure never changes this eligibility set.

ListObjectsV2 is bounded and cursor-backed because at 10x scale R2 LIST/HEAD cost fails before Postgres row transitions do. XML is parsed against the narrow S3 response shape and fails closed when a truncated response lacks a continuation token. No fallback parser or status sniffing is admitted.

ADR-024 is not reopened. Reconciliation can find missing keys and size/type drift, but cannot detect same-size/type byte substitution. A future R2 SHA-256 `FULL_OBJECT` capability or a product decision to distrust paired devices requires a superseding ADR, not a dormant dual mode here.
