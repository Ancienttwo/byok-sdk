# Plan: WP3B Step 1: cloud kernel increments (GAP-1/2/3/4/6 + observer)

> **Status**: Archived
> **Created**: 20260903-1330
> **Slug**: wp3b-step1-kernel-increments
> **Artifact Level**: work-package
> **Promotion Reason**: Owner approved (2026-09-03, 「批准」) the next slice after Step 0 landed (PR #128 → 59eae41, closeout #129 → 5cfc8c7). Design packet `docs/researches/2026-09-03_wp3b-coordination-kernel-design-packet.md` §2 names five kernel gaps plus one observer hook that `@byok-sdk/server` needs before Step 2 can reimplement `createByokServer` over `@byok-sdk/cloud`. §7 Step 1 splits them into six independently revertable sub-steps 1a–1f. `@byok-sdk/server` stays at zero diff.
> **Verification Boundary**: per sub-step `bun run build && bun run typecheck && bun run test`; 1b/1c/1d additionally `bun run --cwd packages/conformance test`; 1b additionally `bun run check:deploy-sql`; whole slice `bun run check:api-surface`, `bun run check:version-authority`, `repo-harness run check-task-workflow --strict`, `git diff --check`, and `git diff --stat origin/main..HEAD -- packages/server` empty.
> **Rollback Surface**: six linear commits (1a…1f), each `git revert`-able alone; PR is rebase-merged (not squashed) to keep that property. 1b's migration `deploy/sql/0018_*.sql` is revert-by-delete before any environment applies it, else a forward `0019` reverse migration.
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/2026-09-03_wp3b-coordination-kernel-design-packet.md` §2, §7 Step 1, §8 R3/R4; `docs/architecture/adr-2026-09-03-domain-model-and-authority.md` ADR-028 (claimedRuntime is a one-shot claim snapshot, not execution state)
> **Task Contract**: `tasks/contracts/20260903-1330-wp3b-step1-kernel-increments.contract.md`
> **Task Review**: `tasks/reviews/20260903-1330-wp3b-step1-kernel-increments.review.md`
> **Implementation Notes**: `tasks/notes/20260903-1330-wp3b-step1-kernel-increments.notes.md`

## Agentic Routing
- Selected route: code-change, three sequential `deep-worker` dispatches (D1 = 1e + 1a, D2 = 1c + 1f, D3 = 1b + 1d), one `gatekeeper` pass at the PR boundary
- Routing reason: sub-steps are independent in semantics but share files (`cloud.ts`: 1a/1b/1e/1f; `inbound.ts`: 1b/1f; task-attempts stores + conformance: 1b/1d), so concurrent writers would collide; sequential dispatch keeps one writer per file at a time. 1e goes first because §8 R4 makes it a hard precondition of Step 2.
- Due diligence:
  - P1 map (verified against main@5cfc8c7 by explorer, 2026-09-03): `ByokCloud` interface `packages/cloud/src/cloud.ts:337-448` (host control today: enqueue*Offer, `cancelTask :411`, `readTaskResult :432`, `listPresence :440`; no approve/reject/steer); `ByokCloudOptions` `cloud.ts:198` (only hook `agentMessage :230`, admission semantics); private `enqueueAgentControlEnvelope` `cloud.ts:849`; `ApprovalTimelineStore` `packages/cloud/src/approval-timeline.ts:57-59`; inbound entry `packages/cloud/src/inbound.ts:298` returning `InboundOutcome = 'accepted'|'duplicate'|'rejected'|'rate_limited'` (`:65`), `task.claim` branch `:459`; `TaskAttempt` `packages/cloud/src/stores/ports.ts:251-269` (no `claimedRuntime`), `TaskAttemptStore` `:329-331` (`get`/`getMany` only); stores `packages/cloud/src/stores/in-memory/task-attempts.ts`, `packages/cloud-dataplane/src/stores/task-attempts.ts`, conformance `packages/conformance/src/cloud/task-attempts.ts`; `deploy/sql/0001…0017` (next 0018), `check:deploy-sql` = `repo-harness run check-deploy-sql-order`; **`MailboxStore` lives in `packages/core/src/mailbox.ts:140-160`** (packet mis-cites it as cloud), `MailboxPage :73-80` has no `recoverableFrom`, in-memory impl `packages/core/src/in-memory/mailbox.ts:162-200`, dataplane impl under `packages/cloud-dataplane/src/stores/core/`, conformance `packages/conformance/src/core/mailbox.ts`; `handlers/events.ts:142-148` always 200 empty; server 409 shape `packages/server/src/http.ts:386`; client parser `packages/client/src/daemon/long-poll-transport.ts:567-578`; bearer `packages/cloud/src/auth/bearer.ts:32`, row==claims `:47`; server has both checks `packages/server/src/auth.ts:404-405`; sentinel `packages/server/src/__tests__/bearer-instance-product.test.ts`; `RuntimeId` = `z.enum(['pi','claude','codex'])` `packages/protocol/src/messages.ts:39-40`; server steer gate semantics `packages/server/src/hub.ts:416-441` + `steer-runtime-capability-gate.test.ts:129,304` (claim snapshot decides, connection declaration does not).
  - P2 trace (1a, the one that exercises the most kernel): host calls `cloud.approveTask(tenant, taskId, {approvalId})` → read `ApprovalTimelineStore` tail for `taskId` → if no pending `await_approval` entry → reject (`no_pending_approval`); if `approvalId` given and ≠ current pending id → `StaleApprovalError(taskId, requested, current)`; else `enqueueAgentControlEnvelope('task.approve', …)` → mailbox row for the owner device → device long-polls `GET /byok/events` → posts `task.approval_resolved` → `inbound.ts` appends timeline. Same path for `rejectTask` with `task.reject`. 1f's observer fires after each `inbound.ts` commit with `{tenantId, deviceId, envelope, outcome}`; a throwing observer is caught and logged, outcome unchanged.
  - P3 decision rationale: (i) all six land in one PR but as six commits, rebase-merged, because the packet's rollback unit is the sub-step; (ii) GAP-3 changes a **core** port (`MailboxPage.recoverableFrom`), so `packages/core/src/**` joins the allowed paths — the packet's "all in cloud" was a mis-citation, not a different design; (iii) GAP-4 cursor: `TaskAttempt` has no monotonic seq and `taskId` is `task_<uuid>`, so `list` is keyset-paged by `taskId` ascending with an opaque string cursor (`{ attempts, nextCursor? }`), order stable but not chronological — adding a seq column for a read model would be a larger migration than the consumer (façade `tasks.list()`) justifies; (iv) `instanceProductId` is optional with two explicit authorities (given → instance check; absent → row==claims), not a fallback; (v) observer is post-commit, void, never awaited for outcome, distinct from the admission hook.

## Workflow Inventory
- Active plan: `plans/plan-20260903-1330-wp3b-step1-kernel-increments.md`
- Sprint contract: `tasks/contracts/20260903-1330-wp3b-step1-kernel-increments.contract.md`
- Sprint review: `tasks/reviews/20260903-1330-wp3b-step1-kernel-increments.review.md`
- Implementation notes: `tasks/notes/20260903-1330-wp3b-step1-kernel-increments.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260903-1330-wp3b-step1-kernel-increments.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260903-1330-wp3b-step1-kernel-increments.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260903-1330-wp3b-step1-kernel-increments.md`.

## Approach
### Strategy
Six sub-steps, each one commit, in order 1e → 1a → 1c → 1f → 1b → 1d, dispatched as three sequential workers with disjoint-in-time file ownership. Each sub-step ends with the per-step verification green and `packages/server` untouched. After all six: packet corrections (§5.10 wording, GAP-3 path), notes, gate, PR, rebase-merge.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| One PR, six commits, rebase-merge (chosen) | Per-sub-step revert; one CI + one gate | Deviates from the repo's squash habit for this PR only | Use |
| Six PRs | Cleanest revert | Six harness cycles for ≤1-day steps | Reject |
| Parallel workers per sub-step | Wall clock | Shared files (`cloud.ts`, `inbound.ts`, task-attempts stores) → merge conflicts | Reject |
| GAP-4 cursor = new seq column | Chronological order | Migration + three stores for a read-model nicety | Reject |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/cloud/src/auth/bearer.ts`, `packages/cloud/src/cloud.ts` | Edit (1e) | `ByokCloudOptions.instanceProductId?: string`; when set, `authenticateBearer` also requires `claims.productId === instanceProductId`; absent keeps today's row==claims byte-for-byte |
| `packages/cloud/src/cloud.ts`, new `packages/cloud/src/approval-control.ts` (or inline), `packages/cloud/src/index.ts` | Edit/Create (1a) | `approveTask`/`rejectTask` on `ByokCloud`; `StaleApprovalError` moved to cloud and exported; staleness read from `ApprovalTimelineStore` tail; delivery via `enqueueAgentControlEnvelope` |
| `packages/core/src/mailbox.ts`, `packages/core/src/in-memory/mailbox.ts`, `packages/cloud-dataplane/src/stores/core/*mailbox*`, `packages/cloud/src/handlers/events.ts`, `packages/conformance/src/core/mailbox.ts` | Edit (1c) | `MailboxPage.recoverableFrom`; `events.ts` returns 409 `{error:'cursor_too_old', recoverableFrom}` when `cursor < recoverableFrom - 1` (same floor rule as `hub.ts:2519`); conformance case |
| `packages/cloud/src/cloud.ts`, `packages/cloud/src/inbound.ts`, `packages/cloud/src/index.ts` | Edit (1f) | `ByokCloudOptions.observer?: { onInboundCommitted(input: {tenantId, deviceId, envelope, outcome}): void }`; fired once per committed envelope (`accepted`), not for `rejected`/`rate_limited`; `duplicate` decision recorded in notes (default: not fired — nothing was committed); throws are swallowed |
| `packages/cloud/src/stores/ports.ts`, `packages/cloud/src/inbound.ts`, `packages/cloud/src/stores/in-memory/task-attempts.ts`, `packages/cloud-dataplane/src/stores/task-attempts.ts`, `deploy/sql/0018_task_attempt_claimed_runtime.sql`, `packages/conformance/src/cloud/task-attempts.ts`, `packages/cloud/src/cloud.ts` | Edit/Create (1b) | `TaskAttempt.claimedRuntime?: RuntimeId` written once at `task.claim` (idempotent re-claim does not overwrite); `steerTask(tenant, taskId, payload)` gated on the claim snapshot's steer capability; `SteerRejectedError` with codes `steer_unsupported_runtime | task_not_running | task_terminal` moved to cloud |
| `packages/cloud/src/stores/ports.ts`, both task-attempts stores, `packages/conformance/src/cloud/task-attempts.ts`, `packages/cloud/src/cloud.ts` | Edit (1d) | `TaskAttemptStore.list(tenant, {limit, cursor?})` → `{attempts, nextCursor?}` keyset by `taskId`; `ByokCloud.listTaskAttempts` |
| `packages/cloud/src/__tests__/*.test.ts` | Create | Unit tests per sub-step as listed in §7 |
| `docs/researches/2026-09-03_wp3b-coordination-kernel-design-packet.md` | Edit | Two corrections only: §5.10 `rateLimitEvents` counts per rejected envelope (episode coalescing is on `device.rate_limited` only); GAP-3 citations point to `packages/core/src/mailbox.ts` |

### Data Flow
See P2 trace.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| 1c changes a core port shape; a MailboxStore impl outside the three known ones breaks typecheck | Low | Build red | `bun run typecheck` across the workspace is the per-step gate; fix in the same commit |
| 1b migration is not online-safe on dataplane | Low | GAP-2 degrades per §8(d) | Column is nullable with no backfill; D3 records the SQL in notes for review |
| Observer fires inside a transaction-like path and a slow observer delays inbound | Medium | Latency | Fire after the store write returns, synchronously, wrapped in try/catch; documented as "must be cheap" |
| `steer` capability source for the claim snapshot is ambiguous (which runtime declares steer) | Medium | Wrong gate | Mirror `packages/server/src/hub.ts:416-441` and the runtime infos in server test-support; pin with the same two assertions as `steer-runtime-capability-gate.test.ts:129,304` |

## Task Contracts
- Contract file: `tasks/contracts/20260903-1330-wp3b-step1-kernel-increments.contract.md`
- Review file: `tasks/reviews/20260903-1330-wp3b-step1-kernel-increments.review.md`
- Implementation notes file: `tasks/notes/20260903-1330-wp3b-step1-kernel-increments.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260903-1330-wp3b-step1-kernel-increments.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff
- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate
- **Merge/PR unit**: one PR, six sub-step commits plus one docs/notes commit, rebase-merged.
- **Rollback surface**: see header.
- **Verification boundary**: see header.
- **Review/acceptance boundary**: `gatekeeper` checks each sub-step is one commit with its own tests, `packages/server` has zero diff, 1e's absent-option path is byte-identical to today, 1f's observer cannot alter an outcome, 1c's 409 shape equals `http.ts:386`.
- **High-risk surface**: 1e (auth) and 1b (migration).
- **Why not checklist row**: five kernel API additions and one core port change that Step 2 builds on.

## Evidence Contract
- **State/progress path**: `tasks/notes/20260903-1330-wp3b-step1-kernel-increments.notes.md`
- **Verification evidence**: per-sub-step command tails in the notes; `.ai/harness/checks/latest.json`
- **Evaluator rubric**: six commits present and individually green; new tests per §7 exit lines; conformance green; `check:deploy-sql` green; `packages/server` zero diff; api-surface golden for `cloud`/`core` regenerated only if the check demands it and the diff is exactly the new exports
- **Stop condition**: a sub-step needs a `packages/server` change or a second store authority → stop that sub-step, record in notes, continue the others
- **Rollback surface**: see header

## Annotations
- Resolved 2026-09-03: `scripts/api-surface/check-api-surface.mjs` gates `cloud`, `cloud-dataplane`, `core` (byte-for-byte against `api-surface/<pkg>.d.ts`). The new exports are additive, so T2 regenerates exactly those three goldens with `bun run check:api-surface -- --update` and the diff must contain only the new symbols; `api-surface/{cloud,core,cloud-dataplane}.d.ts` join allowed paths. `server.d.ts`/`client.d.ts` stay untouched (Step 5 owns their breaking diff per §7 write-order table).

## Task Breakdown
- [x] T1e instance-product bearer (`instanceProductId`) + tests (D1)
- [x] T1a `approveTask`/`rejectTask` + `StaleApprovalError` + tests (D1)
- [x] T1c `cursor_too_old` 409 via `MailboxPage.recoverableFrom` + conformance (D2)
- [x] T1f `observer.onInboundCommitted` post-commit hook + tests (D2)
- [x] T1b `claimedRuntime` + migration 0018 + `steerTask` + conformance + tests (D3)
- [x] T1d `TaskAttemptStore.list` keyset paging + conformance (D3)
- [x] T2 packet corrections (§5.10, GAP-3 path), notes, zero `packages/server` diff, gate, PR (rebase-merge)
