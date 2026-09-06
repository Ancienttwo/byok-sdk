# Plan: Issue 147 task offer journal authority

> **Status**: Completed
> **Created**: 20260906-0350
> **Slug**: issue-147-task-offer-journal
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: Cross-package protocol classification and durable recovery invariant; independently reviewable bugfix
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260906-0420-issue-147-integration.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20260906-0420-issue-147-integration.md`; after execution revert branch `codex/issue-147-task-offer-journal` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260906-0420-issue-147-integration.contract.md`
> **Task Review**: `tasks/reviews/20260906-0420-issue-147-integration.review.md`
> **Implementation Notes**: `tasks/notes/20260906-0420-issue-147-integration.notes.md`

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

- Active plan: `plans/plan-20260906-0420-issue-147-integration.md`
- Sprint contract: `tasks/contracts/20260906-0420-issue-147-integration.contract.md`
- Sprint review: `tasks/reviews/20260906-0420-issue-147-integration.review.md`
- Implementation notes: `tasks/notes/20260906-0420-issue-147-integration.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260906-0420-issue-147-integration.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260906-0420-issue-147-integration.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260906-0420-issue-147-integration.md`.

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
- Contract file: `tasks/contracts/20260906-0420-issue-147-integration.contract.md`
- Review file: `tasks/reviews/20260906-0420-issue-147-integration.review.md`
- Implementation notes file: `tasks/notes/20260906-0420-issue-147-integration.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260906-0420-issue-147-integration.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260906-0420-issue-147-integration.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260906-0420-issue-147-integration.md`; after execution revert branch `codex/issue-147-task-offer-journal` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260906-0420-issue-147-integration.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260906-0420-issue-147-integration.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: Cross-package protocol classification and durable recovery invariant; independently reviewable bugfix

## Evidence Contract

- **State/progress path**: `plans/plan-20260906-0420-issue-147-integration.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260906-0420-issue-147-integration.contract.md`, `tasks/reviews/20260906-0420-issue-147-integration.review.md`, and `tasks/notes/20260906-0420-issue-147-integration.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260906-0420-issue-147-integration.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260906-0420-issue-147-integration.md`; after execution revert branch `codex/issue-147-task-offer-journal` or the explicitly reviewed diff.

## Integration authority
User approved this exact next slice: combine #147 with frozen PR149 and obtain typed Claude AcceptanceReceipt. PR149 merged at612ec44073f0481341036107483aaf8fdc190a87, head27a5a70d6a16aadfb4f97272b9cdcee22e330aea. Integrate source branch1dc17ce24ed8206c1dc6e6b784d72c38f3a4e342 only in /Users/kito/Projects/byok-sdk-wt-issue-147-integration. Main has concurrent timeline-spill WIP; do not touch it.

## P1 Architecture Map
Protocol registry and daemon journaling overlap PR149 protocol exports/event spill config. Spill owns bounded event payloads, journal owns durable task rows. The combined source must preserve both.

## P2 Concrete Trace
Validated offer -> protocol classifier -> journal append -> runner -> cursor. Oversized runtime event -> spill -> bounded payload -> egress -> terminal journal/send. Restart reads the same task rows and marks interrupted.

## P3 Design Decision
Merge exact accepted main successor and exact #147 source rather than reconstructing either patch. Regenerate protocol API closure; verify combined source once before external review. Keep existing contract-frozen Claude/protocol1 acceptance authority as explicitly approved; do not silently change it to the newly installed protocol2 default. No new dependencies or runtime behavior beyond the approved fixes. Existing journal/spill bounds govern 10x load.

## Task Breakdown
- [x] I1 Readback frozen PR149 and isolate integration checkout.
- [ ] I2 Integrate exact #147 subject and regenerate API snapshot.
- [ ] I3 Run combined source gates and freeze semantic subject.
- [ ] I4 Obtain one read-only Claude review, record and verify typed AcceptanceReceipt, deliver local integration handoff.

## Stop and scope
No main merge/push/release/registry/tag/deploy/downstream pin. Do not include timeline-spill or provider catalog WIP. New reviewer findings outside this integration are report-only. No user waiver has been requested or granted.

## Verified closeout — 2026-09-06

Lifecycle reconciled from exact SDK/consumer CI and live PR/Issue readback in `tasks/notes/20260906-pr152-closeout.md`. Historical checkboxes and acceptance text remain frozen; this completion record supersedes earlier pending-state statements. This closes the source/candidate delivery boundary only; registry publication and production rollout remain separate.
