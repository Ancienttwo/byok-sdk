# Task Review: tenant-erasure

> **Status**: Pending
> **Plan**: plans/plan-20260821-1720-tenant-erasure.md
> **Contract**: tasks/contracts/20260821-1720-tenant-erasure.contract.md
> **Notes File**: tasks/notes/20260821-1720-tenant-erasure.notes.md
> **Recommendation**: pending

## Review Card

- Intended change: package-owned, recoverable tenant erasure only.
- Required evidence: real Postgres + MinIO, R2 canonical-list regression, SQL inventory guard, typed conflict/replay/failure tests, build/typecheck/test/strict workflow.
- Unreviewed boundary: host authorization/write quiescence and product-owned data deletion remain out of scope.
