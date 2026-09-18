# Plan: WP1 keys: resilient per-ACE identity translation in Windows projection ACL script

> **Status**: Executing
> **Created**: 20260917-1705
> **Slug**: wp1-keys-translate-resilience
> **Planning Source**: codex-plan-or-waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260917-1705-wp1-keys-translate-resilience.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20260917-1705-wp1-keys-translate-resilience.md`; after execution revert branch `codex/wp1-keys-translate-resilience` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260917-1705-wp1-keys-translate-resilience.contract.md`
> **Task Review**: `tasks/reviews/20260917-1705-wp1-keys-translate-resilience.review.md`
> **Implementation Notes**: `tasks/notes/20260917-1705-wp1-keys-translate-resilience.notes.md`

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

- Active plan: `plans/plan-20260917-1705-wp1-keys-translate-resilience.md`
- Sprint contract: `tasks/contracts/20260917-1705-wp1-keys-translate-resilience.contract.md`
- Sprint review: `tasks/reviews/20260917-1705-wp1-keys-translate-resilience.review.md`
- Implementation notes: `tasks/notes/20260917-1705-wp1-keys-translate-resilience.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260917-1705-wp1-keys-translate-resilience.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260917-1705-wp1-keys-translate-resilience.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260917-1705-wp1-keys-translate-resilience.md`.

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
- Contract file: `tasks/contracts/20260917-1705-wp1-keys-translate-resilience.contract.md`
- Review file: `tasks/reviews/20260917-1705-wp1-keys-translate-resilience.review.md`
- Implementation notes file: `tasks/notes/20260917-1705-wp1-keys-translate-resilience.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260917-1705-wp1-keys-translate-resilience.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260917-1705-wp1-keys-translate-resilience.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260917-1705-wp1-keys-translate-resilience.md`; after execution revert branch `codex/wp1-keys-translate-resilience` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260917-1705-wp1-keys-translate-resilience.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260917-1705-wp1-keys-translate-resilience.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260917-1705-wp1-keys-translate-resilience.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260917-1705-wp1-keys-translate-resilience.contract.md`, `tasks/reviews/20260917-1705-wp1-keys-translate-resilience.review.md`, and `tasks/notes/20260917-1705-wp1-keys-translate-resilience.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260917-1705-wp1-keys-translate-resilience.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260917-1705-wp1-keys-translate-resilience.md`; after execution revert branch `codex/wp1-keys-translate-resilience` or the explicitly reviewed diff.

## Captured Planning Output

# WP1 keys: resilient per-ACE identity translation in the Windows projection ACL script

## Why
Owner ruling 2026-09-17 (execution-layer ownership exception): round-4 CI evidence pinned the lowpriv lane's last red to a pre-existing product bug. WINDOWS_PROJECTION_ACL_SCRIPT (packages/keys/src/pi-provider-launcher-core.ts, rules loop ~:259-266) eagerly translates every ACE's IdentityReference; on SystemRoot (the owner-mismatch negative target) some identities do not translate under a non-privileged token, so the script dies with MethodInvocationException and the expected typed refusal pi_projection_owner_mismatch never reaches the Node validator. Admin tokens translate them, which is why #193's gate was green.

## Task Breakdown
- [x] In the rules loop: per-ACE resilient sid resolution — if IdentityReference is already a SecurityIdentifier use .Value; otherwise Translate inside try/catch; on failure emit sid = $null. ~6 lines inside the script string; nothing else in the script changes.
- [x] Confirm Node-side fail-closed stays intact without code change: sid=null fails the `typeof rule.sid !== 'string'` / SID-regex check -> pi_projection_acl_invalid_ace; owner check precedes rules validation so SystemRoot yields pi_projection_owner_mismatch.
- [x] Update any existing test pinning the script text (packages/keys tests only) to the new script shape.
- [x] Local verification: root typecheck, keys package tests (windows file self-skips on darwin), check:api-surface, check:version-authority, git diff --check; vendored tree zero-byte vs d4dcf961.

## Evidence Contract
- Round-4 job 105133623925 log: MethodInvocationException "Some or all identity references could not be translated" at the rules loop; 3/4 keys tests green post-warm-up.
- Baseline bytes at d4dcf961; this slice is the only keys change on top.

## Promotion Gate
Owner-authorized (message 2026-09-17): fast-worker fix -> local gate -> push round-5 CI validating warm-up + fix together. No assertion loosening, no contract change, no maxDepth involvement.

## Stop Conditions
- BLOCK if making the owner-mismatch test pass requires changing anything beyond the script's per-ACE sid resolution or its direct test pins.
- BLOCK if Node-side validation would need weakening to accommodate sid=null.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] In the rules loop: per-ACE resilient sid resolution — if IdentityReference is already a SecurityIdentifier use .Value; otherwise Translate inside try/catch; on failure emit sid = $null. ~6 lines inside the script string; nothing else in the script changes.
- [x] Confirm Node-side fail-closed stays intact without code change: sid=null fails the `typeof rule.sid !== 'string'` / SID-regex check -> pi_projection_acl_invalid_ace; owner check precedes rules validation so SystemRoot yields pi_projection_owner_mismatch.
- [x] Update any existing test pinning the script text (packages/keys tests only) to the new script shape.
- [x] Local verification: root typecheck, keys package tests (windows file self-skips on darwin), check:api-surface, check:version-authority, git diff --check; vendored tree zero-byte vs d4dcf961.
