# Implementation Notes: wp3b-step0-characterization

> **Status**: Active
> **Plan**: plans/plan-20260903-1129-wp3b-step0-characterization.md
> **Contract**: tasks/contracts/20260903-1129-wp3b-step0-characterization.contract.md
> **Review**: tasks/reviews/20260903-1129-wp3b-step0-characterization.review.md
> **Last Updated**: 2026-09-03 12:45
> **Lifecycle**: notes

## Design Decisions

- **Long-poll only, and provably so.** The new file never calls `byok.attachWebSocket`. `test-support.ts`'s `startServer` attaches the WS upgrade unconditionally, so the test file starts its own HTTP-only server (`startHttpOnlyServer`, ~10 lines serving `byok.hono.fetch` with the same `127.0.0.1` hostname pin `startServer` uses for `port-shadowing.test.ts`'s reason). That makes case 1's "no WS ever opened" a structural property of the whole file rather than one test's claim, and it is what lets all ten cases survive Step 2b's deletion of `ws-server.ts`.
- **`POST /byok/messages` is its own barrier.** `handleInbound` runs fully synchronously inside the request, so an awaited `send()` is itself the completion signal for every state change it caused. No `waitForTaskEvent`/`waitForServerEvent` and no sleep is needed anywhere except case 10, where the barrier is the rate limiter's wall-clock refill and the test polls a public read with a bounded 10s deadline instead.
- **`connectFakeDaemonLongPoll` renews the token.** It runs the full `pair -> challenge -> token` leg and returns the token minted by `POST /byok/token`, not the one `POST /byok/pair` returned — the WS fixtures never needed the renewal leg, and pinning it here means case 1 covers the credential path a real long-poll daemon actually uses.
- **`next()` vs `replay(cursor)` are deliberately two methods.** `EventsPollResponse.cursor` is the highest `seq` ASSIGNED to the device, which can run ahead of the page just returned (terminal-task entries are filtered out). `next()` takes that value as the new ack point, exactly as a real daemon does; `replay(cursor)` reads an explicit point, never touches the fixture's cursor, and hands back the raw `Response` so a 409 body can be inspected instead of thrown away.

## Per-Case Mapping (packet §5 → test)

All ten live in `packages/server/src/__tests__/coordination-characterization.test.ts`, one `it` each, named `case N: ...`. All ten PASS; none is skipped.

| § | `it` name | Public surface asserted |
|---|---|---|
| 5.1 | `case 1: pair -> challenge -> token -> dispatch delivers the first task.offer over long-poll, with no WebSocket anywhere` | `machines.list()`, `GET /byok/events` page + cursor, `tasks.get().state` |
| 5.2 | `case 2: TaskHandle.result() and tasks.get() report the completed task field by field` | `handle.result()` ≡ `tasks.get().result` field by field, `tasks.list()` |
| 5.3 | `case 3: first terminal wins — a second task.complete with a different payload never overwrites the recorded result` | two `POST /byok/messages` bodies, `tasks.get().result/state/sessionRef`, `handle.result()` |
| 5.4 | `case 4: cancel() is authoritative immediately — a late task.complete leaves the result Cancelled` | `handle.cancel()`, `handle.result()`, `tasks.get()`, the redelivered `task.cancel` page |
| 5.5 | `case 5: approval targeting — the previous round's approvalId is stale, the current one resolves` | `StaleApprovalError` (`taskId`/`requestedApprovalId`/`currentApprovalId`), `tasks.get().pendingApprovalId`, the two `task.approve` envelopes |
| 5.6 | `case 6: the steer gate reads the claim, not the connection — a steerable conn.hello does not unlock a non-steerable claim` | `machines.list()[0].runtimes` (steerable), `SteerRejectedError.code/runtime/state`, empty next page |
| 5.7 | `case 7: cursor replay is stable and monotonic, and a cursor below the recoverable floor fails closed with 409 cursor_too_old` | repeated `GET /byok/events?cursor=` pages, 409 `{error, recoverableFrom}`, `recoverableFrom - 1` still 200 |
| 5.8 | `case 8: an identical envelope id applies once, and a foreign device cannot terminate someone else's task` | `stats().dedupDrops`, `tasks.get()` unchanged, `{accepted: 0, rejected: 1}` for the foreign device |
| 5.9 | `case 9: capability admission runs before the mailbox append — a refused Agent dispatch leaves no task and no outbound row` | `dispatch()` rejection, `tasks.list()`, `stats().taskCountsByState`, empty page + cursor still `0` |
| 5.10 | `case 10: a rate-limit episode rejects with 429, counts every rejected envelope in stats(), and admits again after the bucket refills` | 429 body, `stats().rateLimitEvents`, `tasks.get().state`, recovery via bounded poll |

## Step 1 Gaps

No case had to be skipped — all ten are expressible on the public surface against today's `hub.ts` with zero production change. Four findings Steps 1–2 must carry forward, recorded here rather than "fixed":

