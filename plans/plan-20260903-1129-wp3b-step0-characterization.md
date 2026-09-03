# Plan: WP3B Step 0: server coordination characterization tests

> **Status**: Executing
> **Created**: 20260903-1129
> **Slug**: wp3b-step0-characterization
> **Artifact Level**: work-package
> **Promotion Reason**: Owner approved (2026-09-03, 「批准」) the first slice of WP3B from `docs/researches/2026-09-03_architecture-review.md` §8 and the design packet `docs/researches/2026-09-03_wp3b-coordination-kernel-design-packet.md` §5/§7: before `@byok-sdk/server` is reimplemented over the `@byok-sdk/cloud` kernel, pin today's coordination semantics on the public surface (`createByokServer` in, HTTP + `TaskHandle` out) with tests that are green against `hub.ts` now and must stay green byte-for-byte after the fold. Zero production change.
> **Verification Boundary**: `bun run --cwd packages/server test` (36 existing files + the new file green), `bun run build`, `bun run typecheck`, `bun run test`, `bun run check:api-surface`, `bun run check:version-authority`, `repo-harness run check-task-workflow --strict`, `git diff --check`.
> **Rollback Surface**: `git revert` of one commit; only `packages/server/src/__tests__/**` changes.
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/2026-09-03_wp3b-coordination-kernel-design-packet.md` §3 (TaskHandle invariant), §5 (test plan), §7 Step 0, §8 R2; `docs/architecture/adr-2026-09-03-domain-model-and-authority.md` ADR-032
> **Task Contract**: `tasks/contracts/20260903-1129-wp3b-step0-characterization.contract.md`
> **Task Review**: `tasks/reviews/20260903-1129-wp3b-step0-characterization.review.md`
> **Implementation Notes**: `tasks/notes/20260903-1129-wp3b-step0-characterization.notes.md`

## Agentic Routing
- Selected route: code-change (tests only), delegated to `fast-worker` (or `deep-worker` if the long-poll fixture needs protocol-level care), accepted by `gatekeeper`
- Routing reason: Bounded, decision-free; the packet already fixes the ten cases and the fixture to add.
- Due diligence:
  - P1 map: `packages/server/src/__tests__/` has 36 `.test.ts` files + `test-support.ts` (418 lines: `startServer`/`stopServer` `:31,:55`, `pairFakeDaemon` `:223`, `connectFakeDaemonWs` `:251`, `connectFakeDaemon` `:298`, `waitForTaskEvent` `:341`, `waitForServerEvent` `:363`, `claimAndStart` `:388`, `moveToAwaitApproval` `:410`; runtime infos `:154-176`; `TEST_TENANT_ID`/`testPairingClaims` `:180-195`). `long-poll.test.ts` already drives `GET /byok/events?cursor=` with raw `fetch` against `createByokServer({ longPollHoldMs })` (`:37-96`) — the pattern for the new long-poll fixture. Public surface under test: `packages/server/src/index.ts` (`createByokServer` `:203`, `ByokServer` `:118`, `TaskHandle` via `dispatch()`), `http.ts` routes, `hub.ts` semantics (first-terminal-wins, cancel precedence, approval targeting `StaleApprovalError`, steer gate `SteerRejectedError`, cursor replay + `cursor_too_old` 409, inbound dedup + ownership, capability admission before mailbox append, rate-limit episodes).
  - P2 trace: fake daemon pairs (`pairFakeDaemon`) → `POST /byok/challenge` + `/byok/token` → `GET /byok/events?cursor=N` long-poll receives the `task.offer` enqueued by `byok.dispatch()` → fake daemon posts `task.claim`/`task.started`/…/`task.complete` via `POST /byok/messages` → `TaskHandle.result()` resolves and `byok.tasks.get(taskId)` shows the same fields. Each of the ten cases drives exactly this path with one twist (duplicate terminal, cancel race, stale approval id, unsupported-steer runtime, cursor replay/eviction, duplicate `message_id`/foreign device, missing Agent capability, rate-limit episode).
  - P3 decision rationale: Characterization first (packet §7 Step 0) so the fold in Steps 1–2 is measured against behaviour, not against the implementation being deleted. Tests target only the public surface so they survive the `hub.ts` deletion unchanged; nothing here decides the lease-reaper question (§8 R2, owner decision pending) — `task-lease.test.ts` is untouched.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260903-1129-wp3b-step0-characterization.md`
- Sprint contract: `tasks/contracts/20260903-1129-wp3b-step0-characterization.contract.md`
- Sprint review: `tasks/reviews/20260903-1129-wp3b-step0-characterization.review.md`
- Implementation notes: `tasks/notes/20260903-1129-wp3b-step0-characterization.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260903-1129-wp3b-step0-characterization.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260903-1129-wp3b-step0-characterization.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260903-1129-wp3b-step0-characterization.md`.

