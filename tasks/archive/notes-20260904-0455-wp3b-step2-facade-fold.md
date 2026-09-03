> **Archived**: 2026-09-04 04:55
> **Related Plan**: plans/archive/plan-20260903-1505-wp3b-step2-facade-fold.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260904-0455

# Implementation Notes: wp3b-step2-facade-fold

> **Status**: Active
> **Plan**: plans/plan-20260903-1505-wp3b-step2-facade-fold.md
> **Contract**: tasks/contracts/20260903-1505-wp3b-step2-facade-fold.contract.md
> **Review**: tasks/reviews/20260903-1505-wp3b-step2-facade-fold.review.md
> **Last Updated**: 2026-09-04 03:41
> **Lifecycle**: notes

## Design Decisions

## 2a — façade over the cloud kernel

`createByokServer` is now a thin composition over `createByokCloud`. No coordination
semantics remain in this package: pairing, tokens, the inbound gate, ownership,
first-terminal-wins, approvals, steering, cancellation, long-poll redelivery and the
`cursor_too_old` floor are all the kernel's.

### Files

Created:

- `packages/server/src/connections.ts` — in-process device observations (`conn.hello`
  discovery block, liveness).
- `packages/server/src/relay.ts` — `TaskEventRelay`, the kernel's `ByokCloudObserver`.
- `packages/server/src/snapshot.ts` — pure projections: `TaskAttempt` -> `TaskSnapshot`,
  `TerminalResult` -> `TaskResult`, `DeviceRecord` (+ observation) -> `MachineInfo`,
  and the one `TaskState` derivation.
- `packages/server/src/stores.ts` — store composition, tenant derivation, the three
  decorators, the quota entitlement.
- `packages/server/src/device-selection.ts` — ambient `dispatch()` device pick.
- `packages/server/src/task-handle.ts` — `TaskHandle` (read-back `result()`).

Rewritten / edited:

- `packages/server/src/index.ts` — rewritten; `attachWebSocket` removed.
- `packages/server/src/types.ts` — pruned (see below).
- `packages/server/src/event-queue.ts` — bounded, drop-oldest + one truncation marker.
- `packages/server/src/rate-limiter.ts` — token bucket unchanged; added the counting
  `InboundRateLimiter` adapter with per-episode `device.rate_limited` coalescing.
- `packages/server/package.json` — added `@byok-sdk/cloud` (workspace).
- `packages/server/src/__tests__/test-support.ts` — `startServer` no longer attaches WS;
  `testPairingClaims` returns `CreatePairingCodeInput` (no tenant); `createPairingCode`
  awaited; `NONCE_SIGNING_DOMAIN` now from `@byok-sdk/cloud`.
- `packages/server/src/__tests__/coordination-characterization.test.ts` — `await`
  insertions and one `.tasks` unwrap only (full diff below).
- `packages/cloud/src/approval-timeline.ts` — ONE additive change, see Deviations.

Untouched on disk (2b deletes them, `index.ts` no longer imports any of them):
`hub.ts`, `http.ts`, `auth.ts`, `ws-server.ts`, `heartbeat.ts`, `pairing.ts`,
`task-store.ts`, `sqlite-task-store.ts`, `blob-store.ts`, `sqlite-blob-store.ts`,
`ids.ts`.

### Tenant derivation

`serverTenantId(productId) = tenantId(`product:${productId}`)` (`stores.ts`), minted with
core's single `tenantId()` mint point. One product, one tenant, decided once at
construction. `pairing.createPairingCode` therefore takes `{ productId, ttlMs? }` and no
tenant, and fails closed when `productId` is not this instance's own (a code for another
product would mint a device every bearer-authed route then refuses under
`instanceProductId`). `devices.revoke(deviceId)` binds this derived tenant
inside the façade; an unknown device id remains a documented silent no-op.

### `stats()` counter sources

| Field | Source |
|---|---|
| `connectedDeviceCount` | `DeviceConnections.connectedCount()` — devices observed alive and not since forgotten |
| `taskCountsByState` | walked from `cloud.listTaskAttempts` (paged) + `readApprovalTimeline`, through the SAME `toTaskSnapshot` projection `tasks.get` uses |
| `envelopesIn` | the `InboundRateLimiter` decorator — the kernel debits it at inbound-gate step 0 for every envelope, before any other decision (`inbound.ts` `applyInboundGate`), which is exactly where `ConnectionHub.handleInbound` counted |
| `dedupDrops` | the `InboundDedupStore` decorator (`checkAndRecord` returning `true`) |
| `rateLimitEvents` | the same rate-limiter decorator, per REFUSED envelope (never coalesced) |
| `uptimeMs` | `Date.now() - startedAtMs` |

No cloud hook was needed for any counter. `envelopesOut` is REMOVED (no Step 0 case
asserts it; server -> daemon envelopes are durable mailbox rows the kernel owns, and a
counter here would be a second, weaker authority over that fact).

`stats()` is now `Promise<HubStats>` — see Deviations.

### `TaskState` mapping

`toTaskState(attempt, pending)` (`snapshot.ts`), gates in order:

| Condition | `TaskState` |
|---|---|
| `attempt.cancellation !== undefined` | `Cancelled` |
| `status === 'complete'` | `Complete` |
| `status === 'failed'` | `Failed` |
| `status === 'cancelled'` / `'cancel_requested'` | `Cancelled` |
| `status === 'offered'` + pending approval | `AwaitApproval` |
| `status === 'offered'` | `Offered` |
| `status === 'claimed'` + pending approval | `AwaitApproval` |
| `status === 'claimed'` | `Claimed` |
| `status === 'running'` + pending approval | `AwaitApproval` |
| `status === 'running'` | `Running` |

`pending` is `pendingApproval(readApprovalTimeline(...))` — the kernel's own fold, so the
projection and the kernel's `approveTask` staleness gate read one authority.
`AwaitApproval` has no attempt status by design (ADR-028), which is why it is derived.

### `MachineInfo.runtimes`

The kernel persists `conn.hello.capabilities` on the durable device row and NOTHING else
from the hello: `runtimes` (`RuntimeInfo[]`, with the per-runtime capability blocks),
`clientVersion` and `configuredToolsets` are not stored anywhere in `@byok-sdk/cloud`, and
core presence carries a different, weaker shape (`PresenceRuntimeFact`: id/version/
authPresent, no capabilities) which nothing in this repo publishes over these routes.

So `MachineInfo.runtimes` / `clientVersion` / `configuredToolsets` / `lastSeen` are read
from `DeviceConnections` (`connections.ts`), populated by the relay from each ACCEPTED
`conn.hello` commit; `deviceId` / `deviceName` come from `cloud.listDevices`. `connected`
is set by an accepted `conn.hello` OR by a `GET /byok/events` poll (observed through the
mailbox `readCursor` decorator), and cleared by revocation. This is deliberately an
in-process observation with the same lifetime as the connection it describes — Step 0
case 6 (`machines.list()[0].runtimes` equals the declared infos) and cases 1 and 9
(`connected: true` straight after `conn.hello`) both pass on it.

### Relay bounds

- `taskEventBufferLimit`, default `DEFAULT_TASK_EVENT_BUFFER_LIMIT = 1000`: per-task
  drop-oldest, then a single `{ kind: 'error', reason: 'events_truncated' }`.
