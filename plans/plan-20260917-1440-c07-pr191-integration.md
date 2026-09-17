# Plan: Integrate C07 PR191 trusted MCP launch

> **Status**: Executing
> **Artifact Level**: work-package
> **Promotion Reason**: Integrate and accept the independently mergeable PR191 boundary
> **Verification Boundary**: Current-main MCP preparation and runtime projection with repository required checks
> **Rollback Surface**: Revert PR191 integration without touching other candidates
> **Planning Source**: Owner-approved C07 merge train; existing PR191 design retained
> **Task Contract**: `tasks/contracts/20260917-1440-c07-pr191-integration.contract.md`
> **Task Review**: `tasks/reviews/20260917-1440-c07-pr191-integration.review.md`
> **Implementation Notes**: `tasks/notes/20260917-1440-c07-pr191-integration.notes.md`

## Goal
Integrate the existing PR191 candidate with accepted PR187/main, prove the combined candidate, and merge PR191. No new MCP semantics or compatibility paths.

## P1 Architecture
Trusted launch resolver owns directory/ancestor and launcher validation. TaskRunner carries one binding to MCP probes/adapters; Pi directly spawns there while Claude/Codex use the validated launcher. Remote preparation is another real MCP probe consumer introduced by PR189 and must carry the same boundary into its fingerprints.

## P2 Concrete Trace
Operator mcpLaunchCwd -> directory validation -> remote required-toolset observation -> stdio probe spawn cwd -> returned observation plus actual launch attestation -> executor fingerprint -> durable receipt. Missing/untrusted cwd must reject before spawn and become the existing terminal toolsets_unobservable refusal. Runtime CLI workspace stays independent.

## P3 Decision
Retain existing platform admission/launcher semantics. Resolve trusted cwd once in the existing remote observation closure, pass it to every probe, and return its direct-spawn attestation for fingerprinting. No invented path, inferred launcher or compatibility default. At 10x scale concurrent probes remain bounded by existing deadlines; this slice adds no cache or parallelism.

## Task Breakdown
- [x] Verify dependency and merge accepted main, preserving both document additions.
- [ ] Freeze authority/projection and run canonical checks.
- [ ] Obtain one independent exact-subject acceptance and finalize.
- [ ] Push, verify exact-head CI and merge PR191; preserve dependent PR bases until retargeted.

## Stop Conditions
No provider calls/publication/deployment. Preserve other worktrees and concurrent PR193 work. At most three fix/verify rounds per issue; report unrelated failures.

## Evidence Contract
- State/progress path: This plan Task Breakdown and matching contract/notes/review.
- Verification evidence: Canonical .ai/harness/checks/latest.json and immutable .ai/harness/runs records.
- Evaluator rubric: One independent Codex verdict on the frozen MCP integration boundary.
- Stop condition: Checks and acceptance pass, exact-head CI passes, PR191 merged.
- Rollback surface: Revert this PR191 integration.

## Promotion Gate
- Merge/PR unit: PR191 trusted MCP launch and current-main integration.
- Rollback surface: Revert PR191 without modifying other C07 branches.
- Verification boundary: Canonical contract checks and exact-head GitHub CI.
- Review/acceptance boundary: Typed AcceptanceReceipt from independent Codex review.
- High-risk surface: MCP tool identity, runtime projection and preparation binding.
- Why not checklist row: An independently mergeable PR with shared public API and runtime ownership changes.
