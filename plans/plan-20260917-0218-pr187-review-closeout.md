# Plan: Close PR 187 preparation review findings

> **Status**: Executing
> **Created**: 20260917-0218
> **Slug**: pr187-review-closeout
> **Planning Source**: codex-plan-or-waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: User approved PR closeout and necessary review fixes before merge
> **Verification Boundary**: Focused preparation regressions and repository required checks on frozen head
> **Rollback Surface**: One PR187 repair commit; no store migration or production activation
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260917-0218-pr187-review-closeout.contract.md`
> **Task Review**: `tasks/reviews/20260917-0218-pr187-review-closeout.review.md`
> **Implementation Notes**: `tasks/notes/20260917-0218-pr187-review-closeout.notes.md`

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

- Active plan: `plans/plan-20260917-0218-pr187-review-closeout.md`
- Sprint contract: `tasks/contracts/20260917-0218-pr187-review-closeout.contract.md`
- Sprint review: `tasks/reviews/20260917-0218-pr187-review-closeout.review.md`
- Implementation notes: `tasks/notes/20260917-0218-pr187-review-closeout.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260917-0218-pr187-review-closeout.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260917-0218-pr187-review-closeout.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260917-0218-pr187-review-closeout.md`.

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
- Contract file: `tasks/contracts/20260917-0218-pr187-review-closeout.contract.md`
- Review file: `tasks/reviews/20260917-0218-pr187-review-closeout.review.md`
- Implementation notes file: `tasks/notes/20260917-0218-pr187-review-closeout.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260917-0218-pr187-review-closeout.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260917-0218-pr187-review-closeout.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: One PR187 repair commit; no store migration or production activation
- **Verification boundary**: Focused preparation regressions and repository required checks on frozen head
- **Review/acceptance boundary**: `tasks/reviews/20260917-0218-pr187-review-closeout.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: User approved PR closeout and necessary review fixes before merge

## Evidence Contract

- **State/progress path**: `plans/plan-20260917-0218-pr187-review-closeout.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260917-0218-pr187-review-closeout.contract.md`, `tasks/reviews/20260917-0218-pr187-review-closeout.review.md`, and `tasks/notes/20260917-0218-pr187-review-closeout.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260917-0218-pr187-review-closeout.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: One PR187 repair commit; no store migration or production activation

## Captured Planning Output

## Objective
Close PR #187 review findings without expanding the C07 feature scope, then verify, push and merge the accepted PR. Preserve all other worktrees and downstream stacked bases.

## P1 Architecture
Local HMAC control calls enter create-daemon and InputPreparationService. The configured authority owns scope and canonical source authorization. Native Pi owns compilation; the service owns durable reservation, counter lifetime, and retention; InputPreparationStore owns serialized writes and GC. Host source semantics must not be re-derived locally.

## P2 Trace
prepare copies input, opens/reconciles, checks policy and bytes, resolves scope, reserves a durable request, compiles, persists the artifact and counter reservation, awaits the adapter, and records its terminal result. Current timeout/cancel only abort the signal while stop awaits the same run. GC runs only on prepare; native import failure enters the generic compile rejection. Source is copied to bindings without a source-aware authority decision.

## P3 Decision
Require explicit source authorization before reservation/compile/count. Bound SDK waiting independently of adapter cooperation, preserve unknown counter outcomes and never auto-retry. Enforce artifact/tombstone expiry on open and with an owned timer; expose GC faults and await owned cleanup on stop. Preserve runtime_identity_unavailable instead of misclassifying installation failures. Keep durable idempotency history: a reserved request is not silently recreated. No compatibility fallback, no provider calls, no native fork or downstream changes.

## Task Breakdown
- [x] Freeze exact API and ownership choices against existing contract and review findings.
- [x] Prove the four failures with focused regression cases before production fixes.
- [x] Implement minimal fixes with source denial, non-cooperative counter/late settlement, idle/restart GC, and runtime-identity failure coverage.
- [ ] Run focused tests; freeze source; run required build/typecheck/full tests/API/version/workflow checks once.
- [ ] Obtain one independent acceptance verdict; record evidence and resolve review findings with concrete references.
- [ ] Push exact accepted head; retarget PR #187 to main, verify CI, merge, then only clean branches/worktrees without open stacked dependents.

## Scope
Product: packages/client/src/input-preparation.ts; packages/client/src/index.ts; packages/client/src/daemon/create-daemon.ts (startup open/GC); packages/client/src/daemon/input-preparation-service.ts; packages/client/src/daemon/input-preparation-store.ts; packages/client/src/adapters/pi/input-preparation.ts if necessary for typed failure; API-surface projections generated by repository command.
Tests: packages/client/src/__tests__/input-preparation.test.ts; input-preparation-store.test.ts; input-preparation-control.test.ts; pi-input-preparation.test.ts. Required direct authority resolver fixtures may change with the single source-authority contract. Docs: docs/researches/runtime-input-preparation-contract.md and task-local plan/contract/notes/review. No change to main WIP or other C07 candidate branches.

## Verification
Use actual @byok-sdk/client Vitest, then bun run build, bun run typecheck, bun run test, bun run check:api-surface, bun run check:version-authority, repo-harness run check-task-workflow --strict. No live provider tests or registry publication. Record exact subjects and nonpassing lanes honestly.

## Stop Conditions
At most three fix/reverify rounds per issue. Report unrelated failures without repairing them. Missing source authority fails closed. Do not merge failed checks or delete a branch used as an open PR base. Browser review stays deferred until authorized repository closeout is complete.

## Rollback
Revert this bounded repair commit; retain source branch and durable store data. Do not reset or clean another worktree.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Freeze exact API and ownership choices against existing contract and review findings.
- [x] Prove the four failures with focused regression cases before production fixes.
- [x] Implement minimal fixes with source denial, non-cooperative counter/late settlement, idle/restart GC, and runtime-identity failure coverage.
- [ ] Run focused tests; freeze source; run required build/typecheck/full tests/API/version/workflow checks once.
- [ ] Obtain one independent acceptance verdict; record evidence and resolve review findings with concrete references.
- [ ] Push exact accepted head; retarget PR #187 to main, verify CI, merge, then only clean branches/worktrees without open stacked dependents.