- `taskEventRetentionMs`, default `DEFAULT_TASK_EVENT_RETENTION_MS = 5 * 60_000`: after a
  terminal, the queue is closed and the entry dropped (`unref`'d timer).
- The cross-task `ByokServerEvent` feed is bounded on the same limit and drops silently —
  that union has no member that could carry a truncation notice.
- `stop()` clears every timer, settles every terminal barrier, closes every queue, and
  clears the connection observations.

### Step 0 result: 8/10

`bun run --cwd packages/server test -- coordination-characterization` -> `2 failed | 8
passed`. Both failures are recorded here per the contract's escalation path; **no Step 0
assertion was edited** to accommodate either.

**Case 6 — `SteerRejectedError.state` is `undefined`.** Every other assertion in the case
passes (`code`, `runtime`, the empty next page, the surviving `Running` snapshot). Step 1
moved the class to `@byok-sdk/cloud` but RENAMED the third field: the server's
`state: TaskState` (`'Running'`) became cloud's `status: TaskAttemptStatus` (`'running'`).
The brief has this package re-export cloud's class so `instanceof` works across both
surfaces, so the pinned `.state` no longer exists.

Not fixable inside this package without something the taste constraints forbid: adding a
`state` getter in cloud would need a second `TaskAttemptStatus -> TaskState` mapping that
cannot be right (it cannot see the approval timeline, so it would report `Running` for a
task this façade calls `AwaitApproval`, and it would have to decide `cancel_requested`
alone), and catching-and-rethrowing a server-shaped error in `TaskHandle.steer` is the
shape translator the workflow contract forbids. **Orchestrator decision needed**: either
the kernel error carries the wire state as a first-class field, or the pin moves to
`.status` and Step 5 documents the public break.

**Case 7 — cursor replay of ACKED rows, and the ring-overflow `409 cursor_too_old`.**
Fails at `expect(backwards).toEqual(firstRead)`. Core's mailbox (`packages/core/src/
in-memory/mailbox.ts`) is cursor-advance-then-consume: `readAfter` returns only `pending`
rows, so once a poll at `cursor - 1` acks rows 1..2 they are `acked` and a later poll from
cursor 0 sees only row 3. The old hub kept a 500-entry replay ring that replayed acked
entries. The second half of the case is unreachable for the same family of reasons:
`recoverableFrom` moves only when rows become `expired`, which only `collectRetired` does,
and its cutoff is a TIMESTAMP, not a count — 501 offers appended within a few milliseconds
cannot be split by it, so no floor ever moves and no 409 is produced.

Expressing this case would mean giving the façade its own count-bounded `MailboxStore`
implementation (a replay window that retains acked rows and dead-letters past a
capacity). That is a new store authority and an architectural decision outside this
sub-step's brief, so it is escalated rather than taken. **Orchestrator decision needed.**

### Step 0 file diff (complete)

Only `await` insertions plus one `.tasks` unwrap; every assertion is byte-identical.
`git diff origin/main..HEAD -- packages/server/src/__tests__/coordination-characterization.test.ts`
is 34 hunks of exactly that shape — see the PR diff. Shapes used:

- `X.tasks.get(id)?.f` -> `(await X.tasks.get(id))?.f`
- `const s = X.tasks.get(id)` -> `const s = await X.tasks.get(id)`
- `X.tasks.list()` -> `(await X.tasks.list()).tasks`
- `X.machines.list()` -> `(await X.machines.list())` / `await X.machines.list()`
- `X.stats().f` -> `(await X.stats()).f`

### Deviations

1. **`packages/cloud/src/approval-timeline.ts`: `resolvedBy: z.enum(['local'])` ->
   `z.enum(['local', 'host'])`.** The ONLY cloud change, additive, no behaviour change for
   any existing path (`pendingApproval`'s fold reads both identically; no gate branches on
   the field). Needed because the kernel's `approveTask`/`rejectTask` deliberately do NOT
   record the host's decision — cloud's own suite pins that only a device-reported
   `task.approval_resolved` clears the pending slot. The embedded server's contract is the
   opposite (`approve()` is authoritative immediately: Step 0 cases 5 and 8), so the
   façade writes the host decision onto the timeline, which is the ONE authority both the
   snapshot projection and the kernel's staleness gate read. The alternatives were worse:
   a façade-local "already resolved" set is a second authority for exactly one datum and
   would leave the kernel enqueueing a duplicate `task.approve` on every later call;
   writing `resolvedBy: 'local'` for a host decision is a lie in a durable record.
   `api-surface/cloud.d.ts` is NOT regenerated in this commit (closeout owns it), so
   `bun run check:api-surface` now fails for `cloud` as well as `server`.
   - Narrow known hole, deliberate: the timeline's `approval_resolved` requires an
     `approvalId`, so a host decision on a pre-M5 approval (daemon reported none) is
     delivered to the device but leaves the slot pending until the daemon reports it.
2. **`stats()` is now `Promise<HubStats>`.** `taskCountsByState` is computed from the
   durable task store on every call. Keeping it synchronous would have required a
   task-state mirror maintained in this package — precisely the second task authority the
   fold exists to delete. Cost: three `await` insertions in the Step 0 file.
3. **`envelopesOut` removed from `HubStats`** (no Step 0 case asserts it).
4. **`ByokServerEvent.task.approval_resolved.targeted` is always `false`.** It reported
   whether the device's LIVE WS registration advertised `approval-targeting`; that
   registration no longer exists, and the durable capability list is a device-build fact,
   not a per-report one.
5. **`agentMessage.consume` adopts the kernel's shape verbatim** (async, and carrying
   `tenant`). One-shot break, per packet §6; no adapter.
6. **Dropped from `index.ts`'s exports**: `TaskStore`, `CreateTaskInput`, `TaskRecord`,
   `InMemoryTaskStore`, `IllegalTaskTransitionError`, `SqliteTaskStore(+Options)`,
   `SqliteBlobStore(+Options)`, `LocalDiskBlobStore`, `BlobStore` and its input/result
   types, `PairingAttemptConflictError`, `PairingCodeInvalidError`,
   `PairingAttemptBinding`, `PairingCodeClaims`, `PairingCompletion`,
   `AgentHomeProjectionCompletionError(+Code)` (the completion route is the kernel's now
   and fails with `ByokCloudError`), and `AuthenticatedDevice` (no equivalent is exported
   from `@byok-sdk/cloud`). `SqliteUnavailableError` is kept. Added: `PairingCodeInfo`,
   `CreatePairingCodeInput`, `TaskPage`, `TaskListQuery`, `DEFAULT_TASK_PAGE_LIMIT`,
   `DEFAULT_TASK_EVENT_BUFFER_LIMIT`, `DEFAULT_TASK_EVENT_RETENTION_MS`, and the cloud
   re-exports.
7. **`TaskSnapshot.createdAt` / `sessionRef` come from a dispatch-time index**
   (`DispatchFacts`, held per task id in `index.ts`). `TaskAttempt` carries neither — it
   has `updatedAt` only, and no session. Reporting `updatedAt` as `createdAt` would be a
   false public field; the index records the offer envelope's own `ts` at dispatch and
   falls back to `attempt.updatedAt` for a task this process did not dispatch. A terminal's
   own `sessionRef` outranks the dispatched one.
8. **`longPollIntervalMs`** is derived (`hold / 8`, clamped to `[5, 250]`ms) rather than
   exposed as an option, so a short test hold still re-reads several times.
9. **A tenant storage entitlement is written at construction** from `maxBlobSizeBytes`.
   Blob reservations need one and an embedded server has exactly one tenant and one
   configured ceiling; without it the blob routes 4xx.
10. **`TEST_TENANT_ID` in `test-support.ts` is now stale** (kept, unused by the fixture) —
    2d owns the tests that pass it to `devices.revoke`.

### Verification

- `bun run --cwd packages/server build` — `tsup` OK (`dist/index.js` emitted); the
  `tsc -p tsconfig.build.json` half FAILS, in `hub.ts`, `task-store.ts` and
  `sqlite-task-store.ts` only, because they still reference the pruned `TaskSnapshot` /
  `HubStats` / `ByokServerEvent`. Those three are 2b deletions and `index.ts` no longer
  imports them. `bun run --cwd packages/server typecheck` fails for the same three plus
  the 36 unmigrated test files (2d). Making either pass in 2a would mean either doing 2b
  early or re-adding the pruned fields, i.e. the compatibility shim the fold removes.
- Façade sources typecheck CLEAN in isolation. Reproduce with a temporary
  `packages/server/tsconfig.facade-check.json` extending `./tsconfig.json` and
  `include`-ing exactly `src/{index,types,relay,task-handle,snapshot,stores,connections,device-selection,event-queue,rate-limiter,sqlite-support}.ts`,
  then `npx tsc -p packages/server/tsconfig.facade-check.json --noEmit` -> exit 0.
- `bun run --cwd packages/cloud typecheck` -> exit 0; `bun run --cwd packages/cloud test`
  -> 34 files, 306 tests, all passing (the approval-timeline enum change is inert for
  every existing path).
- `bun run --cwd packages/server test -- coordination-characterization` -> 8 passed,
  2 failed (cases 6 and 7, above).


## 2a-escalations resolved (Step 0 cases 6 and 7)

Both escalations from 2a were ruled on by the orchestrator and closed over the
kernel. `bun run --cwd packages/server test -- coordination-characterization`
is now **10 passed / 10**.

### Case 6 — `SteerRejectedError.state`

**Ruling: `@byok-sdk/server` keeps its OWN `SteerRejectedError`.** This is a
deliberate deviation from design packet §1.2, which had the class move to
`@byok-sdk/cloud` with this package re-exporting it.

Reason: the wire `TaskState` vocabulary (`Offered`/`Claimed`/`Running`/
`AwaitApproval`/…) is host-facing and lives in `packages/server/src/types.ts`,
not in cloud. The kernel's class carries `status: TaskAttemptStatus` instead,
and the two cannot be one field: `AwaitApproval` is derived from the durable
approval timeline and has NO attempt status at all (ADR-028), so any
`TaskAttemptStatus -> TaskState` mapping placed inside cloud would report
`Running` for a task this façade calls `AwaitApproval`.

Shape (`packages/server/src/task-handle.ts`): `taskId`, `code:
SteerRejectionCode`, `state: TaskState`, `runtime` — byte-identical to the
pre-fold `hub.ts:471` class, including its message text.
`TaskHandle.steer()` calls `cloud.steerTask`, catches the kernel's
`SteerRejectedError`, and rethrows the server class with `code` and `runtime`
passed through and `state` READ — not translated — through
`index.ts`'s `readTaskState`, which is `projectTask(attempt).state`, i.e. the
exact projection `byok.tasks.get(taskId)` answers with, at the moment of the
refusal. One authority, two readers, no second mapping, and no shape
translator: nothing is derived from the kernel's `status` field.

Unchanged: `SteerRejectionCode` is still a re-export of cloud's (identical
strings), and `StaleApprovalError` is still a re-export of cloud's class (shape
identical). Case 6's assertions are untouched.

### Case 7 — cursor semantics

**Ruling: the kernel's mailbox semantics win; the hub's 500-entry replay ring
is dropped, not rebuilt.** Packet §2 already records the kernel contract as
"语义更强", and hosted production runs on it. The case is re-pinned — the ONE
Step 0 case re-ruled in Step 2 — still entirely on the public surface
(`GET /byok/events` status + body):

| Pinned | How |
|---|---|
| reading does not ack | two `replay(c)` at the same cursor return identical pages |
| the ack is the NEXT poll's cursor, and is irreversible | after a poll carries the cursor back, a read from a LOWER cursor returns only still-pending rows, and a following read at the higher cursor sees nothing re-delivered |
| the floor moves only on expiry | a retention sweep dead-letters the one un-acked row (acked rows are deleted, which moves nothing); `replay(0)` -> 409 `{error:'cursor_too_old', recoverableFrom}`, `replay(recoverableFrom - 2)` -> 409, `replay(recoverableFrom - 1)` -> 200 with the retained tail |

Dropped from the old pin, deliberately: "the same cursor twice returns a
byte-identical page **after those rows were acked**" (that was the ring
replaying consumed rows — `mailbox-cursor.test.ts` pins the opposite as the
contract), and "501 offers move the floor" (retention is a TIMESTAMP cutoff,
never a count).

Design packet updated: §5 item 7 rewritten to the kernel contract with the
reason the ring is not rebuilt; §8 gained a paragraph naming case 7 as the only
re-ruled Step 0 case.

#### Deviations from the orchestrator's literal instruction for case 7

Two, both because the premise did not exist in the tree:

1. **No `CreateByokServerOptions.clock` was added.** It was specified as the
   means to "advance the clock past the retention". `MailboxRetentionInput`
   takes the cutoffs as explicit canonical timestamps, so the test names a
   far-future instant (`2999-01-01T00:00:00.000Z`, exactly as
   `packages/cloud/src/__tests__/events-cursor-too-old.test.ts` does) and needs
   no clock at all. Adding a clock option would have been public surface the
   case does not use.
2. **A `ByokServer.mailbox.collectRetired(input)` pass-through was added**,
   because there is NO mailbox retention knob and no sweep driver anywhere:
   `grep -rn collectRetired packages/{core,cloud,server}/src` outside tests
   returns only the port declaration, the in-memory implementation, and this
   façade's own decorator — nothing in core, cloud or server calls it, on a
   timer or otherwise. So neither "a sweep on poll" nor "a maintenance call"
   existed to be found.

   Shape: a verbatim forward of core's host control-plane operation
   (`MailboxStore.collectRetired`) bound to this server's one tenant. It names
   NO policy — the caller supplies both cutoffs — runs no timer, and holds no
   second opinion about when work is declared lost, so it adds no retention
   authority. It closes a real gap rather than a test-only one: without it an
   embedded server retires nothing ever, and `recoverableFrom` can never move,
   which is precisely what made the 409 path unreachable in 2a.
   `MailboxRetentionInput`/`MailboxRetentionResult` are re-exported from
   `@byok-sdk/core`.


## 2b — deletions

`packages/server/src` is now 11 files (façade + `types.ts`/`index.ts`/
`sqlite-support.ts`/`rate-limiter.ts`/`event-queue.ts`); `bun run --cwd
packages/server build` (tsup **and** `tsc -p tsconfig.build.json`) exits 0 for
the first time since 2a.

### Deleted modules (5,196 lines)

| File | Lines |
|---|---|
| `hub.ts` | 2639 |
| `http.ts` | 496 |
| `auth.ts` | 407 |
| `sqlite-task-store.ts` | 402 |
| `sqlite-blob-store.ts` | 277 |
| `blob-store.ts` | 251 |
| `ws-server.ts` | 236 |
| `pairing.ts` | 214 |
| `task-store.ts` | 184 |
| `heartbeat.ts` | 69 |
| `ids.ts` | 21 |

Exactly the packet §1.2 list and exactly its 5,196-line estimate.

### Deleted tests (1,679 lines)

Deleted-class: `task-store` (141), `sqlite-task-store` (453),
`sqlite-blob-store` (288), `sqlite-lifecycle` (112), `pairing` (89),
`nonce-store` (53). Transport-only: `heartbeat` (96), `version-negotiation`
(126), `port-shadowing` (32). Owner ruling R2 (lease reaper deleted):
`task-lease` (289).

### Conformance-coverage skim (packet §5 asks for this)

Compared each deleted-class suite against `packages/conformance/src/cloud/
{pairing,nonces,task-attempts,blobs}.ts`. **Reported, not ported** — nothing was
moved into `packages/server`.

**Covered no weaker than the deleted unit tests** — pairing: unknown code,
expired code, single redemption, claims round-trip (conformance is STRICTER:
it adds "does not consume a code it rejected as expired" and a concurrent
single-winner enrollment). Nonces: single-consume winner, per-device binding,
TTL expiry, distinctness. Task attempts: ownership on first claim, claim race
winner, re-open idempotence, lifecycle transitions, claim-time runtime snapshot
written once, tenant-scoped paging with limit validation. Blobs: grant minting,
no download URL before bytes land, no second write grant once bytes landed,
unknown/foreign id indistinguishable, tenant-scoped destination.

**Gaps — assertions the conformance suites do NOT cover.** Three classes:

*(A) The concept is deleted; there is nothing to cover (ADR-028).* All of
`task-store.test.ts`'s FSM: `IllegalTaskTransitionError` on `Offered ->
Running`, on any transition out of a terminal, and on `AwaitApproval ->
Complete`; the `AwaitApproval <-> Running` loop; `setPendingApprovalId` and its
"no-op once the task has left AwaitApproval" rule. The kernel has no execution
state machine — `TaskAttempt` carries a coarse status and `AwaitApproval` is
derived from the durable approval timeline, whose fold is covered by
`packages/conformance/src/cloud/approval-timeline.ts` and the cloud suite.
Filling these into conformance would mean re-asserting the second authority
this work-package deletes. **No action.**

*(B) Genuinely uncovered anywhere, and cheap to add to conformance later.*
1. `pairing.test.ts:17` — the DEFAULT pairing-code lifetime (~10min). No
   conformance case asserts a default TTL, only that an expired code is
   refused.
2. `pairing.test.ts:82` — the claims of an already-minted code cannot be
   mutated through the value the mint returned (defensive copy). No conformance
   equivalent.
3. `pairing.test.ts:34` — two codes minted with different claims stay bound to
   their own. Conformance asserts one code registers under its own claims but
   never contrasts two.
4. `nonce-store.test.ts:42` — deleting a device's registration drops every
   outstanding nonce for it (§6.3). `cloud/nonces.ts` has no
   device-deletion case at all, and neither does any other cloud dimension.
   This is the sharpest of the four: it is a real cross-port invariant, not an
   implementation detail.

*(C) Adapter facts with no port-level expression; Step 3 (SQLite) owns them.*
`nonce-store.test.ts`'s three pruning cases (expired/used nonces swept on a
later `issue()`, live ones kept) are storage reclamation, invisible through the
port — a conformance suite can only observe the TTL behaviour it already
covers. Everything in `sqlite-task-store.test.ts` (cross-instance
compare-and-set, reopen persistence, creation-order recovery, in-place additive
migrations for `pending_approval_id` / `claimed_runtime`, tolerating a lost
`ALTER TABLE` race), `sqlite-blob-store.test.ts` (byte round-trip, size- and
contentHash-mismatch rejection, restart-safe bytes/ids/HMAC signing secret,
racing secret initialization, 0600 file modes, cross-instance presigned
download) and `sqlite-lifecycle.test.ts` (stores closed when schema init fails)
is likewise adapter-shaped. Two notes: `cloud/blobs.ts` states in its own header
that byte-level and URL-shaped facts belong to a composition suite, not the
dimension; and the size/hash-mismatch rule does have a port-level cousin in
`core/objects.ts` ("refuses to commit an object whose observed shape
disagrees"). **These should be re-asserted by running the conformance suites
against the Step 3 SQLite composition, not rewritten as server unit tests.**

### `test-support.ts`

WS half removed: `connectFakeDaemonWs`, `connectFakeDaemon`, `nextEnvelope`,
`send`, `toEnvelope` and the per-socket queue, plus `claimAndStart` and
`moveToAwaitApproval` (both took a `WebSocket`). 558 -> 333 lines, and the file
no longer imports `ws`. Kept: `startServer`/`stopServer`,
`connectFakeDaemonLongPoll` + `FakeLongPollDaemon`, `pairFakeDaemon`,
`testPairingClaims`, `generateFakeDeviceIdentity`, `waitForTaskEvent`,
`waitForServerEvent`, and the three `RuntimeInfo` fixtures. 2d owns long-poll
replacements for `claimAndStart`/`moveToAwaitApproval` (the Step 0 file already
has a local `claimAndStartOverLongPoll` worth lifting).

### `packages/server/package.json`

Dropped `ws` and `@types/ws` (no non-test source imports either), and `jose`,
which `auth.ts` was the only consumer of — `grep -rn jose packages/server/src`
is now empty. `hono` / `@hono/node-server` KEPT (the façade app and the test
fixtures use both). `bun install` re-run; `bun.lock` updated.

### State of the remaining tests (2d)

27 `.test.ts` files remain. 3 typecheck clean today
(`coordination-characterization` — 10/10 green, `dispatch-routing`,
`sqlite-support`); **24 do not compile**, which is expected and is 2d's job.
What they need:

- 22 still `import { WebSocket } from 'ws'` and drive `connectFakeDaemon` /
  `claimAndStart` / `moveToAwaitApproval`: swap to `connectFakeDaemonLongPoll`
  and long-poll equivalents of the two drivers.
- 8 import deleted modules by path (`../hub`, `../http`, `../auth`,
  `../task-store`, `../blob-store`): `agent-home-contract`,
  `bearer-instance-product`, `hub-approval-resolved`, `hub-approve-reject`,
  `issues-112-120-security-reliability`, `rate-limit-episode`, `rate-limit`,
  `result-document-projection`. Their setup has to be rebuilt on the public
  surface; any assertion that cannot be must be listed here rather than
  quietly dropped.
- `integration.test.ts:312` and `rate-limit-episode.test.ts:41` consume
  `device.connected`, which no longer exists (plan Annotations, option A).
- `auth.test.ts` and `nonce`-adjacent expectations now answer from the kernel's
  auth plane, not the deleted local one.

`grep -rnE "from '\./(hub|http|auth|ws-server|heartbeat|pairing|task-store|sqlite-task-store|blob-store|sqlite-blob-store|ids)'" packages/server/src`
returns ZERO hits — every remaining reference is a test file using `../`.


## 2c — smoke scripts + `examples/basic`

### Script exit codes

| Command | Exit |
|---|---|
| `node packages/client/scripts/control-socket-check.mjs <name>` | **0** |
| `node packages/client/scripts/ipc-smoke.mjs` | **0** |
| `node packages/client/scripts/adapter-task-smoke.mjs` | **0** |

`bun run --cwd examples/basic typecheck` -> exit 0.
`grep -rn 'attachWebSocket\|SqliteTaskStore\|SqliteBlobStore\|LocalDiskBlobStore' packages/client/scripts examples/basic`
-> zero hits (the prose in these files names the WS attachment and the deleted
stores descriptively so the Step 5 grep gate stays at zero).

`control-socket-check.mjs` takes a REQUIRED `<name>` argument (unchanged by this
sub-step): invoked bare it prints its usage line and exits 1. The plan's
verification boundary lists it without one — that line needs a name.

### The three scripts

All three: `byok.attachWebSocket(httpServer)` deleted from the `serve` callback,
and `byok.pairing.createPairingCode` awaited with `{ productId }` only (the
tenant is derived at construction now).

There was nothing to *configure* for long-poll in the two CLI-driven scripts:
the daemon config file exposes no transport knob, and the façade serves no WS
endpoint at all, so `byok-agent start` falls back on its own. `byok-agent status`
now reports `transport=degraded` in `ipc-smoke`, which is the long-poll fact,
not a failure — both scripts assert the LOCAL control socket, which is
transport-independent.

Two server options had to be set to keep the scripts bounded; both are smoke
harness values, not product semantics:

1. **`longPollHoldMs: 500` (all three).** `LongPollClient.stop()` ends the poll
   loop but does not abort the request already in flight, so at the ~50s
   production default the `byok-agent start` child outlived the control-socket
   shutdown it had already confirmed — `ipc-smoke` failed on its "the start
   child terminates on its own" assertion with `process did not exit within
   10000ms`. Bounding the SERVER's hold is the fix available from a smoke
   script; aborting the in-flight fetch on `stop()` is a real client-side
   improvement for Step 4 to consider.
2. **Default `taskEventRetentionMs` (`adapter-task-smoke`).** The relay now
   closes a task's event queue immediately after pushing the terminal event;
   retention only controls later buffer reclamation. The smoke deliberately
   keeps the 5-minute default to prove `collectTaskEvents` does not depend on
   that timer.

`adapter-task-smoke` additionally: dropped `heartbeatIntervalMs` (gone from
`CreateByokServerOptions`); added `longPoll: { wsFailureThreshold: 1,
retryDelayMs: 10, idleDelayMs: 10, wsRetryIntervalMs: 60_000 }` to the daemon
overrides so it reaches long-poll on the first failed WS probe instead of
burning the three-failure default; replaced `assert(daemon.status().connected)`
(that predicate is WS-open only) with a wait on `daemon.status().degraded` plus
a wait on the SERVER-side observation `(await byok.machines.list()).some(m =>
m.deviceId === deviceId && m.connected)`; awaited both `byok.tasks.get` calls;
and passes an explicit `deviceId` (from `daemon.status().deviceId`) to all three
`dispatch()` call sites.

Worth recording because it was the open risk going in: the real client daemon
sends `conn.hello` only over WS (`ws-transport.ts:119`; no long-poll equivalent
exists), and the durable device `capabilities` row is written only from an
accepted hello (`cloud/src/inbound.ts:531-541`). The `dispatchSelection`
admission gate reads exactly that row. It nonetheless PASSES here — verified,
not assumed — so nothing in this sub-step is blocked on it.

### Resolved blocking gap — `task.decline` records a terminal result

Before the kernel fix, `adapter-task-smoke` exited 1 at its FIRST case
("pi BYOK missing launcher") on:

```
Error: task task_… reached a terminal with no recorded result
    at Object.result (packages/server/dist/index.js:717)
```

Cause: the kernel's `task.decline` branch writes `recordStatus({ status:
'failed' })` and NO `TerminalResult` (`packages/cloud/src/inbound.ts:551-557`) —
unlike `task.complete`/`task.fail`/`task.cancelled`, which all call
`recordTerminal`. The relay meanwhile treats `task.decline` as a terminal and
settles the `result()` barrier (`packages/server/src/relay.ts:200-202`,
`:236-252`), so `TaskHandle.result()` wakes, reads back nothing from
`cloud.readTaskResult`, and throws by design
(`packages/server/src/task-handle.ts:151-159`). The pre-fold hub recorded a
result for a decline, so this is a fold regression on a public promise: a
declined task is observably `Failed` through `tasks.get()` and through the event
feed, but `result()` is unusable for it.

The chosen repair is at the one kernel authority: `task.decline` now uses
`recordTerminal`, and the terminal projection preserves the device's reason and
`retryable` value. The façade does not synthesize a result. The complete smoke
now exits 0; the detailed fix and regression matrix are in `2c-kernel` below.

The unfaked script now proves the declined result plus the three per-runtime
offer→claim→started→complete cases and the three cancel→quiescent-disposal
lifecycle cases, ending with `adapter-task-smoke: PASS` and exit 0.

### `examples/basic`

`server.ts` — minimal, typecheck-green:

- Import list reduced to `createByokServer`, `DispatchInput`, `TaskHandle`; the
  deleted store classes and `BlobStore`/`TaskStore` types are gone, as are the
  now-unused `node:fs` `mkdirSync` and `node:http` `Server` imports.
- `BYOK_STORE=sqlite` **fails closed at startup** (`console.error` naming "SQLite
  persistence returns in WP3B Step 3", then `process.exit(1)`). No silent
  fallback to memory.
- `const dispatched = new Map<string, {instruction, runtime?, policy}>()`, written
  on every successful `dispatch()` and joined by taskId into `/api/tasks` and
  `/api/tasks/:taskId` — packet §6's ownership fix for the four pruned
  `TaskSnapshot` fields. The UI keeps the fields it renders.
- `/api/pair`, `/api/machines`, `/api/tasks`, `/api/tasks/:taskId` are now
  `async` and await the façade; `/api/tasks` unwraps the paged
  `{ tasks, nextCursor }`.
- `serve()`'s callback no longer attaches WS; the `server` binding it needed is
  gone with it.

One route could not be kept and now answers `501` with an explanatory body
rather than a lie:

- `GET /api/blobs/:blobId/url` — it minted a browser-facing download URL off the
  embedder's own `blobStore` handle, and `CreateByokServerOptions` no longer
  accepts one. Step 3.
`POST /api/machines/:deviceId/revoke` is also restored. The façade API is now
`devices.revoke(deviceId)` and binds the one embedded tenant internally, so the
example neither receives nor re-derives tenant authority.

`README.md` — the storage section now states there is no persistent mode and
shows the fail-closed `BYOK_STORE=sqlite` output; the live-task-recovery caveat
and the `node:sqlite` capability note went with the mode they described. A short
paragraph names the remaining blob `501` route and the restored revocation
route. Nothing else in the file changed.

## 2d-client — `packages/client`'s `real-server-*` suite

Plan decision (ix): the real-server fixture is KEPT and the WS start modes are
dropped. `bun run --cwd packages/client test -- real-server` ->
**8 files passed / 2 skipped, 10 tests passed / 5 skipped**, stable across
three consecutive runs. `npx tsc --noEmit` reports nothing for
`src/__tests__/fixtures/real-server.ts` or any `src/__tests__/real-server-*`,
and `attachWebSocket` appears in none of them.

### `src/__tests__/fixtures/real-server.ts`

Three start modes collapsed to one. `startRealServerWithoutWebSocket` and
`startRealServerWithDeferredWebSocket` (plus `DeferredWebSocketServerHandle`
and its `enableWebSocket()`) are gone, and `startRealServer` no longer calls
`attachWebSocket` — the façade has no WS upgrade at all, so a daemon pointed at
it reaches long-poll through its own `wsFailureThreshold` fallback (Node
destroys the socket on an unhandled `'upgrade'`, a genuine WS failure). Also:
`createPairingCode()` is now `Promise<PairingCodeInfo>` and names only
`productId` (the tenant is derived at construction), `TEST_TENANT_ID` is
deleted with the tenant parameter that used it, and `close()` calls
`byok.stop()` before closing the socket so the relay's per-task feeds and
reclamation timers do not outlive the file.

### Per file

| File | Change |
|---|---|
| `real-server-outbox-switch.test.ts` | **Deleted** (packet §4). The WS<->long-poll switch it forced with `enableWebSocket()` is deleted behaviour; there is no second transport to switch to. |
| `real-server-longpoll-only.test.ts` | Fixture adaptation only. 2/2 pass. |
| `real-server-longpoll-retry-idempotent.test.ts` | Fixture adaptation only. 1/1 passes. |
| `real-server-longpoll-steer.test.ts` | Fixture adaptation only (now backed by Step 1b `steerTask`). 2/2 pass. |
| `real-server-outbox-chunking.test.ts` | Fixture adaptation only. 1/1 passes. |
| `real-server-longpoll-redelivery.test.ts` | 1 skipped (gap 1), 1 passes. The `SteerUnsupportedError` case additionally had an ordering race exposed by the faster façade: it read a `baseline` cursor of 0 and then let the OFFER's own advance satisfy the post-steer assertion. Fixed by pinning `baseline` to `> 0` (the task is already `Running`, so the offer's seq is persisted) and waiting for `steerAttempts === 1` before inspecting the cursor. No assertion loosened. |
| `real-server-longpoll-stall-dedup.test.ts` | All 3 skipped (gap 1). |
| `real-server-redelivery.test.ts` | Rewritten to long-poll. "Drop the socket, reconnect" became "the receive half goes dark": `GET /byok/events` fails at the fetch layer while `POST /byok/messages` is left alone, so the in-flight session is undisturbed and the only thing under test is the envelope enqueued during the gap. Pins unchanged — a `task.approve` issued while the daemon is not receiving reaches the SAME still-alive session once polling resumes (`resolveApprovalCalls` equals `[{approved:true}]`), and the task completes. Added: the gap is proven real (at least one poll already failed) before the approve, and `resolveApprovalCalls` is asserted empty immediately after it. |
| `real-server-cancel-redelivery.test.ts` | Same rewrite shape. Pins unchanged — the server's record is `Cancelled` immediately, the delivered `task.cancel` interrupts the SAME session despite its task having been terminal the whole time it sat queued, `result()` is `Cancelled`, and the daemon's own `task.cancelled` is absorbed idempotently. The final "nothing broke" check no longer sleeps 100ms: it waits for the daemon's `task.cancelled` to actually appear on the wire (counted at the fetch layer) and then asserts the record. |
| `real-server-approval-resolved-e2e.test.ts` | Rewritten to long-poll, then skipped (gap 2). No `ByokServerEvent` `device.*` usage existed in it. |
| `real-server-repair-cursor.test.ts` | Rewritten to long-poll (the finding is transport-independent; what makes it observable — device B's mailbox starting at seq 1 — is unchanged). `connected === true` became `degraded === true` plus the server-side observation. 1/1 passes, including `recordB.deviceId !== recordA.deviceId`. |

### Gaps (skipped, never silently deleted)

**Gap 1 — a stalled handler's envelope is never redelivered (5 skipped `it`s).**
`real-server-longpoll-redelivery` ("a polled task.steer whose handler throws …
a re-poll redelivers it"), and all three of `real-server-longpoll-stall-dedup`
(the delay-spaced retry, the in-flight offer dedup, the exactly-once stalled
retry), plus `agent-home-projection` (a 503 completion must keep the mailbox
cursor behind the projection so daemon restart redelivers it).

The kernel mailbox's ack is IRREVERSIBLE (`readAfter` returns only `pending`
rows; `advanceCursor` marks everything at or below the cursor `acked`), and the
hub's 500-entry replay ring is gone — the case 7 ruling above. The long-poll
client acks OPTIMISTICALLY: `ConnectionManager.dedupWatermark()` returns the
delivered high-water while unstalled, so the poll issued immediately after a
batch is delivered carries that seq and acks the envelope BEFORE its handler
has settled. Observed on the wire against this server:

```
poll cursor=1 -> 200 [[2,"task.steer"]] cursor 2
poll cursor=2 -> 200 []                          <- irreversible ack of seq 2
poll cursor=1 -> 200 []   (x N, forever)         <- stall rolls the cursor back; nothing left to replay
```

So `stalledAtSeq` freezes a cursor the server has already moved past, and the
whole F3/P2 redelivery-after-handler-failure guarantee is unreachable
end-to-end over long-poll. **This is a product gap, not a test artifact** —
the client-side optimistic ack is what breaks it, and it is the daemon's only
remaining transport once Step 4 lands. Two candidate closures, both outside
2d's scope: have the long-poll loop poll with the DURABLE cursor (ack only what
a handler has settled), or give the kernel a read-vs-ack split on the wire.
The third stall-dedup case is additionally VACUOUS rather than merely
unprovable — with no redelivery, the offer under test is delivered exactly once,
so it would pass without ever exercising the dedup guard it is named for; a
false green, hence skipped rather than kept.

**Gap 2 — `approval_resolved` advertisement: resolved.**
The kernel now advertises `approval_resolved` from `GET /byok/events`, guarded
by `packages/cloud/src/__tests__/protocol-capabilities.test.ts`. The real
client/server E2E is un-skipped and proves local control-socket approval reaches
the kernel as `task.approval_resolved` before progress.

### Adjacent fixture consumer

`packages/client/src/__tests__/agent-home-projection.test.ts` was adapted to the
async façade and long-poll-only fixture. Its exact-completion redelivery case is
the fifth Gap 1 guard: it remains explicitly skipped until Step 4 repairs the
read/ack boundary, rather than timing out the full client suite.

### Root-build blocker — approval projection authority

The first frozen root build exposed an adjacent type regression from the
already-landed kernel approval timeline: `ApprovalTimelineEvent.resolvedBy`
admits both `local` and `host`, while `ApprovalProjectionItem.resolvedBy` still
admitted only `local`. The façade now records host decisions on that one durable
timeline, so hiding `host` at the UI projection would either fail compilation or
misstate authority. The bounded blocking fix widens only the projection type to
`'local' | 'host'` and adds a test proving a host rejection remains attributed
to `host`; no compatibility path or semantic translation was added.

### Root-test blocker — deleted nonce-domain former site

The frozen root test then found `packages/core/src/__tests__/pairing.test.ts`
still opening the deleted `packages/server/src/auth.ts` as one of three former
nonce-domain definition sites. That guard is about surviving re-export sites;
the façade fold deleted the server auth module whole. The approved bounded fix
removes only that nonexistent path from the list, while the client and cloud
sites remain checked for both no local declaration and the core re-export.

## 2c-kernel: `task.decline` terminal result

Closes the one blocking gap reported by 2c above. Fixed in the kernel, which is
the single authority for what a terminal is; the façade was not touched.

### What the pre-fold hub recorded

`git show origin/main:packages/server/src/hub.ts` — `onDecline` ended with

```ts
this.applyOrFail(taskId, 'Failed', {
  result: { state: 'Failed', reason: payload.reason, retryable: payload.retryable },
});
```

So the hub did record a result for a decline: `Failed`, the decline reason, and
the device's own `retryable` passed through verbatim — not a hardcoded `true`.
That matters: `TaskRunner.decline()`
(`packages/client/src/daemon/task-runner.ts:3588`) always sends an explicit
`retryable`, and its ~20 call sites send both values (`agent home busy` → `true`,
`policy rejected` / `invalid AgentRef` / `strict Agent-only daemon` → `false`).

### What the kernel records now

- `packages/cloud/src/inbound.ts:551` — the `task.decline` branch calls
  `recordTerminal(stores, taskId, envelope, 'failed')` instead of a bare
  `recordStatus({ status: 'failed' })`. Same receipt key
  (`task:<id>:terminal`), same first-terminal-wins rule, same cancellation
  precedence, same board projection as `task.complete`/`task.fail`/
  `task.cancelled`. The attempt status is still `failed`; no new status and no
  new terminal state name were introduced.
- `packages/cloud/src/inbound.ts:664` — `recordTerminal`'s `terminalCause`
  now also covers `task.decline`, so a declined attempt carries its reason the
  same way a failed one does (strictly more information on the attempt row; no
  semantics changed).
- `packages/cloud/src/terminal-result.ts:101` — `projectTerminalResult` gained
  a `case 'task.decline'` projecting `{ state: 'failed', reason, terminalCause,
  retryable? , agentRef? }`. `retryable` is copied verbatim when present and
  left ABSENT when the decline omitted it, exactly like the `task.fail` arm —
  the projection never decides on the device's behalf that a decline is
  retryable. This is the one deliberate deviation from the dispatch's suggested
  `retryable: true`: the payload field is the device's authority (protocol
  `TaskDeclinePayloadSchema`, `retryable?: boolean`), the hub passed it through,
  and hardcoding `true` would silently overwrite a device that said `false`.

`readTaskResult` and `readTerminalReceipt` both return it with no change of
their own — they read the same receipt key.

### Tests

`packages/cloud/src/__tests__/task-decline-terminal.test.ts` (new, 6 cases, all
through the real inbound gate and the real `ByokCloud` read model, no
hand-written receipt):

1. decline → `readTaskResult` is `{ state: 'failed', reason, terminalCause,
   retryable: true }`, attempt status `failed`, `readTerminalReceipt` defined,
   no summary/sessionRef/artifactRefs.
2. `retryable: false` survives verbatim.
3. a decline that omits `retryable` leaves the key absent, never synthesized.
4. decline then late `task.complete` → result and status unchanged.
5. complete then late decline → result and status unchanged.
6. a replayed decline with a new envelope id (dedup does not catch it) leaves
   the first decline's reason and retryable in place.

Verification: `bun run --cwd packages/cloud typecheck` clean;
`bun run --cwd packages/cloud test` 35 files / 312 tests passed;
`bun run --cwd packages/conformance test` 4 files / 156 tests passed.

## 2d-server-1 — twelve kept server suites migrated to long-poll

Scope: `test-support.ts`, the façade sources, and twelve `.test.ts` files
(`auth`, `bearer-instance-product`, `tenant-pairing-isolation`,
`authenticated-enrollment-tenant-projection`, `blob`, `dispatch-selection`,
`toolset-dispatch`, `strict-agent-only`, `task-claim-runtime`,
`steer-runtime-capability-gate`, `issues-112-120-security-reliability`,
`integration`). `coordination-characterization.test.ts` was read but not edited
and stays 10/10.

### Result

`bun run test -- <the twelve> coordination-characterization` -> **13 files, 86
passed, 9 skipped, 0 failed**. `npx tsc --noEmit` reports nothing for any file
in this scope (façade sources included).

| File | passed | skipped |
|---|---|---|
| `auth` | 5 | 0 |
| `bearer-instance-product` | 2 | 2 |
| `tenant-pairing-isolation` | 10 | 2 |
| `authenticated-enrollment-tenant-projection` | 3 | 1 |
| `blob` | 9 | 0 |
| `dispatch-selection` | 4 | 0 |
| `toolset-dispatch` | 5 | 0 |
| `strict-agent-only` | 2 | 0 |
| `task-claim-runtime` | 4 | 0 |
| `steer-runtime-capability-gate` | 15 | 0 |
| `issues-112-120-security-reliability` | 5 | 2 |
| `integration` | 12 | 2 |
| `coordination-characterization` (untouched) | 10 | 0 |

No file in this scope imports `ws` any more, and no `setTimeout` is used as a
completion signal anywhere in it: `POST /byok/messages` applies its envelopes
inside the request, so an awaited send IS the barrier.

### Helpers added to `test-support.ts` (all additive; existing signatures stable)

- `pairFakeDaemon` now also returns `tenantId: TenantId`, branded from the
  `POST /byok/pair` response. That response is the ONLY public way to learn the
  one tenant an embedded server serves; the fixture deliberately does not
  re-derive it from `productId` (that derivation is the façade's).
- `FakeLongPollDaemon` gained `tenantId` and `identity` (so a test can re-sign a
  later challenge without threading the identity separately).
- `sendOne(daemon, envelope)` -> `{status, body}`.
- `nextEnvelope(daemon)` — one envelope at a time off the long-poll transport,
  buffering the page remainder in a `WeakMap` keyed by the daemon; throws rather
  than hanging when the hold window closes empty.
- `expectNoMoreEnvelopes(daemon)` — buffer empty AND a full poll returns `[]`.
- `claimAndStart(byok, daemon, handle, runtime?, capabilities?)` — LIFTED from
  Step 0's `claimAndStartOverLongPoll`; the Step 0 file keeps its own copy on
  purpose (a frozen pin must not depend on a shared fixture that can drift).
- `moveToAwaitApproval(byok, daemon, handle, opts?)`.
- `announceHello(daemon, opts)` — re-publish `conn.hello`; the long-poll
  equivalent of "the same device reconnects advertising something different".
- `waitFor(check, timeoutMs?)` — bounded poller, same shape as Step 0's.

### Façade fixes (all in `packages/server/src/`)

1. **`pairing.createPairingCode` is now `async`** (`index.ts`). Its declared
   contract is `Promise<PairingCodeInfo>`, but the cross-product guard THREW
   synchronously, so no `await`/`.catch()` caller of a promise-returning method
   could handle the refusal. Same guard, same message, now on the same channel
   as every other failure of the method.
2. **`devices.revoke(deviceId)`** — orchestrator ruling (from the 2c
   smoke-script worker): the tenant-first signature was uncallable from outside
   the package (`TenantId` is a branded type an embedder cannot mint, and
   nothing on `ByokServer` / `MachineInfo` / `PairingCodeInfo` hands one back).
   The façade binds its one tenant internally; the scoping is unchanged, just
   not the caller's to state. `index.ts` interface + implementation updated.
3. **`TaskHandle.events()` ends at the terminal** — orchestrator ruling. The
   relay now CLOSES the per-task queue immediately after pushing the terminal
   `{kind:'state'}` event (`relay.ts` `#transition`); `#scheduleReclaim` only
   deletes the map entry afterwards. Closing does not empty the buffer
   (`event-queue.ts`), so a late subscriber inside the retention window still
   replays from 0 and then ends. `taskEventRetentionMs` is memory reclamation
   only and must never be what terminates an iterator; its doc comment in
   `types.ts` now says so. New pin: `integration.test.ts` "events() ends at the
   terminal, not when the retention window expires" runs with
   `taskEventRetentionMs: 60 * 60_000`, so the only thing that can end either
   iteration (one live, one subscribed after the terminal) is the close.
4. **`SteerRejectedError.code` is `task_terminal` whenever this surface's own
   state is terminal** (`task-handle.ts`, new `refusalCode`). Exposed by
   `steer-runtime-capability-gate`'s "a terminal task is task_terminal, NOT
   task_not_running". After `handle.cancel()` the kernel's attempt is
   `cancel_requested`, which `steer-control.ts` documents as LIVE ->
   `task_not_running`; the façade calls an accepted host cancellation terminal
   immediately (`snapshot.ts` gate 1, Step 0 case 4). The error was therefore
   self-contradictory: `state: 'Cancelled'` with `code: 'task_not_running'`.
   The fix reads nothing from the kernel's `status` — it applies the kernel's
   own documented "terminal first" precedence to the one `TaskState` already
   being put on the error.

### Per file — what changed, and every deleted or skipped `it`

**`auth.test.ts`** (5/5). `TEST_TENANT_ID` replaced by the pair response's
tenant; `createPairingCode` awaited; then `devices.revoke(deviceId)` per the
ruling. DELETED: the WS half of "revoking a device 401s its next challenge,
token, WS, and authed-HTTP calls" (surface 3, the `ws://…/byok/ws` upgrade) —
WS transport, deleted in 2b. The case keeps challenge + token + authed HTTP and
gains `POST /byok/messages` as a fourth authed-HTTP surface, so the same number
of live surfaces is probed.

**`bearer-instance-product.test.ts`** (2 passed / 2 skipped). Rebuilt on the
public surface; `../auth` is gone.
- SKIPPED `refuses a cross-product device on every bearer-authed route`
  (`// 2d gap:`) — a cross-product device ROW can no longer be brought into
  existence here: `createPairingCode` fails closed on a foreign product before a
  code exists, and pairing is the only enrollment path. The bearer-time check is
  the kernel's and is covered by
  `packages/cloud/src/__tests__/bearer-instance-product.test.ts`.
- SKIPPED `answers a cross-product token and a garbage token identically`
  (`// 2d gap:`) — same missing input. The "every auth failure answers
  identically" property is still pinned by `tenant-pairing-isolation`'s
  no-existence-oracle case.
- DELETED `fails at authenticateBearer itself when the row disagrees with the
  instance` — drove `DeviceRegistry` / `mintAccessToken` / `authenticateBearer`
  from `../auth`, a module deleted in 2b. Its subject moved to
  `packages/cloud/src/auth/bearer.ts` and is covered by cloud's own suite.
- KEPT and rewritten: the same-product device on all three routes; plus the
  mint-time refusal (`createPairingCode` for a foreign product), which is where
  this package's half of the S1 product boundary now lives.

**`tenant-pairing-isolation.test.ts`** (10 passed / 2 skipped). One tenant per
server, so codes no longer name one; forged token CLAIMS are still the way to
name a foreign tenant, which keeps the whole I5 matrix alive.
- DELETED assertion, inside "lands a redeemed device in the code's tenant":
  `devices.revoke(TENANT_B, deviceId)` is a no-op. `revoke` takes only a device
  id now, so the foreign-tenant input does not exist. "and in no other tenant"
  stays pinned by the forged cross-tenant token case in the same file.
- SKIPPED `keeps two devices paired under different tenants independent`
  (`// 2d gap:`) — needs two tenants enrolled into one instance; covered at the
  port level by `packages/conformance/src/cloud/pairing.ts`.
- SKIPPED `refuses the upgrade for a device row outside the instance product,
  before any hello` (`// 2d gap:`) — cross-product row unconstructible (as
  above) AND the WS upgrade is deleted.
- DELETED: the `expectUpgradeRejected(...)` WS half of "rejects a token whose
  tenant does not own the device", of "rejects a token whose product disagrees
  with the device row", and of "refuses challenge, token, and connect for a
  revoked device" (that one renamed to `…and authed HTTP`, probing
  `POST /byok/messages` instead). WS transport.
