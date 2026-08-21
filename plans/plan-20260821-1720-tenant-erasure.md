# Plan: Package-Owned Tenant Erasure

> **Status**: Active
> **Created**: 20260821-1720
> **Slug**: tenant-erasure
> **Artifact Level**: work-package
> **Verification Boundary**: resumable tenant-scoped PostgreSQL and R2 erasure with schema inventory drift guard and second-tenant isolation
> **Rollback Surface**: disable the operator entrypoint while retaining forward schema/progress evidence
> **Dependency**: base migration numbering after U1; do not share cleanup/store file ownership concurrently

## Goal

Provide an explicit package-owned operator primitive that erases all SDK-owned
tenant PostgreSQL rows and R2 objects idempotently and resumably, without making
the host understand table order or object-key layout. Existing retention/GC
`PostgresCloudCleanup.runTenant()` is not this authority.

## P1 — Authority map

- `@byok-sdk/cloud-dataplane` owns schema inventory, FK-safe deletion order,
  object manifests/cursors, progress persistence, and direct-DSN operator API.
- R2 deletion is driven by durable package-owned evidence; the last manifest or
  cursor cannot disappear before object deletion succeeds.
- Salesko owns the product erasure saga, its own data deletion, audit, and call
  into this primitive.
- Device routes, Hyperdrive serving paths, and retention policy are out of scope.

## P2 — Concrete trace

Operator calls `eraseTenant(tenant, operationId)` → durable operation row/CAS →
bounded inventory page → R2 delete/readback → FK-safe bounded database deletion
→ persisted cursor/progress → repeat until typed completed readback. Crash or R2
failure resumes from durable evidence; a second tenant remains byte-for-byte
untouched.

## P3 — Decision

Build a distinct erasure authority rather than setting retention to zero or
exporting raw SQL/key helpers. Use one operation id for idempotency and bounded
resumption. Add a schema-inventory guard so a future tenant-owned table fails
closed until erasure coverage is updated. At 10x, object enumeration/deletion is
the first pressure point, so work is paged with explicit outstanding counts.

## Required coverage

Devices, pairing, presence, mailbox/outbox, board, activity, approvals, task
attempts, request/proof receipts, truth, blob refs/manifests, quota,
reservations, usage, cleanup metadata, erasure progress, and tenant-owned R2
objects. Never delete migration ledger, schema, other tenants, or deployment
configuration.

## Scope / ownership

- Owns a Node direct-DSN maintenance API and its forward-only schema.
- Owns the tenant-table/object inventory test and typed progress/readback.
- May reuse low-level deletion helpers only if erasure remains the single
  orchestration authority; it must not mutate retention semantics.
- Separate contract worktree after U1 fixes the next migration ordinal.

## Acceptance matrix

- empty tenant replay
- populated tenant erased while a second tenant is untouched
- R2 failure, database failure, and process crash resume
- duplicate and concurrent same/different operation ids
- orphan/untracked object policy
- outstanding/completed/partial typed readback with audit-safe errors
- real PostgreSQL plus object-store fixture
- schema inventory drift fails closed for every future tenant-owned table

## Task Breakdown

- [x] Create a dedicated strict contract/worktree after U1 migration numbering is fixed.
- [x] Inventory every tenant-owned table/FK/object authority and lock it with a red drift test.
- [x] Define operation state, typed progress, concurrency, and orphan policy.
- [ ] Implement bounded R2-first evidence-preserving deletion and FK-safe DB batches.
- [ ] Add crash/failure injection, replay, isolation, and real-substrate tests.
- [ ] Run full required checks and review; hand back only local evidence until release is separately authorized.

## Authorization boundary

No publish, deploy, production migration, credential/secret mutation, host raw
SQL, destructive down migration, or Salesko product-data deletion is authorized.
