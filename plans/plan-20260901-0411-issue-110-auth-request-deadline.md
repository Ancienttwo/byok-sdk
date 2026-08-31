# Plan: Issue 110 AuthManager request deadline

> **Status**: Review
> **Created**: 20260901-0411
> **Slug**: issue-110-auth-request-deadline
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: GitHub issue #110
> **Artifact Level**: work-package
> **Promotion Reason**: Explicit owner dispatch for a bounded credential-I/O lifecycle bugfix that crosses AuthManager, daemon shutdown, configuration, and deterministic regression guards.
> **Verification Boundary**: Deterministic pair/challenge/token/body hangs, stop abort, persistence/revocation assertions, client/root gates, strict workflow, and diff check.
> **Rollback Surface**: Revert the AuthManager request deadline/controller, daemon config composition, config coverage, test fixture hooks, and auth/daemon regressions together.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260901-0411-issue-110-auth-request-deadline.contract.md`
> **Task Review**: `tasks/reviews/20260901-0411-issue-110-auth-request-deadline.review.md`
> **Implementation Notes**: `tasks/notes/20260901-0411-issue-110-auth-request-deadline.notes.md`

## Agentic Routing
- Selected route: bugfix
- Routing reason: Captured from codex-plan planning output.
- Source ref: GitHub issue #110
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260901-0411-issue-110-auth-request-deadline.md`
- Sprint contract: `tasks/contracts/20260901-0411-issue-110-auth-request-deadline.contract.md`
- Sprint review: `tasks/reviews/20260901-0411-issue-110-auth-request-deadline.review.md`
- Implementation notes: `tasks/notes/20260901-0411-issue-110-auth-request-deadline.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260901-0411-issue-110-auth-request-deadline.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260901-0411-issue-110-auth-request-deadline.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260901-0411-issue-110-auth-request-deadline.md`.

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
- Contract file: `tasks/contracts/20260901-0411-issue-110-auth-request-deadline.contract.md`
- Review file: `tasks/reviews/20260901-0411-issue-110-auth-request-deadline.review.md`
- Implementation notes file: `tasks/notes/20260901-0411-issue-110-auth-request-deadline.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260901-0411-issue-110-auth-request-deadline.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260901-0411-issue-110-auth-request-deadline.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert the AuthManager request deadline/controller, daemon config composition, config coverage, test fixture hooks, and auth/daemon regressions together.
- **Verification boundary**: Deterministic pair/challenge/token/body hangs, stop abort, persistence/revocation assertions, client/root gates, strict workflow, and diff check.
- **Review/acceptance boundary**: `tasks/reviews/20260901-0411-issue-110-auth-request-deadline.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: Explicit owner dispatch for a bounded credential-I/O lifecycle bugfix that crosses AuthManager, daemon shutdown, configuration, and deterministic regression guards.

## Evidence Contract

