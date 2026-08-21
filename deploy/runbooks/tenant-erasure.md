# Tenant erasure runbook

`@byok-sdk/cloud-dataplane` owns the SDK product-data half of tenant erasure.
This is an operator procedure, not an HTTP endpoint and not a retention-policy
change. Salesko (or another host) owns authorization, product-owned records,
audit policy, tenant write quiescence, and the decision to invoke this package.

## Preconditions

1. Put the tenant behind the host's write fence. Stop new device/task/blob
   admissions and wait for in-flight product writers to settle. A completed SDK
   receipt proves its readback at that moment; it cannot prevent a host writer
   from adding data after the check.
2. Run the package migration from a Node operator process against the same
   direct application-role DSN as the serving deployment. Do not use a request
   pooler, `public` fallback, manually copied SQL, or a production migration in
   this procedure without separate authorization.
3. Use the serving R2 endpoint/bucket/credentials/region and the exact immutable
   `keyPrefix` configured for that deployment. The only namespace this operation
   owns is `[keyPrefix/]tenants/<tenant>/objects/sha256/`.
4. Allocate and record one non-empty `operationId` in the host audit event. That
   id is the only retry key; do not mint a new one after a partial result.

## Run

Create a direct-DSN pool and call `createPostgresTenantErasure`. Invoke
`eraseTenant(tenant, operationId)` until its typed result is terminal:

| Result | Meaning | Operator action |
| --- | --- | --- |
| `outstanding` | One bounded R2 or SQL page was committed. | Schedule/retry the same `(tenant, operationId)`. |
| `partial` | An R2/database/layout fault occurred. Durable cursor/row progress was retained. | Correct the external fault, then retry the same id. Do not delete receipt rows. |
| `conflict` | A different caller holds the unfinished operation lease (same or different id). | Wait for that operation or its lease to expire; do not start a second operation. |
| `completed` | Canonical tenant R2 namespace and every package-owned product table were rechecked empty. | Retain the receipt; continue host-owned erasure/audit work. |

The call has a bounded work budget. `maxPagesPerRun` and `batchSize` are explicit
constructor options; do not increase them to hide a stuck operation. Monitor
`r2ObjectsDeleted`, `sqlRowsDeleted`, `sqlTableIndex`, `r2Complete`, and the
closed `errorCode` from the returned receipt.

## Recovery rules

- **R2 failure or response loss:** R2 is object-first. The cursor only advances
  after every object in its page answers delete; retry deletes missing keys
  safely before SQL begins.
- **Postgres failure:** no SQL page is marked complete until its delete commits.
  Retry the same operation id after the database is healthy.
- **Process crash:** the persisted CAS lease expires. A later retry with the
  same operation id takes the expired lease and resumes from durable progress.
- **Malformed key below the canonical tenant prefix:** this is typed
  `tenant_erasure_object_key_invalid` / `partial`. Do not delete it by raw key
  or add a layout fallback. Diagnose the deployment/schema drift first.
- **Schema inventory drift:** a new tenant-owned table causes
  `tenant_erasure_schema_drift` before an operation receipt or destructive work
  is created. Add that table to the package inventory, deletion order, tests,
  and this runbook in a new approved migration work package.

## Evidence and rollback

The completed `tenant_erasure_operation` receipt is control evidence and is not
product data; retain it. It contains no object names or remote error body.
Before declaring the host tenant erased, retain the operation id/result and the
host's own product-data/audit evidence.

To stop an unsafe rollout, disable the host operator entrypoint. Do not delete
the forward migration or operation receipts, and do not restore product rows
from cleanup/GC state. Once the root cause is corrected, resume the same
operation id; R2 delete and SQL deletion pages are replay-safe.
