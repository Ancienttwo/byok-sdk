# Plan: Integrate C07 PR190 read-only tool policy

> **Status**: Executing
> **Artifact Level**: work-package
> **Promotion Reason**: Integrate and accept the independently mergeable PR190 boundary
> **Verification Boundary**: Current-main MCP preparation and runtime projection with repository required checks
> **Rollback Surface**: Revert PR190 integration without touching other candidates
> **Planning Source**: Owner-approved C07 merge train; existing PR190 design retained
> **Task Contract**: `tasks/contracts/20260917-1420-c07-pr190-integration.contract.md`
> **Task Review**: `tasks/reviews/20260917-1420-c07-pr190-integration.review.md`
> **Implementation Notes**: `tasks/notes/20260917-1420-c07-pr190-integration.notes.md`

## Goal
Integrate the existing PR190 candidate with accepted PR187/main, prove the combined candidate, and merge PR190. No new MCP semantics or compatibility paths.

## P1 Architecture
Operator-owned McpToolsetConfig.readOnlyTools joins live MCP observations in the registry; shared policy filtering feeds runtime grants, Pi extension registration and preparation manifests. Runtime qualified identifiers remain an independent authority boundary. Provider and deployment are out of scope.

## P2 Concrete Trace
Device config classification -> live tool observation -> task permission mode -> shared policy filter -> Claude/Codex grants or Pi extension/prepared projection -> tool dispatch. A raw read/mutation name collision can survive as a read grant if the mutation half is removed before validation; runtime identity must therefore be checked before narrowing.

## P3 Decision
Preserve PR188 full-observation collision rejection before the PR190 policy filter, returning its existing typed refusal. Retain both branches' tests and error handling. Update release-smoke fixture with an explicit legal auto permission mode matching its pre-policy complete-tool exposure. At 10x scale repeated MCP discovery remains the pressure point; no new discovery/cache/compatibility authority is introduced.

## Task Breakdown
- [x] Verify dependency and merge accepted main, preserving both document additions.
- [ ] Freeze authority/projection and run canonical checks.
- [ ] Obtain one independent exact-subject acceptance and finalize.
- [ ] Push, verify exact-head CI and merge PR190; preserve dependent PR bases until retargeted.

## Stop Conditions
No provider calls/publication/deployment. Preserve other worktrees and concurrent PR193 work. At most three fix/verify rounds per issue; report unrelated failures.

## Evidence Contract
- State/progress path: This plan Task Breakdown and matching contract/notes/review.
- Verification evidence: Canonical .ai/harness/checks/latest.json and immutable .ai/harness/runs records.
- Evaluator rubric: One independent Codex verdict on the frozen MCP integration boundary.
- Stop condition: Checks and acceptance pass, exact-head CI passes, PR190 merged.
- Rollback surface: Revert this PR190 integration.

## Promotion Gate
- Merge/PR unit: PR190 read-only tool policy and current-main integration.
- Rollback surface: Revert PR190 without modifying other C07 branches.
- Verification boundary: Canonical contract checks and exact-head GitHub CI.
- Review/acceptance boundary: Typed AcceptanceReceipt from independent Codex review.
- High-risk surface: MCP tool identity, runtime projection and preparation binding.
- Why not checklist row: An independently mergeable PR with shared public API and runtime ownership changes.
