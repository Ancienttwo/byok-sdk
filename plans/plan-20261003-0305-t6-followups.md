# Plan: T6 Claude mode, uncertain group and output/preflight followups

> **Status**: Executing
> **Created**: 20261003-0305
> **Slug**: t6-followups
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: /tmp/byok-t6-followups.md
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: four independent red-on-old regressions and final exact-HEAD checks
> **Rollback Surface**: four local followup commits in the isolated worktree
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20261003-0305-t6-followups.contract.md`
> **Task Review**: `tasks/reviews/20261003-0305-t6-followups.review.md`
> **Implementation Notes**: `tasks/notes/20261003-0305-t6-followups.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan planning output.
- Source ref: /tmp/byok-t6-followups.md
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20261003-0305-t6-followups.md`
- Sprint contract: `tasks/contracts/20261003-0305-t6-followups.contract.md`
- Sprint review: `tasks/reviews/20261003-0305-t6-followups.review.md`
- Implementation notes: `tasks/notes/20261003-0305-t6-followups.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20261003-0305-t6-followups.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20261003-0305-t6-followups.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20261003-0305-t6-followups.md`.

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
- Contract file: `tasks/contracts/20261003-0305-t6-followups.contract.md`
- Review file: `tasks/reviews/20261003-0305-t6-followups.review.md`
- Implementation notes file: `tasks/notes/20261003-0305-t6-followups.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20261003-0305-t6-followups.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20261003-0305-t6-followups.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: four local followup commits in the isolated worktree
- **Verification boundary**: four independent red-on-old regressions and final exact-HEAD checks
- **Review/acceptance boundary**: `tasks/reviews/20261003-0305-t6-followups.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20261003-0305-t6-followups.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20261003-0305-t6-followups.contract.md`, `tasks/reviews/20261003-0305-t6-followups.review.md`, and `tasks/notes/20261003-0305-t6-followups.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20261003-0305-t6-followups.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: four local followup commits in the isolated worktree

## Captured Planning Output

# Owner-approved T6 followups
Scope authority /tmp/byok-t6-followups.md. Work ONLY on codex/n1-t6-followups in /Users/chris/Projects/byok-sdk-wt-t6-followups off current origin/main. F2 remains outside this branch. Local commits only, each item one commit with red-on-old tests.

## P1 map
Client custody owns final admission, native spawn, shared physical/cumulative/live accounting. Vendor owns finite adapter invocation/async output conventions. Implementation-identity owns sealed physical installation proof. Keep SDK umbrella and credential boundary.
## P2 trace
Prepare verifies installation/version/help/mode; task final admission currently verifies identity but not changed mode, post-PID setup errors retain uncertain slots without group stop, output argv accepts any absolute path, and exhausted cumulative policy is checked only after probes.
## P3 decision
Four sequential independent slices, preserve F1 charge-once and all caps. Use supported CLI status for final mode recheck without unproved settings/pin. Stop uncertain process group while retaining slots until proven death. Bind legitimate async output root without cwd-only limitation. Reuse one cumulative policy for early/final checks. No F2 cherry-pick, no billing or quota wiring.

## Task Breakdown
- [x] F3: final Claude auth-mode recheck, red-on-old fixture and residual pin/check-time evidence; local commit.
- [x] Info-2: SIGTERM post-PID uncertain group, retain slots/counters and test actual group signal/liveness; local commit.
- [x] F6: bind adapter output path and legitimate async root, substitute/refuse fixtures and provenance; local commit.
- [ ] F4: shared authoritative policy preflight, no probes when exhausted, race-safe final admission; local commit.
- [ ] Regenerate projection only through tooling and execute exact seven-check chain after last commit; publish /tmp/byok-t6-followups-report.md.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] F3: final Claude auth-mode recheck, red-on-old fixture and residual pin/check-time evidence; local commit.
- [x] Info-2: SIGTERM post-PID uncertain group, retain slots/counters and test actual group signal/liveness; local commit.
- [x] F6: bind adapter output path and legitimate async root, substitute/refuse fixtures and provenance; local commit.
- [ ] F4: shared authoritative policy preflight, no probes when exhausted, race-safe final admission; local commit.
- [ ] Regenerate projection only through tooling and execute exact seven-check chain after last commit; publish /tmp/byok-t6-followups-report.md.