## Approach
### Strategy
Add `connectFakeDaemonLongPoll()` to `test-support.ts` (mirrors `connectFakeDaemonWs`/`connectFakeDaemon`: pair, challenge/token, then a small poller over `GET /byok/events?cursor=` with `POST /byok/messages` for outbound envelopes and a cursor the test can freeze/replay), then one new file `packages/server/src/__tests__/coordination-characterization.test.ts` with the ten cases from packet §5, all asserting on public outputs (`TaskHandle`, `tasks.get/list`, HTTP status/body, `stats()`).

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| One new file + one fixture helper (chosen) | Zero production change; survives the fold; single reviewable unit | Some overlap with existing hub-* tests | Use |
| Rewrite existing WS-based tests to long-poll now | Fewer files later | Mixes Step 0 (characterize) with Step 2d (migrate/delete) | Reject |
| Test against `hub.ts` internals | Precise | Dies with `hub.ts`; defeats the purpose | Reject |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/server/src/__tests__/test-support.ts` | Edit | Add `connectFakeDaemonLongPoll()` (pair → token → long-poll loop with explicit cursor control: `next()`, `ack(cursor)`, `replay(cursor)`, `send(envelope)`); no change to existing helpers |
| `packages/server/src/__tests__/coordination-characterization.test.ts` | Create | Ten cases: (1) pair→challenge→token→first offer over long-poll, no WS; (2) `dispatch()`→`TaskHandle.result()` equals `tasks.get()` field by field; (3) first-terminal-wins on two `task.complete`; (4) `cancel()` then late `task.complete` → `result().state === 'Cancelled'`; (5) approval targeting: second-round approve with first-round `approvalId` → `StaleApprovalError`; (6) steer gate: runtime without steer → `SteerRejectedError('steer_unsupported_runtime')`, connection-level declaration does not change it; (7) cursor replay returns the same page, acks are monotonic, beyond the recoverable floor → 409 `cursor_too_old`; (8) inbound dedup on `message_id` + foreign-device `task.complete` rejected; (9) missing Agent capability → rejected before mailbox append (`tasks.list()` empty, no mailbox row); (10) rate-limit episode: reject, `stats().rateLimitEvents` +1, then admit after recovery |

### Code Snippets
Fixture shape (illustrative):
```ts
export async function connectFakeDaemonLongPoll(baseUrl, byok, opts?): Promise<{
  deviceId: string; token: string; cursor: () => number;
  next(): Promise<Envelope[]>;      // GET /byok/events?cursor=<current>
  replay(cursor: number): Promise<Response>;
  send(env: Envelope): Promise<Response>; // POST /byok/messages
}>
```

### Data Flow
See P2 trace.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| A case accidentally asserts on `hub.ts`-specific timing (e.g. `longPollHoldMs`) | Medium | Test dies in the fold | Use explicit cursors and `waitUntil`-style polling; no fixed sleeps as completion signals |
| Existing tests already cover a case | Medium | Duplication | Acceptable: the new file is the survivor set; Step 2d prunes the rest |
| `cursor_too_old` needs the outbox ring to evict | Low | 501 dispatches per case run | No option exists; dispatch 501 offers to one device (pattern from #116); keep it in one case only |

## Task Contracts
- Contract file: `tasks/contracts/20260903-1129-wp3b-step0-characterization.contract.md`
- Review file: `tasks/reviews/20260903-1129-wp3b-step0-characterization.review.md`
- Implementation notes file: `tasks/notes/20260903-1129-wp3b-step0-characterization.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260903-1129-wp3b-step0-characterization.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: one commit, one PR (tests only).
- **Rollback surface**: see header.
- **Verification boundary**: see header.
- **Review/acceptance boundary**: `gatekeeper` checks every case asserts on public outputs only and that no `setTimeout` is used as a completion signal.
- **High-risk surface**: none.
- **Why not checklist row**: ten normative behaviour pins that Steps 1–2 depend on.

## Evidence Contract

- **State/progress path**: `tasks/notes/20260903-1129-wp3b-step0-characterization.notes.md`
- **Verification evidence**: test names + command tails in the notes; `.ai/harness/checks/latest.json`
- **Evaluator rubric**: ten cases present, each mapped to packet §5 item; fixture added; no production diff (`git diff --stat origin/main..HEAD -- packages/server/src ':!packages/server/src/__tests__'` empty); full server suite green
- **Stop condition**: a case cannot be expressed on the public surface without a production change (then record it in the notes as a Step 1 gap, do not change production)
- **Rollback surface**: see header

## Annotations
- Resolved 2026-09-03: `cursor_too_old` reachability — there is no public ring-size option; `OUTBOX_RING_CAPACITY = 500` is a `hub.ts` constant. Reach it on the public surface by dispatching 501 tasks to one device (pending `task.offer` entries are recoverable, so eviction raises `recoverableFrom`), then `GET /byok/events?cursor=0` → 409 `cursor_too_old` (same path as `issues-112-120-security-reliability.test.ts` #116). Case 7 uses this; the Risk table row is superseded.
- Owner decision recorded 2026-09-03 (「同意」): design packet §8 R2 — the lease reaper is deleted with `hub.ts` in WP3B Step 2; a dark device's task stays `pending` and the host owns timeout + `cancel()` (matches today's hosted cloud semantics). Consequence for this slice: none. Consequence for Step 2d: `packages/server/src/__tests__/task-lease.test.ts` is deleted whole, and the replacement contract (host-side timeout + `cancel()`) is documented in `docs/` under Step 5.

## Task Breakdown
- [ ] T1 `connectFakeDaemonLongPoll()` in `test-support.ts`
- [ ] T2 Cases 1–5 (pairing/long-poll, TaskHandle ≡ tasks.get, first-terminal-wins, cancel precedence, stale approval)
- [ ] T3 Cases 6–10 (steer gate, cursor replay + `cursor_too_old`, dedup + ownership, capability admission before mailbox, rate-limit episode)
- [ ] T4 Verification boundary; notes; confirm zero production diff