- REWRITTEN: `accepts a hello whose productId matches the device row` now goes
  through `connectFakeDaemonLongPoll` (which fails loudly unless the server
  accepted the announcement) and asserts `machines.list()` shows the device
  connected. ADDED alongside it, replacing the deleted WS hello gate:
  `refuses a hello whose productId disagrees with the device row` — the same I9
  subject on the surviving transport (`{accepted: 0, rejected: 1}`).

**`authenticated-enrollment-tenant-projection.test.ts`** (3 passed / 1 skipped).
- SKIPPED `rejects malformed and oversize tenant claims before a response can be
  emitted` (`// 2d gap:`) — `createPairingCode` has no `tenantId` input, so a
  malformed tenant CLAIM has nowhere to arrive; the mint-point validation is
  core's `tenantId()`.
- REWRITTEN: case 1 proves "row's tenant, not the request's" by comparing
  against a second enrollment redeemed with no tenant in the request at all;
  case 2 ("two codes, different tenants") uses two instances, which is what two
  tenants now means. ADDED: the mint refuses a foreign product — the reason a
  single instance can no longer straddle two tenants.

**`blob.test.ts`** (9/9). Only `await` on `createPairingCode`, plus two changes
in the round-trip:
- REWRITTEN setup: `finalize` under a "different-key" now declares a REAL second
  reservation first. The kernel separates the two refusals — an idempotency key
  naming NO reservation is `404 storage_reservation_not_found`, a key bound to a
  DIFFERENT reservation is `422 storage_integrity_mismatch` — so the original
  422 is asserted on the setup that actually means "wrong binding".
