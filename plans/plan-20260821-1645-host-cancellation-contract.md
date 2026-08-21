# Plan: Host Cancellation Contract

> **Status**: Executing
> **Created**: 20260821-1645
> **Slug**: host-cancellation-contract
> **Planning Source**: user-approved-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: consumer_blocking_cross_package_authority
> **Verification Boundary**: Five cancellation scenarios across hosted cloud, durable dataplane, protocol state, and client runtime interruption
> **Rollback Surface**: Revert cancellation protocol, cloud store/API, migration, client handling tests, and docs before any publish or deploy
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260821-1645-host-cancellation-contract.contract.md`
> **Task Review**: `tasks/reviews/20260821-1645-host-cancellation-contract.review.md`
> **Implementation Notes**: `tasks/notes/20260821-1645-host-cancellation-contract.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from user-approved-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260821-1645-host-cancellation-contract.md`
- Sprint contract: `tasks/contracts/20260821-1645-host-cancellation-contract.contract.md`
- Sprint review: `tasks/reviews/20260821-1645-host-cancellation-contract.review.md`
- Implementation notes: `tasks/notes/20260821-1645-host-cancellation-contract.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260821-1645-host-cancellation-contract.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260821-1645-host-cancellation-contract.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260821-1645-host-cancellation-contract.md`.

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
- Contract file: `tasks/contracts/20260821-1645-host-cancellation-contract.contract.md`
- Review file: `tasks/reviews/20260821-1645-host-cancellation-contract.review.md`
- Implementation notes file: `tasks/notes/20260821-1645-host-cancellation-contract.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260821-1645-host-cancellation-contract.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260821-1645-host-cancellation-contract.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert cancellation protocol, cloud store/API, migration, client handling tests, and docs before any publish or deploy
- **Verification boundary**: Five cancellation scenarios across hosted cloud, durable dataplane, protocol state, and client runtime interruption
- **Review/acceptance boundary**: `tasks/reviews/20260821-1645-host-cancellation-contract.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: consumer_blocking_cross_package_authority

## Evidence Contract

- **State/progress path**: `plans/plan-20260821-1645-host-cancellation-contract.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260821-1645-host-cancellation-contract.contract.md`, `tasks/reviews/20260821-1645-host-cancellation-contract.review.md`, and `tasks/notes/20260821-1645-host-cancellation-contract.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260821-1645-host-cancellation-contract.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert cancellation protocol, cloud store/API, migration, client handling tests, and docs before any publish or deploy

## Captured Planning Output

## Goal

Deliver Salesko upstream U1: a host-initiated cancellation authority that durably prevents not-yet-started work, interrupts leased work through the existing client Session lifecycle, and makes cancellation accepted-first win over a racing succeeded receipt.

## Success criteria

- Host can cancel by tenant/taskId; unknown tasks fail closed and repeated cancellation is idempotent.
- Unleased offer cancellation becomes cancelled immediately and the original offer is never delivered on a later reconnect.
- Leased cancellation becomes cancel_requested, durably queues task.cancel, and the existing TaskRunner interrupt/close path emits task.cancelled.
- Cancellation accepted before a late task.complete remains the host-visible terminal outcome; the late device receipt may remain stored as evidence but cannot authorize business success.
- Tests cover pre-lease, running, offline/reconnect, cancel-vs-succeeded race, and duplicate cancel.

## P1 Architecture map

- Protocol already owns task.cancel and task.cancelled; extend lifecycle status with cancel_requested only where hosted task attempts expose state. Do not invent another wire message or adapter API.
- @byok-sdk/cloud owns the host API, tenant-bound cancellation mutation port, hosted attempt/result projection, and device long-poll filtering.
- @byok-sdk/cloud-dataplane owns the durable PostgreSQL implementation and forward migration.
- @byok-sdk/client already routes task.cancel to TaskRunner, which interrupts Session and emits task.cancelled; change it only where tests prove a missing contract.
- Release/publish/deploy and Salesko glue remain out of scope.

## P2 concrete trace

1. cancelTask(tenant, taskId, reason) resolves the tenant-owned attempt and atomically persists the cancellation tombstone with the durable task.cancel mailbox delivery.
2. If no owner exists, attempt status is cancelled; if claimed/running, it is cancel_requested. Repeating the call reuses the same durable cancellation delivery.
3. /byok/events never returns an offer whose attempt has a cancellation tombstone, but returns the retained cancel delivery, so an offline device cannot start cancelled work after reconnect.
4. A running daemon receives task.cancel; existing TaskRunner calls Session.interrupt(), awaits the authoritative close receipt, and sends task.cancelled.
5. Hosted inbound handling never lets task.complete or task.fail overwrite cancellation priority. Host result projection prefers the accepted cancellation tombstone and preserves timestamps/reason needed to prove ordering.

## P3 decision rationale

Use one dedicated cancellation mutation authority because task-state update plus mailbox delivery is one invariant; two independent best-effort writes permit accepted-but-undeliverable cancellation. Reuse the frozen wire messages and existing Session interruption path. Keep task execution status (cancel_requested) distinct from host terminal decision (cancelled after authority acceptance). The first 10x pressure point is per-poll task lookups; batch reads must be used rather than one query per mailbox row.

Rejected: no repair/fallback result path, no multi-backend abstraction, no capability/load scheduling, no shadow state parser, no second process-kill API.

## Scope

- Product/spec and protocol docs required to define cancellation ordering.
- packages/cloud, packages/cloud-dataplane, packages/client, protocol lifecycle types/tests, and the new forward SQL migration.
- Testkit/conformance updates only where public store contracts require them.

## Non-scope

- U2 usage telemetry, U3 readiness, U4 release hygiene, package version bump, publish, deploy, production migration, Salesko code, and unrelated existing architecture WIP.

## Verification

Start with red tests for all five scenarios. Then run targeted protocol/cloud/cloud-dataplane/client suites, migration verification, bun run build, bun run typecheck, bun run test, and repo-harness run check-task-workflow --strict. Do not claim production readiness without publish/deploy and downstream integration evidence.

## Rollback

Before publish/deploy, revert this coherent work package including its migration. After a deployed forward migration, roll back behavior by disabling the host cancel entrypoint while retaining additive columns/rows; do not destructively down-migrate user data.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] Add red cloud, dataplane, and client tests for pre-lease, running, offline reconnect, cancellation/success race, duplicate cancellation, tenant isolation, and atomic rollback.
- [ ] Add the hosted cancellation state/tombstone contract and one atomic cancellation mutation port without changing frozen wire message shapes.
- [ ] Implement in-memory and PostgreSQL cancellation authorities plus the additive forward migration and migration parity tests.
- [ ] Add `ByokCloud.cancelTask()`, long-poll suppression of cancelled offers, and cancellation-first terminal result projection.
- [ ] Confirm the existing client `task.cancel` path interrupts/closes the runtime and emits one `task.cancelled`; change client production code only if red evidence requires it.
- [ ] Update product/protocol truth, run targeted suites and all required checks, then record review/acceptance and canonical Obsidian memory.
