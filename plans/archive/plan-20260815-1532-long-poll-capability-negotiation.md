# Plan: Long-poll capability negotiation

> **Status**: Archived
> **Created**: 20260815-1532
> **Slug**: long-poll-capability-negotiation
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Red-green client regression plus protocol, cloud, server targeted tests and required workspace checks
> **Rollback Surface**: Additive EventsPollResponse.capabilities field and long-poll capability ingestion
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260815-1532-long-poll-capability-negotiation.contract.md`
> **Task Review**: `tasks/reviews/20260815-1532-long-poll-capability-negotiation.review.md`
> **Implementation Notes**: `tasks/notes/20260815-1532-long-poll-capability-negotiation.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260815-1532-long-poll-capability-negotiation.md`
- Sprint contract: `tasks/contracts/20260815-1532-long-poll-capability-negotiation.contract.md`
- Sprint review: `tasks/reviews/20260815-1532-long-poll-capability-negotiation.review.md`
- Implementation notes: `tasks/notes/20260815-1532-long-poll-capability-negotiation.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260815-1532-long-poll-capability-negotiation.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260815-1532-long-poll-capability-negotiation.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260815-1532-long-poll-capability-negotiation.md`.

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
- Contract file: `tasks/contracts/20260815-1532-long-poll-capability-negotiation.contract.md`
- Review file: `tasks/reviews/20260815-1532-long-poll-capability-negotiation.review.md`
- Implementation notes file: `tasks/notes/20260815-1532-long-poll-capability-negotiation.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260815-1532-long-poll-capability-negotiation.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260815-1532-long-poll-capability-negotiation.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Additive EventsPollResponse.capabilities field and long-poll capability ingestion
- **Verification boundary**: Red-green client regression plus protocol, cloud, server targeted tests and required workspace checks
- **Review/acceptance boundary**: `tasks/reviews/20260815-1532-long-poll-capability-negotiation.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260815-1532-long-poll-capability-negotiation.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260815-1532-long-poll-capability-negotiation.contract.md`, `tasks/reviews/20260815-1532-long-poll-capability-negotiation.review.md`, and `tasks/notes/20260815-1532-long-poll-capability-negotiation.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260815-1532-long-poll-capability-negotiation.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Additive EventsPollResponse.capabilities field and long-poll capability ingestion

## Captured Planning Output

## Objective
Restore fail-closed server capability negotiation for pure long-poll topologies so result-document can be delivered when the current responder explicitly supports it.

## Task Breakdown
- [x] Add optional capabilities to EventsPollResponse; absence means empty.
- [x] Advertise implemented capabilities from cloud and server long-poll responders.
- [x] Apply each successful poll advertisement before delivering its events, without overwriting a newer WS ack.
- [x] Add red-green regression coverage and update protocol documentation.
- [x] Run targeted tests and required workspace checks.

## Invariants
- Keep old responders fail-closed; never reuse stale WS capabilities.
- Preserve cursor and envelope delivery semantics.
- Keep cloud advertisement limited to features its inbound path implements.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Add optional capabilities to EventsPollResponse; absence means empty.
- [x] Advertise implemented capabilities from cloud and server long-poll responders.
- [x] Apply each successful poll advertisement before delivering its events, without overwriting a newer WS ack.
- [x] Add red-green regression coverage and update protocol documentation.
- [x] Run targeted tests and required workspace checks.
