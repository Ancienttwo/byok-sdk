# Implementation Notes: tenant-erasure

> **Status**: Active
> **Plan**: plans/plan-20260821-1720-tenant-erasure.md
> **Contract**: tasks/contracts/20260821-1720-tenant-erasure.contract.md
> **Review**: tasks/reviews/20260821-1720-tenant-erasure.review.md
> **Last Updated**: 2026-08-21 17:20

## P1: Authority map

- `PostgresTenantErasure` owns the operation receipt, CAS lease, static tenant-table inventory, R2-first paging, and row-deletion order.
- `R2ObjectMaintenanceStore` remains the only object-store adapter; its ListObjectsV2 prefix must be the same canonical namespace as `tenantObjectKey`.
- The host owns authorization, tenant write quiescence, its own product data, scheduling, and the decision to invoke/retry an operation.
- `tenant_erasure_operation` is operator control evidence, explicitly excluded from tenant product-data deletion and retained after completion.

## P2: Concrete trace

`eraseTenant(tenant, operationId)` verifies the live schema inventory, inserts/reads a tenant operation receipt, obtains its CAS lease, lists one canonical R2 page and deletes each listed canonical object, persists the opaque continuation cursor, then deletes one FK-safe SQL batch. A crash before a cursor/CAS update replays an idempotent delete or SQL batch; no cursor is advanced before the external deletion succeeds.

## P3: Decision

The operation is separate from cleanup because an erasure receipt must survive all product data and cannot inherit retention policy or GC cursor semantics. The first pressure point at 10x is R2 listing/deletion, so every call has a bounded page budget. Unknown non-canonical keys under the owned prefix are drift: fail closed and retain the receipt rather than deleting a key whose ownership/layout cannot be proved.

## Evidence

- Pre-implementation red test: `packages/cloud-dataplane/src/__tests__/tenant-erasure.test.ts` imports the required root API before it exists.
- Runtime evidence and final check output will be recorded after implementation.
