# Plan: WP3B Step 2: reimplement @byok-sdk/server as a façade over the cloud kernel and delete hub/WS

> **Status**: Archived
> **Created**: 20260903-1505
> **Slug**: wp3b-step2-facade-fold
> **Artifact Level**: work-package
> **Promotion Reason**: Owner approved (2026-09-03, 「批准」) the slice after Step 1 landed (PR #130 rebase-merged, closeout #131 → main@0ceb4d4). Design packet `docs/researches/2026-09-03_wp3b-coordination-kernel-design-packet.md` §1, §3, §6, §7 Step 2a–2d. Owner-approved the packet's 2a as the next cut; 2a alone is not a mergeable unit (23 of 37 server test files drive the WebSocket fixture that 2a stops serving), so this plan is the whole Step 2 in one PR with four sequential work commits and one closeout; only the PR head must pass `bun run test`.
> **Verification Boundary**: PR head: `bun run build`, `bun run typecheck` (includes `examples/basic`), `bun run test`, `bun run --cwd packages/server test`, `bun run --cwd packages/client test`, `bun run check:api-surface`, `bun run check:version-authority`, `node packages/client/scripts/control-socket-check.mjs wp3b-smoke`, `node packages/client/scripts/ipc-smoke.mjs`, `node packages/client/scripts/adapter-task-smoke.mjs`, `grep -rn 'attachWebSocket' packages/server/src packages/client/src/__tests__ packages/client/scripts examples` = 0 hits, `repo-harness run check-task-workflow --strict`, `git diff --check`. Per work commit: `bun run --cwd packages/server build && bun run --cwd packages/server typecheck` and `coordination-characterization.test.ts` green from the 2a commit on.
> **Rollback Surface**: one squash commit on main; `git revert` restores `hub.ts` and the WebSocket path whole. Sub-steps 2a–2d are strictly sequential (packet §7), so per-sub-step revert is not a goal here (unlike Step 1).
> **Spec**: `docs/spec.md`
> **Research**: design packet §1 (surface disposition), §3 (TaskHandle + relay invariant), §4 (consumer matrix), §5 (test classification), §6 (async one-shot breaking), §7 Step 2, §8 R1/R2; ADR-028, ADR-034 (`deviceId` stays optional)
> **Task Contract**: `tasks/contracts/20260903-1505-wp3b-step2-facade-fold.contract.md`
> **Task Review**: `tasks/reviews/20260903-1505-wp3b-step2-facade-fold.review.md`
> **Implementation Notes**: `tasks/notes/20260903-1505-wp3b-step2-facade-fold.notes.md`

## Agentic Routing
- Selected route: code-change; D1 `deep-worker` (2a façade), D2 `deep-worker` (2b deletions + re-exports), then three parallel workers on disjoint files — D3a `deep-worker` (server tests), D3b `deep-worker` (client real-server tests + fixture), D4 `fast-worker` (scripts, `examples/basic`, packet corrections) — no commits in the parallel phase; orchestrator commits; one `gatekeeper` at the PR boundary.
- Routing reason: 2a and 2b are single-writer on `packages/server/src`; after 2b the remaining work splits cleanly by directory.
- Due diligence:
  - P1 map (explorer, main@98495a2, 2026-09-03): `createInMemoryByokCloud` `packages/cloud/src/composition/in-memory.ts:101` (options `:45-88`: `instanceProductId :52`, `agentMessage :83`, `observer :85`; **no rate limiter option**, `AllowAllRateLimiter` hardwired at `stores/in-memory/index.ts:88`); `createInMemoryCloudStores` exported (`stores/in-memory/index.ts:60`) and `createByokCloud({ core, cloud: stores, … })` (`cloud.ts:213-215`) → the façade composes its own stores and can decorate `rateLimiter`/`dedup` for counting with zero cloud diff. `ByokCloud.fetch` is a mountable app (`cloud.ts:384-386`, `router/registry.ts:50-81`). Route parity: all 11 device routes of `http.ts` exist in cloud (`cloud.ts:622-827`); `GET /healthz` (`http.ts:125`, opt-in) has no cloud equivalent. Server surface: `index.ts:27-96` exports, `ByokServer :118-189` (sync: `pairing.createPairingCode`, `readAgentHomeProjection`, `tasks.get/list`, `egress.get`, `machines.list`, `devices.revoke`), `types.ts` `TaskHandle :240-258`, `ServerTaskEvent :232-237`, `TaskSnapshot :275-360`, `MachineInfo :261-272`, `HubStats :459-474`, `ByokServerEvent :368-450`, `DispatchInput.deviceId?` `:131`; `event-queue.ts` `AsyncEventQueue` unbounded replay-from-0 `:38-58`; `rate-limiter.ts` `RateLimiter.consume(key)` `:81-218`; cloud port `InboundRateLimiter.consume(tenant, deviceId): Promise<boolean>` `ports.ts:671-673`. Consumers breaking on deletion: `examples/basic/server.ts:25` (workspace member, only root `typecheck` reaches it), `packages/sdk/src/index.ts:10` (re-export, no edit), `packages/client/scripts/{control-socket-check,ipc-smoke,adapter-task-smoke}.mjs` (dynamic import of dist, `attachWebSocket`), `packages/client/src/__tests__/fixtures/real-server.ts:10` + 11 `real-server-*.test.ts`. Server tests: 24 WS-fixture-dependent (incl. `coordination-characterization` via `startServer`'s unconditional `attachWebSocket` `test-support.ts:37`), 13 not; deletion-class tests per packet §5 plus `sqlite-lifecycle.test.ts` (unlisted in §5). `device.connected` consumers: `integration.test.ts:312` and `rate-limit-episode.test.ts:41` (second one unlisted in §1.2). `api-surface/server.d.ts` is gated (`check-api-surface.mjs:25`); no `sdk` golden. No WP3A branch/PR/worktree exists → no write-owner conflict on `packages/client/src/__tests__` today.
  - P2 trace (the fold's hot path): host `createByokServer({productId})` → façade builds `createInMemoryCloudStores()` with `rateLimiter` = server `RateLimiter` adapted to `InboundRateLimiter` and `dedup` wrapped by a counting decorator → `createByokCloud({ core, cloud, instanceProductId: productId, observer: relay, agentMessage })` → façade Hono app mounts `cloud.fetch` at `/` plus opt-in `/healthz` → `dispatch(input)` picks `deviceId` (explicit, else ambient: `listPresence` unexpired ∩ device row capabilities, non-strict-agent-only, toolsets present) → `cloud.enqueue*Offer(tenant, deviceId, …)` → `TaskHandle{taskId}`; device long-polls `GET /byok/events` → posts `task.claim…task.complete` to `POST /byok/messages` → `inbound.ts` commits → `observer.onInboundCommitted` → `TaskEventRelay` folds to `ServerTaskEvent`, pushes to the per-task bounded queue, resolves the terminal promise → `handle.result()` awaits it then **reads back** `cloud.readTaskResult(tenant, taskId)`; `tasks.get(taskId)` = `cloud.readTaskAttempt` (+ terminal receipt) projected to the pruned `TaskSnapshot`; `tasks.list(query)` = `cloud.listTaskAttempts` paged.
  - P3 decision rationale: (i) whole Step 2 in one PR, squash-merged: sub-steps are strictly sequential and each intermediate state fails the test gate by construction; rollback unit is the fold itself. (ii) Tenant: one fixed tenant per `createByokServer` (embedded = single tenant), derived from `productId`; no multi-tenant façade surface. (iii) Rate limiting and dedup counting via store decorators composed in the façade, so cloud stays at zero diff (packet GAP-5 "cloud 不动" holds). (iv) `/healthz` kept as a server-local opt-in route layered on `cloud.fetch` (it is deployment liveness, not coordination). (v) `ByokServerEvent`: delete `device.connected`/`device.disconnected` (packet §1.2 option A) — recorded as an owner-visible decision in Annotations. (vi) Nine Step 0 cases may change only by inserting `await` and unwrapping the paged `tasks.list()` result (`.tasks`). Owner-approved exception (2026-09-04): case 7 is semantically re-pinned once to the kernel mailbox authority — read does not ack, ack is irreversible, and expiry moves `recoverableFrom`; rebuilding the old hub replay ring would recreate the duplicate authority this fold deletes. Any other assertion change remains a hard stop. (vii) `TaskSnapshot` pruned per §6 (`instruction/policy/runtime/requiredToolsets` dropped); `HubStats` keeps `envelopesIn/dedupDrops/rateLimitEvents/taskCountsByState/uptimeMs`, `connectedDeviceCount` becomes unexpired-presence count. (viii) Lease reaper deleted per owner ruling (R2); `taskLeaseMs` option removed; `task-lease.test.ts` deleted whole. (ix) `packages/client` real-server tests keep the `real-server.ts` fixture over the new façade with the WS mode removed (smaller than the packet's "swap to real-cloud.ts"); the four WS-only client tests are rewritten to long-poll, `real-server-outbox-switch.test.ts` deleted. (x) `examples/basic`: minimal edit to keep `typecheck` green — drop `attachWebSocket` and the SQLite store wiring (`BYOK_STORE=sqlite` fails closed with a message pointing at Step 3), `await` the async members, keep its own `Map<taskId, {instruction, runtime, policy}>` per §6; full example migration remains Step 3.

## Workflow Inventory
- Active plan: `plans/plan-20260903-1505-wp3b-step2-facade-fold.md`
- Sprint contract: `tasks/contracts/20260903-1505-wp3b-step2-facade-fold.contract.md`
- Sprint review: `tasks/reviews/20260903-1505-wp3b-step2-facade-fold.review.md`
- Implementation notes: `tasks/notes/20260903-1505-wp3b-step2-facade-fold.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260903-1505-wp3b-step2-facade-fold.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260903-1505-wp3b-step2-facade-fold.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260903-1505-wp3b-step2-facade-fold.md`.

## Approach
### Strategy
2a: new façade under `packages/server/src/` (relay, handle, stores composition, snapshot projection, ambient device selection, rate-limiter adapter), `index.ts` rewired, old modules no longer referenced; nine Step 0 cases adapted with `await`/`.tasks` only and case 7 re-pinned to kernel mailbox semantics under the 2026-09-04 owner ruling. 2b: delete the 11 modules and the deletion-class tests; `index.ts` re-exports auth/error types from cloud. 2d: migrate the kept server tests and the client real-server tests to the long-poll fixture; delete `task-lease.test.ts` and `real-server-outbox-switch.test.ts`; rework the two `device.connected` consumers. 2c: three `.mjs` smoke scripts to long-poll (+ explicit `deviceId` in `adapter-task-smoke`), `examples/basic` minimal typecheck fix. Closeout: `api-surface/server.d.ts` (and `cloud.d.ts` only if a cloud hook was unavoidable) regenerated; packet corrections; notes.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Whole Step 2, one PR, squash (chosen) | Only shippable shape; single rollback | Large PR (~5.2k deletions + ~2k changes) | Use |
| 2a alone as a PR | Small | Cannot be green: 23 WS test files + client fixture + scripts break | Reject |
| Keep hub for WS in 2a | Green | Two task authorities in one process | Reject |
| Store decorators for stats (chosen) vs widening cloud observer | Zero cloud diff | Decorators are façade-local glue | Use decorators; widen observer only if a count is unreachable otherwise (record) |
| `device.connected/disconnected` from presence edges (B) | Keeps shape | Synthesised events from TTL jitter | Reject (A) |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/server/src/index.ts` | Rewrite (2a) | `createByokServer` over `createByokCloud` + own store composition; `hono` = façade app mounting `cloud.fetch` (+ opt-in `/healthz`); async `pairing.createPairingCode`, `readAgentHomeProjection`, `tasks.get/list` (paged), `egress.get`, `machines.list`, `devices.revoke`; `events.subscribe` from relay; `stop()` closes relay; `stats()`; `attachWebSocket` removed; `taskStore`/`blobStore`/`taskLeaseMs`/WS options removed from `CreateByokServerOptions`; re-exports of `StaleApprovalError`, `SteerRejectedError`, `SteerRejectionCode`, auth types from `@byok-sdk/cloud` |
| `packages/server/src/relay.ts` (new), `task-handle.ts` (new), `stores.ts` (new: composition + `InboundRateLimiter` adapter + counting dedup), `snapshot.ts` (new: `TaskAttempt`+receipt → `TaskSnapshot`, `MachineInfo` join), `device-selection.ts` (new: ambient pick) | Create (2a) | Relay: pure fold of committed envelopes → `ServerTaskEvent`; per-task bounded ring (`CreateByokServerOptions.taskEventBufferLimit`, explicit default), drop-oldest + `{kind:'error', reason:'events_truncated'}`, terminal TTL reclaim, `stop()` clears |
| `packages/server/src/event-queue.ts` | Edit (2a) | Add bound + truncation marker |
| `packages/server/src/rate-limiter.ts` | Edit (2a) | Keep token bucket; expose an `InboundRateLimiter`-shaped adapter keyed by `(tenant, deviceId)` |
| `packages/server/src/types.ts` | Edit (2a/2b) | `TaskSnapshot` pruned; `HubStats` reshaped; `ByokServerEvent` minus `device.connected/disconnected`; `CreateByokServerOptions` pruned; `DispatchInput.deviceId` stays optional |
| `packages/server/src/__tests__/coordination-characterization.test.ts`, `test-support.ts` | Edit (2a) | Nine cases: `await`/`.tasks` only. Case 7: owner-approved one-shot re-pin to kernel mailbox semantics. `startServer` stops attaching WS; WS helpers removed in 2d |
| `hub.ts`, `http.ts`, `auth.ts`, `ws-server.ts`, `heartbeat.ts`, `pairing.ts`, `task-store.ts`, `sqlite-task-store.ts`, `blob-store.ts`, `sqlite-blob-store.ts`, `ids.ts` | Delete (2b) | ≈5,196 lines |
| `__tests__/{heartbeat,version-negotiation,port-shadowing,task-store,sqlite-task-store,sqlite-blob-store,sqlite-lifecycle,pairing,nonce-store,task-lease}.test.ts` | Delete (2b/2d) | transport-only / deleted-class / lease reaper |
| remaining 23 kept server test files | Edit (2d) | fixture → `connectFakeDaemonLongPoll`; setup that used deleted classes replaced by public-surface setup; assertions not loosened; unexpressible assertions listed in notes |
| `packages/client/src/__tests__/fixtures/real-server.ts`, `real-server-*.test.ts` | Edit/Delete (2d) | fixture drops WS mode; 4 WS tests → long-poll; `real-server-outbox-switch.test.ts` deleted |
| `packages/client/scripts/{control-socket-check,ipc-smoke,adapter-task-smoke}.mjs` | Edit (2c) | long-poll; explicit `deviceId` |
| `examples/basic/server.ts` (+ README only if a command changes) | Edit (2c) | minimal typecheck-green migration; SQLite path fails closed until Step 3 |
| `api-surface/server.d.ts` | Regenerate (closeout) | the intended breaking diff; `client.d.ts` untouched |
| design packet | Edit (closeout) | §5 add `sqlite-lifecycle.test.ts`; §1.2 add `rate-limit-episode.test.ts:41`; §1.1 note `/healthz`; §7 Step 2 note "one PR" |

### Data Flow
See P2.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| A Step 0 case other than owner-approved case 7 needs an assertion change | Medium | Behaviour change hidden as refactor | Hard stop for that case: record in notes, escalate; do not edit the assertion |
| Kept tests rely on deleted classes for setup (`InMemoryTaskStore` override, `SqliteTaskStore`, `stopLeaseReaper`) | High | 2d takes longer than the packet's "fixture swap" | Replace setup with public surface; list every dropped assertion in notes for the gate |
| `stats()` counters unreachable via decorators (e.g. `envelopesIn` for rate-limited envelopes) | Medium | Cloud diff | Allowed as a last resort: additive observer widening, recorded |
| Client daemon still has WS mode (Step 4) and a test pins WS↔long-poll switching | Certain | Test deleted | `real-server-outbox-switch.test.ts` is the packet-listed deletion |
| `examples/basic` semantics drift before Step 3 | Low | Example breaks for SQLite users | Fail closed with an explicit message; Step 3 restores |

## Task Contracts
- Contract file: `tasks/contracts/20260903-1505-wp3b-step2-facade-fold.contract.md`
- Review file: `tasks/reviews/20260903-1505-wp3b-step2-facade-fold.review.md`
- Implementation notes file: `tasks/notes/20260903-1505-wp3b-step2-facade-fold.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260903-1505-wp3b-step2-facade-fold.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff
- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate
- **Merge/PR unit**: one PR, squash-merged.
- **Rollback surface**: see header.
- **Verification boundary**: see header.
- **Review/acceptance boundary**: `gatekeeper` checks: nine Step 0 cases are `await`/`.tasks`-only and case 7 is exactly the owner-approved kernel-mailbox re-pin; no `hub.ts`/WS references remain; `result()` reads back from the store; relay bounded; zero cloud diff (or an additive hook with rationale); every dropped assertion from 2d is listed in the notes; scripts run.
- **High-risk surface**: public API breaking (server), 5.2k deletions.
- **Why not checklist row**: the WP3B fold itself.

## Evidence Contract
- **State/progress path**: `tasks/notes/20260903-1505-wp3b-step2-facade-fold.notes.md`
- **Verification evidence**: command tails per sub-step in notes; `.ai/harness/checks/latest.json`
- **Evaluator rubric**: verification boundary green; Step 0 ten cases green, with nine `await`/`.tasks`-only cases and case 7 exactly matching the approved kernel-mailbox re-pin; `git grep attachWebSocket` zero in the listed dirs; notes list of dropped/unexpressible assertions reviewed
- **Stop condition**: a Step 0 assertion outside approved case 7 must change → stop that case and escalate; a kept test's behaviour cannot be expressed on the public surface → record, do not silently delete
- **Rollback surface**: see header

## Annotations
- Owner-visible decision (packet §1.2), resolved 2026-09-03 by the orchestrator on the packet's recommendation and surfaced to the owner in-session: `ByokServerEvent` loses `device.connected` / `device.disconnected` (option A). An owner objection before the 2d commit switches to B; none received at plan approval time.
- Owner ruling 2026-09-03 (Step 0 plan): lease reaper deleted with `hub.ts`; `task-lease.test.ts` deleted whole; host-side timeout + `cancel()` documented in Step 5.
- Owner ruling 2026-09-04: case 7 is the sole Step 0 semantic re-pin, replacing the deleted hub replay-ring contract with the kernel mailbox contract (read is non-acking, ack is irreversible, expiry advances the recoverable floor). The other nine cases retain the `await`/`.tasks`-only constraint.

## Task Breakdown
- [x] T2a façade (D1): relay, handle, stores composition, snapshot, device selection, `index.ts`, types; nine Step 0 cases `await`-adapted, case 7 owner-approved kernel-mailbox re-pin, all green
- [x] T2b deletions (D2): 11 modules, deletion-class tests, cloud re-exports; server build/typecheck green
- [x] T2d-server (D3a): 23 kept tests on long-poll fixture; `task-lease.test.ts` deleted; `device.connected` consumers reworked
- [x] T2d-client (D3b): `real-server.ts` fixture without WS; 4 tests rewritten; `outbox-switch` deleted; client suite green
- [x] T2c (D4): 3 `.mjs` scripts; `examples/basic` minimal; packet corrections
- [ ] T3 closeout: `api-surface/server.d.ts`; notes; gate; PR; squash-merge
