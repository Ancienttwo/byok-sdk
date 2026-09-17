# Plan: WP1 Windows CI: swap ps51 diagnostics for permanent lowpriv module warm-up

> **Status**: Executing
> **Created**: 20260917-1646
> **Slug**: wp1-win-ci-warmup
> **Planning Source**: codex-plan-or-waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260917-1646-wp1-win-ci-warmup.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20260917-1646-wp1-win-ci-warmup.md`; after execution revert branch `codex/wp1-win-ci-warmup` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260917-1646-wp1-win-ci-warmup.contract.md`
> **Task Review**: `tasks/reviews/20260917-1646-wp1-win-ci-warmup.review.md`
> **Implementation Notes**: `tasks/notes/20260917-1646-wp1-win-ci-warmup.notes.md`

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

- Active plan: `plans/plan-20260917-1646-wp1-win-ci-warmup.md`
- Sprint contract: `tasks/contracts/20260917-1646-wp1-win-ci-warmup.contract.md`
- Sprint review: `tasks/reviews/20260917-1646-wp1-win-ci-warmup.review.md`
- Implementation notes: `tasks/notes/20260917-1646-wp1-win-ci-warmup.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260917-1646-wp1-win-ci-warmup.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260917-1646-wp1-win-ci-warmup.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260917-1646-wp1-win-ci-warmup.md`.

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
- Contract file: `tasks/contracts/20260917-1646-wp1-win-ci-warmup.contract.md`
- Review file: `tasks/reviews/20260917-1646-wp1-win-ci-warmup.review.md`
- Implementation notes file: `tasks/notes/20260917-1646-wp1-win-ci-warmup.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260917-1646-wp1-win-ci-warmup.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260917-1646-wp1-win-ci-warmup.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260917-1646-wp1-win-ci-warmup.md`; after execution revert branch `codex/wp1-win-ci-warmup` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260917-1646-wp1-win-ci-warmup.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260917-1646-wp1-win-ci-warmup.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260917-1646-wp1-win-ci-warmup.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260917-1646-wp1-win-ci-warmup.contract.md`, `tasks/reviews/20260917-1646-wp1-win-ci-warmup.review.md`, and `tasks/notes/20260917-1646-wp1-win-ci-warmup.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260917-1646-wp1-win-ci-warmup.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260917-1646-wp1-win-ci-warmup.md`; after execution revert branch `codex/wp1-win-ci-warmup` or the explicitly reviewed diff.

## Captured Planning Output

# WP1 Windows CI: swap ps51 diagnostics for permanent lowpriv module warm-up

## Why
Round 4 (run 35200434840) closed the module-load question: under the lowpriv token, a cold PS 5.1 profile fails to auto-load Microsoft.PowerShell.Security inside the keys suite's -EncodedCommand query (rounds 1-3), and a single explicit Import-Module under that token first (diagA/diagB) makes the product path resolve Get-Acl — 3/4 keys tests green, including the previously failing positive ACL case. The temporary [ps51-diag] block and the two probe commits in packages/keys were evidence instruments and must leave the tree; the warm-up must stay as environment setup for the synthetic account.

## Task Breakdown
- [x] Restore packages/keys/src/pi-provider-launcher-core.ts to baseline d4dcf961 bytes (drop the two temporary probe edits 5dd0056a/2bb441ba).
- [x] Replace the [ps51-diag] block in .github/workflows/ci.yml with a permanent one-line PS 5.1 module warm-up (Import-Module Microsoft.PowerShell.Security under the lowpriv token, before the keys suite), with rationale comment.
- [x] Commit both (no AI attribution). No push: the owner-mismatch keys test remains red on a pre-existing product-code Translate bug (WINDOWS_PROJECTION_ACL_SCRIPT eager per-ACE IdentityReference.Translate fails under lowpriv on SystemRoot), reported to the Owner for a packages/keys ownership ruling before any further push.

## Evidence Contract
- round-4 logs 35200434840: [ps51-diag] as-inherited/sanitized both resolve Get-Acl; keys suite 3 passed / 1 failed with MethodInvocationException Translate.
- git diff d4dcf961..HEAD -- packages/keys/ empty after restore.

## Promotion Gate
Owner-approved WP1 chain ("批准": gate -> push -> Windows CI verification) continues on this branch; this slice is the in-surface cleanup half. Product-code fix is explicitly out of this slice's scope (blocked on ownership ruling).

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Restore packages/keys/src/pi-provider-launcher-core.ts to baseline d4dcf961 bytes (drop the two temporary probe edits 5dd0056a/2bb441ba).
- [x] Replace the [ps51-diag] block in .github/workflows/ci.yml with a permanent one-line PS 5.1 module warm-up (Import-Module Microsoft.PowerShell.Security under the lowpriv token, before the keys suite), with rationale comment.
- [x] Commit both (no AI attribution). No push: the owner-mismatch keys test remains red on a pre-existing product-code Translate bug (WINDOWS_PROJECTION_ACL_SCRIPT eager per-ACE IdentityReference.Translate fails under lowpriv on SystemRoot), reported to the Owner for a packages/keys ownership ruling before any further push.