- **State/progress path**: `plans/plan-20260901-0411-issue-110-auth-request-deadline.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260901-0411-issue-110-auth-request-deadline.contract.md`, `tasks/reviews/20260901-0411-issue-110-auth-request-deadline.review.md`, and `tasks/notes/20260901-0411-issue-110-auth-request-deadline.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260901-0411-issue-110-auth-request-deadline.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert the AuthManager request deadline/controller, daemon config composition, config coverage, test fixture hooks, and auth/daemon regressions together.

## Captured Planning Output

> **Task Profile**: bugfix

## P1: Architecture Map

- Boundary: `packages/client` owns device-local pairing, challenge/token renewal, OS credential custody, daemon lifecycle, and CLI JSON configuration. The server remains the remote authentication authority; `DeviceStore` projects only non-secret metadata and `DeviceCredentialStore` owns the complete credential record.
- Entrypoints: `AuthManager.pair()`, `AuthManager.handleUnauthorized()/renew()`, proactive renewal, `createDaemonWithAdapters()` lifecycle, and CLI `loadConfig()`.
- Authority: `AuthManager` must own exactly one active authentication I/O cancellation authority and one credential mutation tail. `create-daemon` owns composition and stop ordering. Tests own deterministic HTTP stalls.
- In scope: `auth-manager.ts`, `create-daemon.ts`, configuration test/loader surface as required, auth/daemon tests, test HTTP fixture if required, and strict workflow artifacts. Out of scope: protocol changes, server behavior, credential-store schema, retry fallbacks, device revocation semantics, release, merge, push, PR, issue mutation, publish, and deploy.

## P2: Concrete Trace

`daemon.pair(code)` acquires the lifecycle mutation lease -> `auth.pair()` enters the credential mutation tail -> POST `/byok/pair` -> reads a JSON body -> saves non-secret projection then replaces the complete OS credential record. Renewal follows `getValidAccessToken()/handleUnauthorized()` -> same credential tail -> POST `/byok/challenge` -> parse nonce -> POST `/byok/token` -> parse token -> replace credential record -> schedule timer. Current fetch and `safeErrorText()/json()` body reads have no deadline/cancellation authority; `AuthManager.stop()` only clears timers and awaits the tail, so a hung response can retain the writer and daemon lease forever. A real 401 remains the sole input to `DeviceRevokedError`.

## P3: Design Decision

Add the smallest AuthManager-owned configurable deadline and a single active request controller authority spanning every pairing/renewal fetch and response-body read. Stop synchronously aborts active I/O, then awaits the already-owned mutation tail; abort/timeout surfaces a stable classified auth request error rather than `DeviceRevokedError`. The only durable write remains after a complete validated response, so timeout/cancel cannot persist a partial credential. Wire the config through `DaemonConfig` and the existing JSON loader composition without a second config authority. At 10x, one manager still serializes credential mutation by design; the one active controller bounds its one in-flight network operation instead of creating parallel renewal paths.

## Approach

- [x] Freeze deterministic fetch/HTTP hang regressions for pair, challenge/token/body response, stop-vs-renewal abort, near-deadline success, and no partial/revoked state on timeout/cancel; capture non-zero pre-fix evidence.
- [x] Add the bounded AuthManager request deadline/controller lifecycle with stable timeout/cancel errors and response-body coverage.
- [x] Thread the single daemon config field into AuthManager and assert CLI config composition.
- [x] Verify focused auth/daemon coverage, client build/typecheck, root gates, strict workflow, diff, and candidate commit.

## Evidence Contract

- **State/progress path**: this plan, its contract/review/notes, and `.ai/harness/checks/latest.json`.
- **Verification evidence**: a pre-fix failing guard, deterministic auth-manager and daemon tests, client/root build/typecheck/test, strict workflow, and diff check.
- **Evaluator rubric**: every configured bounded operation either succeeds before its deadline or rejects with the stable non-revocation auth deadline/cancel classification; no incomplete credential write is observable.
- **Stop condition**: all allowed source/test/artifact paths pass the contract criteria; no AcceptanceReceipt is created.
- **Rollback surface**: revert the AuthManager deadline/controller wiring, daemon configuration composition, and the coupled regressions together.

## Promotion Gate

- **Merge/PR unit**: one isolated issue #110 AuthManager request-deadline bugfix candidate.
- **Rollback surface**: AuthManager request-controller logic, create-daemon config composition, config test, HTTP fixture hooks, and auth/daemon tests.
- **Verification boundary**: deterministic fetch/body/abort timing guards plus focused package and root checks.
- **Review/acceptance boundary**: strict local contract/review artifacts only; AcceptanceReceipt, merge, and remote actions are excluded.
- **High-risk surface**: device credential persistence and shutdown lease release.
- **Why not checklist row**: this changes a shared credential-I/O lifecycle invariant across direct pairing, renewal, daemon shutdown, and product configuration.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] Freeze deterministic fetch/HTTP hang regressions for pair, challenge/token/body response, stop-vs-renewal abort, near-deadline success, and no partial/revoked state on timeout/cancel; capture non-zero pre-fix evidence.
- [ ] Add the bounded AuthManager request deadline/controller lifecycle with stable timeout/cancel errors and response-body coverage.
- [ ] Thread the single daemon config field into AuthManager and assert CLI config composition.
- [ ] Verify focused auth/daemon coverage, client build/typecheck, root gates, strict workflow, diff, and candidate commit.