- DELETED assertion: re-`PUT`ting the identical bytes to a finalized blob is
  `422`. The kernel's content proxy validates size + sha256 on every write
  (`stores/in-memory/blobs.ts`), so an identical re-PUT is an idempotent retry
  (204) and no bytes can ever change; the pre-fold blanket refusal of a retry is
  gone. Immutability against DIFFERENT bytes is still covered by the
  hash-mismatch and size-mismatch cases in the same file, and "no second write
  GRANT" by `packages/conformance/src/cloud/blobs.ts`.

**`dispatch-selection.test.ts`** (4/4). Long-poll.
- DELETED assertions on the pruned `TaskSnapshot.runtime`: `tasks.get(id)
  ?.runtime === 'pi'` in the first case. "Derives the requested runtime" stays
  pinned where it is observable — `offer.payload.runtime`.
- `tasks.list()` -> `(await tasks.list()).tasks`.

**`toolset-dispatch.test.ts`** (5/5). Long-poll.
- DELETED assertion on the pruned `TaskSnapshot.requiredToolsets`:
  `tasks.get(id)?.requiredToolsets` in the first case. The offer payload
  assertion (`offer.payload.requiredToolsets`) is unchanged and is what "persists
  only logical ids" is actually about, together with the no-command/args/secret
  serialization check.

