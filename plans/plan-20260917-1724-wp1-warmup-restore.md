# Plan: WP1: restore proven Get-Command warm-up form

> **Status**: Complete
> **Created**: 20260917-1724
> **Slug**: wp1-warmup-restore
> **Planning Source**: codex-plan-or-waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260917-1724-wp1-warmup-restore.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20260917-1724-wp1-warmup-restore.md`; after execution revert branch `codex/wp1-warmup-restore` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260917-1724-wp1-warmup-restore.contract.md`
> **Task Review**: `tasks/reviews/20260917-1724-wp1-warmup-restore.review.md`
> **Implementation Notes**: `tasks/notes/20260917-1724-wp1-warmup-restore.notes.md`

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

- Active plan: `plans/plan-20260917-1724-wp1-warmup-restore.md`
- Sprint contract: `tasks/contracts/20260917-1724-wp1-warmup-restore.contract.md`
- Sprint review: `tasks/reviews/20260917-1724-wp1-warmup-restore.review.md`
- Implementation notes: `tasks/notes/20260917-1724-wp1-warmup-restore.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260917-1724-wp1-warmup-restore.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260917-1724-wp1-warmup-restore.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260917-1724-wp1-warmup-restore.md`.

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
- Contract file: `tasks/contracts/20260917-1724-wp1-warmup-restore.contract.md`
- Review file: `tasks/reviews/20260917-1724-wp1-warmup-restore.review.md`
- Implementation notes file: `tasks/notes/20260917-1724-wp1-warmup-restore.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260917-1724-wp1-warmup-restore.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260917-1724-wp1-warmup-restore.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260917-1724-wp1-warmup-restore.md`; after execution revert branch `codex/wp1-warmup-restore` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260917-1724-wp1-warmup-restore.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260917-1724-wp1-warmup-restore.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260917-1724-wp1-warmup-restore.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260917-1724-wp1-warmup-restore.contract.md`, `tasks/reviews/20260917-1724-wp1-warmup-restore.review.md`, and `tasks/notes/20260917-1724-wp1-warmup-restore.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260917-1724-wp1-warmup-restore.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260917-1724-wp1-warmup-restore.md`; after execution revert branch `codex/wp1-warmup-restore` or the explicitly reviewed diff.

## Captured Planning Output

# WP1 Windows CI: restore the empirically-proven module warm-up form

## Why
Round 5 (35203870015) regressed to the rounds-1-3 failure mode: test 1 slow-fail 5006ms, tests 2-4 fast generic fails -- timing signature matches round 3 (4044/398/345/366ms) where Get-Acl module auto-load failed. The downgraded warm-up (Import-Module only) does not produce the state round 4's form (Import-Module + (Get-Command Get-Acl).Name) demonstrably produced for subsequent processes. The translate fix never got exercised (script never reached the rules loop).

## Task Breakdown
- [x] ci.yml warm-up: add `(Get-Command Get-Acl).Name` after Import-Module (round-4 proven form) and gate the warm-up on $LASTEXITCODE with a clear Fail message (import failure is an env problem, fail loud not downstream).
- [x] Local parse/grep verification, commit, push round 6.

## Evidence Contract
- Round 4: warm-up with Get-Command -> 4/4 tests reached real bodies, module load green in all product spawns (timings 1709/506/614/459ms).
- Round 5: Import-Module only -> 5006ms timeout + fast generic fails = round-3 signature.
- PS7 parse of the modified ACL script: PARSE_OK (docker), construct smoke sid=S-1-5-18 passthrough OK.

## Promotion Gate
Same Owner-approved WP1 chain (close the lowpriv lane green). ci.yml-only change; no product bytes.

## Stop Conditions
- Stop if round 6 still fails the keys suite after this restore (then re-instrument stderr detail under a fresh ruling).

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] ci.yml warm-up: add `(Get-Command Get-Acl).Name` after Import-Module (round-4 proven form) and gate the warm-up on $LASTEXITCODE with a clear Fail message (import failure is an env problem, fail loud not downstream).
- [x] Local parse/grep verification, commit, push round 6.
