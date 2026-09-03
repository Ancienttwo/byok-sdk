# Implementation Notes: wp3b-step1-kernel-increments

> **Status**: Active
> **Plan**: plans/plan-20260903-1330-wp3b-step1-kernel-increments.md
> **Contract**: tasks/contracts/20260903-1330-wp3b-step1-kernel-increments.contract.md
> **Review**: tasks/reviews/20260903-1330-wp3b-step1-kernel-increments.review.md
> **Last Updated**: 2026-09-03 14:30
> **Lifecycle**: notes

## Design Decisions

## Sub-step 1e — instance-product bearer (GAP-6)

Commit `1df290f` — `feat(cloud): optional instanceProductId enforced in authenticateBearer`

Files touched:

- `packages/cloud/src/auth/bearer.ts` — `BearerAuthDeps.instanceProductId?: string`; the new check sits AFTER the existing row==claims check.
- `packages/cloud/src/cloud.ts` — `ByokCloudOptions.instanceProductId?: string`, spread into the single `deviceRouteDeps.bearer` object every device route shares.
- `packages/cloud/src/composition/in-memory.ts` — option passthrough so a composition (and the test harness) can declare it.
- `packages/cloud/src/__tests__/bearer-instance-product.test.ts` — new, 7 tests.

Decisions:

- **Two authorities, not a check plus a fallback.** Absent `instanceProductId` is the multi-product hosted shape, where the device row is the whole product authority; present is the single-product (embedded) shape. Neither is a degraded version of the other, so nothing infers one from the other.
- **Compared against `claims.productId`, not `device.productId`.** The check runs after `device.productId !== claims.productId` has already refused any disagreement, so at that point the two are provably equal and the comparison is the same comparison either way; it is written against the claims because "this token was minted for another product" is what it means. `packages/server/src/auth.ts:404-405` writes the same pair against the row.
- **Same `undefined` as every other failure.** An instance mismatch is indistinguishable from unknown/wrong-tenant/revoked, so a 401 never becomes an oracle for which product an instance serves. Asserted directly (`answers a cross-product token and a garbage token identically`).
- Rejection *shape* therefore stays `{ error: 'unauthorized' }`, 401, on every bearer-authed route — no new code, no new body.

Falsifier run: with the new condition forced to `false`, 2 of the 7 new tests go red (`1 failed (1) / 2 failed | 5 passed (7)`); restored immediately.

Command tails:

```
bun run build            -> byok-sdk build: Exited with code 0
bun run typecheck        -> 15 packages, 0 errors
bun run test             -> cloud 31 files / 284 tests; server 37 files / 289 tests; all packages green
git diff --check         -> clean
git diff --stat origin/main..HEAD -- packages/server  -> empty
```

## Sub-step 1a — approveTask / rejectTask (GAP-1)

Commit `52e965f` — `feat(cloud): approveTask/rejectTask with StaleApprovalError`

Files touched:

- `packages/cloud/src/approval-control.ts` — new. `StaleApprovalError` (moved from `packages/server/src/hub.ts:380`, defined here; server untouched) and `pendingApproval(tail)`.
- `packages/cloud/src/errors.ts` — new code `task_not_awaiting_approval`.
- `packages/cloud/src/cloud.ts` — `ApproveTaskOptions`/`RejectTaskOptions`, `ByokCloud.approveTask`/`rejectTask`, private `resolveApproval`, predicate `isTerminalAttemptStatus`.
- `packages/cloud/src/index.ts` — exports `StaleApprovalError`, `pendingApproval`, `PendingApproval`, `ApproveTaskOptions`, `RejectTaskOptions`.
- `packages/cloud/src/__tests__/approval-control.test.ts` — new, 16 tests.

### The pending-approval derivation rule (the load-bearing decision)

The server keeps one mutable slot per task (`TaskSnapshot.pendingApprovalId`). Cloud adds **no store and no record**: the two observations that move that slot are already durable in the `ApprovalTimelineStore` tail, so the slot is DERIVED per call by folding the tail's entries in revision order, holding exactly one slot:

- `approval_requested` **sets** the slot, superseding whatever it held (mirrors `hub.ts:1399` — a daemon that dispatched a fresh approval has moved on, and the newest request is what an operator is being asked about).
- `approval_resolved(X)` **clears** the slot when the slot's id is `X`, or when the slot has no id at all (a pre-M5 daemon reported none, so the resolution can only be about the single outstanding request). A resolution naming some other id is about an already-superseded approval and leaves the current slot standing (mirrors `hub.ts:1569`).

