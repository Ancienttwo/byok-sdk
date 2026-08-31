# Plan: Issue 102 atomic auth nonce consumption

> **Status**: Executing
> **Created**: 20260831-2147
> **Slug**: issue-102-atomic-auth-nonce
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: User explicitly approved the bounded #102 security fix; it crosses cloud and cloud-dataplane nonce authorities and requires a linked contract worktree.
> **Verification Boundary**: Focused in-memory and Postgres concurrency regressions plus cloud and cloud-dataplane package tests, typecheck, build, and strict contract verification.
> **Rollback Surface**: Revert the NonceStore atomic-consume contract, both store implementations, token handler composition, and their regression tests as one unit.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260831-2147-issue-102-atomic-auth-nonce.contract.md`
> **Task Review**: `tasks/reviews/20260831-2147-issue-102-atomic-auth-nonce.review.md`
> **Implementation Notes**: `tasks/notes/20260831-2147-issue-102-atomic-auth-nonce.notes.md`

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

- Active plan: `plans/plan-20260831-2147-issue-102-atomic-auth-nonce.md`
- Sprint contract: `tasks/contracts/20260831-2147-issue-102-atomic-auth-nonce.contract.md`
- Sprint review: `tasks/reviews/20260831-2147-issue-102-atomic-auth-nonce.review.md`
- Implementation notes: `tasks/notes/20260831-2147-issue-102-atomic-auth-nonce.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260831-2147-issue-102-atomic-auth-nonce.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260831-2147-issue-102-atomic-auth-nonce.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260831-2147-issue-102-atomic-auth-nonce.md`.

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
- Contract file: `tasks/contracts/20260831-2147-issue-102-atomic-auth-nonce.contract.md`
- Review file: `tasks/reviews/20260831-2147-issue-102-atomic-auth-nonce.review.md`
- Implementation notes file: `tasks/notes/20260831-2147-issue-102-atomic-auth-nonce.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260831-2147-issue-102-atomic-auth-nonce.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260831-2147-issue-102-atomic-auth-nonce.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert the NonceStore atomic-consume contract, both store implementations, token handler composition, and their regression tests as one unit.
- **Verification boundary**: Focused in-memory and Postgres concurrency regressions plus cloud and cloud-dataplane package tests, typecheck, build, and strict contract verification.
- **Review/acceptance boundary**: `tasks/reviews/20260831-2147-issue-102-atomic-auth-nonce.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: User explicitly approved the bounded #102 security fix; it crosses cloud and cloud-dataplane nonce authorities and requires a linked contract worktree.

## Evidence Contract

- **State/progress path**: `plans/plan-20260831-2147-issue-102-atomic-auth-nonce.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260831-2147-issue-102-atomic-auth-nonce.contract.md`, `tasks/reviews/20260831-2147-issue-102-atomic-auth-nonce.review.md`, and `tasks/notes/20260831-2147-issue-102-atomic-auth-nonce.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260831-2147-issue-102-atomic-auth-nonce.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert the NonceStore atomic-consume contract, both store implementations, token handler composition, and their regression tests as one unit.

## Captured Planning Output

## Why

`POST /byok/token` currently validates a nonce, verifies the Ed25519 signature, and then marks the nonce used through separate store operations. Two identical concurrent requests can both pass validation and each mint an access token. The approved slice makes nonce consumption atomic after signature verification so exactly one request may mint.

## Scope

- Replace the hosted cloud `NonceStore` split validate/mark-used mutation with an atomic consume-if-valid operation bound to exact tenant, device, nonce, and current time.
- Update both `InMemoryNonceStore` and `PostgresNonceStore` without compatibility aliases or dual semantics.
- Update `AuthPlane` and `tokenHandler` so signature verification happens before atomic consumption, and only the winning consume mints a token.
- Add deterministic reference/in-memory and Postgres concurrency regressions plus expired, used, wrong-device, and wrong-tenant negatives.

Out of scope: mailbox cursor semantics, pairing transactions, HTTP body limits, client auth request deadlines, publication, deployment, production migration, GitHub issue mutation.

## Architecture and Trace

P1: hosted auth handler owns request composition; `AuthPlane` binds the authenticated device identity; `NonceStore` is the mutation port; in-memory and Postgres implementations are the only store authorities.

P2: token request -> resolve device row -> validate signature over domain-separated nonce -> atomic consume-if-valid -> only winner calls `mintAccessToken`; loser returns the existing 401 invalid/expired/already-used response.

P3: use one atomic store method rather than a controller mutex or best-effort rollback. Postgres uses guarded `UPDATE ... WHERE used = false AND expires_at >= now RETURNING`; in-memory performs check-and-mark synchronously within the method before yielding. Remove the old split mutation surface in the same work package.

## Task Breakdown

- [ ] Add red concurrency and negative regression guards for both store implementations and token route behavior.
- [ ] Replace the nonce port with the atomic consume contract.
- [ ] Implement in-memory and Postgres atomic consume.
- [ ] Recompose `AuthPlane` and `tokenHandler` so only the consume winner mints.
- [ ] Run focused, package, typecheck, build, diff, and strict contract gates.
- [ ] Obtain an independent gatekeeper verdict on the exact diff.

## Evidence Contract

State/progress is the approved plan and linked contract worktree. Required evidence is a deterministic two-request race where exactly one consume succeeds, negative identity/expiry cases, focused route tests, cloud/cloud-dataplane package verification, and independent diff review. Stop if the store contract cannot preserve signature-before-consume or if implementation would require a compatibility path. Rollback is the complete source-and-test slice above.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] Add red concurrency and negative regression guards for both store implementations and token route behavior.
- [ ] Replace the nonce port with the atomic consume contract.
- [ ] Implement in-memory and Postgres atomic consume.
- [ ] Recompose `AuthPlane` and `tokenHandler` so only the consume winner mints.
- [ ] Run focused, package, typecheck, build, diff, and strict contract gates.
- [ ] Obtain an independent gatekeeper verdict on the exact diff.
