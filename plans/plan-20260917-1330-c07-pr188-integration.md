# Plan: Integrate C07 PR188 shared MCP core

> **Status**: Executing
> **Artifact Level**: work-package
> **Promotion Reason**: Integrate and accept the independently mergeable PR188 boundary
> **Verification Boundary**: Current-main MCP preparation and runtime projection with repository required checks
> **Rollback Surface**: Revert PR188 integration without touching other candidates
> **Planning Source**: Owner-approved C07 merge train; existing PR188 design retained
> **Task Contract**: `tasks/contracts/20260917-1330-c07-pr188-integration.contract.md`
> **Task Review**: `tasks/reviews/20260917-1330-c07-pr188-integration.review.md`
> **Implementation Notes**: `tasks/notes/20260917-1330-c07-pr188-integration.notes.md`

## Goal
Integrate the existing PR188 candidate with accepted PR187/main, prove the combined candidate, and merge PR188. No new MCP semantics or compatibility paths.

## P1 Architecture
The SDK MCP core owns transport, discovery, observations and per-tool projection. Pi extension and preparation are consumers. Native Pi compilation remains external authority; source authorization belongs to the configured Host resolver.

## P2 Concrete Trace
Daemon preparation resolves scope/source, reserves the durable record, observes configured MCP executors, compiles through native Pi, then stores the receipt. Execution uses the same MCP observation/projection core through the Pi extension. The merge preserves PR187 authorization before reserve/compile and its bounded counter and GC lifecycle.

## P3 Decision
Retain the existing PR188 design and use Git's conflict-free main merge. No compatibility adapter. Freeze current main 601a1991da6c0c0353d4d059cdc851f457e79d93 before checks; evaluate public API, actual MCP fixtures and full repo guards on the combined head. At 10x scale process ownership and bounded RPC/tool results remain the pressure points; this integration does not expand those contracts.

## Task Breakdown
- [x] Verify dependency and merge accepted main without conflicts.
- [ ] Freeze authority/projection and run canonical checks.
- [ ] Obtain one independent exact-subject acceptance and finalize.
- [ ] Push, verify exact-head CI and merge PR188; preserve dependent PR bases until retargeted.

## Stop Conditions
No provider calls/publication/deployment. Preserve other worktrees and concurrent PR193 work. At most three fix/verify rounds per issue; report unrelated failures.

## Evidence Contract
- State/progress path: This plan Task Breakdown and matching contract/notes/review.
- Verification evidence: Canonical .ai/harness/checks/latest.json and immutable .ai/harness/runs records.
- Evaluator rubric: One independent Codex verdict on the frozen MCP integration boundary.
- Stop condition: Checks and acceptance pass, exact-head CI passes, PR188 merged.
- Rollback surface: Revert this PR188 integration.

## Promotion Gate
- Merge/PR unit: PR188 shared MCP core and current-main integration.
- Rollback surface: Revert PR188 without modifying other C07 branches.
- Verification boundary: Canonical contract checks and exact-head GitHub CI.
- Review/acceptance boundary: Typed AcceptanceReceipt from independent Codex review.
- High-risk surface: MCP tool identity, runtime projection and preparation binding.
- Why not checklist row: An independently mergeable PR with shared public API and runtime ownership changes.
