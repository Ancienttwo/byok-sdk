# Task Contract: tenant-erasure

> **Status**: Partial
> **Plan**: plans/plan-20260821-1720-tenant-erasure.md
> **Task Profile**: migration
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-21 17:20
> **Review File**: `tasks/reviews/20260821-1720-tenant-erasure.review.md`
> **Notes File**: `tasks/notes/20260821-1720-tenant-erasure.notes.md`

## Why

The SDK has durable tenant-scoped PostgreSQL state and tenant-scoped R2 objects, but no package-owned operator primitive that can remove both safely after a tenant is retired. Retention cleanup cannot be repurposed: its cursors, policy semantics, and accounting authority are not an erasure receipt.

## Goal

Add a Node-only `@byok-sdk/cloud-dataplane` tenant-erasure operation. It must persist one independent operation receipt, delete the canonical tenant R2 namespace before product rows in bounded pages, survive retry/crash boundaries, reject schema inventory drift, and leave a second tenant untouched. The operation receipt is package/operator evidence and remains after product data is erased.

## Scope

- In scope: forward-only `0010`, the package-root Node maintenance API, canonical R2 list-prefix correction, tests using real disposable Postgres + MinIO, SQL inventory invariants, operator runbook and package documentation.
- Out of scope: U1 cancellation implementation, U2/U3/U4 surfaces, host/product erasure saga, deploy/publish/production migration, credential or secret mutation, retention cursor reuse, and every product compatibility fallback.

## Stop Conditions

- Stop if a change needs a path outside `Allowed Paths`.
- Stop if exact schema inventory cannot be made fail-closed before deletion.
- Stop if a failure boundary cannot preserve enough durable state to replay safely.

## Falsifier

A real MinIO object at `tenants/<tenant>/objects/sha256/<hash>` that the maintenance list cannot discover proves the prefix correction wrong. A future tenant table accepted by the inventory guard proves the erasure authority is unsafe.

## Workflow Inventory

- Source plan: `plans/plan-20260821-1720-tenant-erasure.md`
- Review: `tasks/reviews/20260821-1720-tenant-erasure.review.md`
- Notes: `tasks/notes/20260821-1720-tenant-erasure.notes.md`
- Contract verification: `repo-harness run verify-contract --contract tasks/contracts/20260821-1720-tenant-erasure.contract.md --strict`

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260821-1720-tenant-erasure.md
  - tasks/contracts/20260821-1720-tenant-erasure.contract.md
  - tasks/notes/20260821-1720-tenant-erasure.notes.md
  - tasks/reviews/20260821-1720-tenant-erasure.review.md
  - deploy/sql/0010_tenant_erasure.sql
  - tests/sql/control_plane_invariants.sql
  - packages/cloud-dataplane/src/tenant-erasure.ts
  - packages/cloud-dataplane/src/index.ts
  - packages/cloud-dataplane/src/stores/r2-blobs.ts
  - packages/cloud-dataplane/src/__tests__/tenant-erasure.test.ts
  - packages/cloud-dataplane/src/__tests__/support/dataplane.ts
  - packages/cloud-dataplane/src/__tests__/r2-blobs.test.ts
  - packages/cloud-dataplane/src/__tests__/cleanup.test.ts
  - deploy/runbooks/tenant-erasure.md
  - packages/cloud-dataplane/README.md
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
  - .ai/harness/worktrees/.gitkeep
```

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```

## Exit Criteria

```yaml
exit_criteria:
  files_exist:
    - deploy/sql/0010_tenant_erasure.sql
    - packages/cloud-dataplane/src/tenant-erasure.ts
    - packages/cloud-dataplane/src/__tests__/tenant-erasure.test.ts
    - deploy/runbooks/tenant-erasure.md
  files_contain:
    - path: packages/cloud-dataplane/src/tenant-erasure.ts
      pattern: "PostgresTenantErasure"
    - path: deploy/sql/0010_tenant_erasure.sql
      pattern: "tenant_erasure_operation"
    - path: packages/cloud-dataplane/src/stores/r2-blobs.ts
      pattern: 'tenantObjectKey\(tenant, LIST_PREFIX_HASH'
  tests_pass:
    - path: packages/cloud-dataplane/src/__tests__/tenant-erasure.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes

- Functional behavior: R2 objects are removed before tenant product rows; a completed receipt is replay-stable.
- Edge cases: same/different operation ids, lease expiry after crash, R2/database failure, untracked canonical keys, invalid keys, and a second tenant.
- Residual risk: host must quiesce product writers before accepting a final receipt; the SDK does not own the host write fence.

## Rollback Point

- Commit / checkpoint: pending local implementation commit.
- Revert strategy: disable the operator entrypoint; retain forward schema and operation evidence for audit/recovery.
