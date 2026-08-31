# Plan: Issue 108 duplicate in-flight control RPC IDs

> **Status**: Executing
> **Created**: 20260901-0335
> **Slug**: issue-108-control-rpc-ids
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: GitHub issue #108
> **Artifact Level**: work-package
> **Promotion Reason**: A connection currently treats a request ID as stream cleanup metadata rather than exclusive ownership, so a duplicate can overwrite the tracked controller and leak the original handler.
> **Verification Boundary**: Audit-baseline failing socket repro, authenticated public control-socket tests, focused/client/root checks, strict workflow verification, and independent acceptance.
> **Rollback Surface**: Revert the per-connection request registry and its dedicated dispatch regression tests together.
> **Spec**: `docs/spec.md`
> **Task Contract**: `tasks/contracts/20260901-0335-issue-108-control-rpc-ids.contract.md`
> **Task Review**: `tasks/reviews/20260901-0335-issue-108-control-rpc-ids.review.md`
> **Implementation Notes**: `tasks/notes/20260901-0335-issue-108-control-rpc-ids.notes.md`

## Agentic Routing

- Selected route: regression-first local protocol ownership bugfix with an independent exact-diff gate.
- P1 map: `handleConnection` owns one authenticated socket, its request dispatch state, response frames, stream abort controllers, and disconnect cleanup. `create-daemon.ts` supplies unary/stream handlers; `control-protocol.ts` supplies the wire shapes.
- P2 trace: NDJSON frame -> `parseRawControlRequest` -> `dispatch` -> unary or stream handler -> response/event frames -> async completion cleanup. The baseline records only streams, registers after method selection, overwrites `activeStreams[id]`, and unconditionally deletes by ID on completion.
- P3 decision rationale: use one connection-local `Map<string, request-record>` for every running unary/stream operation. Reject an already-owned ID before handler invocation, register before the first async boundary, and release only when the exact record still owns the ID. Disconnect aborts each stream controller and clears the registry. Unknown methods and invalid versions never become in-flight operations.

## Workflow Inventory

- Active plan: `plans/plan-20260901-0335-issue-108-control-rpc-ids.md`
- Contract: `tasks/contracts/20260901-0335-issue-108-control-rpc-ids.contract.md`
- Review: `tasks/reviews/20260901-0335-issue-108-control-rpc-ids.review.md`
- Notes: `tasks/notes/20260901-0335-issue-108-control-rpc-ids.notes.md`
- Checks: `.ai/harness/checks/latest.json`
- Execution isolation: `/Users/kito/Projects/byok-sdk-wt-issue-108-control-rpc-ids` on `codex/issue-108-control-rpc-ids`.

## Trade-offs

| Option | Decision | Reason |
|--------|----------|--------|
| One connection-local registry for unary and stream requests | selected | The wire ID namespace is shared, so the ownership guard must cover both handler kinds without creating another protocol authority. |
| Guard streaming requests only | rejected | A long-running unary request can still collide with a stream or another unary request under the same wire ID. |
| Generation counters or replacement semantics | rejected | Replacement preserves ambiguous ownership and requires semantic arbitration the protocol does not define. |
| Copy the dirty main outbound writer changes | rejected | Outbound flow control is a separate issue and is outside #108's approved work package. |

## Scale Boundary

At 10x concurrent requests per connection, the registry grows linearly with genuinely active handlers. The first pressure point is a handler that never settles; this slice preserves existing lifetime semantics and prevents duplicate IDs from multiplying that leak, but it does not add timeouts or cancellation RPCs.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/daemon/control-server.ts` | modify | Make request IDs exclusive connection-local ownership across unary and stream handlers with identity-safe cleanup. |
| `packages/client/src/__tests__/control-server.test.ts` | modify | Add authenticated socket regressions for duplicate IDs, cross-kind collisions, completion/rejection cleanup, and disconnect abort. |

## Task Breakdown

- [x] Freeze the audit-baseline duplicate-ID failure with a non-zero artifact.
- [x] Reject a duplicate active unary or stream ID before a second handler starts.
- [x] Release an ID only when the completing request record still owns it.
- [x] Prove handler rejection releases ownership and disconnect aborts every active stream once.
- [ ] Run focused, client/root, strict workflow, and independent acceptance gates.

## Evidence Contract

- **State/progress path**: this plan, its contract, notes, and review.
- **Verification evidence**: audit-baseline failure artifact; authenticated real-socket Vitest guards; client/root build, typecheck, and tests; strict workflow report; typed `AcceptanceReceipt`.
- **Evaluator rubric**: one in-flight operation per connection/request ID across both method kinds; stable `duplicate_request_id`; no duplicate handler start; identity-safe cleanup; disconnect aborts all active streams; no #109 outbound-flow changes.
- **Stop condition**: every task row is evidenced, independent gate passes, final receipt verifies, and repo-harness permits handoff.
- **Rollback surface**: one request registry in `handleConnection` and the focused test section.

## Promotion Gate

- **Merge/PR unit**: complete #108 connection-local control RPC ID ownership and dedicated regression evidence.
- **Rollback surface**: request registry/cleanup and focused socket tests.
- **Verification boundary**: exact isolated diff plus focused client tests, package/root required checks, strict workflow, and independent read-only review.
- **Review/acceptance boundary**: one gatekeeper evaluates the frozen diff and one typed external-pass receipt binds the subject.
- **High-risk surface**: local authenticated RPC response correlation, handler lifetime ownership, and disconnect teardown.
- **Why not checklist row**: protocol concurrency behavior requires explicit failure evidence and semantic acceptance.
- **Not authorized**: merge, push, PR, issue close, publish, deploy, migration, or production mutation.
