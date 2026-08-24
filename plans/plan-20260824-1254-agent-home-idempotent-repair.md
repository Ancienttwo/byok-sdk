# Plan: Agent-home exact-replay ensure/repair

> **Status**: Executing
> **Created**: 20260824-1254
> **Slug**: agent-home-idempotent-repair
> **Artifact Level**: work-package
> **Promotion Reason**: Salesko's frozen post-0.8.0 reconciliation falsifier proves that surviving SDK ordering state prevents repair of a locally lost opaque product projection.
> **Verification Boundary**: Client ensure lifecycle and ordering negatives, shared lease/restart/completion behavior, full repository gates, aligned packed 0.8.1/keys 0.3.2 RC, and exact Salesko packed-RC acceptance.
> **Rollback Surface**: Revert this unpublished branch and discard the packed RC; no registry, remote, production, migration, or secret state is authorized.
> **Spec**: `docs/spec.md`
> **Task Contract**: `tasks/contracts/20260824-1254-agent-home-idempotent-repair.contract.md`
> **Task Review**: `tasks/reviews/20260824-1254-agent-home-idempotent-repair.review.md`
> **Implementation Notes**: `tasks/notes/20260824-1254-agent-home-idempotent-repair.notes.md`

## Agentic Routing

- Selected route: strict bugfix contract in the existing isolated worktree.
- Routing reason: the change touches a public client lifecycle, durable ordering,
  writer-lease behavior, downstream reconciliation, and the release train.
- P1: `AgentHomeManager` owns canonical home, lease, ordering state and hook
  invocation; cloud/server own immutable exact receipts; downstream owns opaque
  product bytes and schema.
- P2: new exact-device request -> daemon `project()` -> canonical-home lease ->
  read ordering state -> equal revision/hash currently returns before hook ->
  completion/cursor advances while product-derived bytes may remain absent.
- P3: add an explicit opt-in idempotent `ensure` lifecycle. Preserve existing
  `apply` semantics for consumers that may have non-idempotent side effects;
  exact replay invokes `ensure` under the same lease and still returns
  `idempotent`. Stale/conflict never invoke either hook.

## Workflow Inventory

- Active plan: `plans/plan-20260824-1254-agent-home-idempotent-repair.md`
- Contract: `tasks/contracts/20260824-1254-agent-home-idempotent-repair.contract.md`
- Review: `tasks/reviews/20260824-1254-agent-home-idempotent-repair.review.md`
- Notes: `tasks/notes/20260824-1254-agent-home-idempotent-repair.notes.md`
- Deferred ledger: `tasks/todos.md`
- Checks: `.ai/harness/checks/latest.json`
- Runs: `.ai/harness/runs/`
- Worktree: `/Users/kito/Projects/byok-sdk-wt-agent-home-idempotent-repair`
- Scope authority: matching contract `allowed_paths`.

## Approach

### Public contract

- Add optional `AgentHomeProjection.ensure` and its typed input/function export.
- Add a clearly named helper that opts one idempotent opaque consumer into both
  initial apply and exact-replay ensure; keep the existing apply-only helper unchanged.
- Equal revision/hash with configured ensure runs it after initialization and
  before an `idempotent` result. Ensure failure leaves ordering state unchanged
  and prevents completion/cursor acknowledgement.
- Exact replay without an ensure retains existing 0.8.0 apply-only behavior;
  hosts opt in explicitly rather than silently replaying non-idempotent effects.

### Release candidate

- Prepare aligned train `0.8.1` and independently versioned keys `0.3.2`
  because keys must retain its exact core edge.
- Produce all ten clean packed artifacts and a byte/integrity manifest without
  npm publication, tag, merge, push, deploy, or migration.
- Consume exact client/protocol/core RC bytes in the frozen Salesko worktree,
  update only the Phase 2 guard outcome to `idempotent`, and require the opaque
  `profile.json` repair assertion to pass.

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Existing apply has non-idempotent side effects | Do not replay apply implicitly; explicit ensure opt-in only. |
| Exact replay advances after failed repair | Throw before completion; preserve cursor redelivery and ordering state. |
| Repair races Agent execution | Reuse the same canonical-home writer lease and test overlap. |
| Ordering semantics drift | Focused stale/conflict/newer/exact tests and exact completion readback. |
| Downstream gains path authority | SDK passes canonical cwd and opaque payload only; Salesko hook remains path/schema owner. |

## Promotion Gate

- **Merge/PR unit**: client lifecycle/API/tests/docs plus exact aligned RC metadata.
- **Rollback surface**: one unpublished branch and disposable tarballs.
- **Verification boundary**: focused/full upstream gates, pack/install closure,
  and frozen Salesko consumer acceptance against exact RC bytes.
- **Review/acceptance boundary**: source acceptance and packed RC acceptance;
  formal publication is a separate user gate.
- **High-risk surface**: durable ordering, exact receipt/cursor and same-Agent serialization.
- **Why not checklist row**: this is a public lifecycle addition with a real
  downstream falsifier and cross-repository artifact acceptance.

## Evidence Contract

- **State/progress path**: this plan and matching contract/notes/review/checks.
- **Verification evidence**: upstream pre-fix regression, focused tests, full
  gates, RC manifest/integrities, and Salesko exact-RC command output.
- **Evaluator rubric**: product-only and whole-home loss converge; equal replay
  is idempotent after ensure; stale/conflict never call hooks; failure remains
  unacked/retryable; lease/restart/readback stay exact.
- **Stop condition**: stop on implicit apply replay, public outcome change,
  non-exact RC dependency graph, or any request for publish/merge/push/deploy.
- **Rollback surface**: discard branch/RC and restore Salesko's guard-only edit.

## Task Breakdown

- [ ] Activate a strict bugfix contract and capture the real pre-fix regression.
- [ ] Freeze and implement the explicit generic ensure lifecycle and negatives.
- [ ] Run focused plus full upstream verification and disposable integration gates.
- [ ] Pack aligned 0.8.1/keys 0.3.2 RC with exact manifest/integrity readback.
- [ ] Consume exact RC bytes in frozen Salesko and pass Phase 2 plus existing acceptance.
- [ ] Record source/RC/downstream acceptance separately; stop before publication.