**`strict-agent-only.test.ts`** (2/2). Long-poll; `nextEnvelope(daemon)`.
Title reworded from "TaskStore/outbox" to "task store/mailbox" (both classes
deleted). No assertion changed.

**`task-claim-runtime.test.ts`** (4/4). Long-poll.
- DELETED assertions on the pruned `TaskSnapshot.runtime` (the REQUESTED
  runtime): `?.runtime` before and after the claim in the first two cases. Both
  cases survive as distinct pins — one dispatch with no requested runtime, one
  with — for `claimedRuntime` being recorded from the claim alone. The header
  comment now says why the "requested field untouched" half has no field left.
- The last case additionally asserts the event's `claimedRuntime` equals the
  snapshot's (strengthened, not loosened).

**`steer-runtime-capability-gate.test.ts`** (15/15). Long-poll throughout.
- DELETED assertions on the pruned `HubStats.envelopesOut` — both halves of
  `expectNoSteerSent`'s `stats().envelopesOut` check. The ordering claim (the
  very next envelope after `cancel()` is that cancel) is kept and is the half
  that can actually catch a steer that was built.
- DELETED sub-suite: `describe.skipIf(!sqliteReady)('… survives a
  SqliteTaskStore roundtrip')`, both cases. `SqliteTaskStore` and the
  `taskStore` option are deleted (2b); persistence of the claim snapshot is
  Step 3's, to be re-asserted by running the conformance suites against the
  SQLite composition rather than as a server unit test.
