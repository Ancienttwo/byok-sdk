# Plan: Issues 112-121 security and reliability batch

> **Status**: Executing
> **Created**: 20260901-1128
> **Slug**: issues-112-121-security-reliability-batch
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: risk_boundary
> **Verification Boundary**: Issue-specific red-first regressions; focused client/server/cloud/cloud-dataplane suites; root build, typecheck, test, strict workflow, diff check, and exact-diff gatekeeper review.
> **Rollback Surface**: Revert the complete Issues 112-121 source, schema, tests, and workflow artifacts as one local work-package commit; no migration or compatibility fallback remains partially active.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260901-1128-issues-112-121-security-reliability-batch.contract.md`
> **Task Review**: `tasks/reviews/20260901-1128-issues-112-121-security-reliability-batch.review.md`
> **Implementation Notes**: `tasks/notes/20260901-1128-issues-112-121-security-reliability-batch.notes.md`

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

- Active plan: `plans/plan-20260901-1128-issues-112-121-security-reliability-batch.md`
- Sprint contract: `tasks/contracts/20260901-1128-issues-112-121-security-reliability-batch.contract.md`
- Sprint review: `tasks/reviews/20260901-1128-issues-112-121-security-reliability-batch.review.md`
- Implementation notes: `tasks/notes/20260901-1128-issues-112-121-security-reliability-batch.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260901-1128-issues-112-121-security-reliability-batch.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260901-1128-issues-112-121-security-reliability-batch.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260901-1128-issues-112-121-security-reliability-batch.md`.

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
- Contract file: `tasks/contracts/20260901-1128-issues-112-121-security-reliability-batch.contract.md`
- Review file: `tasks/reviews/20260901-1128-issues-112-121-security-reliability-batch.review.md`
- Implementation notes file: `tasks/notes/20260901-1128-issues-112-121-security-reliability-batch.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260901-1128-issues-112-121-security-reliability-batch.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260901-1128-issues-112-121-security-reliability-batch.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert the complete Issues 112-121 source, schema, tests, and workflow artifacts as one local work-package commit; no migration or compatibility fallback remains partially active.
- **Verification boundary**: Issue-specific red-first regressions; focused client/server/cloud/cloud-dataplane suites; root build, typecheck, test, strict workflow, diff check, and exact-diff gatekeeper review.
- **Review/acceptance boundary**: `tasks/reviews/20260901-1128-issues-112-121-security-reliability-batch.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: risk_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260901-1128-issues-112-121-security-reliability-batch.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260901-1128-issues-112-121-security-reliability-batch.contract.md`, `tasks/reviews/20260901-1128-issues-112-121-security-reliability-batch.review.md`, and `tasks/notes/20260901-1128-issues-112-121-security-reliability-batch.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260901-1128-issues-112-121-security-reliability-batch.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert the complete Issues 112-121 source, schema, tests, and workflow artifacts as one local work-package commit; no migration or compatibility fallback remains partially active.

## Captured Planning Output

## Why

Issues #112-#121 are ten open security and reliability defects bound to main@d8df33e. They cross pairing completion, URL diagnostics, blob ingress/ownership, delivery continuity, WebSocket epoch/admission, hosted inbound admission, task lifecycle, and blob-client cancellation. The user explicitly authorized parallel implementation through a complete local Git commit.

## Scope

In scope:

- #112 recoverable pairing completion for hosted and reference compositions, including exact retry, conflict rejection, concurrency, and client first-pair recovery.
- #113 one structural secret-safe server URL formatter reused by validation errors and insecure-remote warnings.
- #114 bounded presigned upload streaming for hosted and reference routes using authoritative expected size plus deployment ceiling.
- #115 tenant-owned reference blob metadata and tenant-scoped URL minting across LocalDisk and SQLite stores, including persistence upgrade owned by the reference store.
- #116 explicit replay-gap detection at server and client boundaries; an evicted history is never presented or persisted as contiguous delivery.
- #117 last-transport-wins WebSocket epoch authority with stale-frame, stale-close, and heartbeat isolation.
- #118 finite hello deadline, half-open admission, and protocol-owned inbound payload ceiling before decode/hub mutation.
- #119 exactly one common hosted inbound rate-limit/dedup admission for every agent.message.publish attempt.
- #120 exact replay before lifecycle gate; new publish side effects require live task state under composition-owned atomic/CAS authority in hosted and reference implementations.
- #121 per-attempt blob HTTP deadlines composed with task/daemon lifecycle cancellation through response-body completion; stable typed deadline/cancelled classification and no finalize-after-cancel.
- Dedicated regressions, package and root verification, exact-diff independent review, local commit, and durable repo/brain state refresh.

Out of scope: push, PR creation, npm publish, release/tag, deployment, production migration, production secrets, downstream upgrade, and GitHub issue close/comment mutation.

## Architecture and Trace

P1: The package boundaries are client daemon (`auth-manager`, URL diagnostics, transport/cursor, BlobClient and TaskRunner lifecycle), embedded reference server (`http`, `BlobStore`, `ConnectionHub`, `ws-server`), hosted cloud (`auth/blob/message handlers`, inbound and store ports), durable cloud dataplane (Postgres pairing/task/blob stores and forward SQL when required), shared protocol/core schemas, and repo-harness workflow artifacts. Repository source and store contracts are authority; issue bodies and vault notes are evidence, not runtime truth.

P2: Trace each external input to its final authority: pair request -> immutable attempt -> registration/completion receipt -> token response; presigned PUT -> reservation lookup -> bounded reader -> store commit; bearer blob URL -> tenant lookup -> signed capability URL; reconnect cursor -> recoverable floor -> ordered replay or typed failure -> client cursor persistence; WS upgrade -> pre-hello slot/deadline -> hello -> connection epoch -> inbound mutation; message publish -> common admission -> existing receipt replay or live-state atomic reservation -> external consumer; BlobClient operation -> lifecycle+deadline signal -> fetch/body -> integrity/finalize.

P3: Preserve one authority per datum. Do not add controller-only locks around durable races, best-effort cleanup, dual old/new APIs, synthesized enrollment, raw URL scrubbing, silent replay fallback, or semantics-changing runner fallback. Use staged write ownership where issues share a file. At 10x scale, memory pressure, connection admission, store atomicity, and durable replay floors fail first; the batch therefore makes those limits explicit and observable.

## Parallel Write Ownership

- Client writer owns only `packages/client/**` for #113, client half of #116, and #121; it must not edit server/cloud/protocol/workflow files.
- Cloud writer owns only `packages/cloud/**` and `packages/cloud-dataplane/**` for hosted halves of #112/#114/#119/#120; it must not edit client/server/protocol/workflow files.
- Server writer owns only `packages/server/**` for reference halves of #112/#114/#115/#116/#117/#118/#120; it must not edit client/cloud/protocol/workflow files.
- Parent owns shared `packages/protocol/**`, `packages/core/**`, `deploy/sql/**`, docs, plan/contract/review/notes, integration conflict resolution, root verification, memory sync, and the final local commit.
- Files shared by more than one issue within one package pass sequentially through the same package owner; they are never concurrently written by two agents.

## Task Breakdown

- [x] Freeze per-issue root-cause evidence and red-first regression guards without changing production behavior.
- [x] Implement the client track: #113, client gap rejection for #116, and #121 lifecycle/deadline composition.
- [x] Implement the hosted track: #112/#114/#119/#120 with one durable authority and focused Postgres/in-memory coverage.
- [x] Implement the reference-server track: #112/#114/#115/#116/#117/#118/#120 with explicit ownership, admission, epoch, and replay contracts.
- [x] Integrate shared protocol/core/schema decisions once, remove old authorities, and update protocol/security/architecture docs only where contracts changed.
- [x] Run all issue-focused tests, package tests/typechecks/builds, then frozen root `bun run build`, `bun run typecheck`, `bun run test`, `repo-harness run check-task-workflow --strict`, `git diff --check` exactly once after code freeze.
- [x] Run one independent Codex gatekeeper review on the exact frozen diff; fix only in-scope findings with at most three fix/reverify rounds.
- [x] Refresh workflow artifacts and canonical BYOK brain note, create one coherent local commit, and verify commit/tree/status. Do not push or mutate GitHub issues.

## Evidence Contract

State/progress lives in this plan, linked strict contract, notes, review, checks, and workstream projection. Required evidence includes per-issue deterministic pre-fix failure/guard mapping, concurrency or lifecycle barriers for #112/#117/#120, plus-one stream bounds for #114/#118, two-tenant/restart negatives for #115, 501+ replay-gap behavior for #116, exact rate debit/dedup for #119, and hung-header/body plus cancellation races for #121. The evaluator must reject any compatibility fallback, duplicate authority, raw credential projection, post-terminal side effect, stale socket mutation, normal cursor advancement across a gap, or request body/frame materialization beyond the declared bound. Stop if a required durable race cannot be made atomic in the existing store boundary without a schema contract, or if an edit would escape the declared package/workflow scope. Rollback is the complete work-package commit.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Freeze per-issue root-cause evidence and red-first regression guards without changing production behavior.
- [x] Implement the client track: #113, client gap rejection for #116, and #121 lifecycle/deadline composition.
- [x] Implement the hosted track: #112/#114/#119/#120 with one durable authority and focused Postgres/in-memory coverage.
- [x] Implement the reference-server track: #112/#114/#115/#116/#117/#118/#120 with explicit ownership, admission, epoch, and replay contracts.
- [x] Integrate shared protocol/core/schema decisions once, remove old authorities, and update protocol/security/architecture docs only where contracts changed.
- [x] Run all issue-focused tests, package tests/typechecks/builds, then frozen root `bun run build`, `bun run typecheck`, `bun run test`, `repo-harness run check-task-workflow --strict`, `git diff --check` exactly once after code freeze.
- [x] Run one independent Codex gatekeeper review on the exact frozen diff; fix only in-scope findings with at most three fix/reverify rounds.
- [x] Refresh workflow artifacts and canonical BYOK brain note, create one coherent local commit, and verify commit/tree/status. Do not push or mutate GitHub issues.
