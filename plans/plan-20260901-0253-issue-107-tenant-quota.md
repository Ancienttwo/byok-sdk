# Plan: Issue 107 atomic tenant reliable-egress quota

> **Status**: Complete
> **Created**: 20260901-0253
> **Slug**: issue-107-tenant-quota
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: GitHub issue #107
> **Artifact Level**: work-package
> **Promotion Reason**: The configured tenant byte ceiling spans every Agent-local durable spool, but the current check and commit are not one controller-owned operation.
> **Verification Boundary**: Audit-baseline failing races, public append readback, focused/client/root checks, strict workflow verification, and independent acceptance.
> **Rollback Surface**: Revert the controller-wide reliable append gate and its dedicated regression tests together.
> **Spec**: `docs/spec.md`
> **Task Contract**: `tasks/contracts/20260901-0253-issue-107-tenant-quota.contract.md`
> **Task Review**: `tasks/reviews/20260901-0253-issue-107-tenant-quota.review.md`
> **Implementation Notes**: `tasks/notes/20260901-0253-issue-107-tenant-quota.notes.md`

## Agentic Routing

- Selected route: regression-first durable concurrency bugfix with an independent exact-diff gate.
- P1 map: `AgentEgressController` owns the authenticated tenant and aggregates pending bytes across its Agent-local `AgentReliableSpool` instances; each spool separately owns one file, cursor, per-Agent quotas, and write queue.
- P2 trace: public reliable/content append -> open selected spool -> compute controller `tenantPendingBytes()` -> pass the snapshot to the selected spool -> spool-local quota check -> append + fsync. Different spools can consume the same pre-append tenant snapshot and both commit.
- P3 decision rationale: place `spoolFor`, tenant-total observation, and the durable append for both reliable variants behind one controller-wide promise tail. Keep sanitizer outside, retain per-Agent quota/cursor ownership in the spool, and release the tail in `finally`. Do not add a reservation ledger, shared store, or change ack/recovery/lifecycle semantics.

## Workflow Inventory

- Active plan: `plans/plan-20260901-0253-issue-107-tenant-quota.md`
- Contract: `tasks/contracts/20260901-0253-issue-107-tenant-quota.contract.md`
- Review: `tasks/reviews/20260901-0253-issue-107-tenant-quota.review.md`
- Notes: `tasks/notes/20260901-0253-issue-107-tenant-quota.notes.md`
- Checks: `.ai/harness/checks/latest.json`
- Execution isolation: `/Users/kito/Projects/byok-sdk-wt-issue-107-tenant-quota` on `codex/issue-107-tenant-quota`.

## Trade-offs

| Option | Decision | Reason |
|--------|----------|--------|
| Controller-wide promise tail | selected | It makes the existing process-local tenant observation and commit one linearized operation without duplicating byte/cursor authority. |
| In-memory reservation ledger | rejected | Receipt size depends on spool-owned identity, and reserve/commit/rollback would create a second quota authority. |
| Shared transactional tenant store | rejected for this slice | It is required only if multiple controllers/processes can write one tenant; no such deployment contract exists here. |
| Extend to deactivate/fsync-uncertainty semantics | deferred | Those are separate lifecycle/durability questions and do not justify expanding the named quota work package. |

## Scale Boundary

At 10x concurrent Agents, the controller tail intentionally trades parallel fsync throughput for correct tenant admission and can create head-of-line blocking. If one tenant later has multiple writer processes or measured latency violates an SLO, quota plus durable evidence must move to one shared transactional authority rather than adding local heuristics.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/daemon/agent-egress-controller.ts` | modify | Add one controller-wide append gate shared by reliable payloads and content receipts. |
| `packages/client/src/__tests__/agent-egress-spool.test.ts` | modify | Add deterministic public cross-Agent races and failed-operation release/readback. |

## Task Breakdown

- [x] Freeze reliable/reliable and reliable/content audit-baseline failures with a non-zero artifact.
- [x] Serialize both new-record paths across `spoolFor`, tenant observation, and durable append.
- [x] Prove exactly one racing append succeeds when only one fits and total bytes never exceed the tenant ceiling.
- [x] Prove existing per-Agent quota behavior and definite failed-append release remain intact.
- [x] Run focused, client/root, strict workflow, and independent acceptance gates.

## Evidence Contract

- **State/progress path**: this plan, its contract, notes, and review.
- **Verification evidence**: audit-baseline failing artifact, deterministic public Vitest guards with real temporary spool readback, client/root build/typecheck/test, strict workflow report, and typed `AcceptanceReceipt`.
- **Evaluator rubric**: both reliable write variants share one controller linearization point; only one cross-Agent race winner fits; no reservation survives a definite failure; scope does not include #106 home identity or broader lifecycle/persistence redesign.
- **Stop condition**: every task row is evidenced, independent gate passes, final receipt verifies, and repo-harness permits handoff.
- **Rollback surface**: one controller field/helper, two call sites, and the focused test section.

## Promotion Gate

- **Merge/PR unit**: complete #107 controller-local atomic tenant reliable-egress quota and dedicated regression evidence.
- **Rollback surface**: controller-wide reliable append tail and focused race tests.
- **Verification boundary**: exact isolated diff plus focused client tests, package/root required checks, strict workflow, and independent read-only review.
- **Review/acceptance boundary**: one gatekeeper evaluates the frozen diff and one typed external-pass receipt binds the subject.
- **High-risk surface**: tenant resource accounting, cross-spool fsync ordering, and failure release.
- **Why not checklist row**: merge, push, issue mutation, publication, and deployment require separate authority.
- **Not authorized**: merge, push, PR, issue close, publish, deploy, migration, or production mutation.
