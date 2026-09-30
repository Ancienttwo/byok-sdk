# Plan: Host goal and btw execution composition

> **Status**: Executing
> **Created**: 20260930-1536
> **Slug**: conversation-goal-btw
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: User implementation authorization and Herdr Claude w9:p1 discussion
> **Artifact Level**: work-package
> **Promotion Reason**: Explicit implementation authorization; bounded private Host reference, no public SDK topology change
> **Verification Boundary**: Private Host composition, durable CAS and real embedded server/stub daemon tests; root required checks
> **Rollback Surface**: Revert only this isolated branch; retain main research and concurrent Pi upgrade
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260930-1536-conversation-goal-btw.contract.md`
> **Task Review**: `tasks/reviews/20260930-1536-conversation-goal-btw.review.md`
> **Implementation Notes**: `tasks/notes/20260930-1536-conversation-goal-btw.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan planning output.
- Source ref: User implementation authorization and Herdr Claude w9:p1 discussion
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260930-1536-conversation-goal-btw.md`
- Sprint contract: `tasks/contracts/20260930-1536-conversation-goal-btw.contract.md`
- Sprint review: `tasks/reviews/20260930-1536-conversation-goal-btw.review.md`
- Implementation notes: `tasks/notes/20260930-1536-conversation-goal-btw.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260930-1536-conversation-goal-btw.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260930-1536-conversation-goal-btw.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260930-1536-conversation-goal-btw.md`.

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
- Contract file: `tasks/contracts/20260930-1536-conversation-goal-btw.contract.md`
- Review file: `tasks/reviews/20260930-1536-conversation-goal-btw.review.md`
- Implementation notes file: `tasks/notes/20260930-1536-conversation-goal-btw.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260930-1536-conversation-goal-btw.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260930-1536-conversation-goal-btw.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert only this isolated branch; retain main research and concurrent Pi upgrade
- **Verification boundary**: Private Host composition, durable CAS and real embedded server/stub daemon tests; root required checks
- **Review/acceptance boundary**: `tasks/reviews/20260930-1536-conversation-goal-btw.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: Explicit implementation authorization; bounded private Host reference, no public SDK topology change

## Evidence Contract

- **State/progress path**: `plans/plan-20260930-1536-conversation-goal-btw.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260930-1536-conversation-goal-btw.contract.md`, `tasks/reviews/20260930-1536-conversation-goal-btw.review.md`, and `tasks/notes/20260930-1536-conversation-goal-btw.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260930-1536-conversation-goal-btw.review.md` must receive the user-selected Claude w9:p1 external AcceptanceReceipt over the frozen subject
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert only this isolated branch; retain main research and concurrent Pi upgrade

## Captured Planning Output

## Goal
Implement a usable, private Host composition for persistent goals and independent btw questions in the existing basic example. Codex owns code; the user-selected Herdr Claude supplies read-only design/review. User explicitly authorized discussion and final implementation.

## P1/P2/P3
P1: Host owns objective, context snapshot, CAS/outbox and product result acceptance. SDK owns fresh offers, exact Agent/device, runtime admission and terminal truth. No new public package API, wire, provider transport or Pi pin.
P2: SQLite reserve with revision CAS -> immutable taskId/input -> embedded dispatchFreshAgentEgress -> TaskRunner canonical-home admission -> stub runtime -> device terminal -> exact readback -> validated Host goal/btw result. A different agentId/home allows btw concurrency; profileRevision alone does not.
P3: Adopt host orchestration rather than native TUI plugin injection. Claude rejects premature public GoalStore/controller; use example-local SQLite persistence and callable composition instead of merely a test reducer. Max steps and explicit deadline bound continuation. No release receipt is invented: subsequent admission may decline, which blocks the goal without retry.

## Scope
- examples/basic/goal-btw.ts and goal-btw-store.ts: explicit Host-owned state, transactional revision CAS, immutable reserved execution, exact recovery/readback; no background timer or implicit retry.
- examples/basic tests: goal continue/complete/wait/block, budgets, pause/cancel, SQLite restart/crash windows, stale revisions, exact bindings; real embedded server + public-API stub daemon for parallel btw, cancellation isolation and same-home refusal.
- Existing example package test/typecheck scripts, README with concrete usage and result extraction/configuration requirements.
- docs/researches/2026-09-30-goal-btw-host-integration.md, owned tasks artifacts. Update research conclusions to clarify useful patterns versus native package installation.
- Out: SDK public exports, cloud/protocol/client production changes, Pi upgrade, global plugins, paid provider requests, release/deploy and downstream Salesko writes.

## Falsifier
If fresh result-document cannot support message-free goal/btw on real embedded server/stub daemon, or separate homes/cancellation cannot preserve the main task, stop and revisit the selected execution seam rather than weakening admission.

## Verification
bun run build; bun run typecheck; bun run test; bun run check:api-surface; bun run check:version-authority; repo-harness run check-task-workflow --strict. New example tests include runtime transport and Host state restart; native Pi/Claude/Codex and downstream production adoption are not established by stub evidence.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] T1 Freeze Host composition and SQLite CAS/outbox design (private Host database, built-in node:sqlite), record Claude corrections.
- [x] T2 Implement persistent goal state and explicit bounded reserve/submit/reconcile/pause/resume/cancel.
- [x] T3 Implement independent readonly btw input, results and exact cancellation.
- [x] T4 Run lifecycle/restart/concurrency and real server+stub daemon acceptance; obtain Claude review and fix actionable findings.
- [ ] T5 Run required checks, update documentation/plan/receipts and deliver the isolated patch.
