# Plan: T6 N1 official external CLI custody edge

> **Status**: Review
> **Created**: 20261002-1658
> **Slug**: t6-n1-sixth-edge
> **Planning Source**: codex-plan-or-waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Sixth-edge real fixture evidence and required workspace checks
> **Rollback Surface**: Revert local T6 commits only; keep approved T3b stacked base
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20261002-1658-t6-n1-sixth-edge.contract.md`
> **Task Review**: `tasks/reviews/20261002-1658-t6-n1-sixth-edge.review.md`
> **Implementation Notes**: `tasks/notes/20261002-1658-t6-n1-sixth-edge.notes.md`

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

- Active plan: `plans/plan-20261002-1658-t6-n1-sixth-edge.md`
- Sprint contract: `tasks/contracts/20261002-1658-t6-n1-sixth-edge.contract.md`
- Sprint review: `tasks/reviews/20261002-1658-t6-n1-sixth-edge.review.md`
- Implementation notes: `tasks/notes/20261002-1658-t6-n1-sixth-edge.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20261002-1658-t6-n1-sixth-edge.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20261002-1658-t6-n1-sixth-edge.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20261002-1658-t6-n1-sixth-edge.md`.

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
- Contract file: `tasks/contracts/20261002-1658-t6-n1-sixth-edge.contract.md`
- Review file: `tasks/reviews/20261002-1658-t6-n1-sixth-edge.review.md`
- Implementation notes file: `tasks/notes/20261002-1658-t6-n1-sixth-edge.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20261002-1658-t6-n1-sixth-edge.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20261002-1658-t6-n1-sixth-edge.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert local T6 commits only; keep approved T3b stacked base
- **Verification boundary**: Sixth-edge real fixture evidence and required workspace checks
- **Review/acceptance boundary**: `tasks/reviews/20261002-1658-t6-n1-sixth-edge.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20261002-1658-t6-n1-sixth-edge.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20261002-1658-t6-n1-sixth-edge.contract.md`, `tasks/reviews/20261002-1658-t6-n1-sixth-edge.review.md`, and `tasks/notes/20261002-1658-t6-n1-sixth-edge.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20261002-1658-t6-n1-sixth-edge.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert local T6 commits only; keep approved T3b stacked base

## Captured Planning Output

# T6 N1 sixth custody edge

Scope authority: /tmp/byok-t6-sixth-edge-spec.md, Owner Aimpact approval 2026-10-02 16:49 HKT. Work only on codex/n1-sixth-edge-impl stacked on b5364f44; no rebase, remote publication or cleanup. The finalized contract from origin/codex/n1-sixth-edge-contract is read-only reference.

## P1 map
SDK implementation-identity owns install measurement and descendant shapes. Client custody owns input admission, parent binding, ledger/cap and final spawn authority. Vendor background runner crosses append and external-cli-runner spawn seams. Host ToolImplementationAuthority owns official installation provenance; task config never supplies identity or limits. Keep packages SDK umbrella; examples coverage is unrelated advice. keys remains separate credential plane and receives no new external credential route.

## P2 trace
Initial config bytes -> SDK dispatcher admission -> Pi runner record -> helper payload -> actual vendor config read -> append request bytes -> whole-batch SDK validation -> adapter fixed invocation -> verified auth probe -> SDK final identity/argv/env/permit check -> external task child. Pressure points: config TOCTOU, append admission, preflight before identity, final physical spawn. T3b prerequisites are present and its 29 tests pass (/tmp/byok-t6-prerequisite.log).

## P3 decision
Reuse strict Host install record physical measurement/reverify, shared cross-process fanout lock and session/root slots, existing opaque one-time workflow permits. External target has an independent closed subject and V2 terminal launch branch, inheritsCredential=false. Switch descendant records to the same V2 cohort without accepting old records for new delegation. Root selects only Host-proven non-secret installations/config restriction evidence; unsupported installs/auth modes refuse. Bound new env by allowlist then provider/loader/custody/adapter denies. All three input paths share validation. Charge depth once on first terminal handoff; distinct attempts consume new physical claims and logical charge; replay cannot refund/reclaim. Shared E=min(R,16), W=min(E,4), Q=2, J=1. At 10x the root admission lock/ledger and live slots are the first bottleneck; no per-adapter pools and no billing or token/money/spend metering.

## Task Breakdown
- [x] Add external subject/identity and V2 terminal record with strict bindings; carry only SDK/Host-selected non-secret authority through root and helper config.
- [x] Wire unified initial/payload/append admission, config commitment and batch failure ack, final identity/auth/permit gate with no ambient fallback.
- [x] Add one shared E/W/Q/J ledger under existing fanout lock, depth handoff/operation-attempt charge-once, lifecycle/live-slot settlement.
- [x] Add real executable fixture coverage for auth/env/argv/config refusal, identity substitution/replay, permit reuse, caps/retry and append batch. Update changed vendor provenance and closure/API snapshots when required.
- [x] Run touched tests and all required checks without assertion/timeout/skip loosening; record results and residual limits, local review and local commit only; write /tmp/byok-t6-sixth-edge-report.md.

## Verification
Touched implementation-identity/client tests; bun run build; bun run typecheck; full bun run test with existing strict Bun config; bun run check:api-surface; bun run check:version-authority; repo-harness run check-task-workflow --strict. No GitHub CI. Official CLI installation/login smoke is distinct from causal fixture evidence; unsupported platform/version remains fail-closed. Top-level Codex env-strip mismatch is T7 and excluded.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Add external subject/identity and V2 terminal record with strict bindings; carry only SDK/Host-selected non-secret authority through root and helper config.
- [x] Wire unified initial/payload/append admission, config commitment and batch failure ack, final identity/auth/permit gate with no ambient fallback.
- [x] Add one shared E/W/Q/J ledger under existing fanout lock, depth handoff/operation-attempt charge-once, lifecycle/live-slot settlement.
- [x] Add real executable fixture coverage for auth/env/argv/config refusal, identity substitution/replay, permit reuse, caps/retry and append batch. Update changed vendor provenance and closure/API snapshots when required.
- [x] Run touched tests and all required checks without assertion/timeout/skip loosening; record results and residual limits, local review and local commit only; write /tmp/byok-t6-sixth-edge-report.md.

## Execution Evidence

T3b prerequisites: current HEAD b5364f44; 29 focused tests passed. T6 touched suite: 9 files / 149 tests passed; implementation-identity: 115 tests passed; actual built Host-helper-to-external fixture path: 3 tests passed. Final canonical contract verification: 12/12 PASS, status Fulfilled, /tmp/byok-t6-canonical-contract.log and /tmp/byok-t6-canonical-evaluation.json (all check exit codes 0). Earlier failures remain in /tmp/byok-t6-check-results.json and are not final passing evidence.

The exact public API goldens were reviewed/updated. Independent code review found no remaining defect. The original architecture freeze block was closed under PM22:31 authority by CodeGraph 1.6.1 readiness, manifest-only apply and empty-noop proof reconciliation. Canonical prepare on committed bf340ebb passed 12/12 criteria and all six executed current_exact checks (/tmp/byok-t6-pm-final-prepare.log; /tmp/byok-t6-pm-final-evaluation.json). Independent Codex reviewed frozen subject sha256:f3fa892f9cdbef7a3e375b9bc4901620b32ac603903ff999e32f75cfcf523f2b against origin/main@f2098ecbf84570054600bad0680ba72e59654ea9 and returned external_pass. Supported Receipt recording/finalization completed without retesting (/tmp/byok-t6-pm-finalize.log). Completion changes only bookkeeping; no product or semantic model change and no remote action.

## Fix 1 — PM 22:58 HKT

- [x] Prove F1 with permit claim/consume, synchronous native spawn failure and genuine uncertainty regression fixtures.
- [x] Release provably not-spawned reservations/live slots without replay or cumulative-claim laundering; fix trivial F5/F7 and cover T1–T3; disposition F2–F7 explicitly.
- [x] Run touched tests, renew exact-subject acceptance and strict workflow, local commits only. After the last commit execute touched tests, typecheck, build and full test on final HEAD; update report.

Fix1 canonical prepare passed 12/12 on 0ea3e7f9 with all six current_exact checks actually executed; independent Codex external_pass accepted subject sha256:99f6aec693fc84bf4f94408a87c39fc2b739e7bd87ab5172a3b8b565f17a05df at origin/main@f2098ecb. Supported Receipt/finalize succeeded without re-execution. Required after-last-bookkeeping-commit evidence is published to /tmp/byok-t6-fix1-final-head-evaluation.json and /tmp/byok-t6-fix1-final-head-touched.log, with the actual final HEAD and exits in /tmp/byok-t6-sixth-edge-report.md. Report remains BLOCKED until that chronological sequence passes.

## F2 — user-approved locked tuple recheck (2026-10-03)

- [x] Prove replacement after full reverify while waiting for the real admission lock; target/config, interpreter/assets and parent bindings must refuse before native spawn.
- [x] Add identity-owned synchronous tuple/directory proof without replacing full hash reverify; wire locked beforeLaunch and preserve F1 rollback/permit/counter semantics.
- [ ] Run focused tests and required checks, deliberate API goldens, independent exact-subject acceptance, strict workflow, local commits only; execute final checks after last commit and update local report.
