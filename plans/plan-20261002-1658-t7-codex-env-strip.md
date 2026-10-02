# Plan: T7 top-level Codex env-strip

> **Status**: Blocked
> **Created**: 20261002-1658
> **Slug**: t7-codex-env-strip
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: /tmp/byok-t7-codex-env-strip-spec.md
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20261002-1658-t7-codex-env-strip.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20261002-1658-t7-codex-env-strip.md`; after execution revert branch `codex/fix-codex-env-strip` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20261002-1658-t7-codex-env-strip.contract.md`
> **Task Review**: `tasks/reviews/20261002-1658-t7-codex-env-strip.review.md`
> **Implementation Notes**: `tasks/notes/20261002-1658-t7-codex-env-strip.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan planning output.
- Source ref: /tmp/byok-t7-codex-env-strip-spec.md
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20261002-1658-t7-codex-env-strip.md`
- Sprint contract: `tasks/contracts/20261002-1658-t7-codex-env-strip.contract.md`
- Sprint review: `tasks/reviews/20261002-1658-t7-codex-env-strip.review.md`
- Implementation notes: `tasks/notes/20261002-1658-t7-codex-env-strip.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20261002-1658-t7-codex-env-strip.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20261002-1658-t7-codex-env-strip.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20261002-1658-t7-codex-env-strip.md`.

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
- Contract file: `tasks/contracts/20261002-1658-t7-codex-env-strip.contract.md`
- Review file: `tasks/reviews/20261002-1658-t7-codex-env-strip.review.md`
- Implementation notes file: `tasks/notes/20261002-1658-t7-codex-env-strip.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20261002-1658-t7-codex-env-strip.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20261002-1658-t7-codex-env-strip.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20261002-1658-t7-codex-env-strip.md`; after execution revert branch `codex/fix-codex-env-strip` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20261002-1658-t7-codex-env-strip.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20261002-1658-t7-codex-env-strip.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20261002-1658-t7-codex-env-strip.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20261002-1658-t7-codex-env-strip.contract.md`, `tasks/reviews/20261002-1658-t7-codex-env-strip.review.md`, and `tasks/notes/20261002-1658-t7-codex-env-strip.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20261002-1658-t7-codex-env-strip.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20261002-1658-t7-codex-env-strip.md`; after execution revert branch `codex/fix-codex-env-strip` or the explicitly reviewed diff.

## Captured Planning Output

## Approval and Scope
Owner Aimpact approved T7 at 2026-10-02 16:49 HKT in /tmp/byok-t7-codex-env-strip-spec.md. User instructed Read and do it. Work only in this checkout on codex/fix-codex-env-strip, base f2098ecb. Local commits only; no push, PR, merge, branch/worktree deletion, GitHub CI, sixth-edge work or auth-store reads.

## P1: Architecture Map
TaskRunner owns the per-runtime allowlist; adapters own final runtime launch. Codex app-server uses codex-session-runtime and owned-line-process. implementation-identity owns the bounded credential exclusion used by measurement and client stripping. Existing sdk-root matches both changed packages; retain that umbrella for this shared policy fix. Example coverage is unrelated.

## P2: Concrete Trace and Root Cause
process.env -> TaskRunner.buildRuntimeEnv(operator allow) -> CodexAdapter.start copies input.env -> codexSession -> owned process spawn. Unlike Claude, Codex does not apply withoutProviderCredentials. New real TaskRunner fixture tests fail in runtime and explicit subscription selection (exit 1; credential presence boolean true). Loader/BYOK hard-deny remains daemon-owned.

## P3: Decision
Reuse subscription exclusion before Codex hands env to the owned process; add CODEX_API_KEY and CODEX_ACCESS_TOKEN confirmed in official pinned 0.159.2 auth source. Keep HOME/USER/platform baseline and explicitly allowed CODEX_HOME/config. Use one finite policy for stripping and measurement, including case aliases for Windows semantics. No new abstraction or auth-mode promise. At 10x scale, existing process startup dominates the bounded env scan.

## Captured Execution Steps
- [x] T1 Prove mismatch via real TaskRunner + Codex child; boolean-only receipt and subscription/runtime guards.
- [x] T2 Wire subscription exclusion and shared finite auth policy; preserve measurement/spawn projection and add regression guards.
- [x] T3 Align security/spec docs; review sibling consumers; run touched-package tests and root checks.
- [x] T4 Record evidence and local commit SHA in /tmp/byok-t7-codex-env-strip-report.md; commit locally only.

## Verification Plan
Red: real fixture credential-presence test fails before fix. Green: explicit credentials absent; unknown BYOK/custody/loader variables refused; platform/allowed config preserved; child digests match admission projection. Run client and implementation-identity tests, bun run typecheck, bun run build, bun run test, bun run check:api-surface, bun run check:version-authority, repo-harness run check-task-workflow --strict; capability validation and architecture sync.

## Rollback Surface
Revert the single local T7 commit after review. No deployment or credential mutations. Real CLI login/platform smoke remains explicitly unverified.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] T1 Prove mismatch via real TaskRunner + Codex child; boolean-only receipt and subscription/runtime guards.
- [x] T2 Wire subscription exclusion and shared finite auth policy; preserve measurement/spawn projection and add regression guards.
- [x] T3 Align security/spec docs; review sibling consumers; run touched-package tests and root checks.
- [x] T4 Record evidence and local commit SHA in /tmp/byok-t7-codex-env-strip-report.md; commit locally only.

## Local Closeout Gate

Implementation and all owner-required commands passed. T4 delivers the local checkpoint and requested report; actual commit SHA is recorded in that external report. Formal harness acceptance remains blocked: architecture-projection reconciliation requires ready CodeGraph proof (no index was created), and the aborted 120-second helper wrapper left an expensive-run reservation/lock. The full suite was rerun directly with the existing formal Bun gate and exited 0. No lock in the shared Git directory was removed, and no AcceptanceReceipt is claimed.
