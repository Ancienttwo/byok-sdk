# Hosted Host contract (Topology H)

Use this contract when a product runs its Host in the cloud.
The Host calls `createByokCloud` from `@byok-sdk/cloud` on Cloudflare Workers.
It uses the stores from `@byok-sdk/cloud-dataplane/runtime`. The daemon stays on the device.
Section 1 of the [Host execution core guide](host-execution-core.md#1-ownership-and-topology) defines Topology L and Topology H.
The intent, FIFO, generation and retry rules of that guide also apply here.
This contract adds the hosted rules: readback, rescan, wake, message consume, idle cost and retention.

This document states current behavior. It does not promise a release.
**Gap** marks a known open item. Section 7 lists all gaps.
Code citations use `path:line` at commit `f0455787`.

## 1. Readback decision table

Bind each product intent to one taskId before submit.
Persist the complete input before submit (`docs/host-execution-core.md:105-107`).
Then read the task with these calls:

- `readTaskAttempt(tenant, taskId)` returns the attempt.
  It has `status`, `ownerDeviceId` and the Host `cancellation` marker
  (`packages/cloud/src/cloud.ts:2340-2342`, `packages/cloud/src/stores/ports.ts:254-266`, `packages/cloud/src/stores/ports.ts:283-336`).
- `readTaskOffer(tenant, taskId)` returns the immutable offer and its `delivered` marker.
  It returns `undefined` when the attempt or the offer receipt is missing (`packages/cloud/src/cloud.ts:2317-2338`).
- `readDeviceTerminal(tenant, taskId)` returns the first device terminal:
  `task.complete`, `task.fail`, `task.decline` or `task.cancelled`.
  A Host cancellation never creates it (`packages/cloud/src/cloud.ts:758-759`, `packages/cloud/src/cloud.ts:2356-2359`, `packages/cloud/src/terminal-result.ts:16-30`).
- `readTaskResult(tenant, taskId)` returns a typed result.
  The Host cancellation marker has priority over the device receipt.
  So the result is `cancelled` as soon as `cancelTask` commits, also while the device still runs (`packages/cloud/src/cloud.ts:2377-2398`).

Read `readTaskAttempt` first. Its status selects the row. The other reads add evidence.
The intent states are example names. A product can use its own names.
It must keep the split between settled and unsettled intents.
Rows F, G, H, I and K are settled. All other rows are unsettled.

| Row | Case | `readTaskAttempt` | `readTaskOffer` | `readDeviceTerminal` | `readTaskResult` | Intent state | Host action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | Submit did not reach the store | `undefined` | `undefined` | `undefined` | `undefined` | `pending` | Resubmit the same input with the same taskId. |
| B | Attempt open, offer receipt missing | `offered` | `undefined` | `undefined` | `undefined` | `pending` | Resubmit the same input. |
| C | Offer receipt, delivered marker missing | `offered` | `delivered: false` | `undefined` | `undefined` | `pending` | Resubmit the same input. |
| D | Offer in the mailbox, not claimed | `offered` | `delivered: true` | `undefined` | `undefined` | `delivered` | Wait. At the waiting deadline, cancel. |
| E | Claimed or started | `claimed` or `running`, owner set | defined | `undefined` | `undefined` | `running` | Wait for a device terminal. |
| F | Device completed | `complete` | defined | `task.complete` | `state: 'complete'` | `succeeded` | Apply the outcome. |
| G | Device failed | `failed` | defined | `task.fail` | `state: 'failed'`, `reason`, `retryable` | `failed` | Retry only when the policy and the terminal permit it. |
| H | Device declined | `failed` | defined | `task.decline` | `state: 'failed'`, `code` | `failed` | Retry only for a busy `code`. |
| I | Host cancel before claim | `cancelled`, marker set, no owner | unchanged | `undefined`, or a late terminal | `state: 'cancelled'` | `cancelled` or `expired` | Settle now. The offer cannot run. |
| J | Host cancel after claim, no device terminal | `cancel_requested`, marker set | unchanged | `undefined` | `state: 'cancelled'` | `running` | Keep it unsettled. Wait for a device terminal. |
| K | Host cancel after claim, device terminal stored | `cancelled`, marker set | unchanged | any terminal, also `task.complete` | `state: 'cancelled'` | `cancelled` | Settle. Do not apply a success outcome. |
| L | Device revoked or lost before a terminal | unchanged | unchanged | `undefined` | `undefined`, or `cancelled` after a cancel | `unknown` | **Gap.** The product concludes the intent. |

Evidence for each row:

- **A.** Each read returns `undefined` for an unknown taskId
  (`packages/cloud/src/cloud.ts:2319-2320`, `packages/cloud/src/cloud.ts:2357-2358`, `packages/cloud/src/cloud.ts:2378-2397`).
  `cancelTask` throws `task_not_found` (`packages/cloud/src/api/task-cancellation.ts:40-42`).
- **B and C.** Submit opens the attempt first (`packages/cloud/src/cloud.ts:1148-1154`).
  Then it records the offer receipt (`packages/cloud/src/cloud.ts:1187-1201`) and appends to the mailbox (`packages/cloud/src/cloud.ts:1206-1225`).
  It writes the delivered marker last (`packages/cloud/src/cloud.ts:1239`).
  A retry with the same input finds the same offer. It does not make a second offer
  (`packages/cloud/src/cloud.ts:1144-1147`, `packages/cloud/src/cloud.ts:1170-1173`).
  `delivered: false` does not prove that the append did not happen (`packages/cloud/src/cloud.ts:499`).
  If the status is `claimed` or `running`, use row E.
- **Resubmit errors.** A different offer body fails with `coordination_input_invalid` (`packages/cloud/src/cloud.ts:1196-1201`).
  An Agent offer with a delivered marker fails with `agent_task_already_exists` (`packages/cloud/src/cloud.ts:1174-1181`).
  Then read the offer back and compare it with the frozen input (`docs/host-execution-core.md:109-115`).
- **D.** `delivered` means that the offer is in the device mailbox. It does not mean claimed (`docs/host-execution-core.md:111`).
  Use the waiting deadline steps in `docs/host-execution-core.md:123-131`.
  The `cancelTask` return value is the attempt readback. Then use row I or row J.
- **E.** A claim sets the owner and `claimed` (`packages/cloud-dataplane/src/stores/task-attempts.ts:370-378`).
  `task.started` sets `running` (`packages/cloud/src/inbound.ts:768-774`).
- **F, G and H.** The first terminal wins. A later terminal records nothing (`packages/cloud/src/inbound.ts:852-874`, `packages/cloud-dataplane/src/stores/receipts.ts:63-80`).
  A decline is a terminal. It reads back as `failed` with its `code` (`packages/cloud/src/inbound.ts:775-782`, `packages/cloud/src/terminal-result.ts:164-181`).
  The retry rules and the busy codes are in `docs/host-execution-core.md:152-157`.
- **I, J and K.** See [cancelTask](#canceltask) below.
  In row I, a late device terminal is kept as evidence. It does not change the conclusion
  (`packages/cloud/src/inbound.ts:871-874`, `packages/cloud/src/inbound.ts:884-895`).
  The daemon sends `task.cancelled` only in reply to `task.cancel`
  (`packages/client/src/daemon/task-runner.ts:2940-2951`, `packages/client/src/daemon/task-runner.ts:3150-3164`,
  `packages/client/src/daemon/task-runner.ts:4471-4520`, `packages/client/src/daemon/create-daemon.ts:2826-2834`).
  In row K, a success terminal does not authorize the outcome (`docs/host-execution-core.md:141-142`).
- **L.** See [revokeDevice](#revokedevice) and the lost device gap below.

Corrupt evidence throws. `readTaskOffer` throws `coordination_input_invalid` for an unreadable or mismatched offer receipt
(`packages/cloud/src/cloud.ts:2324-2335`).
`readTaskResult` throws `terminal_receipt_unreadable` for a body that is not a terminal envelope
(`packages/cloud/src/terminal-result.ts:111-121`, `packages/cloud/src/terminal-result.ts:195-199`).
`readDeviceTerminal` throws `terminal_receipt_unreadable` for a wrong taskId or type (`packages/cloud/src/terminal-result.ts:24-28`).
For bytes that do not decode, it throws the protocol decode error
(`packages/cloud/src/terminal-result.ts:23`, `packages/protocol/src/codec.ts:46-55`).
Do not guess a state. Keep the intent unsettled and tell an operator.

### cancelTask

`cancelTask(tenant, taskId, reason)` records the cancel and appends `task.cancel` to the device mailbox
(`packages/cloud/src/api/task-cancellation.ts:18-54`). The Postgres store does this in one transaction:

- A task that is already `complete`, `failed` or `cancelled`, with no earlier marker, is returned unchanged.
  The store writes no marker and no mailbox row (`packages/cloud-dataplane/src/stores/task-cancellations.ts:50-56`).
- Otherwise the store appends `task.cancel` and records the marker.
  The status becomes `cancelled` when no device owns the task. Otherwise it becomes `cancel_requested`
  (`packages/cloud-dataplane/src/stores/task-cancellations.ts:75-98`).
- The cancel row is exempt from the mailbox limit. A full mailbox does not block it
  (`packages/cloud-dataplane/src/stores/task-cancellations.ts:77-86`).
- A repeat call returns the same marker and mailbox row while the mailbox keeps that row
  (`packages/cloud-dataplane/src/stores/task-cancellations.ts:58-73`).
  Once the row is gone (acked and deleted by retention, reaped as a dead letter, or discarded by an operator), the attempt returns
  as it stands, in any status, with no row, and nothing is enqueued again (`packages/cloud-dataplane/src/stores/task-cancellations.ts:64-72`).
  The SQLite and in-memory stores behave the same, including the dead-letter reap; only Postgres has the operator discard.
- The call returns the attempt after the commit (`packages/cloud/src/api/task-cancellation.ts:53`, `packages/cloud-dataplane/src/stores/task-cancellations.ts:99-103`).
  Embedded `tasks.cancel` returns void (`docs/host-execution-core.md:144`).

After the marker, no claim can win (`packages/cloud-dataplane/src/stores/task-attempts.ts:377-378`).
The events route does not deliver an offer whose attempt has a marker (`packages/cloud/src/handlers/events.ts:162-171`).
A daemon that runs the task interrupts it and sends `task.cancelled` (`packages/client/src/daemon/task-runner.ts:4497-4520`).
A device terminal that arrives after the marker is kept as device evidence. The status becomes `cancelled`
(`packages/cloud/src/inbound.ts:871-874`, `packages/cloud/src/inbound.ts:884-895`).

### revokeDevice

`revokeDevice(tenant, deviceId)` calls the device directory (`packages/cloud/src/cloud.ts:2404-2406`).
The Postgres directory does this in one transaction (`packages/cloud-dataplane/src/stores/devices.ts:258-277`):

- It deletes the device row (`packages/cloud-dataplane/src/stores/devices.ts:262-265`).
- It deletes the `device_presence`, `auth_nonce`, `inbound_dedup` and `device_assertion_replay` rows of the device
  (`packages/cloud-dataplane/src/stores/devices.ts:94-99`, `packages/cloud-dataplane/src/stores/devices.ts:266-270`).
- It deletes the E2EE member state of the device: the key packages addressed to its member, its pairing MACs and its
  member key registration (#654 E2c, `DEVICE_STATE_DELETES` in `packages/cloud-dataplane/src/stores/devices.ts`).
  Machine supersession runs the same deletes. The SQLite directory does the same; the in-memory directory does not.
  The member chain is tenant history and stays. Security does not rest on this cleanup: the other members rotate.
- It keeps the `task`, `agent_egress_event`, `proof_request_receipt`, `outbox` and `device_stream` rows
  (`packages/cloud-dataplane/src/stores/devices.ts:76-84`).
- It writes no task terminal and does not change a task status.

After the revoke, the bearer token of the device fails (`packages/cloud/src/auth/bearer.ts:62-63`).
So the device cannot send a terminal for its tasks.

**Gap: lost device.** A revoked or lost device leaves its open tasks with no terminal.
All four reads stay as they are.
`cancelTask` on a claimed task of that device stays `cancel_requested`, because no device terminal arrives.
The SDK has no call that ends these attempts.
The mailbox rows of the device also stay. Under retention, its pending rows become dead letters (section 6).
Today the product concludes the intent itself, for example as `abandoned`, and records the cause.
Use a product rule: the waiting deadline, `device_offline` or the revoke action.

A device that restarts is not lost. On start it ends each task it claimed and had not finished
with `task.fail` (`reason: daemon_interrupted`, `retryable: false`), and it never runs that task again (#924).
So a `cancelTask` sent while the device was down settles once the device is back.

## 2. Rescan contract

The SDK sends the Host no reliable notice of a state change:

- `ByokCloudObserver` callbacks are synchronous and return `void`. They run inline after the outcome is fixed.
  For inbound envelopes and projection completions, they run on the request path. `onMaintenance` runs inside `runMaintenance`.
  The SDK ignores a throw from them
  (`packages/cloud/src/inbound.ts:174-201`, `packages/cloud/src/inbound.ts:478-500`, `packages/cloud/src/cloud.ts:312-319`,
  `packages/cloud/src/cloud.ts:1668`, `packages/cloud/src/cloud.ts:1972`).
- `onInboundCommitted` runs only for an `accepted` envelope. A `duplicate` retry gets no call
  (`packages/cloud/src/inbound.ts:158-166`, `packages/cloud/src/inbound.ts:478-481`).
  So a notice that the product loses does not come again.
- A Worker invocation ends with its response. Work after the response runs only inside `ctx.waitUntil`.
  The platform cancels that work after 30 seconds ([Workers context](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)).
- The SDK has no hosted scheduler for Topology H (`docs/host-execution-core.md:25-26`).

The product keeps this contract:

1. Keep a ledger of unsettled intents in product storage. For example, use one Durable Object for each tenant or each FIFO.
2. While the ledger has an unsettled intent, keep a Durable Object alarm set.
3. On each alarm, read each unsettled intent with the table in section 1. Settle the settled rows. Then set the next alarm.
4. Delete the alarm when no unsettled intent remains.
5. Catch errors in the alarm handler and set a new alarm.
   The platform retries a handler that throws only a limited number of times.
   An object has one alarm, and `setAlarm` replaces it ([Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)).
6. Make each settle step idempotent. An alarm runs at least once, so a scan can repeat (same page).
7. Use the observer only to start a scan earlier, for example through `ctx.waitUntil` on a call to the Durable Object.
   Correctness must not depend on the observer.
8. Scan the product ledger, not `listTaskAttempts({ active: true })`.
   That filter drops attempts with a cancellation marker, so it misses `cancel_requested` tasks
   (`packages/cloud/src/cloud.ts:748`, `packages/cloud-dataplane/src/stores/task-attempts.ts:322`).

The alarm interval sets the longest settle delay. The product chooses it.

## 3. Wake on Workers

The `MailboxWake` port (`packages/cloud/src/mailbox-wake.ts:3-15`):

- It is a lossy hint. It is never a delivery or cursor authority (`packages/cloud/src/mailbox-wake.ts:3`).
- `appended(tenant, deviceId)` runs after a mailbox commit. It is synchronous and must not throw (`packages/cloud/src/mailbox-wake.ts:5-6`).
- A caller must call `subscribe` before it reads. Then an append between the read and `next()` is kept (`packages/cloud/src/mailbox-wake.ts:7-8`).
- `next(maxWaitMs)` resolves on a hint, the fallback interval, `maxWaitMs`, abort or close (`packages/cloud/src/mailbox-wake.ts:12-13`).

How the SDK uses the port:

- `createByokCloud` requires `mailboxWake` (`packages/cloud/src/cloud.ts:810`).
- The SDK calls `appended` after the mailbox append and after a cancel commit, with no `try`
  (`packages/cloud/src/tenant-stores.ts:253-256`, `packages/cloud/src/tenant-stores.ts:318-322`).
  So a throw from `appended` rejects a call whose row is already committed.
- The events route subscribes (`packages/cloud/src/handlers/events.ts:135`) before its first `readAfter` (`packages/cloud/src/handlers/events.ts:140`).
  After an empty read it waits on `next(remaining)` and reads again (`packages/cloud/src/handlers/events.ts:194-196`).
  The hold ends at `longPollHoldMs` (`packages/cloud/src/handlers/events.ts:133`).
  The route closes the subscription when it returns (`packages/cloud/src/handlers/events.ts:198-200`).

The dataplane README gives the Workers composition (`packages/cloud-dataplane/README.md:416-420`):

- The Postgres listener wake is Node-only. Hyperdrive cannot carry LISTEN/NOTIFY.
- A Workers Host injects a new `createInProcessMailboxWake({ fallbackMs: 1_000 })` for each invocation.
  It sees writes from other isolates within that interval.
- A low-latency Durable Object wake is outside the current scope of the package.

Read cost on Workers:

- The in-process wake keeps its subscriptions in a map inside the instance
  (`packages/cloud/src/stores/in-memory/mailbox-wake.ts:17-23`).
  An instance for one invocation gets no hint from another invocation.
- So an idle hold gets no hint. Each wait ends at the fallback interval
  (`packages/cloud/src/stores/in-memory/mailbox-wake.ts:52`, `packages/cloud/src/stores/in-memory/mailbox-wake.ts:68`).
- For an idle device, each wait is followed by one `mailbox.readAfter` (`packages/cloud/src/handlers/events.ts:137-156`, `packages/cloud/src/handlers/events.ts:194-196`).
- A 50-second hold with a 1-second fallback does up to 51 `readAfter` calls: one first read and up to 50 more.

A Durable Object wake is a product obligation. The SDK does not supply one.
A product that builds one must keep the port rules:

- `appended()` returns at once and never throws.
  Start the hint, for example a `fetch` to the Durable Object stub, as a promise. Catch its errors.
  Give the promise to `ctx.waitUntil`, so the platform does not cancel it when the response returns
  ([Workers context](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)).
- `appended` has no `ctx` argument. So build the wake for each invocation and keep that invocation's `ctx` in it.
- `subscribe()` registers before the first read of the route.
  A hint between `subscribe()` and `next()` must make `next()` resolve at once.
  The in-process wake does this with a pending flag
  (`packages/cloud/src/stores/in-memory/mailbox-wake.ts:29-32`, `packages/cloud/src/stores/in-memory/mailbox-wake.ts:48-51`).
- `next()` still resolves at the fallback interval, because hints are lossy (`packages/cloud/src/mailbox-wake.ts:3`, `packages/cloud/src/mailbox-wake.ts:12`).
- The subscription closes on response, error or request abort (`packages/cloud/README.md:88-91`).

## 4. Consume return contract

The Host gives `createByokCloud` a consumer in `agentMessage.consume` (`packages/cloud/src/cloud.ts:293-311`).
The consumer gets the first Agent message of each task that has `messageEgress`.
The SDK calls `consume` before it writes the disposition (`packages/cloud/src/inbound.ts:262-296`).

| Consumer result | Stored disposition | Daemon behavior | Task terminal |
| --- | --- | --- | --- |
| Returns `accepted` | `accepted` | Retires the local message and finishes the task (`packages/client/src/daemon/task-runner.ts:1899-1911`). | `task.complete` or `task.fail`, later |
| Returns `refused` | `refused` | Fails the task with `retryable: false` (`packages/client/src/daemon/task-runner.ts:1891-1897`). | `task.fail` |
| Returns `held` | `held` | Stops its retries and writes no terminal (`packages/client/src/daemon/task-runner.ts:1886-1890`). | None until the Host cancels |
| Throws | None. The reservation stays pending (`packages/cloud/src/inbound.ts:283-287`). | Sends the message again after 1 second (`packages/client/src/daemon/task-runner.ts:1843-1852`). | Not yet |
| No consumer, new reservation | `held` with `reasonCode: 'consumer_unavailable'` (`packages/cloud/src/inbound.ts:278-282`) | Same as `held` | None until the Host cancels |
| No consumer, pending reservation | None. The route throws (`packages/cloud/src/inbound.ts:279-281`). | Sends the message again | Not yet |

The product keeps these rules:

1. Deduplicate by the exact identity: tenant, device, task, AgentRef, message id and payload.
   Return the same outcome and `reasonCode` on each exact replay.
   Delivery is at least once, also in parallel and after a restart (`packages/cloud/src/cloud.ts:293-302`).
   After a throw, the SDK calls `consume` again for the same pending reservation
   (`packages/cloud/src/inbound.ts:269-275`, `packages/cloud/src/inbound.ts:283-287`).
   The comment in `deploy/sql/0017_agent_message_admission.sql:5-7` says that retries never invoke the consumer again or synthesize a terminal result.
   The part that says retries never invoke the consumer again is out of date; the code above is the rule.
   A retry still synthesizes no terminal result. The migration file is checksummed, so its comment does not change.
2. Commit the product effect before you return. If the commit is not certain, throw.
3. The first disposition wins (`packages/cloud-dataplane/src/stores/task-attempts.ts:282-290`, `deploy/sql/0017_agent_message_admission.sql:3-4`).
   So `held` cannot become `accepted` through the SDK.
4. The SDK has no route that releases a held message.
   The protocol leaves that to a separate authenticated product action (`docs/protocol.md:1989-1992`).
   The task has no terminal until the Host cancels it. Then use rows J and K of section 1.
5. Return `held` only when the product owns that release action and a plan to settle the task.
   Otherwise return `accepted` or `refused`.
6. Register the consumer in each deployment that serves `POST /byok/messages`.
   `submitAgentExecution` with `messageEgress` refuses to submit without a consumer (`packages/cloud/src/cloud.ts:1940-1942`).
   `enqueuePreparedOffer` and `enqueueAgentEgressOffer` do not check for a consumer (`packages/cloud/src/cloud.ts:2021-2047`).
   Without a consumer, a new message is held with `consumer_unavailable`.

## 5. Idle cost profile

Defaults and settings:

| Item | Default | Setting | Source |
| --- | --- | --- | --- |
| Long-poll hold | 50 s | Host `longPollHoldMs`. The SDK does not check its range. | `packages/cloud/src/cloud.ts:216`, `packages/cloud/src/cloud.ts:338`, `packages/cloud/src/cloud.ts:900` |
| Wake fallback | 1 s on Workers (README). The SDK default is 5 s. | `createInProcessMailboxWake({ fallbackMs })` | `packages/cloud-dataplane/README.md:416-420`, `packages/cloud/src/stores/in-memory/mailbox-wake.ts:4` |
| Daemon wait after an empty poll | 250 ms | Daemon override `longPoll.idleDelayMs` | `packages/client/src/daemon/long-poll-transport.ts:524-530`, `packages/client/src/daemon/create-daemon.ts:873-877` |
| Presence heartbeat | 30 s | Daemon `config.presence.intervalMs`. It must stay above the minimum interval and below the TTL. | `packages/client/src/daemon/presence-publisher.ts:45-52`, `packages/client/src/daemon/create-daemon.ts:1454-1459` |
| Presence TTL | 90 s | Host `presenceTtlMs`. The daemon `config.presence.ttlMs` only checks the cadence. | `packages/cloud/src/coordination.ts:15`, `packages/cloud/src/cloud.ts:1000`, `packages/client/src/daemon/presence-publisher.ts:87-88` |
| Presence on or off | On when the Host `capabilities` declaration has `presence.hints` | Host declaration | `packages/cloud/src/cloud.ts:995-1006`, `packages/client/src/daemon/create-daemon.ts:3078-3079` |
| Access token | 1 h. The daemon renews it 60 s early with 2 calls. It computes the expiry from its own receipt time plus the response's `expiresIn`, so the device clock's offset from the Host's does not move the renewal point. | Host `accessTokenTtlSeconds` | `packages/cloud/src/auth/tokens.ts:25`, `packages/cloud/src/cloud.ts:331`, `packages/client/src/daemon/auth-manager.ts:96-97` (renewal margin), `packages/client/src/daemon/auth-manager.ts:614-622` (expiry from `expiresIn`), `packages/client/src/daemon/auth-manager.ts:510-532` (scheduling) |

Calls per hour for one idle device.
These numbers are computed from the defaults. They are not measured.

| Setting | `GET /byok/events` | `PUT /byok/presence` | Token renewal | HTTP total | `readAfter` calls |
| --- | --- | --- | --- | --- | --- |
| 1. Defaults: hold 50 s, presence on | 71.6 | 120 | 2.0 | 194 | about 3,650 |
| 2. Presence off, hold 50 s | 71.6 | 0 | 2.0 | 74 | about 3,650 |
| 3. Presence off, hold 60 s | 59.8 | 0 | 2.0 | 62 | about 3,650 |

How the numbers are computed:

- Polls per hour = 3,600 / (hold + 0.25 s).
- Presence calls per hour = 3,600 / 30 s. A slow publish delays the next beat, so 120 is an upper limit
  (`packages/client/src/daemon/presence-publisher.ts:103-104`).
- Token calls per hour = 2 × 3,600 / (3,600 − 60).
- `readAfter` calls per hour = polls per hour × (1 + hold / fallback), with a 1 s fallback.
  The hold changes the HTTP count. The fallback interval sets the database reads.
- Each poll and each presence call also reads the device row for bearer authentication
  (`packages/cloud/src/handlers/events.ts:101`, `packages/cloud/src/handlers/presence.ts:23`, `packages/cloud/src/auth/bearer.ts:62`).
  Each poll also reads the mailbox cursor (`packages/cloud/src/handlers/events.ts:120`).

Compare these numbers with the downstream budget.
The budget is at most one light call per 60 s for each idle device (`docs/host-execution-core.md:392`). That is 60 calls per hour.

- Setting 1 is about 3.2 times the budget. Setting 2 is about 1.2 times the budget.
- In setting 3 the polls stay in the budget (59.8 per hour).
  The 2 token calls make the total about 62. That is about 3 % above the budget.
- Each setting does about 3,650 `readAfter` calls per hour on Postgres.
  The product decides whether a held poll with 51 or 61 reads is a light call.

Presence off also has a cost:

- Without `presence.hints`, the SDK does not mount the presence route (`packages/cloud/src/cloud.ts:995-1006`).
  So `listPresence` has no entry for the device (`packages/cloud/src/cloud.ts:2428-2429`).
  Presence is the TTL-bounded discovery hint (`packages/cloud/README.md:43-47`).
- The Host must find `device_offline` from its own data (`docs/host-execution-core.md:383`).

## 6. Data retention

Current behavior:

- Each receipt family is `identity` class. A key with an unknown prefix is also `identity` class
  (`packages/cloud/src/receipt-retention.ts:2-10`, `packages/cloud/src/receipt-retention.ts:20-22`).
  No family is `request` class (`packages/cloud/src/receipt-retention.ts:11-13`).
- `PostgresRequestReceiptStore.collectExpired` returns at once and removes no row, because the request prefix list is empty
  (`packages/cloud-dataplane/src/stores/receipts.ts:45-48`).
- `runMaintenance` takes a complete retention policy from the caller
  (`packages/cloud/src/maintenance.ts:97`, `packages/cloud/src/maintenance.ts:141-144`).
  It calls `collectExpired` in its `receipts` step (`packages/cloud/src/maintenance.ts:163`).
  So `requestReceiptRetentionMs` removes no receipt.
- With `DEFAULT_RETENTION_POLICY` (`packages/cloud/src/maintenance.ts:23-29`), the `mailbox` step deletes acked rows after 1 day.
  It marks pending rows older than 7 days as `expired`. An expired row keeps its body
  (`packages/cloud/src/maintenance.ts:153-155`, `packages/cloud/src/maintenance.ts:162`,
  `packages/cloud-dataplane/src/stores/core/mailbox.ts:320-371`).
- Automatic retention deletes an expired row (a dead letter) once it is older than
  `mailboxUnackedRetentionMs + mailboxDeadLetterRetentionMs` (7 + 30 days by default), except the
  highest-seq dead letter of each device, which stays as its `recoverableFrom` floor (#1115).
  Before that, only the operator call `discardDeadLetter` or tenant erasure deletes it
  (`packages/cloud-dataplane/src/cleanup.ts:262-286`, `packages/cloud-dataplane/src/tenant-erasure.ts:44`).
  `discardDeadLetter` refuses the floor row with `cleanup_dead_letter_is_recovery_floor`; tenant erasure removes it with the rest of the tenant.
  `PostgresCloudCleanup` ships from the package root, not from `./runtime`
  (`packages/cloud-dataplane/src/index.ts:56-59`, `packages/cloud-dataplane/README.md:94-97`).
- So the mailbox copy of an acked offer goes.
  The mailbox copy of an offer that the device never acked stays as a dead letter for the dead-letter window.
  The receipt copy stays in both cases.
- Used device-proof request ids live in `proof_request_receipt`. The Host must pass
  `proofReceiptRetention: { authority }` to `createByokCloud` (#1120); the authority is a `PostgresProofReceiptRetentionAuthority`
  from `@byok-sdk/cloud-dataplane/runtime`, over the same table as the `proofReceipts` port
  (`packages/cloud-dataplane/src/stores/proof-receipts.ts:104`).
  The step deletes rows recorded more than `proofReceiptRetentionMs` before `now`: 24 hours by default,
  at least 15 minutes, checked at construction (`packages/cloud/src/maintenance.ts:48-70`).
  Within the retention a `requestId` stays single-use.

What the kept rows hold:

| Row | Content | Source |
| --- | --- | --- |
| `task-offer:<messageId>` receipt | `{ deviceId, type, payload }`: the full offer payload | `packages/cloud/src/cloud.ts:1187-1195` |
| `task-offer-delivered:<messageId>` receipt | The message id | `packages/cloud/src/cloud.ts:1239` |
| `task:<taskId>:terminal` receipt | The first terminal envelope, with summary, final message, document and usage | `packages/cloud/src/inbound.ts:359-362`, `packages/cloud/src/inbound.ts:866-874`, `packages/cloud/src/terminal-result.ts:61-90` |
| `agent-message-offer:<deviceId>:<taskId>` receipt | AgentRef, session, message requirement and the Host message context | `packages/cloud/src/cloud.ts:1921-1928` |
| `agent_message_admission` row | The full publish payload, with the message `body`, in `payload_body` (`NOT NULL`). The payload again in `terminal_body`, with the disposition. | `deploy/sql/0017_agent_message_admission.sql:16-17`, `packages/cloud/src/inbound.ts:262-268`, `packages/cloud/src/inbound.ts:289-296`, `packages/protocol/src/messages.ts:488-499` |
| `task` row | Status, owner, claim snapshot and cancel marker | `packages/cloud-dataplane/src/stores/task-attempts.ts:53` |

- The SDK has no ContextPack field. The K4 execution core (`@byok-sdk/server/execution-core`) adds its ContextPack to the inline instruction
  (`packages/server/src/execution-core/core.ts:655-663`).
  So the cloud keeps that ContextPack, with its resident memory text, as long as it keeps the offer receipt.
- An `agent_message_admission` row goes only when its `task` row goes (`deploy/sql/0017_agent_message_admission.sql:20-22`).
- The `tasks` maintenance step archives a terminal task once its `archive_after` is older than `terminalTaskArchiveMs`
  (default 90 days) (#1120). Every body in the table above becomes a body-free tombstone (hash, byte length, envelope type),
  the free-text terminal cause and cancel reason are cleared, and the board item is removed. The rows themselves stay as
  the task's identity fence and are never deleted; only tenant erasure removes them. Archived tasks leave the board.
  See [the cleanup runbook](../deploy/runbooks/cloud-cleanup.md) for migration 0032's backfill.
- The receipt store writes each body as it gets it (`packages/cloud-dataplane/src/stores/receipts.ts:63-73`).
  For a task whose offer has `sealing`, a body of a sealed category holds the sealed member, so the store keeps ciphertext ([protocol §2.5](protocol.md#25-sealed-payload-v1-654-gated-addition)).
  Every other body is plaintext. [security.md, Sealed tasks](security.md#sealed-tasks) lists what a sealed task still shows the Host.

Deletion paths:

- `revokeDevice` deletes only rows of the device (see [revokeDevice](#revokedevice)).
- `eraseAgentMemoryProjection(tenant, agentId)` revokes consent and erases the hosted Agent memory projection of one Agent
  (`packages/cloud/src/cloud.ts:1782-1795`).
- `discardDeadLetter` deletes one expired mailbox row other than the device's recovery floor (see above).
- `redactTasks(tenant, { taskIds })` removes the content of terminal tasks and keeps their rows
  (`packages/cloud/src/task-redaction.ts`, `packages/cloud-dataplane/src/stores/task-redaction.ts`).
  It replaces the bodies of the task receipts, the admission row and the acked and expired outbox rows with a tombstone.
  The tombstone holds the SHA-256 and the byte length of the body, and the envelope type.
  It clears the free-text `task` columns, deletes the activity, approval and draft rows,
  and deletes the objects that the bodies name when no reference, upload, other receipt body or pending outbox row holds them.
  A replay of the same body still matches, and new content is still a conflict.
  When the task has no terminal receipt, it writes a tombstone there, so a late device terminal stores nothing.
  Content reads of the task, `readTerminalReceipt` included, then throw `task_content_redacted`.
  `listDeadLetters` returns a redacted row with the tombstone as its body.
  It refuses a task that is not terminal or that has a pending outbox row; the Host retries later.
  A failed or refused call can leave the objects deleted and the bodies in place; call it again.
  Known limit: a late progress or approval report can add a row after a call. A second call deletes it, and the row TTL bounds it.
  The limits are in [security.md](security.md) (Deletion paths).
  It needs the `taskRedactionStore` option. `createPostgresTaskRedactionStore` ships from `./runtime`, so it runs on Workers.
- A `shred` member chain entry deletes the key packages and scope epochs of one sealed scope, in the append that stores it
  (`packages/cloud/src/e2ee-member.ts`, `packages/cloud-dataplane/src/stores/e2ee-member.ts`).
  It records the scope in `e2ee_scope_shred` (`deploy/sql/0028_e2ee_scope_shred.sql`)
  and writes an `e2ee-scope-shred:<scopeId>` receipt with the chain seq, the time and the writer.
  Later key package puts for the scope get 409 `e2ee_scope_shredded`.
  The Host deletes without verifying the signer, and the ciphertext rows stay.
  Backup copies of the packages stay openable until each member rotates its KEM key and deletes the old private key.
  The limits are in [security.md](security.md) (Scope shred).
- `createPostgresTenantErasure` is the only path that deletes task receipt rows
  (`task-offer:`, `task-offer-delivered:`, `task:` and `agent-message-offer:`), `task` rows and `agent_message_admission` rows.
  It deletes the whole tenant (`packages/cloud-dataplane/src/tenant-erasure.ts:25-59`).
- The only other receipt delete removes a `pairing-completion:v1:` receipt when a pairing code is issued again
  (`packages/cloud-dataplane/src/stores/pairing-codes.ts:145-151`).
- Tenant erasure is Node-only. It imports `node:crypto` (`packages/cloud-dataplane/src/tenant-erasure.ts:9`).
  It ships from the package root (`packages/cloud-dataplane/src/index.ts:75-81`).
  The `./runtime` entry does not export it (`packages/cloud-dataplane/src/runtime.ts:28-105`).
- Run it from a Node process with a direct DSN
  (`packages/cloud-dataplane/README.md:94-97`, `packages/cloud-dataplane/README.md:215-216`).
  The Host must authorize it and stop product writes first (`packages/cloud-dataplane/README.md:223-224`).

**Gap: retention and scoped deletion.** Task receipts and admission rows have no TTL.
`redactTasks` removes their content by task, but no call removes it by device, Agent or time.
`redactTasks` does not cover reliable egress rows (they have no task key), truth records, or receipts without a task key
(`agent-input-preparation-*`, `agent-home-projection-*`, `agent-content-*`).
It cannot reach backups, replicas or logs.
A scope shred removes key packages and scope epochs only. There is no `redactScope`: the Host calls `redactTasks` with the scope's taskIds, which leaves the rows `redactTasks` does not cover.
The shred is complete only on the live store until each member of the scope rotates its KEM key and purges its scope keys,
and the SDK does not run that rotation or purge yet.
This document states current behavior. It does not promise a design or a release.

## 7. Gaps

| Gap | Current behavior | Product rule today |
| --- | --- | --- |
| Lost or revoked device | Its open tasks never get a terminal (section 1, row L). | Conclude the intent with a product rule. |
| Observer notice | Inline, one time and not replayed (section 2). | Keep a Durable Object alarm while intents are unsettled. |
| Wake across invocations | The SDK has no wake across Worker invocations. Each wait ends at the fallback (section 3). | Accept the fallback reads, or build a Durable Object wake. |
| Held message | No SDK route releases it. The task has no terminal until a cancel (section 4). | Return `held` only with a product release action. |
| Idle cost | 62 to 194 HTTP calls and about 3,650 reads for each idle device per hour (section 5). | Choose presence, hold and fallback against the budget. |
| Retention | No receipt TTL. `redactTasks` removes content by task only. Unacked offers stay as dead letters for the dead-letter window (section 6). | Tenant erasure from Node is the only delete path for task receipt rows and admission rows. |
| Scope shred | The Host deletes a scope's key packages on any well-shaped `shred`, without verifying the signer. Backup copies of the packages stay openable until each member rotates its KEM key and deletes the old private key. Members keep their scope keys until they purge them (section 6). | Treat a shred as complete only on the live store. Remove the scope's task-keyed plaintext rows with `redactTasks`. |