1. **Packet §5.10 is imprecise about `rateLimitEvents`.** It says the counter goes up by 1 for the episode. It does not: `stats().rateLimitEvents` increments once per REJECTED ENVELOPE, unconditionally. The once-per-episode coalescing applies only to the `device.rate_limited` `ByokServerEvent`. Case 10 pins the actual behaviour (two rejected sends → `+2`) and must not be relaxed when `RateLimiter` becomes `InboundRateLimiter` in Step 2a.
2. **"Ignored" and "rejected" are different wire answers, and only one is visible as `rejected`.** A stale-terminal `task.complete` (cases 3, 4) and a dedup'd replay (case 8) both answer `{ accepted: 1 }` — wire-level successes that ran no handler. Only the ownership mismatch (case 8, second half) answers `{ accepted: 0, rejected: 1 }`. The cloud kernel's `inbound.ts` must preserve that three-way split exactly, not collapse "dropped as stale" into `rejected`.
3. **`cursor_too_old` has no public reachability knob.** `OUTBOX_RING_CAPACITY = 500` is a `hub.ts` constant with no `CreateByokServerOptions` equivalent, so case 7 reaches the eviction path by dispatching 501 offers to one device (~40ms; kept to this one case, per the plan's superseding annotation). If Step 1c gives `MailboxStore` a configurable retention bound, this case should switch to it rather than keep the 501 loop.
4. **`TaskResult` exposes no timestamps.** Case 2's "field by field" therefore covers `state`/`summary`/`sessionRef`/`document`/`artifactRefs`/`reason`/`retryable` plus a `TaskSnapshot`-only coherence check (`updatedAt >= createdAt`). If Step 2a's façade adds a terminal timestamp to `TaskResult`, this case is where it gets pinned.

Adjacent, for Step 2d rather than Step 1: `test-support.ts`'s `startServer` attaches the WS upgrade unconditionally, which is why this file starts its own HTTP-only server. Once `attachWebSocket` is deleted in Step 2b, `startServer` becomes HTTP-only on its own and `startHttpOnlyServer` should be deleted in favour of it.

## Verification

Run from the worktree root (`/Users/kito/Projects/byok-sdk-wt-wp3b-step0-characterization`, branch `codex/wp3b-step0-characterization`, base `a0b183d`):

| Command | Outcome |
|---|---|
| `bun run --cwd packages/server test -- coordination-characterization` | 1 file, 10 tests passed (0 skipped); re-run 3× for flake, stable |
| `bun run --cwd packages/server test` | 37 files, 289 tests passed |
| `bun run test` (workspace) | exit 0, all packages green |
| `bun run build` | exit 0 |
| `bun run typecheck` | exit 0, 15 packages |
| `bun run check:api-surface` | `9 package golden(s) match the built declarations` |
| `bun run check:version-authority` | `README.md and docs/spec.md agree with byok-sdk@0.12.0 and @byok-sdk/keys@0.3.9` |
| `git diff --check` | clean |
| `git diff --stat -- packages/server/src ':!packages/server/src/__tests__'` | empty — zero production diff |

One transient: the FIRST `bun run test` failed `packages/cloud-dataplane`'s `worker-packaging.test.ts > dry-runs wrangler deploy over worker-smoke` on its 5s test timeout (a cold `wrangler --dry-run` spawn under load). Re-run in isolation with the changes stashed AND present: green both times, and the full workspace run afterwards exited 0. Out of this slice's scope and out of reach of its diff (server tests only) — reported, not fixed.

## Deviations From Plan Or Spec

- Fixture shape: the plan sketched `{ deviceId; token; cursor; next; replay; send }` with a separate `ack(cursor)`. Shipped as `{ deviceId; accessToken; cursor(); next(); replay(cursor); send(envelope) }` — no `ack`, because acking IS `next()` taking the server's returned cursor, and a separate method would have been a second way to express the same fact. `token` is named `accessToken` to match `pairFakeDaemon`'s own return shape.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Reuse `startServer` (attaches WS) vs. a local HTTP-only starter | Local `startHttpOnlyServer` in the test file | Makes "no WS" structural for all ten cases; adding an HTTP-only variant to `test-support.ts` would widen this slice past the one fixture the contract authorises |
| `waitForTaskEvent` vs. the awaited `send()` as the barrier | Awaited `send()` | `handleInbound` is synchronous inside the request, so the send IS the barrier; `events()` replays from index 0, which makes "wait for the SECOND AwaitApproval" (case 5) a counting exercise with no added truth |
| Assert `rateLimitEvents === 1` per the packet vs. the actual per-envelope count | Actual per-envelope count | The packet's §5.10 wording is only true for a one-envelope episode; a test written to the wording would pin a behaviour the code does not have (recorded as Step 1 gap 1) |
| A configurable outbox ring vs. 501 dispatches for case 7 | 501 dispatches | No public option exists and this slice must not add one; the loop is confined to case 7 and costs ~40ms |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
