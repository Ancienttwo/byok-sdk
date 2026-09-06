# Plan: Issue 147 task offer journal authority

> **Status**: Completed
> **Created**: 20260906-0350
> **Slug**: issue-147-task-offer-journal
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: Cross-package protocol classification and durable recovery invariant; independently reviewable bugfix
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260906-0350-issue-147-task-offer-journal.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20260906-0350-issue-147-task-offer-journal.md`; after execution revert branch `codex/issue-147-task-offer-journal` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260906-0350-issue-147-task-offer-journal.contract.md`
> **Task Review**: `tasks/reviews/20260906-0350-issue-147-task-offer-journal.review.md`
> **Implementation Notes**: `tasks/notes/20260906-0350-issue-147-task-offer-journal.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260906-0350-issue-147-task-offer-journal.md`
- Sprint contract: `tasks/contracts/20260906-0350-issue-147-task-offer-journal.contract.md`
- Sprint review: `tasks/reviews/20260906-0350-issue-147-task-offer-journal.review.md`
- Implementation notes: `tasks/notes/20260906-0350-issue-147-task-offer-journal.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260906-0350-issue-147-task-offer-journal.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260906-0350-issue-147-task-offer-journal.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260906-0350-issue-147-task-offer-journal.md`.

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
- Contract file: `tasks/contracts/20260906-0350-issue-147-task-offer-journal.contract.md`
- Review file: `tasks/reviews/20260906-0350-issue-147-task-offer-journal.review.md`
- Implementation notes file: `tasks/notes/20260906-0350-issue-147-task-offer-journal.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260906-0350-issue-147-task-offer-journal.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260906-0350-issue-147-task-offer-journal.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260906-0350-issue-147-task-offer-journal.md`; after execution revert branch `codex/issue-147-task-offer-journal` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260906-0350-issue-147-task-offer-journal.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260906-0350-issue-147-task-offer-journal.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: Cross-package protocol classification and durable recovery invariant; independently reviewable bugfix

## Evidence Contract

- **State/progress path**: `plans/plan-20260906-0350-issue-147-task-offer-journal.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260906-0350-issue-147-task-offer-journal.contract.md`, `tasks/reviews/20260906-0350-issue-147-task-offer-journal.review.md`, and `tasks/notes/20260906-0350-issue-147-task-offer-journal.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260906-0350-issue-147-task-offer-journal.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260906-0350-issue-147-task-offer-journal.md`; after execution revert branch `codex/issue-147-task-offer-journal` or the explicitly reviewed diff.

## Captured Planning Output

# Issue 147 task offer journal authority

## Goal
Fix protocol-owned classification of all task offer variants so hosted journal opens each task before cursor acknowledgement, persists terminals and marks interrupted tasks on restart.

## P1 Architecture Map
Protocol messages/envelope owns the five wire offers; client create-daemon projects validated envelopes into LocalTaskJournal; SQLite owns durable rows; ConnectionManager owns cursor after onEnvelope resolves. TaskRunner owns execution. No cloud settlement, doctor or Salesko changes.

## P2 Concrete Trace
Server offer -> validated Envelope -> create-daemon toJournalEnvelopeRecord -> appendEnvelope transaction -> journal_task if opensTask -> runner -> cursor persisted. Outbound terminal -> recordTerminal -> send. Restart -> listRecoverable -> markRecovered(interrupted). Current hardcoded three-type predicate omits both egress variants, explaining absent task rows, unknown-task terminal warnings and empty recovery scan.

## P3 Design Decision
Define task-offer payload registry in protocol and derive family classification from that registry; consume it at journal projection. Preserve wire shapes and transaction ordering, remove client duplicated list. At 10x traffic existing bounded journal pressure remains the first limit; classification adds no persistence or async boundary. No new dependency.

## Scope
Protocol registry/export and tests; client journal projection and lifecycle regression tests; generated API snapshots and task artifacts. No release/version changes or unrelated WIP.

## Task Breakdown
- [x] T1 Freeze independent base and activate plan/bugfix contract.
- [x] T2 Capture failing regression on unchanged production source.
- [x] T3 Implement protocol single authority and verify lifecycle, recovery, ordering and dedup.
- [x] T4 Run source gates and record integration-ready handoff; release train coordination remains a pre-release gate.

## Subject and Isolation
Base origin/main 440907ee2c44051b427d9ed4fe1431d93ffff72d, refreshed 2026-09-06. Branch codex/issue-147-task-offer-journal, worktree /Users/kito/Projects/byok-sdk-wt-issue-147. Main checkout currently claude/event-spill at 152206c, local main ahead origin/main; neither is our base. Provider catalog and event spill WIP remain untouched. Integration may overlap create-daemon.ts, protocol/index.ts and generated API snapshots: integrate only frozen successor evidence.

## Verification
Regression-first real SQLite journal integration; protocol complete-family coverage; existing journal integration/crash/pressure/dedup suites. Required build, typecheck, test, API surface, version authority and strict workflow checks. Source acceptance is not published artifact acceptance. No push/merge/publish/tag/deploy authorization implied.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Source Delivery

All authorized source work complete at fc404d7ce0599d6ab0e396af39e89a3c8b11ae0c. Single handoff: tasks/notes/issue-147-handoff.md. Plan remains Review because typed acceptance and release integration have not occurred; source checks do not stand in for those gates.

## Verified closeout — 2026-09-06

Lifecycle reconciled from exact SDK/consumer CI and live PR/Issue readback in `tasks/notes/20260906-pr152-closeout.md`. Historical checkboxes and acceptance text remain frozen; this completion record supersedes earlier pending-state statements. This closes the source/candidate delivery boundary only; registry publication and production rollout remain separate.
