# Plan: Issue 104 transactional pairing redemption and registration

> **Status**: Complete
> **Created**: 20260901-0007
> **Slug**: issue-104-pairing-transaction
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: GitHub issue #104
> **Artifact Level**: work-package
> **Promotion Reason**: User explicitly approved the bounded #104 durable-data fix; it changes the cloud composition contract and the Postgres transaction boundary.
> **Verification Boundary**: Deterministic registration-failure regression, in-memory/Postgres conformance, real Postgres rollback/concurrency readback, package/root gates, strict workflow verification, and independent acceptance.
> **Rollback Surface**: Revert the pairing enrollment port, both implementations, auth-plane composition, shared Postgres registration helper, and tests as one unit.
> **Spec**: `docs/spec.md`
> **Task Contract**: `tasks/contracts/20260901-0007-issue-104-pairing-transaction.contract.md`
> **Task Review**: `tasks/reviews/20260901-0007-issue-104-pairing-transaction.review.md`
> **Implementation Notes**: `tasks/notes/20260901-0007-issue-104-pairing-transaction.notes.md`

## Agentic Routing

- Selected route: bugfix
- Routing reason: one user-visible pairing operation crosses two durable stores and can commit a false-negative half-state.
- Due diligence:
  - P1 map: `POST /byok/pair` enters `AuthPlane`; `pairing_code` is tenant/product authority; `device` plus machine-supersession cleanup is registration authority; in-memory and Postgres are the two compositions.
  - P2 trace: validated request -> code guarded update autocommits -> device registration opens a second transaction -> registration failure leaves `redeemed_at` durable and no device -> retry collapses to invalid code.
  - P3 decision rationale: add mandatory composition-owned `PairingEnrollment.redeemAndRegister`. Its input carries code and device facts but never tenant/product; Postgres consumes the code and invokes the existing registration mutation on one `PoolClient` transaction. The old public `redeem` path is removed in the same work package, so hosted callers cannot recreate the split authority.

## Workflow Inventory

- Active plan: `plans/plan-20260901-0007-issue-104-pairing-transaction.md`
- Sprint contract: `tasks/contracts/20260901-0007-issue-104-pairing-transaction.contract.md`
- Sprint review: `tasks/reviews/20260901-0007-issue-104-pairing-transaction.review.md`
- Implementation notes: `tasks/notes/20260901-0007-issue-104-pairing-transaction.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: contract `allowed_paths`
- Execution isolation: `/Users/kito/Projects/byok-sdk-wt-issue-104-pairing-transaction` on `codex/issue-104-pairing-transaction`.

## Approach

- `PairingCodeStore` becomes issuance-only; `PairingEnrollment` is the only code-consumption API.
- `CloudStores` requires both `pairingCodes` and `pairing`; each composition may project one underlying implementation into both roles without duplicating state.
- Postgres extracts one client-scoped device-registration mutation used by standalone registration and pairing enrollment.
- In-memory shares one code/device authority, serializes the exact code key, and marks it consumed only after registration succeeds.

## Trade-offs

| Option | Decision | Reason |
|--------|----------|--------|
| Mandatory `PairingEnrollment` | selected | Names and enforces the cross-store atomic invariant. |
| Put device mutation on `PairingCodeStore` | rejected | Makes an issuance/lifecycle port silently own device state. |
| Keep public `redeem` for compatibility | rejected | Leaves the invalid sequential consumption path available. |
| Compensating un-redeem | rejected | Cannot survive a crash and creates another failure window. |

## Scale Boundary

At 10x, contention first appears on a hot code row or `(tenant, product, machineId)` partial unique key. The transaction holds only the indexed code/machine/device mutation window; losers fail closed and keep their code retryable rather than entering an implicit retry loop.

## Task Breakdown

- [x] Freeze a deterministic pre-fix registration-failure guard and non-zero artifact.
- [x] Add mandatory `PairingEnrollment` and remove public direct redemption.
- [x] Implement in-memory failure/concurrency parity.
- [x] Implement one-client Postgres redemption, supersession cleanup, and registration.
- [x] Add failure, retry, success-once, tenant-claim, and concurrent redemption coverage.
- [x] Run focused, real Postgres, package/root, and strict workflow gates.
- [x] Obtain an independent gatekeeper verdict on the exact diff.

## Evidence Contract

- **State/progress path**: this plan and its linked contract, review, and notes.
- **Verification evidence**: tracked pre-fix failure, deterministic composition tests, real Postgres rollback/concurrency readback, and `.ai/harness/checks/latest.json`.
- **Evaluator rubric**: final review binds to the normalized subject and reports no unresolved P0-P3 finding.
- **Stop condition**: every task item and machine-verifiable exit criterion passes; semantic acceptance is separately recorded.
- **Rollback surface**: port, both implementations, auth composition, shared registration helper, and tests.

## Promotion Gate

- **Merge/PR unit**: complete #104 pairing transaction work package.
- **Rollback surface**: cloud port, in-memory/Postgres compositions, auth plane, and tests.
- **Verification boundary**: pre-fix guard, both compositions, real Postgres failure/concurrency evidence, package/root checks, strict workflow.
- **Review/acceptance boundary**: exact final diff gatekeeper review plus typed AcceptanceReceipt.
- **High-risk surface**: bearer-code consumption and device/machine durable identity.
- **Why not checklist row**: the invariant crosses a public composition contract and a multi-statement transaction.