Two ways nothing is pending: no unresolved request on the tail, or no tail at all — it is a bounded, TTL'd ring, not a permanent authority. Both answer `undefined` and both fail closed. A dropped-then-expired approval is never silently approved.

### Gate order and rejection error names

Mirrors `hub.ts:2315-2360`; every gate runs in full before any mailbox row is allocated, so a refused call has zero side effects (asserted: the poll after each refusal returns 0 events).

1. no such task for this tenant -> `ByokCloudError('task_not_found')` — the same code and message shape `cancelTask` already uses (`cloud.ts:1303`).
2. nothing to resolve -> `ByokCloudError('task_not_awaiting_approval')`. **One code, three ways in**, each with its own message: terminal attempt, no unresolved request on the tail, or no `ownerDeviceId`. They are one code because the caller's remedy is identical in all three; the message says which. Checked BEFORE targeting, so it wins when both would apply (server does the same with `TaskNotAwaitingApprovalError`).
3. `opts.approvalId` given AND a pending id exists AND they differ -> `StaleApprovalError(taskId, requestedApprovalId, currentApprovalId)`. When the daemon never reported an id there is nothing to disagree with, so the call proceeds untargeted — exactly the server's `record.pendingApprovalId !== undefined` guard.

`StaleApprovalError` is a **class**, not a `CloudErrorCode`, deviating from this package's one-class taxonomy on purpose: it carries the two ids a caller needs in order to re-target, which a code cannot. This is also what the design packet §3 prescribes (that table moves `StaleApprovalError` to cloud; it does NOT move `TaskNotAwaitingApprovalError`, hence the code above rather than a second class).

Other decisions:

- **Terminal-attempt gate included.** The server's gate 2 is `state !== 'AwaitApproval'`; cloud has no such attempt status, so the equivalent fact is "the attempt is `complete`/`failed`/`cancelled`". Without it, a runtime that resolved locally and ran to completion (the implicit path, with no `task.approval_resolved` ever sent) would still show an unresolved request on the tail and accept an approve. Covered by `refuses a task that already reached a terminal, even with an unresolved request on the tail`.
- **Delivery to `TaskAttempt.ownerDeviceId`, not `deviceId`.** An approval belongs to the runtime actually paused on it, which is the claiming device; the offered device is not necessarily it. An unclaimed attempt therefore has nothing to notify and is refused rather than delivered to the offer target.
- **Outgoing `approvalId` = caller's ?? pending ?? omitted**, matching `hub.ts:2326`, so the daemon's own exact-match check can still run whenever this cloud has an id to offer at all. `reason` on reject is carried verbatim and stays absent on the wire when absent.
- **Return type is `EnqueuedAgentControl`, not `void`.** Every other cloud enqueue returns the seq + envelope, and a host that wants a delivery-position receipt should not have to re-read the mailbox. Step 2's façade can drop it.
- **No new store, no new route.** Delivery reuses the private `enqueueAgentControlEnvelope` (`cloud.ts:849`) with a fresh `messageId` per call — the wire message has always been a best-effort notification, not an idempotent command. Task approval remains absent from the HTTP route table: it is an operator action, not a device-credentialed one (`cloud.ts`'s existing comment on that).
- **`isTerminalAttemptStatus` is a predicate, not a `Set`.** `constraints.test.ts` keeps every in-process `Map`/`Set` inside a store class; a `new Set<TaskAttemptStatus>([...])` in `cloud.ts` failed that scan on the first run. The predicate needs no collection.

Command tails:

```
bun run build            -> byok-sdk build: Exited with code 0
bun run typecheck        -> 15 packages, 0 errors
bun run test             -> cloud 31 files / 284 tests; server 37 files / 289 tests; conformance 147; all packages green
git diff --check         -> clean
git diff --stat origin/main..HEAD -- packages/server  -> empty
```

### Known, out of scope

- `bun run check:api-surface` fails on `@byok-sdk/cloud` only, with an **additive-only** diff (no removed lines): `approval-control.d.ts` (`StaleApprovalError`, `PendingApproval`, `pendingApproval`), `ApproveTaskOptions`/`RejectTaskOptions`, `approveTask`/`rejectTask`, `task_not_awaiting_approval`, and `instanceProductId` on `ByokCloudOptions`/`BearerAuthDeps`. Goldens are regenerated once at the end of the slice, per the plan's T2 — deliberately not touched here.
- `packages/cloud-dataplane/src/__tests__/worker-packaging.test.ts > dry-runs wrangler deploy over worker-smoke` failed once under the full parallel run and passed on isolated re-run and on the full re-run. Pre-existing flake, unrelated to this slice; not touched.

## Sub-step 1c — `cursor_too_old` (GAP-3)

Commit `b14b6e3` — `feat(core,cloud): MailboxPage.recoverableFrom and 409 cursor_too_old`

Files touched:

- `packages/core/src/mailbox.ts` — `MailboxPage.recoverableFrom: number` (core port change; the design packet mis-cited this file as living in cloud).
- `packages/core/src/in-memory/mailbox.ts` — `#recoverableFrom(device)`; unknown device answers `1`.
- `packages/cloud-dataplane/src/stores/core/mailbox.ts` — `#recoverableFrom(tenant, deviceId)`, one extra `SELECT` issued after the page.
- `packages/cloud/src/handlers/events.ts` — the 409 gate, plus a fourth bullet in the file header.
- `packages/conformance/src/core/mailbox.ts` — 2 new cases (in-memory + Postgres run the same file).
- `packages/cloud/src/__tests__/events-cursor-too-old.test.ts` — new, 4 tests.

### The load-bearing decision: what counts as LOST

The floor is `max(seq of rows in state 'expired') + 1`, and `1` when nothing expired. Only `expired` counts.

The first implementation used "earliest retained (`pending`) row" instead, which also folds `acked` into the floor. That went red on an existing cloud assertion — `mailbox-cursor.test.ts > does not treat a cursor at or below the ack position as an ack attempt`, whose comment is explicit: *"A daemon that lost its journal and polls from zero must not crash the route with a cursor regression — and must not un-ack what it acked."* The existing behaviour is right and the first rule was wrong: a consumed row is not a lost one, and §8.3 stall recovery has a daemon re-polling from an old cursor as a normal event, not a fault.

That also matches the server exactly. `hub.ts:2505-2519` moves `recoverableFrom` only on ring **eviction** — the outbox ring never drops a row because it was acked — so "loss only" is the reference semantics, not a cloud-local softening.

Consequences worth stating:

- Retiring **acked** rows (`collectRetired`'s delete leg) does not move the floor. Pinned by conformance `leaves the recoverable floor where it is when acked rows are retired` and by the route-level `never refuses a cursor merely because the rows past it were acked and retired`.
- Expiring **unacked** rows does. Pinned by conformance `moves the recoverable floor past rows lost to expiry` and the route-level 409 test.
- Empty/never-retired mailbox → `1`, so a fresh device at cursor 0 keeps today's 200. Asserted at both layers.

### No migration (0018 stays free for 1b)

`collectRetired` **never deletes an unacked row** — §12.7.5 requires the dead letter to stay visible — so the loss is already durable in `outbox` and `MAX(seq) WHERE state='expired'` reads it directly. A stored floor column would be a second authority free to drift from the sweep that moved it. Recorded constraint for whoever implements dead-letter reaping (S4B / O-009): that change is the one that has to carry the floor forward into a column, because it is the first thing that would delete the rows this derivation reads.

### Other decisions

- **Read the floor AFTER the page** (Postgres). A sweep landing between the two reads can then only report a floor HIGHER than the page it accompanies — the caller fails closed over a page that may already be missing rows. Reading the floor first would report one too low and serve that gap silently.
- **Gate compares `cursor`, never `scanCursor`.** The handler advances `scanCursor` within a request while scanning past filtered cancelled offers; the floor is about the caller's own position.
- **Gate runs on every read inside the hold loop**, not once at entry, mirroring the server's second `assertReplayAvailable` in the hold's timeout path (`hub.ts:776`): a sweep landing mid-hold ends the hold with the 409 the caller now deserves rather than an empty 200. Zero extra queries — it rides the reads the loop already does.
- **Body is `{ error: 'cursor_too_old', recoverableFrom }`, 409**, byte-equal to `packages/server/src/http.ts:386` and inside every bound `packages/client/src/daemon/long-poll-transport.ts:567-578` checks (`Number.isSafeInteger`, `>= 0`). Client untouched.
- A 409 performs no ack; asserted directly.

Falsifier runs: forcing the route gate to `false` reds `refuses a cursor below rows lost to expiry…` (1 failed / 288); forcing the in-memory expiry branch to `false` (with core rebuilt) reds conformance `moves the recoverable floor past rows lost to expiry` (1 failed / 149). Both restored.

Command tails:

```
bun run build            -> byok-sdk build: Exited with code 0
bun run typecheck        -> 15 packages, 0 errors
bun run test             -> cloud 32 files / 288 tests; server 37 files / 289 tests; all packages green
bun run --cwd packages/conformance test -> 4 files / 149 tests
bun run check:version-authority -> byok-sdk@0.12.0, @byok-sdk/keys@0.3.9 agree
git diff --check         -> clean
git diff --stat origin/main..HEAD -- packages/server  -> empty
```

### Known, out of scope (1c)

- **The Postgres `#recoverableFrom` SQL is not runtime-verified here.** Docker is unavailable in this environment (`docker info` fails), so `BYOK_TEST_POSTGRES_URL` is unset and all 25 dataplane suites — including `core-conformance.test.ts`, the file that would run the two new conformance cases against Postgres — skip. The statement is typechecked and the in-memory sibling is green; the Postgres leg needs the substrate (`docker compose -f docker-compose.test.yml up -d --wait`) or the CI dataplane job (`BYOK_REQUIRE_DATAPLANE=1`) to be proven.
- No migration added, so `deploy/sql/0018_*` remains free for sub-step 1b as planned; `bun run check:deploy-sql` was not run (no SQL touched).

## Sub-step 1f — observer post-commit hook

Commit: this commit — `feat(cloud): ByokCloudOptions.observer.onInboundCommitted post-commit hook` (it carries these notes, so its own SHA cannot appear inside them; the handoff reports it).

Files touched:

- `packages/cloud/src/inbound.ts` — `InboundCommitted`, `ByokCloudObserver`; `handleInboundEnvelope` becomes a thin wrapper over the renamed private `applyInboundGate`; step 5 added to the file header.
- `packages/cloud/src/handlers/messages.ts` — `MessagesRouteDeps.observer?`, passed as the gate's 6th argument.
- `packages/cloud/src/cloud.ts` — `ByokCloudOptions.observer?`, wired into `messagesHandler`.
- `packages/cloud/src/composition/in-memory.ts` — option passthrough (this is how `createHarness({ observer })` reaches it).
- `packages/cloud/src/index.ts` — exports `ByokCloudObserver`, `InboundCommitted`.
- `packages/cloud/src/__tests__/inbound-observer.test.ts` — new, 9 tests.

### One exit, not seven

`handleInboundEnvelope` had ~10 `return` points. Firing from each would have to be repeated at every one and would be one edit away from firing twice or not at all, so the whole gate body was renamed to a private `applyInboundGate` and the exported function became a wrapper with a single exit that fires there. The diff is a rename plus 25 lines; no gate logic moved.

### `duplicate` does NOT fire (the decision the brief asked to record)

A `duplicate` re-ran nothing: the dedup store already held the envelope id, so no lifecycle write happened on this delivery. The wire is at-least-once (§9) and redelivery is the normal event, not the exception — a relay that fired on duplicates would count retries as work, which is precisely the over-count `TaskHandle` fan-out must not have. `rejected` and `rate_limited` wrote nothing at all. So `accepted` is the only firing outcome, and `InboundCommitted.outcome` is typed `Extract<InboundOutcome, 'accepted'>` rather than `InboundOutcome`: a consumer that could branch on values that never arrive would be reading a lie from the type.

The field is carried anyway, per the brief, because it names the fact in the gate's own vocabulary instead of leaving the reader to infer it from the hook's name.

### Other decisions

- **Synchronous, `void`, throw swallowed.** Fired after the gate returns, inside `try/catch`, with the outcome already fixed. `packages/cloud` has no logger of any kind (grepped: no `logger`, no `console.`), so the catch is silent rather than inventing a logging seam this slice did not ask for. Documented on the interface as "cheap by contract — it runs inline on the request path".
- **Async observers are out of contract.** The hook returns `void`; a consumer returning a promise that rejects would surface as an unhandled rejection in the host. Not defended against, because doing so would be defensive code for a shape the type already forbids.
- **Distinct from `agentMessage.consume`.** That one is admission: it runs BEFORE a write and decides whether the write happens. This one runs after and decides nothing. Both facts are on the `ByokCloudObserver` doc comment so the next reader cannot confuse them.
- **Batch order is notification order** because `messagesHandler` awaits one envelope's gate before starting the next. Asserted end to end over `POST /byok/messages`.
- **Tenant comes from `stores.tenant`**, the closure the route already authenticated into — the observer never sees a tenant the caller did not prove.

Falsifier runs: dropping the `outcome === 'accepted'` guard reds the three silence tests (3 failed / 297); replacing the `try/catch` with a bare call reds both throw tests (2 failed / 297). Both restored.

Command tails:

```
bun run build            -> byok-sdk build: Exited with code 0
bun run typecheck        -> 15 packages, 0 errors
bun run test             -> cloud 33 files / 297 tests; server 37 files / 289 tests; conformance 149; all packages green
bun run --cwd packages/conformance test -> 4 files / 149 tests
git diff --check         -> clean
git diff --stat origin/main..HEAD -- packages/server  -> empty
```

### Known, out of scope (1c + 1f)

- `bun run check:api-surface` fails on `@byok-sdk/cloud` and `@byok-sdk/core`, **additive-only** (0 removed lines across both diffs): core gains `MailboxPage.recoverableFrom`; cloud gains `ByokCloudObserver`, `InboundCommitted`, `ByokCloudOptions.observer`, on top of 1a/1e's additions. `@byok-sdk/cloud-dataplane` is unaffected — `#recoverableFrom` is a private method. Goldens are regenerated once at the end of the slice per the plan's T2; deliberately not touched here.

## Sub-step 1b — `claimedRuntime` + migration 0018 + `steerTask` (GAP-2)

Commit `934ad14` — `feat(cloud): TaskAttempt.claimedRuntime at claim and steerTask gated on it`

Files touched:

- `packages/cloud/src/stores/ports.ts` — `TaskAttempt.claimedRuntime?: RuntimeId` and `TaskAttempt.claimedRuntimeCapabilities?: RuntimeCapabilities`; `TaskAttemptStore.claim` takes optional `runtime`/`capabilities`.
- `packages/cloud/src/stores/in-memory/task-attempts.ts` — snapshot written inside the branch that already decides the ownership CAS.
- `packages/cloud-dataplane/src/stores/task-attempts.ts` — snapshot written by the SAME guarded `UPDATE`; two columns added to `TaskRow`, `TASK_SELECT_COLUMNS`, and `taskRowToAttempt`.
- `deploy/sql/0018_task_attempt_claimed_runtime.sql` — new, two nullable columns, no backfill.
- `tests/sql/control_plane_invariants.sql` — one header line claiming 0018 (see Deviations).
- `packages/cloud/src/inbound.ts` — the `task.claim` branch forwards `payload.runtime` / `payload.capabilities`.
- `packages/cloud/src/tenant-stores.ts` — `TenantBoundTaskAttempts.claim` widened.
- `packages/cloud/src/steer-control.ts` — new: `SteerRejectionCode`, `SteerRejectedError`.
- `packages/cloud/src/cloud.ts` — `ByokCloud.steerTask` + the private gate.
- `packages/cloud/src/index.ts` — exports `SteerRejectedError`, `SteerRejectionCode`.
- `packages/conformance/src/cloud/task-attempts.ts` — two cases (write-once snapshot; absent stays absent).
- `packages/cloud/src/__tests__/steer-control.test.ts` — new, 9 cases.

### The steer-capability source (the decision the brief asked to record)

The brief allowed either a runtime-info/capability table or the claim payload's declared capabilities, and forbade a hard-coded runtime list. Cloud has **no** capability table — `grep -rn "steer\|RuntimeCapabilities" packages/cloud/src packages/core/src` was empty before this commit — so the snapshot is **the claim payload's own `capabilities` block**, stored as `TaskAttempt.claimedRuntimeCapabilities` and read by the gate as `?.steer !== true`.

That is byte-for-byte what the reference server does (`hub.ts` `onClaim` writes `TaskSnapshot.claimedRuntimeCapabilities` from `TaskClaimPayload.capabilities`; `steerTask` reads `record.claimedRuntimeCapabilities?.steer !== true`). Two consequences worth stating:

- **`claimedRuntime` alone is not enough for the gate.** It is an id, and mapping `pi -> steerable` would be a second capability authority in the coordination plane that drifts the moment a runtime gains or loses the feature. `claimedRuntime` is still stored and carried on the error, because the operator-facing message needs to name the runtime; the DECISION reads only the capability block.
- **Fail-closed on absent.** No snapshot (a daemon predating the field, an attempt claimed before 0018) refuses under `steer_unsupported_runtime`. Unknown is not supported; guessing reintroduces the permanent redelivery-cursor stall the gate exists to prevent.

### Connection-level declarations cannot reach the gate

Cloud's analogue of `conn.hello` state is `DeviceRecord.capabilities`, written by the bearer-authenticated `conn.hello` branch in `inbound.ts`. It is never read by the gate, as a source or as a fallback. Two tests drive the two layers to disagree in both directions and assert the claim wins — the same pin as `packages/server/src/__tests__/steer-runtime-capability-gate.test.ts:129,304`:

- `conn.hello advertising steer does not flip a claim that reported steer: false`
- `conn.hello advertising steer does not open the gate for a claim that carried nothing` (also asserts nothing was harvested into the attempt)

### Gate order and error taxonomy

`task_not_found` (`ByokCloudError`, matching `approveTask`) -> `task_terminal` -> `task_not_running` -> `steer_unsupported_runtime`, all before a mailbox row is allocated; every refusal case asserts the device's next poll is empty. Two deltas from the server's shape, both deliberate:

- `SteerRejectedError.status` carries a `TaskAttemptStatus`, not the server's `TaskState` — cloud's vocabulary for the same fact. The three `code` strings are byte-identical, so a host's mapping survives the move off the embedded server.
- The "no owning device" narrowing rides `task_not_running` rather than getting a fourth code: an attempt with no owner has no runtime paused on a turn, which is what that code already says. Unreachable in practice while `running` implies a prior claim.

### Migration 0018

Two nullable columns (`claimed_runtime text`, `claimed_runtime_capabilities jsonb`), additive, **no backfill**. A task claimed before this migration has no snapshot to reconstruct, and inventing one would open the gate on a guess; NULL reads as unknown and refuses.

### Verification (1b)

```
bun run build             -> all packages, 0 errors
bun run typecheck         -> 15 packages, 0 errors
bun run test              -> cloud 34 files / 306 tests; server 37 files / 289 tests (unchanged); conformance 151; all packages green
bun run --cwd packages/conformance test -> 4 files / 151 tests
bun run check:deploy-sql  -> [deploy-sql] OK
git diff --check          -> clean
git diff --stat origin/main..HEAD -- packages/server -> empty
```

## Sub-step 1d — `TaskAttemptStore.list` keyset paging (GAP-4)

Commit — `feat(cloud): TaskAttemptStore.list keyset paging by taskId` (the commit carrying this notes update; its own SHA cannot be written into itself)

Files touched:

- `packages/cloud/src/stores/ports.ts` — `TaskAttemptListQuery`, `TaskAttemptPage`, `TaskAttemptStore.list`.
- `packages/cloud/src/stores/ports-contract.ts` — `list` added to the `tasks` method inventory.
- `packages/cloud/src/coordination.ts` — `assertTaskAttemptListLimit`.
- `packages/cloud/src/stores/in-memory/task-attempts.ts`, `packages/cloud-dataplane/src/stores/task-attempts.ts` — the two implementations.
- `packages/cloud/src/tenant-stores.ts` — `TenantBoundTaskAttempts.list`.
- `packages/cloud/src/cloud.ts` — `ByokCloud.listTaskAttempts` (pure passthrough; no unit test, per the brief).
- `packages/cloud/src/index.ts` — exports the two types and the validator.
- `packages/conformance/src/cloud/task-attempts.ts` — five cases.

### The cursor design (the decision the brief asked to record)

Keyset by **`taskId` ascending**, cursor = the last `taskId` of the previous page, used as an exclusive lower bound. Stable and total, but **not chronological**, and that is the trade:

- An attempt carries no monotonic sequence. `updatedAt` moves under an in-flight walk — a status transition re-orders rows mid-page and lets a caller skip or repeat one — so a timestamp cursor cannot give exactly-once.
- `taskId` is `task_<uuid>`: unique per tenant and never rewritten. Arbitrary order, but a total one, which is what a paged read model actually needs. A caller that wants recency sorts a page itself.
- Adding a seq column was rejected (plan P3 iii): a migration across every composition plus a second ordering authority, to serve a read-model nicety.

SQL is `WHERE tenant_id = $1 AND ($2::text IS NULL OR task_id > $2) ORDER BY task_id LIMIT $3` with `$3 = limit + 1`. The `(tenant_id, task_id)` primary key already orders exactly this way, so no new index. The extra row is what tells "page is full" apart from "there is more" without a second count query; `nextCursor` is absent on the last page, so a walk terminates on an absent cursor rather than on an empty page — a page that exactly fills `limit` with nothing after it still ends.

`limit` is a **required** positive integer, validated in the STORE (`assertTaskAttemptListLimit`, throwing `coordination_input_invalid`) rather than only at the façade, because the port is reachable directly by a host composition. `0`, `-1`, `2.5`, `NaN` all reject; nothing is defaulted or clamped.

The in-memory implementation filters on the row's own `tenantId` rather than on a key prefix, so it cannot be widened by a tenant id that happens to prefix another.

### Verification (1d)

```
bun run build             -> all packages, 0 errors
bun run typecheck         -> 15 packages, 0 errors
bun run test              -> cloud 34 files / 306 tests; server 37 files / 289 tests (unchanged); conformance 156; all packages green
bun run --cwd packages/conformance test -> 4 files / 156 tests
bun run check:deploy-sql  -> [deploy-sql] OK
git diff --check          -> clean
git diff --stat origin/main..HEAD -- packages/server -> empty
```

### Known, out of scope (1b + 1d)

- **The Postgres leg is UNVERIFIED locally.** `docker info` fails on this machine, so all 25 `@byok-sdk/cloud-dataplane` suites skip and the cloud conformance suite ran on the in-memory composition only. What was actually verified for `PostgresTaskAttemptStore`: it typechecks against the port, and the SQL was written against the existing `task` DDL (`deploy/sql/0001_cloud_local.sql`) plus migration 0018. The claim-snapshot `UPDATE`, the `jsonb` round trip, and the keyset `list` have NOT been executed against a real Postgres here — they need the dataplane suite in CI.
- `bun run check:api-surface` still fails additively on `cloud`, `core`, and now `cloud-dataplane` (`TASK_SELECT_COLUMNS` is exported, so its literal type changed). Goldens are regenerated once at the end of the slice per the plan's T2; `api-surface/**` deliberately untouched here.

## Deviations From Plan Or Spec

- **1c adds no `deploy/sql` migration** (the brief allowed one "if the dataplane store needs schema to know the floor"). It does not: dead-lettered rows are retained by contract, so the floor is derivable from `outbox` alone. `0018_task_attempt_claimed_runtime.sql` therefore remains sub-step 1b's number and the next worker uses 0018, not 0019.
- **1b edits `tests/sql/control_plane_invariants.sql`, which is NOT in the contract's `allowed_paths`.** One line, forced: `check-deploy-sql-order` refuses any migration that is not claimed in that file (`SQL migration must be referenced by tests/sql/control_plane_invariants.sql`), and the contract's own exit criteria require both `deploy/sql/0018_task_attempt_claimed_runtime.sql` to exist and `bun run check:deploy-sql` to pass. The two are only jointly satisfiable there. Shape follows the precedent for a nullable-column migration (`0006_device_presence_toolsets.sql`): a header claim line, no new `DO $$` assertion — and deliberately no unverifiable assertion, since Postgres cannot run locally.
- **1b stores a second field, `claimedRuntimeCapabilities`, alongside `claimedRuntime`.** The contract names only `claimedRuntime`, but the gate's authority is the capability block, not the runtime id; the alternative — a hard-coded `pi -> steerable` table — was explicitly forbidden. Reasoning under Sub-step 1b.
- **1c's floor semantics are loss-only, not retention-only.** The brief phrased the floor as "lost rows to retirement/expiry"; retirement of *acked* rows is excluded, because counting it contradicts both the reference server (`hub.ts` moves the floor on eviction only) and an existing cloud assertion. Reasoning under "The load-bearing decision" above.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| ... | ... | ... |

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
