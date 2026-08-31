# Plan: Issue 106 single-flight Agent spool initialization

> **Status**: Complete
> **Created**: 20260901-0149
> **Slug**: issue-106-spool-initialization
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: GitHub issue #106
> **Artifact Level**: work-package
> **Promotion Reason**: A durable Agent spool is an instance-local cursor and write authority; concurrent first-open or a home mismatch can create or silently select the wrong authority.
> **Verification Boundary**: Audit-baseline pre-fix guard, public append concurrency tests, client/root checks, strict workflow verification, and independent acceptance.
> **Rollback Surface**: Revert the home-bound in-flight slot and its dedicated regression tests together.
> **Spec**: `docs/spec.md`
> **Task Contract**: `tasks/contracts/20260901-0149-issue-106-spool-initialization.contract.md`
> **Task Review**: `tasks/reviews/20260901-0149-issue-106-spool-initialization.review.md`
> **Implementation Notes**: `tasks/notes/20260901-0149-issue-106-spool-initialization.notes.md`

## Agentic Routing

- Selected route: concurrency bugfix with deterministic regression oracle.
- P1 map: `AgentEgressController.appendReliable()` and `appendContentReceipt()` resolve one Agent-local `AgentReliableSpool`; that instance owns the pending map, cursor allocation, and write queue for its durable JSONL file.
- P2 trace: first append -> `spoolFor(homeDir, AgentRef)` -> `AgentReliableSpool.open()` -> cached spool -> instance-local append. The audit baseline performed check/await/set; current main added an in-flight promise but did not bind cached or opening authority to the requested home.
- P3 decision rationale: preserve the current single-flight shape, bind each in-flight slot and cached spool to the exact home, fail closed on mismatch, and test through public append operations. Do not add a global mutex or mix in tenant-quota serialization.

## Workflow Inventory

- Active plan: `plans/plan-20260901-0149-issue-106-spool-initialization.md`
- Contract: `tasks/contracts/20260901-0149-issue-106-spool-initialization.contract.md`
- Review: `tasks/reviews/20260901-0149-issue-106-spool-initialization.review.md`
- Notes: `tasks/notes/20260901-0149-issue-106-spool-initialization.notes.md`
- Checks: `.ai/harness/checks/latest.json`
- Execution isolation: `/Users/kito/Projects/byok-sdk-wt-issue-106-spool-initialization` on `codex/issue-106-spool-initialization`.

## Trade-offs

| Option | Decision | Reason |
|--------|----------|--------|
| Keep current AgentRef-only promise | rejected | It silently reuses the first home when the same AgentRef is presented with another home. |
| Key only by home | rejected | The controller's public ownership and acknowledgement indexes are AgentRef-based; changing authority shape expands the contract. |
| Home-bound AgentRef promise slot | selected | It closes the named first-open race and fails closed on mismatched authority with the smallest coherent change. |
| Add controller-wide append serialization | rejected | That is the separate tenant-quota race tracked outside #106. |

## Scale Boundary

At 10x concurrent first appends for one AgentRef/home, all callers await one open and then the spool's existing write queue serializes cursor allocation. The first remaining pressure point is cross-Agent tenant quota observation, which is outside this work package.

## Task Breakdown

- [x] Freeze an audit-baseline first-open regression and non-zero artifact.
- [x] Bind cached and in-flight spool authority to the requested home.
- [x] Prove one open, two immediately visible records, and unique monotonic cursors through public appends.
- [x] Prove shared failed-open rejection cleanup/retry and in-flight/cached home mismatch rejection.
- [x] Run focused, client/root, strict workflow, and independent acceptance gates.

## Evidence Contract

- **State/progress path**: `tasks/current.md`, this plan's `## Task Breakdown`, and `tasks/notes/20260901-0149-issue-106-spool-initialization.notes.md`.
- **Verification evidence**: audit-baseline failing artifact, focused Vitest results, client/root build and typecheck output, strict workflow report, and a typed `AcceptanceReceipt`.
- **Evaluator rubric**: one AgentRef/home has one live first-open authority; concurrent successful records are immediately visible with unique monotonic cursors; shared failure permits retry; a different home fails closed before append; scope excludes tenant quota and other daemon lifecycles.
- **Stop condition**: stop only after every task row is evidenced, the independent gate passes, the final receipt verifies, and repo-harness allows handoff.
- **Rollback surface**: the controller slot shape/home checks and one dedicated test file section.
- The clean audit baseline must fail the exact public append concurrency guard for the expected one-open/visible-record invariant.
- Existing restart, acknowledgement, quota, and Agent-home contract tests remain green.

## Promotion Gate

- **Merge/PR unit**: complete #106 home-bound single-flight spool initialization and its dedicated regression evidence.
- **Rollback surface**: `AgentEgressController` slot/home checks and the focused first-open tests.
- **Verification boundary**: exact isolated-worktree diff plus focused client tests, client package build/typecheck, root required checks, strict workflow verification, and independent read-only review.
- **Review/acceptance boundary**: one gatekeeper evaluates the frozen diff and records one typed acceptance receipt.
- **High-risk surface**: durable spool identity, cursor allocation, first-open promise cleanup, and home authority.
- **Why not checklist row**: merge, push, issue mutation, release, and deployment are separate authorities outside this approved local slice.
- **Not authorized**: merge, push, PR, issue close, publish, deploy, or production mutation.
