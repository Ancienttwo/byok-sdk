# Plan: Integrate C07 PR189 remote preparation

> **Status**: Executing
> **Artifact Level**: work-package
> **Promotion Reason**: Integrate and accept the independently mergeable PR189 boundary
> **Verification Boundary**: Current-main MCP preparation and runtime projection with repository required checks
> **Rollback Surface**: Revert PR189 integration without touching other candidates
> **Planning Source**: Owner-approved C07 merge train; existing PR189 design retained
> **Task Contract**: `tasks/contracts/20260917-1400-c07-pr189-integration.contract.md`
> **Task Review**: `tasks/reviews/20260917-1400-c07-pr189-integration.review.md`
> **Implementation Notes**: `tasks/notes/20260917-1400-c07-pr189-integration.notes.md`

## Goal
Integrate the existing PR189 candidate with accepted PR187/main, prove the combined candidate, and merge PR189. No new MCP semantics or compatibility paths.

## P1 Architecture
Protocol owns strict preparation envelopes and completion schemas; cloud owns authenticated mailbox/status routes; daemon remote handler maps local device authority, observed tools and the local preparation service into a durable completion. Host source authorization remains mandatory. No provider, publication or downstream Host activation.

## P2 Concrete Trace
Host request -> cloud authenticated mailbox -> daemon remote handler -> resolve inline/blob context -> observe local toolsets -> project tools -> local scope/source authorization and prepare -> completion PUT -> mailbox cursor advancement. Shared projection now rejects colliding qualified identities; the remote handler must report that authority refusal before returning, while completion transport/storage faults continue to throw for redelivery.

## P3 Decision
Integrate accepted main, retain both research-document additions, migrate two explicit test authority fixtures, and convert only McpAuthorityError to existing unsupported_input at projection. Preserve unknown-error and completion-failure redelivery. At 10x load ordered mailbox head-of-line blocking is the pressure point; terminal authority refusal removes this concrete poison-row cause without semantic fallback.

## Task Breakdown
- [x] Verify dependency and merge accepted main, preserving both document additions.
- [ ] Freeze authority/projection and run canonical checks.
- [ ] Obtain one independent exact-subject acceptance and finalize.
- [ ] Push, verify exact-head CI and merge PR189; preserve dependent PR bases until retargeted.

## Stop Conditions
No provider calls/publication/deployment. Preserve other worktrees and concurrent PR193 work. At most three fix/verify rounds per issue; report unrelated failures.

## Evidence Contract
- State/progress path: This plan Task Breakdown and matching contract/notes/review.
- Verification evidence: Canonical .ai/harness/checks/latest.json and immutable .ai/harness/runs records.
- Evaluator rubric: One independent Codex verdict on the frozen MCP integration boundary.
- Stop condition: Checks and acceptance pass, exact-head CI passes, PR189 merged.
- Rollback surface: Revert this PR189 integration.

## Promotion Gate
- Merge/PR unit: PR189 remote preparation and current-main integration.
- Rollback surface: Revert PR189 without modifying other C07 branches.
- Verification boundary: Canonical contract checks and exact-head GitHub CI.
- Review/acceptance boundary: Typed AcceptanceReceipt from independent Codex review.
- High-risk surface: MCP tool identity, runtime projection and preparation binding.
- Why not checklist row: An independently mergeable PR with shared public API and runtime ownership changes.