- REWRITTEN: "a reconnect advertising a DIFFERENT capability set…" ->
  "a re-announcement…", using `announceHello` (there is no socket to drop), with
  an added `machines.list()` check proving the discovery block really was
  replaced before the frozen-snapshot assertion runs.

**`issues-112-120-security-reliability.test.ts`** (5 passed / 2 skipped).
- `#112` KEPT. Two assertion changes, both recorded: the fixture-authored
  `tenantId: 'tenant-test'` is replaced by "names a tenant, and the SAME one on
  every retry" (the tenant is derived now, not fixture data); and the
  conflicting re-redemption is `401`, not `409`, because the kernel deliberately
  collapses unknown / expired / already-used into one 401 with one message
  (`packages/cloud/src/handlers/auth.ts` header) so a pairing code cannot become
  an oracle. What #112 is about — immutability of the completion — is now
  asserted directly: after the conflicting attempt, the ORIGINAL key still
  returns the original `deviceId`.
- `#114` first two KEPT unchanged. SKIPPED the third, `enforces the deployment
  ceiling even for a previously-reserved capability URL` (`// 2d gap:`): it
  built a `LocalDiskBlobStore` outside the server and passed it as
  `blobStore`, both deleted, and a running instance's `maxBlobSizeBytes` cannot
  be lowered, so a URL reserved above the current ceiling is unconstructible.
