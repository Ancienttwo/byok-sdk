# Plan: Close original Issue178 with verified existing coverage

> **Status**: Executing
> **Created**: 20260910-2154
> **Slug**: brc178-completion
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: sprint:plans/sprints/brc1415-canary.sprint.md#Campaign byok-brc1415-20260910-completion group 1 slot 02: test_gap #178
> **Artifact Level**: work-package
> **Promotion Reason**: verification_boundary
> **Verification Boundary**: Canonical-root acceptance of the exact not-planned decision and falsifier
> **Rollback Surface**: Revert evidence before closeout; preserve immutable disposition afterward
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260910-2154-brc178-completion.contract.md`
> **Task Review**: `tasks/reviews/20260910-2154-brc178-completion.review.md`
> **Implementation Notes**: `tasks/notes/20260910-2154-brc178-completion.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan planning output.
- Source ref: sprint:plans/sprints/brc1415-canary.sprint.md#Campaign byok-brc1415-20260910-completion group 1 slot 02: test_gap #178
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260910-2154-brc178-completion.md`
- Sprint contract: `tasks/contracts/20260910-2154-brc178-completion.contract.md`
- Sprint review: `tasks/reviews/20260910-2154-brc178-completion.review.md`
- Implementation notes: `tasks/notes/20260910-2154-brc178-completion.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260910-2154-brc178-completion.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260910-2154-brc178-completion.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260910-2154-brc178-completion.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/20260910-2154-brc178-completion.contract.md`
- Review file: `tasks/reviews/20260910-2154-brc178-completion.review.md`
- Implementation notes file: `tasks/notes/20260910-2154-brc178-completion.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260910-2154-brc178-completion.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260910-2154-brc178-completion.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert evidence before closeout; preserve immutable disposition afterward
- **Verification boundary**: Canonical-root acceptance of the exact not-planned decision and falsifier
- **Review/acceptance boundary**: `tasks/reviews/20260910-2154-brc178-completion.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: verification_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260910-2154-brc178-completion.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260910-2154-brc178-completion.contract.md`, `tasks/reviews/20260910-2154-brc178-completion.review.md`, and `tasks/notes/20260910-2154-brc178-completion.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260910-2154-brc178-completion.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert evidence before closeout; preserve immutable disposition afterward

## Captured Planning Output

# Issue178 evidence disposition

P1 Map: Original Issue178 alleges absent installed umbrella-package smoke coverage. The frozen source scripts/release/pack-and-smoke.mjs already installs the packed ten-package graph and invokes an isolated Node consumer that asserts exactly seven exported namespaces and excludes keys. The existing Linux, macOS and Windows pack/install jobs at ce48120507bb51360d48aa2ab3a2ffbe4be67951 passed. Issue177 separately repairs README drift and its TS2532 typing error.

P2 Trace: The new campaign planning job for task cc390699e5a5d75ce321debd91105e16aa86084a9c66dad342c99d8fab555764, revision cb10becaf27c226dc9467c948a4b37f15a858811ac32c3e71eaebad56e6bc437, recorded not_reproducible with no proof, binding or execution. The close-not-planned consumer requires an exact committed typed decision, its hash-bound falsifier and a canonical-root AcceptanceReceipt whose reviewed paths include both artifacts. A receipt from another worktree cannot satisfy this boundary.

P3 Decision: Preserve the existing test coverage and record only two evidence files under tasks/evidence/. Reuse the exact baseline CI jobs as historical falsifier evidence after confirming the relevant source digests; do not report an aggregate failed CI run as a pass or claim a new test run. Author artifacts in the parent planning worktree and integrate after the Issue177 worker and verifier have stopped. Prepare and review the final artifact subject at the canonical canary root through the existing codex-plugin path, record the actual verdict, verify the receipt, and invoke public close-not-planned under the authorized parent session. No new dependency, test, runtime export, authorization or compatibility path is needed. Ten times as many findings still each require their own exact task revision and evidence bytes; provider budget is the first finite bound.

Allowed changes: tasks/evidence/brc178-completion.decision.json and tasks/evidence/brc178-completion.falsifier.md. Planning, contract, review and notes are the workflow metadata for this independent acceptance boundary. The decision must exactly match the current campaign, group, intent, Issue database ID, source observation and non-executed task revision. Its falsifier hash includes the sha256: prefix required by this schema.

Verification: This is an artifact-only disposition with no source or executable behavior delta. Check both evidence files against the authoritative schema and cited source/CI observations, and run strict task workflow integrity. Existing passing Issue177 source checks and CI retain their own identities; this contract does not duplicate or relabel them. Final semantic evidence comes from the actual canonical codex-plugin review of these two files and its subject-bound AcceptanceReceipt.

Completion: Only after receipt verification, invoke campaign close-not-planned and read back the immutable cleanup receipt and GitHub Issue178 closed/not_planned status. Then run the fresh group audit against the complete canary and accept the group only if all required cleanup and audit gates pass.

Rollback: Before the public closeout, revert the two evidence artifacts if incorrect. After closeout, preserve immutable evidence and use a new explicit operator disposition for any correction; never rewrite the recorded decision.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] Execute captured plan: Close original Issue178 with verified existing coverage
