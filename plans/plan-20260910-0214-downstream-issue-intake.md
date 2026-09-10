# Plan: Downstream GitHub issue intake

> **Status**: Executing
> **Created**: 20260910-0214
> **Slug**: downstream-issue-intake
> **Planning Source**: codex-plan-or-waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Static GitHub form structure, documentation links, diff whitespace; no runtime changes
> **Rollback Surface**: Remove issue form and documentation entrypoints
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260910-0214-downstream-issue-intake.contract.md`
> **Task Review**: `tasks/reviews/20260910-0214-downstream-issue-intake.review.md`
> **Implementation Notes**: `tasks/notes/20260910-0214-downstream-issue-intake.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan-or-waza-think planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260910-0214-downstream-issue-intake.md`
- Sprint contract: `tasks/contracts/20260910-0214-downstream-issue-intake.contract.md`
- Sprint review: `tasks/reviews/20260910-0214-downstream-issue-intake.review.md`
- Implementation notes: `tasks/notes/20260910-0214-downstream-issue-intake.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260910-0214-downstream-issue-intake.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260910-0214-downstream-issue-intake.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260910-0214-downstream-issue-intake.md`.

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
- Contract file: `tasks/contracts/20260910-0214-downstream-issue-intake.contract.md`
- Review file: `tasks/reviews/20260910-0214-downstream-issue-intake.review.md`
- Implementation notes file: `tasks/notes/20260910-0214-downstream-issue-intake.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260910-0214-downstream-issue-intake.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260910-0214-downstream-issue-intake.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Remove issue form and documentation entrypoints
- **Verification boundary**: Static GitHub form structure, documentation links, diff whitespace; no runtime changes
- **Review/acceptance boundary**: `tasks/reviews/20260910-0214-downstream-issue-intake.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260910-0214-downstream-issue-intake.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260910-0214-downstream-issue-intake.contract.md`, `tasks/reviews/20260910-0214-downstream-issue-intake.review.md`, and `tasks/notes/20260910-0214-downstream-issue-intake.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260910-0214-downstream-issue-intake.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Remove issue form and documentation entrypoints

## Captured Planning Output

Implement the user-requested upstream issue intake using native GitHub Issue Forms.
P1: GitHub Issues is enabled at Ancienttwo/byok-sdk; no existing issue templates. README and diagnostics guide are downstream entrypoints. SDK runtime is outside scope.
P2: Downstream opens link, fills exact versions/scenario/evidence/acceptance/impact, submits under their GitHub identity, and tracks the resulting issue URL. CLI submission explicitly targets upstream.
P3: GitHub owns submission, identity and issue state. Add one bilingual form and guide; do not add runtime reporting or duplicate issue storage. At 10x volume triage is the bottleneck; duplicate search and structured evidence support it.
## Task Breakdown
- [x] Add .github/ISSUE_TEMPLATE/downstream-integration.yml.
- [x] Add docs/upstream-requests.md and link from README.md and docs/agent-diagnostics-integration.md.
- [x] Validate YAML structure and links, run git diff --check, record results.
User approved default-branch landing and GitHub page acceptance on 2026-09-10. Package publication and real test issue creation remain out of scope. Preserve existing research and sprint WIP.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Add .github/ISSUE_TEMPLATE/downstream-integration.yml.
- [x] Add docs/upstream-requests.md and link from README.md and docs/agent-diagnostics-integration.md.
- [x] Validate YAML structure and links, run git diff --check, record results.

## Approved landing follow-up

- [ ] Freeze valid contract and static verification evidence.
- [ ] Obtain the required acceptance receipt without inferring a waiver.
- [ ] Land the bounded diff on the GitHub default branch and verify the live form.