- SKIPPED `#115 makes a disclosed foreign blob id indistinguishable from
  missing` (`// 2d gap:`) — needs two tenants on one instance; its second half
  drove `LocalDiskBlobStore` directly. Covered by
  `packages/conformance/src/cloud/blobs.ts`.
- DELETED `#115 persists SQLite tenant ownership across restart` —
  `SqliteBlobStore` deleted in 2b; Step 3 owns SQLite.
- `#116 returns an explicit long-poll replay-gap failure` KEPT but REWRITTEN:
  the trigger is a retention sweep (`byok.mailbox.collectRetired`), not 501
  dispatches. The count-bounded replay ring that made volume move the floor is
  deliberately not rebuilt — Step 0 case 7's re-pin, packet §5 item 7. The
  asserted answer (`409` + `{error:'cursor_too_old', recoverableFrom}`) is
  byte-identical to the original.
- DELETED `#116 closes a reconnect before conn.ack when its cursor predates the
  recoverable floor` — WS close-code 1008 on the deleted transport.
- DELETED `#117 makes an A -> B takeover stale A inbound frame inert` — live
  socket takeover; there are no sockets and no per-device registration to take
  over.
- DELETED `#118 times out an authenticated socket that never presents
  conn.hello` and `#118 rejects an excess pending hello and a post-hello
  oversized frame without hub mutation` — the hello-timeout, pending-hello and
  oversized-frame sub-suites named in the brief; all three options
  (`webSocketHelloTimeoutMs`, `maxPendingWebSockets`,
  `maxWebSocketPayloadBytes`) are deleted, and the second also read the pruned
  `stats().envelopesIn` around a frame that no longer exists.
- `#120` KEPT, over long-poll, with `agentMessage.consume` in the kernel's async
  shape. The `setTimeout(25)` is gone: the `POST /byok/messages` response is the
  barrier.

**`integration.test.ts`** (12 passed / 2 skipped).
- DELETED `rejects the WS upgrade with a bad bearer token` — WS transport; the
  HTTP equivalent is pinned in `tenant-pairing-isolation`.
- DELETED `device disconnect mid-task does not fail it — task state survives for
  redelivery on reconnect (M1, §9)` — waited on `device.disconnected`, an event
  deleted with the live registration (WP3B §1.2 option A), and reconnected over
  WS. Named in the brief.
- DELETED the whole `describe('WS handshake rejection gates close with code 1002
  (M0 gatekeeper finding #1)')` — three cases (unsupported protocol version,
  productId mismatch, deviceId mismatch). WS handshake, named in the brief. The
  productId-mismatch subject is re-pinned on long-poll in
  `tenant-pairing-isolation` ("refuses a hello whose productId disagrees with
  the device row").
- REWRITTEN `redelivery after reconnect (§9)` -> `redelivery from a stale cursor
  (§9)`: there is no reconnect, so the resync is `GET /byok/events?cursor=<stale>`.
  The assertion is stronger than the original — the whole page is compared as an
  ordered list (`task.steer` for task1 then task2's exempt `task.cancel`, and
  nothing else), which replaces the original's `Promise.race` against a 200ms
  timer.
- SKIPPED `a task.decline arriving after the task was already claimed is a stale
  no-op` (`// 2d gap:`) and `task.started arriving before any claim forces the
  task to Failed (Offered -> Running is illegal)` (`// 2d gap:`). Both are rules
  of the deleted execution FSM (`IllegalTaskTransitionError`), which ADR-028
  removes from the coordination plane on purpose — the kernel records the coarse
  status an envelope reports and never force-fails a task for arriving out of
  order. Exactly the family 2b's conformance-coverage skim classified as "(A)
  the concept is deleted; there is nothing to cover — No action". The second one
  additionally hangs (`result()` never settles, no terminal is ever recorded),
  which is why it is skipped rather than left red.
- `seq` re-pinned: the first `task.offer` is `seq === 1`, not `2`. There is no
  `conn.ack` ROW over long-poll — the announcement is answered by the
  `POST /byok/messages` response — so the shared per-device counter (§1.2) starts
  at the offer. The pin that `seq` is one counter across all server->daemon types
  is unchanged.
- `await_approval -> approve` now reports an `approvalId` on
  `task.await_approval` (the current daemon shape, M5). See the escalation
  below for the pre-M5 no-id path it no longer covers.
- The two stale-terminal cases dropped their second-task ordering marker (the
  send's own response is the barrier) and keep the `state` + `result` +
  `warnSpy` assertions. NOT asserted: whole-snapshot equality — a stale
  `task.cancelled`/`task.fail` still bumps the attempt's `updatedAt`, which the
  original never claimed it did not.
- ADDED (orchestrator ruling 2): `events() ends at the terminal, not when the
  retention window expires`.

### Resolved — the pre-M5 (no `approvalId`) host approval

`TaskHandle.approve()` on an approval the daemon reported WITHOUT an
`approvalId` leaves `tasks.get().state === 'AwaitApproval'` forever, while
`events()` already reports `Running` — the two readers disagree. Cause: the
façade records the host decision on the durable approval timeline
(`recordHostApproval`), and cloud's `ApprovalTimelineEventSchema` requires a
non-blank `approvalId` on `approval_resolved`, so there is nothing to write.
This is 2a's recorded "narrow known hole", and it is now visible as lost
coverage: `integration.test.ts`'s approve case had to report an `approvalId` to
exercise the resume path at all.

The repair lives in the cloud timeline authority: `approval_resolved.approvalId`
is optional for this exact pre-M5 case, `recordHostApproval` appends an id-less
host resolution, and `pendingApproval` clears the id-less slot without any
synthetic identity. UI projection exposes the request and resolution as
separate `unpaired-request` / `unpaired-resolution` items. The previously
skipped published-surface guard is enabled and green.

## Deviations From Plan Or Spec

- See `2a` -> Deviations above (10 items), and the two escalated Step 0 cases.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| ... | ... | ... |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## 2026-09-04 takeover closeout

The three D4 gaps are closed at their single authorities:

- `task.decline` records a durable `failed` terminal result in
  `packages/cloud/src/inbound.ts`; `TaskHandle.result()` only reads it back.
- `devices.revoke(deviceId)` binds the façade's derived tenant internally.
- `TaskEventRelay` closes the per-task queue immediately after publishing a
  terminal event; `taskEventRetentionMs` only reclaims the retained entry.

Two adjacent authority gaps were also made explicit and covered:

- Cloud advertises `approval_resolved`, so a daemon may report a locally
  resolved approval. Pre-M5 id-less host resolutions are stored id-less on the
  cloud timeline and projected by UI runtime as an unpaired resolution; no
  synthetic approval identity is invented.
- The deleted `packages/server/src/auth.ts` is no longer listed as a surviving
  pairing-definition site by core's source-authority guard.

The control-socket smoke initially failed on a second invocation because its
temporary directory was fresh but its OS credential authority was keyed by the
fixed `wp3b-smoke` product id. The script now gives each run a unique product id
and explicitly unpairs before teardown. The unchanged validation command is
therefore repeatable and passed on the next run.

Final frozen-source evidence:

- `bun run build` — pass.
- `bun run typecheck` — pass (including `examples/basic`).
- `bun run test` — pass; client 1607 passed / 16 skipped, cloud 316 passed,
  server 187 passed / 20 skipped, all remaining workspaces green.
- `bun run --cwd packages/server test` — 187 passed / 20 skipped.
- `bun run --cwd packages/client test` — 1607 passed / 16 skipped.
- `bun run check:api-surface` — all 9 goldens match.
- `bun run check:version-authority` — pass.
- `node packages/client/scripts/control-socket-check.mjs wp3b-smoke` — pass,
  including service-identity pair, live status, shutdown, and credential clear.
- `node packages/client/scripts/ipc-smoke.mjs` — pass.
- `node packages/client/scripts/adapter-task-smoke.mjs` — pass. Its one
  post-server-close long-poll warning is the already-deferred Step 4
  `LongPollClient.stop()` abort gap, not a failed assertion.

### First gate findings and owner ruling

The first exact-subject gate returned FAIL on two items:

1. `AsyncEventQueue` used an array index as each subscriber cursor while
   overflow mutated the array with `splice(0, ...)`. A live subscriber that had
   consumed index 0 could therefore wait forever at index 1 after the retained
   buffer shifted back to length 1, missing later events including terminal.
   The queue now gives buffered entries monotonic sequence numbers; a lagging
   subscriber advances to the retained head after receiving its one truncation
   marker. The marker is queue metadata rather than a capacity-consuming event,
   so late subscribers also receive `events_truncated` followed by the retained
   terminal. New tests cover live overflow, late terminal replay, and repeated
   overflow with exactly one marker per subscriber.
2. The plan still described all ten Step 0 cases as `await`/`.tasks`-only even
   though case 7 had been re-pinned to the kernel mailbox. The owner explicitly
   approved the narrow amendment on 2026-09-04: case 7 alone may assert that
   read does not ack, ack is irreversible, and expiry advances the recoverable
   floor. The other nine cases remain byte-identical apart from async
   adaptation. This amendment does not authorize a façade replay ring or any
   second mailbox authority.

Focused post-fix evidence: `event-queue.test.ts` plus `integration.test.ts` —
15 passed / 2 skipped; server typecheck and `git diff --check` passed.

The owner also approved aligning the frozen Acceptance Policy reviewer from
`Claude` to `Codex` on 2026-09-04. This matches the plan's declared gatekeeper
route and the reviewer that actually inspected the exact subject; it does not
authorize a Claude review, push, PR, or merge.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
