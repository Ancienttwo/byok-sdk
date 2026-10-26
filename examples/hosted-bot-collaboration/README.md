# Hosted Bot collaboration (H)

Private reference example for #793 (#606 D2). It is the hosted (H) adapter of the K8 collaboration
commit contract (`examples/bot-collaboration`, #739 D1), on Node and Postgres.

Status: the commit store, the intent submitter (D2b-1), the sync step (D2b-2), the message consumer (D2c), result
reconciliation (D2d), the device binding (D2e), retention (D2g), routines (D2f-2), their scheduler (D2f-3), the outbox
sender (D2b-out-2), delegation settlement (D2f-5), the inbound channel entry (D2b-out-3), the batch seal, the
authenticated command entry (S10), the device observation (S11), the connector card calls (S12), the Agent home
flush (S13), summary-only Host job routines (S14) and Host intents (#955).
Do not use this example as a deployed Host yet.

## Commit store

`HostedCollaborationStore` runs one command through the D1 commit contract in one Postgres
transaction. The transaction holds the state change, the command record and the outbox rows.

- A commit first upserts its scope row and then locks it, so the commits of one scope run one at a time.
- A replay returns the first result and writes nothing. A throw rolls back every row.
- H has no K4 ledger, so the store also records the terminal and message callbacks.
- The caller passes the scope that the authenticated product user owns. A request for another scope is
  a `scope_mismatch` conflict.
- A scope row of an unknown store version is refused before any write. `read()` refuses it too.
- The store builds every command port itself, from the scope's Host config (`host(scope)`: the model templates and the
  read-only toolsets, L's `models` and `readOnlyToolsets`), as L `commitOwner` and `applyOutcome` build them (#793 S9):
  `updatePersona`, `teamBot`, the outcome's `manage`, and the push route ports with `{ channel: true }`. A model template
  carries the device that a new Bot runs on, so each scope has its own config. `commit`, `receive`, `consume` and `finish`
  take the Host clock, not ports. The sync reads its model names and read-only toolsets from the same config.
- A command reads the intent facts (K8 `CommandPorts.intents`) from the intent rows, under the scope lock, as L reads its
  K4 intents in the commit transaction. The committed intents of an outcome
  (`outcome.committed`, which a Main Bot cancel reads) come from the same rows.
- A new commit that leaves a delegation cancel fact to deliver (`cancel_turn` of an open chain Turn,
  `cancel_delegation`, `abandon_delegation`) delivers it in the same transaction, as L `settleChain` runs
  `deliverCancels` after its commit: the K4 cancel of the fact's frozen target, then `delivered`.
- `commit()` is the command entry's call, so it refuses the K4 callback commands (`outcome`, `message`, `occurrence`)
  with `CallbackCommandError`, before it reads or writes anything: no scope row and no command record, so a retry gets
  the same refusal (#793 D2f-6). They come only from `finish`, `consume` and `fire`. The store builds the committed
  intents, `manage` and the routine ports of an outcome.
- The shared K8 commit vectors send an `outcome`. H runs them through the protected `commitIn`, which a test subclass
  (`VectorStore`) exposes, as L's vector subject commits through `commitInLedger`. Host code is trusted: the boundary is
  that the command entry calls `commit()`.
- A new `cancel_turn` of a Turn with a frozen intent runs the K4 cancel in the same transaction, in L's order (K8
  `host.ts` `cancelTurn`): the commit, then `cancel_reason = 'cancelled'` on the open intent, then the version switch
  check. An untried row also concludes `cancelled` (K4 `queuedExpiry`), because the submit claim runs under the same
  lock. A tried row waits for the reconciliation to check its attempt. The next sync ends the Turn.

## Intent submitter

`freezeIntent` saves one intent for a Turn: its source, the frozen SDK input and the stable task id
`taskId(turnId, 0)` of K4. The caller holds the scope lock. A second freeze with the same source, input and
wait changes nothing. Another one throws `Intent identity conflict`, as K4 `enqueue` does. A freeze with a K4 `retry` policy throws,
because H never retries a task (D2d option A) and must not drop the policy.

`HostedSubmitter.run()` takes the due rows and runs the K4 rules on them: the FIFO head (`fifoHeads`), the
queued expiry (`queuedExpiry`) and the frozen submit (`submitFrozen`).

- A try first raises `tries` and takes a lease, under the scope lock. Then it calls the SDK.
- Every write after the SDK call is fenced: `WHERE tries = $mine AND submission <> 'delivered'`. A stale
  submitter cannot overwrite a newer try, and a delivered row never changes back.
- A row that was never tried expires at `wait_until`. A routine row that was never tried also stops at its
  `retry_until` (`superseded`), as K4 `begin` does. A tried row keeps its submit to `wait_until`, because K4 `submit`
  does not read `retryUntil`. A tried row past `wait_until` is never submitted
  again. It gets `cancel_reason = 'expired'` and no conclusion, because an SDK attempt can still exist.
  Reconciliation (D2d) checks the attempt first. A sync cancel that lands during the try keeps its reason.
- Right before the SDK call, a try reads the row again, as K4 does. It stops when the row has a conclusion or a
  cancel reason. The read is outside the scope lock, so a cancel after it can still reach the SDK. D2d's attempt
  check is the guard for that case.
- A delivered head holds its agent's queue until it has a conclusion. The scan returns only FIFO heads, so the
  followers of a queue never fill a pass ahead of a due head.
- A row whose try throws outside the SDK call is backed off, and the pass goes on. `run()` reports it in
  `failed`. A scope of an unknown store version is not written at all.
- The SDK input never changes, and the task id never changes. After a lost response, a readback finds the
  offer, and no second submit runs.

## Tables

`src/ddl.ts` holds the DDL. The statements are unqualified, and `migrate()` runs them in the store's own
schema. The SDK tables stay under the SDK migrations. This example never writes them.

| Table | One row per |
|---|---|
| `scope` | scope: the store version, the frame (the state without its rows), the due time, and its owner switch export mark or import record (#975) |
| `entity` | map entry of the state (Turn, card, Bot, room, delivery, ...), keyed by its id |
| `entry` | element of a list (audit, rejected, team note, home operation, room message), keyed by position |
| `command` | command record: the dedup evidence, the first result and the retention root (nullable) |
| `outbox` | work for the sender: a projection's value and send state, a delivery's scan index (owner §54a, signed), a card's connector call claim, an Agent home operation's scan index, or a Host job's claim (#793 §6, signed) |
| `intent` | Turn intent or Host intent (with its handler name, #955): the frozen SDK input, the generation and its task id, the K4 retry policy, the FIFO order, the submit state, the SDK result read back, K4's preparation error and memory block |
| `intent_execution` | earlier generation of an imported intent (#975): its task id, submit state, claim, and the SDK attempt and terminal |
| `device_binding` | device of a scope: its mode (`L` or `H`), its mode revision, its revoke time and an open owner switch away from H |
| `retired_identity` | Tombstones in K4's scheme `(kind, identity, expires_at)`: kind `row` for a K8 identity that retention retired, `hash([namespace, id])`; kind `intent` for a compacted intent, its K4 intent id `hash(key)`. H writes only permanent ones; kinds `slot` and `application` are K4's, for an owner switch. H reads no expiry and deletes no tombstone (see Owner switch export) |
| `archived_row` | row that retention moved out of the state, by namespace and id; a command record has an expiry |
| `routine` | K4 routine of a Bot: its definition, staged version, lifecycle, status, next slot, and K4's schedule retry fields and last error |
| `occurrence` | K4 occurrence of a routine slot; its conclusion only when it has no intent, a Host job's state (`job`) and K4's slot replay count |

Each scope and each key is stored as `JSON.stringify(value)`, so two values that UTF-8 would merge stay
apart, and a NUL is safe. Each body is `json` text, so the stored bytes keep their key order. `ordinal`
keeps the insertion order of each kind.

## Accepted limits

- A commit loads every row of its scope, except the command records: it loads only the one record that
  it can replay. Retention, after #798, bounds the scope rows.
- When a list gets shorter, the positions of its later elements are renumbered. Retention shortens the
  `rejected`, `audit` and `homeOperations` lists, so their positions change; their content and order stay.
- The `kind` CHECK lists come from the layout at the first `migrate()`. `CREATE TABLE IF NOT EXISTS`
  keeps the old CHECK, so a new kind needs an explicit `ALTER` in a later migration.
- H has no migrations while it is unreleased. After a DDL change, recreate the H schema. `migrate()` on a schema
  from an older revision fails in its one transaction and changes nothing.
- The H reconciler reads an open intent's SDK attempt again after `pollMs` (30 s by default), and L's after 100 ms
  (`reconcileMs`). The room step reads `started` from the claim that it records, so a Bot that claims its seat Turn
  less than one poll before the seat deadline can still be marked `busy` and have its work cancelled. The room rule is
  unchanged; a shorter `pollMs` narrows the window.
- One commit must not delete a map key and add it back. The store keeps the old ordinal, but a JavaScript
  object moves the key to the end. K8 never deletes a map entry today.

## Database

One Postgres database can hold the SDK tables and this example's schema. The store takes its own
`pg.Pool`, so a separate database also works. No path assumes one atomic commit across the store and an
SDK call.

## Sync step

`HostedCollaborationStore.sync(scope, options)` runs the K8 sync rule (`syncTurn`) for each stored Turn, in
insertion order, in one transaction under the scope lock. It writes each step as L writes it to K4:

- `freeze`: `freezeIntent` stores the rule's intent input as it is.
- `cancel`: the open intent of an archived Bot gets `cancel_reason = 'cancelled'`. A row that no submit tried also gets
  the conclusion `cancelled`, as K4 `queuedExpiry` concludes a cancelled queued intent: the submit claim runs under the
  same lock, so no SDK attempt can exist. A tried row waits for the reconciliation.
- `routine`: K4 `promoteOccurrence` runs on the routine slice. The intent row takes the step's execution and the K4
  times: `wait_until` from the occurrence record, `retry_until` from the next slot, and `superseded` at once when a
  newer slot marked the occurrence. It takes no K4 retry policy: its `retry` is H's one-attempt policy. The freeze checks the
  device binding.
- `ended`: a routine Turn that ends before promotion concludes its occurrence `cancelled` (K8 `concludeRoutineTurn`).
  Nothing for another Turn.

Every frozen instruction lists the scope's Bot routines, in insertion order; the store reads them itself.

The sync runs to a fixed point, as the L pass drains again after a step that changed K4. While a round froze or
promoted an intent, concluded an untried intent on `cancel`, or concluded an occurrence on `ended`, it reads the intent
facts again and runs every Turn again. So one sync ends a Turn whose promotion settled `superseded` at once, or whose
untried intent it cancelled. Each of those steps happens once per intent or occurrence, so the rounds end.

In history mode, `options.history` maps each Turn id to that Turn's history rows, as L reads them. A Turn without
an entry does not freeze.

### Batch seal

With a coalesce policy (`new HostedCollaborationStore(pool, schema, { coalesce })`), H coalesces user inputs as L does with
its `coalesce` option. The policy is the value that K8 `coalescePolicy(options, contextMaxBytes)` returns for the
ContextPack budget that the Host gives each sync in `limits`. The store checks the other bounds when it is built, and each
sync checks `maxBytes` against its own budget. A sync whose budget is too small for the policy throws and writes nothing.
The commit path does not know the budget, so it still admits inputs into batches: with that misconfiguration, every
sync of every scope throws and no Turn freezes. L checks the budget once, when it is built, because L owns its budget.
H takes the budget in each sync's `limits`, so give the store a policy built for the smallest budget that its syncs use.

- The store admits each input itself (K8 `admitUserInput`), with its own policy, as L's owner commands do. So the
  admission and the seal use one policy. No caller supplies a port, and the store sets the admission on every commit.
- Each sync round first runs K8 `sealDueBatches`, as L's sync does, so a sealed batch's Turn gets its step in that round.
  A later round of the same sync seals again, so a Bot that an earlier round made idle gets its batch sealed in that sync.
- The sync runs K8 `projectInputBatches` last, after the reply token cleanup, as L's sync does.

There is no due index yet, so a batch whose window ended seals at the next sync of its scope: the interval fallback
for timers (see Deployment config).

### Delegation settlement

Each sync round runs K8 `settleDelegations` after its Turn steps, as L's `sync()` does (#793 D2f-5). It reads its K4
facts from the intent rows again after the steps wrote: `intent`, `started` (the reconciliation's claim, or a terminal
that is not a decline; H's own rows are generation 0, and an imported row is concluded) and `declineCode`. `offeredTo` throws: settlement never reads it.
Settlement spends or releases units, moves a claimed delegation to `running`, writes the `lateTurnId` audit line,
freezes the `target_archived` cancel, resolves a cancel once its target concluded, shows `uncertain` after the delegation
timers, and gives a chain end that did not succeed its verdict. A verdict can add the `bot_reply` Turn of a batch join.

The same round then delivers each new delegation cancel fact (`deliverCancels`), as the L pass does after its sync. A
round that delivered a fact or added a Turn runs again, so one sync freezes the report to A. The store option `timers`
holds the K8 `DelegationTimers`, which the constructor checks as L's does; without it the rule's defaults apply. The
scope due time reads the same timers.

The terminal transaction delivers the Main Bot cancel that its outcome froze, after the row's conclusion and before the
version switch, as L runs `core.cancel` after its terminal transaction. An untried target concludes `cancelled` there;
the verdict comes at the next sync of the scope.

### Card steps

Each sync round runs the K8 card rule (`rules/cards.ts`, through `./rules/commands`) at L's positions (#793 S5):
`expireCards` before the Turn steps, so a ContextPack frozen in that round shows each expiry, and `reportCardDecisions`
after the settlement. A decided card is projected once as `card:<id>:<state>`; a confirmed card waits for its result or
error. A confirmed or rejected card then adds its `action_result` Turn, so the round runs again and freezes it. An expired
card starts no Turn. The due scheduler syncs a scope when a card's `expiresAt` is reached. A confirmed card gets its result
or error from the outbox sender's card call (see Outbox sender); the sync after it reports the card.

### Room step

Each sync round runs the K8 room step (`advanceRoomSeats`, through `./rules/commands`) after the batch seal and the card
expiry and before the Turn steps, as L's sync runs it (#793 S6). Its seat facts come from the intent row of each seat Turn: `admitted` when the row exists,
`started` from the reconciliation's claim fact, and the row's conclusion. A seat Turn that the step queues freezes in the
same round. The step cancels a seat's admitted work through `cancelIntent`, as a delegation cancel does: an untried row
concludes `cancelled` in that sync, and a tried row keeps its cancel reason for the reconciliation. A seat Turn with no
intent fails with the seat's conclusion. The due scheduler syncs a scope when a seat's deadline is reached.

### Reply checks

A chain end that succeeded with no Host reply record leaves its delegation `reply_pending`, with a check time
(`nextCheckAt`). `HostedReplyChecker.check(scope, now)` runs L's `flushReplies` step (#793 S7) on the shared K8 rule:
- `store.replyChecks(scope, now)` reads the due checks in one snapshot, with no lock. K8 `replyCheckDue` selects them,
  as L does. Each check has its fence (`checks`, `nextCheckAt`) and the chain end's frozen task from its intent row. A
  chain end with no intent row has no task.
- For each check, the checker reads the SDK readback outside any transaction, through the port's `agentMessage`. A read
  that throws or takes longer than `timeoutMs` (default 10 s) is a failed read, as in L. A chain end with no task is a
  failed read with no SDK call.
- `store.settleReplyCheck(scope, delegationId, fence, check, clock)` runs K8 `checkReply` with the store's timers, in one
  transaction under the scope lock, at the clock read after the lock (the checker's `now` option), as L reads its clock
  again in its ledger transaction. A reply body that the Host holds answers the delegation; a failed read retries with
  backoff; otherwise the readback decides (`no_reply`, `reply_held`, or another check). The settle writes nothing when
  the delegation is gone, is no longer due at that time (it runs `replyCheckDue` again, so a verdict or a later check time
  stops it), or no longer matches the fence. A throw writes nothing and propagates.

`agentMessage` is on `HostedReplyPort`, not on `HostedTaskPort`. The submitter and the reconciler use `HostedTaskPort`. So a
deployment wires one more scope-bound port, `port(scope)` of the reply checker, to the same SDK tenant (see Deployment config).

`replyChecks` selects the due checks from a snapshot without the scope lock, so a selection can be stale. The settle reads
the delegation again under the lock and checks the fence. A stale selection costs at most one extra SDK read, and its
settle writes nothing.

Two checkers may both read the same delegation; only the first settle applies. The SDK read is read only: the SDK
`readTaskAgentMessage` (`@byok-sdk/cloud` `task-agent-message.ts`) runs SELECTs on the task, its admission and its
offer receipt, and writes nothing. K8 `delegationDue` puts each check time into `scope.due_at`, so the deployment runs
the checker from its due scheduler `sync`, before `store.sync`, as L's pass syncs after its reply checks (see
Deployment config).

### Device observation

A delegation whose chain end has a delivered offer that no device has claimed shows whether that device is connected:
`waiting_device` while it is not, `queued` again once it is. `HostedDeviceObserver.observe(scope)` runs L's
`refreshDevices` step (#793 S11) on the shared K8 rule `observeDevices`:
- `store.awaitsDevice(scope)` reads in one snapshot, with no lock, whether a delegation can change: no verdict, no
  cancel, and `queued` or `waiting_device`, as L checks before its read. With none, the observer reads nothing.
- The observer reads the SDK readiness of the scope's tenant through the port's `readiness` (the SDK
  `readTenantReadiness`, the read behind L's `machines.list`), outside any transaction. `connectedDevices` gives each
  device's `connected` fact as the server gives it to L: connected when it has unexpired presence. A device that the
  read lacks gives no fact. A read that throws or takes longer than `timeoutMs` (default 1 s, as L) writes nothing.
- `store.observeDevices(scope, devices, clock)` runs the rule in one transaction under the scope lock, and the changed
  delegations' projections reach the outbox in it. A store error propagates.

The rule reads K8's `offeredTo` fact from the chain end's intent row: no conclusion, `submission = 'delivered'`, not
`started`, and the stored SDK attempt still `offered`; the device is the frozen input's `deviceId`. The reconciliation
writes that attempt, so the display can lag the SDK by up to its `pollMs`. Presence is display only: the rule never
changes a submit, an expiry or a verdict.

The step has no due time of its own. The deployment runs it from its due scheduler `sync`, after the reply checker and
before `store.sync`, so a waiting delegation's display can lag until its scope's next sync. L polls on every pass.

H runs each L pass step: the device observation and reply checks from the deployment's composed `sync`, and the card
calls and the Agent home flush in the outbox sender.
The due scheduler syncs a scope when one of the due times is reached (see Due scheduler).

The projections that the rule publishes reach the outbox in the same transaction. A sync writes no command
record and keeps the revision. A throw writes nothing. The rule's `executionStarted` fact is the intent's `started`
column, which the reconciliation sets. H retires no Turn id before D2g.

## Command entry

`HostedCommandEntry` is the authenticated product command entry (#793 S10): L's owner API (K8 `host.ts`) for requests. It is
a TypeScript API; the deployment mounts it on its own HTTP framework. It takes:

- `authenticate(credential)`: the product's session check, which returns the scope that the caller owns and the principal of
  the request. A throw or no result is an `UnauthenticatedError`, with nothing written. H never reads a token itself;
- `owner(scope)`: resolves to the owner principal id of the scope, the value that the inbound entry's `InboundIdentity.owner`
  gives;
- `sync(scope, now)`: the deployment's composed sync, the function that the due scheduler runs;
- `failStuckIntent(scope, key)` (optional): the reconciler's `failStuckIntent` for the scope's tenant. Without it, the
  entry's `failStuckIntent` refuses.

Each method checks the principal as L's R2 checks do, commits under L's command id (`hash(['input', botId, key])`,
`['room_input', roomId, key]`, `['answer', id]`, `['decide', id]`, a new id for each keyless command), then runs `sync`, as
L runs its pass, and returns L's value. A refusal writes its audit line first (`Action refused not_owner: …`,
`Action refused unverified_sender: …`) and throws `EntryRefusedError`. `roomInput` takes any verified principal and drops a
bot principal's mentions (R5); every other method needs the scope's owner. L trusts the caller of `setMainBot`,
`updateRoom`, `retryPersona` and its routine API; here every call comes from a request, so they need the owner too.
`decide` throws a refusal or another decision for a decided card after the sync, as L. The Host's own calls
(`personaReady` through `persona_ready`, a team snapshot, retention, compaction, device binding) stay store calls.

The entry commits with `requireBinding`: under the scope lock, after the K8 rule, each Bot of the work that the commit
added (a Turn that is not concluded, a room seat, a new input batch or an input added to an open one) must run on a
device with an active H binding, or the commit throws `DeviceBindingError` and rolls back. A cancel commits on a revoked
device: the Turn that it seals from an open batch is concluded. It reads what the rule produced, so H keeps no copy of the mention and seat selection. An error of the sync
after a commit reaches the caller, as an error of L's pass does: the commit stays.

## Message consumer

`hostedMessageConsumer(store, { scopeOf, now })` is the `agentMessage` option of `createByokCloud`. Its
`consume` decides each Agent message in one transaction under the scope lock, in the order of K4
`consumeMessage`:

1. A tenant whose scope has no row, or a task that no generation of a frozen intent has: `unknown_task`.
2. A device, Agent or message context that differs from the frozen input: `binding_mismatch`.
3. Another message than the task's accepted reply: `message_conflict`. A task has one accepted reply.
4. A task of an earlier generation of an imported intent (#975) with no accepted reply: `stale_generation`. Its
   accepted reply, the receipt K4 stores on that generation's execution, is `accepted`.
5. Otherwise the `message` command commits under the id `taskId:messageId`. A replay returns the decision of
   its command record. Other content for that id is `message_conflict`.

Steps 1 to 4 write nothing. A replay gets the same decision, because the frozen input never changes and an
accepted reply stays. H never returns `held`. A throw writes nothing and leaves the SDK admission pending.

One decision differs from K4. A message for another tenant gets `unknown_task`, because H maps each tenant to
its own scope. Only an imported intent has earlier generations: H opens none itself.

## Reconciliation

`HostedReconciler.run()` reads the SDK result of each tried intent with no conclusion, and concludes it with the rules
of K4 `reconcile` and `finish`. It reads `readTaskOffer`, `readDeviceTerminal` and `readTaskAttempt`, and calls
`cancelTask`. It does not read `readTaskResult`, as K4 does not.

- The offer readback must be the frozen input, and the attempt must have the frozen task, device and Agent.
  Otherwise the row throws, and nothing but its next readback time is written.
- A row with no terminal, no cancel reason and no observed claim gets `cancel_reason = 'expired'` at `wait_until`. The
  write checks `started` again under the scope lock, so a claim that another pass saw keeps the row waiting.
- A row with a cancel reason and an attempt cancels the SDK task. With no attempt, it concludes, but only when its
  submit lease had ended before the attempt read, because a try in flight can still create an attempt. K4 serializes
  this with each submit.
- `started` is set once an attempt has a claim. A cancelled attempt with no claim and no terminal concludes the row.
- A device terminal concludes the row in one store transaction, under the scope lock: `cancelled` for a cancellation
  or `task.cancelled`; `succeeded` for `task.complete`, with the K8 `outcome` command; otherwise `declined` or `failed`.
- The `outcome` command commits under the command id `taskId`, as L does. A replayed terminal gets the first result
  from the command record, so the outcome is applied once. `outcome.committed` is the H intent rows before this row
  concludes.
- H never retries a task, so each task it freezes stays at generation 0. L does not retry a K8 Turn either: each K8 wait window
  (`OFFER_WAIT_MS`, `ROUTINE_WAIT_MS`) is at most the first K4 retry delay. A K8 test pins that.
- Each SDK call runs outside the scope lock. Each write takes the lock and is fenced on `conclusion IS NULL`.
- A row with no terminal is read again after `pollMs`. The SDK task observer does not wake the reconciler yet.

### Host intents

L lets the Host run its own work on the K4 core (`enqueueHostIntent`, #882). H does it on the intent table (#955):

- `HostedCollaborationStore.enqueueHostIntent(scope, input, handler, clock)` is a Host call, not an entry method. One
  transaction under the scope lock saves an intent row with the handler name in `intent.handler`, through `freezeIntent`.
  The row then goes through the same submitter, reconciler and binding fence as a Turn intent, and shares the FIFO of its
  agentRef. It refuses, with nothing written, a handler that the store's `hostIntents` option lacks, connector toolsets
  that the Host config does not declare read-only, a key that is a Bot Turn, a key whose row has another handler or
  none, and each `freezeIntent` refusal. An exact replay returns `{ key, taskId, conclusion? }` until compaction removes
  the row. The handler is part of the row's identity, so a Turn freeze never takes a Host intent row over.
- At `task.complete`, the terminal transaction runs the handler synchronously with the result document and
  `{ intent: { key, taskId }, terminal, publish }`. `publish` writes a projection row in the same commit. The handler sees
  no K8 state, so the K8 revision stays. Other terminals conclude the row with no handler call.
- A terminal that H cannot apply throws `IntentOutcomeError` (L's codes), and the terminal transaction rolls back, so the
  row stays open at the head of its FIFO: `unknown_intent` for a row with no handler whose key is no Bot Turn,
  `handler_failed` for a handler that throws, returns a thenable or is not configured in this process (L refuses to start
  instead; H has no startup scan over every scope), and `outcome_failed` for a Bot Turn whose outcome commit throws. The
  reconciler then writes `<code>: <message>` to the row's `last_error` and one audit line
  (`Intent outcome refused <code>: <key> <message>`) when that value changed, so several processes add one line.
- `HostedReconciler.failStuckIntent(scope, key)` is L's owner `failStuckIntent`. It reconciles that one row again, and
  only when that throws `IntentOutcomeError` for the key, one transaction under the scope lock concludes the row `failed`
  with no terminal, writes `Intent failed by owner <code>: <key> <message>` and runs the version switch. It refuses an
  unknown key, a settled row (also one that this reconciliation concluded), and a row with no refused terminal; another
  error of the reconciliation is thrown as it is. The entry's `failStuckIntent` checks the owner, calls it, then syncs,
  so a Bot Turn ends `failed`.

## Device binding

The mode binding of plan §4.1 is a Host record, not an SDK field. `HostedCollaborationStore.bindDevice(scope, deviceId)`
binds a device to H at mode revision 1. `revokeDevice(scope, deviceId, revokedAt)` sets `revoked_at` and raises the
mode revision in one write, and keeps the row as the tombstone.

- A second bind and a second revoke change nothing. A revoked device id is never bound again (O1 option A): a
  returning device pairs under a new id. A revoke of a device id that was never bound is final too: it writes a
  tombstone row in the default mode L at revision 2 (creating the scope row if needed), so a later bind of the id is
  refused.
- A bind is for a device that pairs with H first. A device whose row names mode L (after a switch to L, or on an
  uncommitted import) refuses a bind with `mode`: it comes to H through an import (see Owner switch import).
- Each write that can create execution checks the binding under the scope lock, and throws `DeviceBindingError`
  unless the device has an active binding in mode H (`DeviceSwitchingError` while a switch of the device is open): the freeze of a new intent and the submit claim (the row backs off
  with the error). The freeze check is the last guard: the sync reads the bindings first (next bullet).
- Right before the SDK call, the submitter reads the binding again. A revoked or changed binding throws, so the try
  backs off with the error. It does not record an expiry.
- The reconciliation and the message consumer do not check the binding: the result of work that started still lands
  under its own identity. A revoke does not cancel the open intents of the device. One that was not delivered concludes
  `expired` at its `wait_until`, through the claim's queued expiry or through the reconciliation, with the revoke
  reason in `last_error`. A delivered task keeps reconciling under its own identity.
- The sync holds a Turn whose Bot's device has no active H binding (#956, §55a). Each sync round reads, in one query,
  the binding of each Bot's current device and answers K8's `deviceRefusal(botId)` (`unbound`, `revoked`, `mode`, or
  `switching` during an owner switch, see Topology switch).
  The K8 step then holds that Bot's Turns that have no intent: `held: 'device_not_bound'`, one `held:<turnId>`
  projection with a fixed body, and an audit line with the reason. The rest of the scope syncs, an Agent's delegation to
  such a Bot included. A Turn that already has an intent is not checked: its work lands under its own identity.
- A held Turn is released by the next sync that does not hold it. The scope's due time (`scope.due_at`, written in each
  transaction) is 0 while a held Turn's Bot device has an active binding or its Bot is archived or gone, so the due
  scheduler syncs it at once:
  - after `bindDevice` of that device, which writes the due time in the same transaction, the Turn freezes;
  - after a `team_snapshot` without the Bot (or `delete_bot`), which archives it, the Turn ends `cancelled`.

  A snapshot cannot move a Bot to another device: K8 keeps the device when the model changes. A held Turn on a
  refused device adds no due time, so a revoked device does not make the scope spin. The owner can also end the Turn
  with `cancel_turn`. The command entry still refuses a commit that adds work for a refused device (see Command entry).
- The routine scheduler checks it before a fire (see Routines).

## Topology switch

The owner switch of plan §4.1 moves one device between L and H (#957). Each step runs in one transaction under the
scope lock, on the expected mode revision, and returns the binding row read back in that transaction:

- `beginSwitch(scope, deviceId, 'L', expectedRevision)` is the freeze of a device that H owns. It sets `switching` to L
  and raises the revision. A device with no row is in the default mode L, so it has no switch to L (`same_mode`). H
  becomes the owner of an L domain only through an import into a new scope (see Owner switch import).
- `drainDevice(scope, deviceId, expectedRevision, { cancel }, clock)` returns the device's open work while H is the old
  owner: the open intent rows that run on the device, and for its Bots the Turns that are not concluded, the open input
  batches and the Agent home writes to the device that were sent and have no terminal readback (a write that was never
  sent moves with the state). With `cancel`, it first sends K8 `cancel_turn` for each Turn and batch,
  and the K4 cancel for an intent with no Turn, and returns each cancel that threw. A tried intent concludes only from SDK
  evidence, so it stays open until the reconciliation concludes it. The drain waits for nothing: the caller syncs the
  scope, which concludes the cancelled Turns, and calls it again. Each cancel runs in its own transaction, which checks the open switch on its revision first, so a
  drain that an abort or a commit overtook stops with `not_switching` and cancels nothing more.
- `commitSwitch(scope, deviceId, expectedRevision, receipt)` makes L the owner mode and raises the revision. It refuses
  with `open_work` while the drain finds any open work, whatever its age: §4.1 has no timeout path, and it needs the
  scope's export and the new owner's receipt (see Owner switch export).
- `abortSwitch(scope, deviceId, expectedRevision)` ends the switch on the old mode and raises the revision.

A step on another revision, a second freeze, a commit with no open switch, a switch to the current mode and a step on a
revoked device refuse with `DeviceSwitchRefusedError` (`code: 'switch_refused'` and a `reason`), and write nothing. A
revoke ends an open switch in the same write, so a revoked device is never left frozen.

During the freeze:

- every write that can create execution for the device throws `DeviceSwitchingError` (`code: 'device_switching'`, the
  target and the frozen revision), as L's error with the same code: the command entry, the freeze of an intent (a Host
  intent too), the submit claim and the read right before the SDK call. The freeze raises the revision, so a submit
  claimed before it is not made;
- a Bot routine fire of the device throws it too and writes nothing (the scheduler counts it in `pass.fenced`); the
  slot stays due and fires after an abort;
- the inbound channel entry refuses input that adds work for a Bot on the device with the same error. Input for an
  unbound or revoked device is still taken and held (#956);
- the sync holds a Turn of the device's Bots with K8's `switching` refusal: `held: 'device_switching'` and a
  `held-switching:<turnId>` projection. An abort writes the due time 0, so the next sync freezes it;
- H sends no new Agent home write to the device, as L. A write that was never sent waits; a sent one is still read back,
  with no new enqueue, and the commit waits for its terminal readback. H marks a write `sent` (K8 `HomeOperation.sent`)
  in the transaction that plans its first enqueue.

After a commit to L, the same writes refuse with `DeviceBindingError` and `mode`. A row that is not revoked names mode L only on a scope
that the switch fence refuses (exported, or an uncommitted import), so no home flush to it commits. A switch away from H
moves the whole scope to L with the state export below, and its commit needs the new owner's receipt.

## Owner switch export (#975)

`src/switch.ts` reads one scope into the switch format of K8 `./migration`. One function, `hostedSwitchContent`, states
what an H scope holds; the commit away seals it again with the same function. The whole scope moves together.

**Export.** After `beginSwitch(scope, deviceId, 'L', revision)` and the drain of each device,
`exportScope(scope, devices, clock)` runs in one transaction under the scope lock: it reads the scope, seals it
(`sealSwitchExport`) and writes the export mark `scope.switch_export`. It refuses:

- a device that has no open switch away from H at its revision, or still has open work (`DeviceSwitchRefusedError`);
- a live Bot on a device it does not name, and every other state the format refuses (`SwitchExportError`);
- a pending projection: the outbox sender flushes it first, since H's receiver deduplicates by `(scope, id)`;
- a card row with a connector call in flight, and a pending Host job, which would run while the export waits;
- an intent with no conclusion, and a stored copy that differs from the value it is derived from, with `reference`: an
  intent's `agent` (K4 `agentKey` with the scope), its task id and frozen input, a routine row's id, a promoted
  occurrence with its own conclusion, and a Host job occurrence with no outbox row.

Each intent moves with the execution facts of its earlier generations (`intent_execution`), which only an import writes:
H's own rows are generation 0. The message receipt of each generation is the K8 accepted reply of its task id, live or
retained (#975 D4). Its retry policy is
the `retry` column: H's own rows store K4's one-attempt policy, since H never retries. A Host job's `attempts` are its
outbox row's `tries`. Routines and occurrences move in the order of their ordinals, as their positions; an intent keeps
its ordinal. The sections are sorted in JS, so no database collation can reorder them. Not moved: the scheduler cursors
of a concluded row (`tries`, `next_at`, `reconcile_at`, `last_error`), settled projection rows, and the delivery, card
and home index rows, which the target rebuilds from the state.

**The fence.** From the mark on, also after a restart and after the commit, H writes nothing to the scope. Each write
transaction of `inSchema` that locked an exported scope throws `SwitchExportedError` (`code: 'switch_exported'`) right
before its commit, so the work's own refusals come first, as on L: a command on the frozen device still gets
`DeviceSwitchingError`, and after the commit `DeviceBindingError` with `mode`. That covers every store method, the
submitter, the reconciler, the outbox sender, retention and compaction, the routine fire and upkeep, the device observer
and the reply checker. `lockScope` refuses to run outside such a transaction, so no writer skips the check. Only the
switch steps pass: `exportScope`, `commitSwitch` and `abortSwitch`. The due, routine, submit, reconciliation and outbox
scans leave an exported scope out. The due and routine backoff writes take no scope lock and do not write to an exported
scope: the due backoff updates the scope row itself, and the routine backoff first takes a share lock on the scope row,
so it waits for an export in flight and reads its mark. An outbox row of a scope exported after the sender's scan is
reported failed and gets no wait, and the pass goes on with the other scopes.

H reads no tombstone expiry and deletes no tombstone. K4's admission readers do not read the expiry either; K4
`compact` does, and deletes expired tombstones. Only K4's routine kinds expire (an occurrence intent, a slot, an applied
outcome), and H compacts no routine intent and no occurrence, so a tombstone H holds with an expiry stays as it is and
moves on with that expiry.

**Commit away.** After the new owner imported and verified the export, `commitSwitch(scope, deviceId, revision,
receipt)` checks the receipt against the mark and `deviceId` at `revision` against the export's devices, seals the scope
again under the export's header, and refuses a different digest. It then moves every device of the export to L in one
transaction, each on its frozen revision and only with no open work, so a domain is never split between the owners. An
abort of a device of the export ends the export and lifts the fence; the new owner discards its import. After the commit
no device of the export aborts.

**Ordering.** The receipt is the export's digest, and nothing between the two Hosts proves that the target imported it:
there is no authentication between them. The product runs the steps in order and keeps the document:

- The old owner commits away only after the target reported its import verified.
- The export document is kept until the target committed toward its owner.
- If an import is lost after the old owner committed away, the kept document is imported into a new tenant or scope.
- From the export on the old owner refuses all work, so two owners never run the domain at the same time.

## Owner switch import (#975)

H becomes the owner of an L domain only through an import into a new scope, as L does for an H domain (K8 `./switch`). No
H switch step goes toward H.

1. `importScope(scope, document, clock)` verifies the L export and writes it into `scope`, which must have no row yet
   (a switch to H opens a new scope), in one transaction: the K8 state through the store's own writer, the rows of each
   section, each device of the export in mode L at revision 1 (owned by the old owner), and the import record
   `scope.switch_import`. Before the transaction commits, the scope is read back with `hostedSwitchContent` under the
   document's header and must seal to its digest; otherwise it throws `SwitchExportError` with `manifest` and writes
   nothing. So an import is either verified or not there. It returns the receipt `{ digest, devices }` that the old
   owner commits away on.
2. After the old owner committed away, `commitImport(scope, digest)` gives H each device of the import (mode H at
   revision 2), deletes the import record and writes the scope's due time.
3. `discardImport(scope)` deletes an import that is not to be committed: every row of the scope and the scope row, in
   one transaction. A committed scope has no import record, so it is refused.

From the import until its commit no work runs on the scope. Each write transaction that locks it throws
`SwitchImportedError` (`code: 'switch_imported'`) right before its commit, after its own refusals: a write that adds
execution on a device of the import refuses with `DeviceBindingError` and `mode` first. The due, routine, submit,
reconciliation and outbox scans leave it out. Only the import steps pass, and the scope takes no switch away before its
commit (`exportScope`, `commitSwitch` and `abortSwitch` throw `SwitchImportedError`). The record is written only with a
new scope row, so the backoff writes, which follow a scan of an existing scope, never meet one.

The import writes each derived value from the format: `agent` with the new scope, the task id of every generation, and
the outbox row of each Host job occurrence. That row's `tries` are the job's attempts; it is settled at the import time
once the occurrence has a conclusion, and due at once while it is pending, so a pending Host job of the export runs after
the commit. The delivery, card and home index rows are rebuilt from the state, so a moved unsent home write is sent
after the commit. A concluded intent gets H's cursors of a new row: no tries, no backoff, no readback time and no
`last_error` (#975 D6). Routines and occurrences go in the order of their ordinals.

An L intent may have been retried, and K4 opens a generation for each retry (#975 D1). The import keeps its generation
and the execution facts of each earlier one in `intent_execution`; their message receipts are the K8 accepted replies of
their task ids, as for the current one. A message for an earlier task is answered as K4 answers it (see Message
consumer), intent compaction deletes the earlier generations with the intent, and the reply check reads a delegation
chain end's current task, as L does. `memoryBlocked` and `slotReplayCount` move as they are; H writes neither itself.

**Ordering.** The receipt is the export's digest, and nothing between the two Hosts proves that H imported it: there is
no authentication between them. The product runs the steps in order and keeps the document:

- L commits away only after H reported its import verified.
- The export document is kept until H committed its import.
- If an import is lost after L committed away, the kept document is imported into another new scope.
- From the export on L refuses all work, and H runs none before `commitImport`, so two owners never run the domain at
  the same time.

## Retention

`HostedCollaborationStore.retain(scope, input, limits)` runs K8 `retainRoots` (#798) in one transaction under the
scope lock, as L `retainInLedger` does. The acknowledged roots move into `archived_row`, their Turn, input, round and
root ids are retired in `retired_identity`, and every moved command record answers replays until it expires
(`retentionMs`, at least seven days). A refusal or a throw writes nothing.

- The rule is synchronous, so the store loads what it can read first: the expired command records, the root tombstones
  of the acknowledged roots and of the records' roots, and the intent rows. A read outside that set throws.
- A moved command record leaves the `command` table in the same transaction. Only command records expire.
- The commit, the message consumer and the terminal transaction read a moved record by its id for a replay, and refuse
  a retired id at admission, as L `commitInLedger` does. The sync fails a Turn whose id was retired (`turn_retired`).
- An accepted Agent message stays accepted for an exact replay after retention. The consumer checks the task's reply
  in the state or in `archived_row`, where retention keeps it with no expiry, as K4 keeps its receipt. A refused message
  replays from its moved record until the record expires, as in L.
- Retention keeps every intent row, settled or not. Only an operator compaction removes one (see Intent compaction).
- The namespace and id of each archived row, and of each row read (a moved command record or a tombstone), are checked
  against the K4 limits (128 and 1024 characters), as K4 checks every row read in L.
- A scope with no row has nothing to retain: the call returns zero counts and writes nothing, as L does on an empty ledger.

### Intent compaction

`HostedCollaborationStore.compactIntents(scope, { acknowledgedTurnIds })` removes settled intent rows (#793 S8), as K4
`compact` removes settled intents in L. The operator calls it; nothing runs it automatically. One transaction under the
scope lock does all of it, and a refusal or a throw writes nothing.

- The K8 rule `compactVeto` checks each acknowledged Turn with an intent row, the rule that L's `botCompactVeto` runs:
  the Turn is concluded and reported, no unresolved delegation references it, its room seat is released, and its reply
  receipt is settled. A refusal throws K4's `CompactVetoError`.
- The store refuses a row with no conclusion, and a Turn id with neither a row nor an intent tombstone.
- Each removed row leaves a permanent intent tombstone in `retired_identity`, kind `intent` with K4's intent id
  `hash(turnId)`, as K4 `compact` writes it. A later call counts that Turn as already compacted. `freezeIntent`
  refuses the Turn with K4's `RetiredIntentIdentityError`, and the sync fails a Turn that never saw its result as
  `result_retired`, as L does.
- It does not cover routine intents, and refuses them. K4 compacts a routine intent with its occurrence, retiring the
  slot and giving the intent tombstone the slot's expiry, and H does not compact occurrences.
- After compaction, an Agent message for the task is refused as `unknown_task`, because its frozen input left with the
  row.

## Routines

H stores K4 routines and occurrences and runs the K4 and K8 routine rules on them (D2f-2). Its scheduler records the
occurrences (D2f-3).

- Each transaction loads a K4 slice under the scope lock: every routine of the scope in insertion order, and its open
  occurrences. An occurrence is open when it has no intent and no conclusion, or when its intent `occurrence:<key>` has
  no conclusion. H runs the K4 rules on the slice and writes back what changed. It drops the K4 fields that it does not
  store: the wake outbox, `attempts`, `slotReplayCount`, `ignoredWakes` and the conclusion copied onto a promoted
  occurrence.
- The terminal transaction runs a Turn's `create_routine`, `update_routine` and `cancel_routine` actions with the
  store's own ports, before the conclusion, as K4 runs `applyOutcome` before `settle`. They use the K8 Bot policy and K4
  `routineCommands` with the K8 calendar.
- `updateRoutine(scope, botId, action, now)` and `setRoutineLifecycle(scope, botId, id, lifecycle, now)` are the owner
  API for the Main Bot's routines, as in L. The caller names the acting Bot, and it must be the Main Bot.
- The keyless K8 `end_routine { botId, routineId }` command, through `commit`, completes any open Bot routine, an archived
  owner's too, as L `endRoutine` does (§55c). The store loads the slice for it and owns its `routines` port, so a caller's
  port never reaches the command. A new acceptance writes the slice back and switches each due version of the scope, as
  the owner API does.
- A Bot and the owner add only `bot-routine` routines. Host code adds summary-only Host job routines (#793 S14, see Host
  jobs). An execution-template routine is refused: no K8 Turn could settle its intent.
- Each transaction that can conclude routine work then switches a staged version that is due: the claim expiry, the
  sync, the reconciliation conclude, the terminal transaction and the owner API. K4 does this after each drain; H has
  no drain.
- Retention refuses a routine root while its occurrence is open, as L does.

### Sealed routines

H runs the K8 sealed Bot routines (#953, #654 E3d-4; K8 README, Sealed Bot routines) on its cloud tenant.

- `createSealedRoutine(scope, botId, action, now)` adds version 1 of a sealed routine of the Main Bot `botId`, with
  the template that the owner's member endpoint sealed for it. `resealRoutine(scope, botId, action, now)` stages the
  next version with a new template. The entry has both as owner commands, which sync after the write, as
  `updateRoutine` does. Both check the template against the Bot's current execution template, with K8
  `sealedDefinition` and `resealDefinition`.
- A retry after a lost response is a no-op while the version it made is still there: a create retry while version 1
  is the routine's definition, and a reseal retry while its version is the current or the staged one and the routine
  is not completed. Later, the retry is refused like any other command: `A routine already has this id` once version 1
  was replaced, or the owner check once the routine is completed. A reseal retry is a no-op even after the Bot's Agent
  changed. The member learns of that change from the `sealed-routine-failed:<turnId>` projection
  (`sealed_routine_agent_changed`) at the next occurrence, and reseals then.
- A reseal for another version than `max(current, pending) + 1` throws `SealedRoutineVersionError`, and nothing is
  written. `updateRoutine` refuses a sealed routine.
- The template lives in the `routine` row's `definition` or `pending` JSON. Once frozen, the sealed offer input lives in
  `intent.input`. There is no DDL change and no second copy.
- The sync passes K8 the template of each routine version, from the slice. A sealed occurrence intent goes through
  `FrozenSubmitPort.submitSealed`, the cloud's `submitSealedAgentExecution`. On a port without it, the submitter fails
  an untried sealed row before any SDK call, as K4 `begin` does in L: the intent ends `failed`, the row keeps K4's
  `preparation_error` `sealed_dispatch_unavailable`, and the agent's queue moves on. The submitter reports the scope through its `changed` option,
  and the deployment's sync then ends the Turn `failed`. A tried row may have reached the SDK, so it
  keeps its resubmit until `wait_until`.
- K4 `enqueue` refuses every sealed execution. H's `freezeIntent` takes one only from the sync's freeze of a promoted
  routine occurrence: source `routine` and no handler, so a Host intent never carries one.

### Scheduler

H has no SDK wake. `HostedRoutineScheduler` finds due slots in `routine_due` and fires each one through
`HostedCollaborationStore.fire(scope, id, now)`, in its own transaction under the scope lock:

- The store re-reads the routine. One that is not active, or whose slot is not due, is skipped with nothing written.
- The fire can create execution, so the owner Bot's device must have an active H binding, read from the same state
  that the sync builds the routine offer from. Otherwise the fire throws `DeviceBindingError` and writes nothing, and
  the slot stays due. When the Bot moves to a bound device, a later pass fires the slot as `catch_up`. An archived owner
  Bot skips this check: its routine Turn creates no execution, because the sync ends it as `cancelled` before any freeze,
  as L does. A revoke and an archive are both final, so with the check that slot could never fire.
- K4 `recordOccurrence` runs on the slice, with the wake built from the locked row. The K8 `occurrence` command adds
  the routine Turn with no command record, as in L: the slot is the replay guard (`UNIQUE (scope, routine_id,
  definition_version, planned_at)`). The occurrence row, the routine's next slot, the routine Turn and the supersede of
  earlier work commit together. An earlier untried intent concludes `superseded`; a tried one keeps running with its
  `retry_until` bounded by the fire time. An earlier occurrence with no intent is marked superseded, and its later
  promotion settles at once.
- A fire runs no version switch: its new occurrence stays open, so K4 `versionSwitchDue` is false for that routine.

`run()` is one pass. It reads due rows in slot order in keyset pages. Only fires count against `batch` (default 100),
so fenced rows and failed rows cannot fill it. A fenced fire (`pass.fenced`: no active binding, or a device frozen for a
switch) and a fire that throws (`pass.failed`) write
nothing but the routine's `retry_at`: it waits `backoffMs` (default 60 s) before its next try, because a stuck row
keeps its old slot, which sorts ahead of every healthy row. The wait is in Postgres (#794 H1), so every scheduler
instance and process keeps it. It holds only for that slot: the store write that moves `next_at` clears it. Each fire
reads the clock, as K4 does when it consumes a wake; the pass time only selects the due rows. The pass also sets `ok` on
a `schedule_retrying` routine once its slot is within the K4 horizon, as K4 `scheduleNext`.

`start()` runs once when the scheduler starts, as K4 `recover`: an active routine with no slot within the horizon is
planned again, and a staged version that is due switches.

H has no timer. The deployment reads `scheduler.intervalMs` and runs `run()` at that interval. The default is 5 s, and
the constructor refuses an interval at or above the K8 late bound (`ROUTINE_LATE_AFTER_MS`, 60 s): with a longer
interval every slot would fire as `catch_up`, and its occurrence key would differ from L's.

- The due query leaves out the rows that wait, so they cannot fill a page. Postgres still reads them through
  `routine_due` and drops them by `retry_at`. Their fire transactions run once per `backoffMs`.
- A routine that waits fires late. Its next try records `catch_up` when the wait ends past the K8 late bound.
- A promoted occurrence keeps `conclusion IS NULL` for good, so `occurrence_open` holds every promoted occurrence of a
  routine. The slice load still scans that history for the unpromoted open rows, so a fire costs more as the routine
  ages. A fix (a `promoted` flag, or moving unpromoted rows) is a DDL change.

## Due scheduler

Each store transaction that loads a scope's state writes `scope.due_at` from the state that it commits: the earliest time
that the K8 rule `collaborationDue` gives, or NULL for none (#793 S4). The rule is L's timer list: each open input batch's
seal, each pending card's expiry, each unreleased seat's deadline, and the delegation times (the reply checks, the cancel
grace and the uncertain timer). Routine slots are not in it: `routine_due` holds them. The write is skipped when the time
did not change, so a step that keeps it does not rewrite the scope row. A sync returns the time that it wrote
(`{ dueAt }`).

`HostedDueScheduler.run()` is one pass over the scopes whose time has come (`scope_due`), in due order, in keyset pages.
It calls the deployment's `sync(scope, now)`, which runs `store.sync` with the deployment's sync options, and reads the
clock for each sync; the pass time only selects the scopes. Only syncs that resolve count against `batch` (default 100).

- A sync that leaves the scope due is reported in `stalled`, for example a reply check time when the deployment's
  `sync` does not run `HostedReplyChecker` first. A sync that
  throws is reported in `failed`. With the composed `sync` (the reply checker, the device observer, then
  `store.sync`), each reply settle and the device observation commit in their own transactions: if a later step or
  `store.sync` throws, the earlier steps of that pass stay committed, and one step never writes partly. Either scope waits `backoffMs` (default 60 s)
  before its next sync, so it is synced at most once per backoff, and each pass reports it again when it is retried. The
  wait is `scope.retry_at` (#794 H1), keyed on the due time the scope still has, so every scheduler instance and process
  keeps it. A store transaction that moves `due_at` clears it, so the new work is due at once.
- H has no timer. The deployment runs `run()` on its own interval, which bounds how late a due step runs in a scope that
  is not stalled. A stalled scope keeps the due time that H cannot clear, so each of its other due times can run up to
  `backoffMs` late.
- Stalled and failed scopes sort first, because their due time has passed. Only a stalled scope uses up the batch: its
  sync resolves, so it counts. Once there are about `batch × backoffMs / interval` of them (1,200 with the defaults and
  a 5 s interval), each pass spends its whole batch on them, and a fresh due scope waits. A failed scope (a sync that
  throws, for example a settle that keeps throwing) does not count, so the pass pages on to the fresh due scopes. It is
  retried once per `backoffMs`, and each retry adds the time of a failing sync to the pass. Postgres also reads every
  backed-off due row through `scope_due` and drops it by `retry_at`. So H must run every step that clears a due time before it deploys.

## Outbox sender

`HostedOutboxSender.run()` is one pass over the unsettled outbox rows that are due, across scopes (`outbox_due`). Each row
runs in its own steps, and a failed row does not stop the later rows. A scope of an unknown store version is left out
before the limit. The outbox DDL is the D2b-out plan text, signed by the owner (§54a), widened for card, home and Host
job rows by the #793 plan §6 text, signed too. Each claim and settle reads the clock after
the scope lock. After a step that threw, the row waits `backoffMs`. That wait never moves `next_at` earlier, so it cannot
shorten the lease of a newer claim. If the wait cannot be written, `run()` rejects and that pass's result is lost.

- **Projections** are sent at least once, as K4's projection flush. A claim raises `tries` and takes a lease under the
  scope lock; the receiver call runs with no lock; the settle is fenced by that `tries`, so a stale settle after another
  claim changes nothing. A receiver error keeps the row with `last_error` and waits `backoffMs`. The wait is flat, where
  the plan grows it with `tries`: K4 tries again at each flush with no wait, and the receiver deduplicates, so one wait is
  enough to keep a broken receiver from a call on every pass. **The receiver must deduplicate by `(scope, id)`**: a crash
  after the call and before the settle sends the same value again. A sent projection keeps its row with `settled_at`,
  where K4 deletes it (design §5 D2: the same record is updated). So a projection id published again with another value
  throws `Projection identity conflict` for as long as the row is kept, where K4 takes the new value once it has sent the
  old one. K8 publishes each id once (plan §3.3). On L this is checked by every K8 vector: no L vector subject flushes its
  outbox, so K4 `project` throws `Projection identity conflict` for any id that a vector publishes with two values.
- **Deliveries** run the K8 delivery rules (`channel.ts`, `delivery.ts`, `delivery-routing.ts`) through the store, as L's
  `flushDeliveries` does: the claim (`startDelivery`) commits before the send, the route with its reply token stays in
  memory, and the settle (`settleDelivery` or `unknownDelivery`) is fenced by the attempt. A claim whose lease passed
  becomes `unknown` (`interrupted`), as L recovers a claim at startup. The lease, not a startup sweep, gates it, because
  several senders can run at once. **The lease must be longer than `sendTimeoutMs`** (the constructor refuses it
  otherwise). An `unknown` row is read back at the next pass when the channel has a readback, and `readbackMs` after
  each readback that leaves it `unknown`. With no readback it waits an hour: only an echo or a manual resend changes it.
  A readback claim takes the same lease, so one sender reads a row back at a time. A readback result counts only for the
  attempt that it read back (K8 `readbackDelivery` takes that attempt). A readback that throws or outlasts
  `sendTimeoutMs` is missing evidence: the row stays `unknown` and waits `readbackMs`, but only while it is still
  `unknown` at that attempt. L awaits a readback with no deadline. The claim returns its lease (the `next_at` it wrote),
  and the readback's wait is written only while the row still holds that lease. So a readback that outlasted its lease
  leaves the lease of a later readback claim alone: no sender claims a readback while a later claim's lease holds (#793 S2).
- **The K8 delivery entity is the authority.** The outbox delivery row is a scan index that one hook in each store
  transaction writes from the entity diff: a row for each new delivery, `settled_at` once it is `accepted` or
  `rejected`, and `next_at` for a `pending` one. So the push fallback that `refuseRoute` inserts with no outbox intent
  gets its row too. A seed writes no outbox row.
- **The store owns the channel outbox port.** With `{ channel: true }`, a K4 callback (an Agent message or an outcome)
  queues its deliveries with K8 `queueDelivery`, which reads the intent conclusions of the scope as they were before
  the transaction wrote, as L reads its committed ledger. No caller supplies `deliver`.
- The sync and each delivery settle drop expired or unneeded reply tokens (`cleanReplyTokens`). L's sync does it too;
  L's call in each flush pass is a call in each delivery settle here. H drops an expired token at the next sync or settle
  of its scope.
- **Inbound** (`receive(scope, message, identity, clock)`, #793 D2b-out-3) is L `receive()`. K8 `classifyInbound` sorts
  the message by the Host's channel identity (`owner`, and the Host's own bot ids by channel in `self`). The identity is
  Host configuration from verified identity, never a field of the message:
  - an `echo` settles the one delivery it names, by `deliveryId` or by platform message id (K8 `echoCandidates` and
    `acceptDeliveryEcho`), under the scope lock, or writes an `unmatched_echo` audit line; the reply tokens are cleaned in
    the same transaction. An echo never creates input;
  - `owner_input` and `room_input` run the K8 `receive` command under the command id `hash(['receive', inboundKey])`, so
    a redelivered event replays. With `{ channel: true }`, the store keeps the inbound and its reply route (K8
    `rememberInbound`);
  - `bot_background` runs the K8 `room_input` command of a bot with no mention, as L `roomInput` does for a bot;
  - any other kind writes only an audit line, one for each delivery, as L.
  The store owns the `remember` port: `commit()` refuses the `receive` command with `InboundCommandError`.
- An unsettled delivery row whose entity is not in the state fails as drift (`Delivery outbox row unsettled for an
  archived entity`) and waits `backoffMs`, as a row with no entity anywhere does (`Delivery not found`). Nothing is
  settled for it.
- Retention refuses a root while an outbox row of one of its deliveries is unsettled. It is a drift guard: the
  transaction that settles a delivery entity settles its row too, so no product path reaches it. Projection rows are left
  out: a projection row carries its own value and belongs to no root.
- **Card calls** (#793 S12) run L's `flushCards` on the K8 card rule (`cardCallDue`, `settleCardCall`), with the outbox
  claim, lease and fence of §54c A. The K8 card is the authority; its outbox row (`kind = 'card'`, key
  `["card", cardId]`) is a claim index that the same entity-diff hook as the delivery index writes: a row, due at once,
  when a card starts to wait for its call (it was confirmed), and `settled_at` when the call has an outcome.
  - `store.claimCard` takes a try and a lease (`next_at = now + leaseMs`) under the scope lock, while the card still
    waits. The connector runs with no lock, with an abort signal and `connectorTimeoutMs` (default 30 s, as L), and
    `store.settleCard` writes its result or error (cut to 1024 characters) and conclusion, fenced by that try and by the
    card still waiting. A connector error or timeout is the card's outcome, as in L, not a failed step. A settle that
    finds another claim's try changes nothing.
  - **A connector runs at most once per card, in H as in L (#958).** A row that already had a try belongs to a claim
    whose lease passed with no settle (the sender stopped after the call, or its settle failed). The call may have run,
    so the next claim ends the card with K8's `CONNECTOR_OUTCOME_UNKNOWN`, `Connector timed out; external outcome is
    unknown`, and never calls again (owner Q3 A).
  - **With a connector, the lease must be longer than `connectorTimeoutMs`** (the constructor refuses it otherwise). A
    Host with no connector fails a card row and waits `backoffMs`. A row whose card is gone settles with no call.
  - Each settle, and each claim that ends a card, reports its scope once per pass through the `changed` option, so the
    deployment syncs it: that sync reports the card and freezes its `action_result` Turn.
- **Agent home operations** (#793 S13) run L's `flushHomes` on the K8 home rules (`team.ts`: `homeHead`,
  `checkHomeReadback`, `planHomeRetry`, `homeEnqueued`, `applyHomeTerminal`, `failHomeFlush`). The K8 operation is the
  authority and the fence; its outbox row (`kind = 'home'`, key `["home", sequence]`, `tries` always 0) is a scan index
  that the same entity-diff hook writes: a row for each new pending operation, due at its `retryAt` (at once when unset),
  `next_at` again whenever `retryAt` changes, and `settled_at` once the operation is `applied` or `failed`.
  - `store.claimHome` checks, under the scope lock, that the operation is its Bot's oldest pending one and that the Bot
    has no intent row with no conclusion (K8 `homeHead`, as L). Otherwise the row waits `backoffMs`. A head takes a lease.
  - With no lock, the sender reads back every request of the operation in order through the scope's `homes(scope)` port
    (the SDK `getAgentHomeProjectionStatus`) and checks each with `checkHomeReadback`; a mismatch is `Home readback
    identity conflict`. `store.settleHome`, fenced by the operation still pending with the claim's retry count, then
    applies a terminal (`applied` or `idempotent` readies the Bot; any other status fails the operation and publishes
    `persona-failed:<sequence>`), or plans the retry (`planHomeRetry`, a new durable request id once `retryAt` passed). The
    sender then enqueues the latest request (the SDK `enqueueAgentHomeProjection`) and runs `homeEnqueued`. The claim's
    lease holds the row through that enqueue: the settle that plans a retry keeps it, and `homeEnqueued` moves the row to
    the operation's `retryAt`, so no other sender enqueues the same operation meanwhile.
  - Each read and the enqueue get `sendTimeoutMs` or the time left on the claim's lease, whichever is shorter, and no call
    is made once the lease has passed (`Home flush outlasted its lease`). So every call of a flush ends within its lease.
    A read or enqueue that throws, outlasts its deadline or is not made is the operation's error (`failHomeFlush`): it
    stays pending and is looked at again when its lease passes. L awaits these calls with no deadline.
  - **H enqueues at `retryAt`; L enqueues again at each pass.** The enqueue is idempotent by request id, so H skips L's
    repeats before `retryAt`. A Bot whose intent kept it waiting is looked at again `backoffMs` after the last look; L
    looks at its next pass. In one H pass a Bot's next operation can be flushed right after the one before it settles;
    L flushes at most one operation per Bot in a pass.
  - A terminal reports its scope through the `changed` option, so the deployment syncs it and the Bot's waiting Turns
    freeze. A Host with no home port fails a home row and waits `backoffMs`.
- **Host jobs** (#793 S14) run K4 `runHostJobs` for one occurrence, with the claim, lease and fence of a card call. The
  handlers are the store's `hostJobs` option, by type, as L's `hostJobs`: the store checks a Host job routine against them
  and the sender runs them, so a deployment registers each type once. See Host jobs.
- Reply readback is not in the sender (§54c A).

### Host jobs

L runs a Bot routine and a summary-only Host job on one K4 core (K8 `routines.test.ts`). H runs both, in the store and
the outbox sender; there is no separate job runner.

- **Host code owns the routine.** `addHostJobRoutine(scope, definition, now)`, `updateHostJobRoutine` and
  `setHostJobLifecycle(scope, id, lifecycle, now)` are L's `core.addRoutine`, `updateRoutine` and `lifecycle` for a Host
  job, through K4 `routineCommands` with the store's handlers and the K8 calendar. No Bot command or entry reaches them.
  They take only Host job routines; the Bot and owner paths take only `bot-routine` routines, so a Host job stays out of
  the Bot policy (`owned`, `endable`, the ContextPack routine views).
- **The scheduler fires it.** A due slot records its K4 occurrence (`recordOccurrence`), with no K8 command and no device
  fence: a Host job creates no execution. The occurrence row gets `job = {}`, and an outbox row (`kind = 'host_job'`, key
  `["host_job", occurrenceKey]`, due at once) takes the place of K4's `host-job:<key>` row. A later slot of the routine
  marks a pending job `execution_superseded`, as K4 does.
- **The sender runs it.** `store.claimHostJob` takes a try and a lease under the scope lock while the occurrence is open;
  the try is the K4 `attempt`. The handler runs with no lock, with an abort signal and `hostJobTimeoutMs` (default 30 s;
  L has no deadline). The sender then checks the result as K4 does (a summary is required and must be JSON), and
  `store.settleHostJob`, fenced by that try, writes it:
  - a summary is stored (`job = { summary }`) and concludes the occurrence `succeeded`;
  - **a result that carries `execution` stores its summary and concludes the occurrence `failed`**, with
    `host_job_execution_unsupported` as the row's `last_error`, and the pass reports it as the row's failure. Nothing is
    promoted, whether the occurrence was superseded or not (owner Q4 A). L concludes it the same way through K4
    `hostJobExecution: 'fail'` (K5); K4 alone promotes it by default;
  - a handler that throws, times out or returns no JSON summary keeps the occurrence pending: the row keeps the error in
    `last_error` and waits `backoffMs`, as K4 keeps the row for its next pass. A later success clears `last_error`.
  A settle that concludes switches a staged version that is due. A settle that finds another claim's try changes nothing.
- **A handler runs at least once.** A claim whose lease passed with no settle runs the job again with the next attempt,
  as K4 retries pending work after a restart. A handler must tolerate a second run of one occurrence.
- **With Host job handlers, the lease must be longer than `hostJobTimeoutMs`** (the sender refuses it otherwise). A store
  with no handler for the type fails the row with `Host job handler not registered` and keeps the occurrence pending.

## Deployment config

H is not deployed yet (see Status). A deployment composes these parts. For the tests, `hosted-cloud.test-support.ts`
composes the SDK side (the Postgres and object stores, the token signer and a paired daemon) and the SDK task port (submit, readbacks, cancel); the
message consumer tests (`messages.test.ts`, `retention.test.ts`) build `hostedMessageConsumer` themselves.

- **Database.** One Postgres database. The store takes its own `pg.Pool` and its own schema
  (`new HostedCollaborationStore(pool, schema, { host })`), and `migrate()` creates the H tables there. The SDK tables come from
  the `@byok-sdk/cloud-dataplane` migrations (`migrate(pool, migrationsDir())`), in the same database or another one.
  No path assumes one atomic commit across the two (see Database). A scope row of an unknown store version is refused.
- **Host config.** `host(scope)` resolves to the scope's model templates (each with the user's own device) and read-only
  toolsets, as L's `models` and `readOnlyToolsets`. Every store over one schema must be built with the same `host`. It
  returns a Promise, so a product reads the one scope's record when it is asked. Each store method awaits it once and
  never while it holds a connection, so the product may read it from the store's own pool.
- **Object storage.** The SDK stores need an S3-compatible endpoint: `objectStorage` with `endpoint`, `bucket`,
  `accessKeyId`, `secretAccessKey`, `region` and a `signingClock`, passed to `createPostgresCoreStores` and
  `createPostgresCloudStores`. H stores no objects itself.
- **Host auth.** The Host resolves each request to the product user that owns it, and passes that user's scope. One
  scope belongs to one SDK tenant: the submitter's, reconciler's and reply checker's `port(scope)` and the message
  consumer's `scopeOf(tenant)` are inverse maps, and that map is the tenant check (see Message consumer). A command for another
  scope is a `scope_mismatch` conflict. A K4 callback command from the entry is a `CallbackCommandError` (see Commit
  store). `HostedCommandEntry` takes the Host's session check as `authenticate` (see Command entry).
- **Enrollment.** A device pairs with the SDK through a pairing code (`cloud.createPairingCode(tenant, { productId })`).
  The Host then binds it to H with `bindDevice(scope, deviceId)`, and `revokeDevice` ends that binding for good (see
  Device binding). Each tenant needs a storage entitlement (`core.quota.writeEntitlement`) before a mailbox append.
- **Signing.** `createByokCloud` takes a `tokenSigner` (for example `createHmacTokenSigner(key, clock)`) and a `crypto`
  port (`createWebCrypto()`). The key is a deployment secret; H never reads it.
- **Retention.** The Host calls `retain(scope, input, limits)` with the acknowledged roots. `retentionMs` must be at
  least seven days (see Retention). The SDK side has its own `retentionPolicyId` in the tenant's entitlement.
- **Intent compaction.** The operator calls `compactIntents(scope, { acknowledgedTurnIds })` for settled Turns; routine
  intents stay (see Intent compaction).
- **Workers.** The Host runs, each on its own interval: `HostedSubmitter.run()`, `HostedReconciler.run()`,
  `store.sync(scope, …)` for each scope that changed (the `changed` option of `HostedReconciler`, for a conclusion or
  a first claim, of `HostedSubmitter`, for an intent that it concluded with no SDK call, and of `HostedRoutineScheduler`,
  for a fire, and the scope of each commit and consume),
  `HostedDueScheduler.run()` for the due scopes, `HostedOutboxSender.run()` with the projection receiver, the channel, the
  connector and the home port (and `store.sync(scope, …)` for each scope of its `changed` option),
  and `HostedRoutineScheduler.run()` every `intervalMs` after one `start()`. A Host with a channel opens its store with
  `{ channel: true }`, a Host that coalesces inputs with `{ coalesce }`, and a Host with its own delegation timers with
  `{ timers }`. Every store over one schema must be built with the same `timers`, because each writes `due_at` with its
  own.
- **Reply checks.** The due scheduler's `sync` runs the reply checker first. `tenantOf` is the deployment's map from a
  scope to its SDK tenant (see Host auth):
  ```ts
  const checker = new HostedReplyChecker(store, { port: scope => ({
    agentMessage: (taskId, deviceId, agentRef) => cloud.readTaskAgentMessage(tenantOf(scope), deviceId, taskId, agentRef) }) });
  const devices = new HostedDeviceObserver(store, { port: scope => ({ readiness: () => cloud.readTenantReadiness(tenantOf(scope)) }) });
  const due = new HostedDueScheduler(pool, store, { sync: async (scope, now) => {
    await checker.check(scope, now);
    await devices.observe(scope);
    return store.sync(scope, { ...syncOptions, now });
  } });
  ```
  `hostedMessageConsumer(store, …)` is the `agentMessage` option of `createByokCloud`.
  The checker reads one due check at a time, each with a `timeoutMs` limit (default 10 s), and the due scheduler syncs
  scopes one at a time. During an SDK outage one pass can take up to the number of due checks in its batch times the
  timeout, which delays the due steps of other scopes. A timed-out read is not cancelled. A failed read backs off, so
  there is no hot loop.
- **Outbox sender ports.** The card connector is the Host's own (as L's `connector`). The home port binds the tenant's SDK
  Agent home calls for the request's device:
  ```ts
  const sender = new HostedOutboxSender(pool, store, { projections, channel, connector,
    homes: scope => ({
      read: request => cloud.getAgentHomeProjectionStatus(tenantOf(scope), request.deviceId, { requestId: request.payload.requestId,
        agentRef: request.payload.agentRef, projectionHash: request.payload.projectionHash }),
      enqueue: request => cloud.enqueueAgentHomeProjection(tenantOf(scope), request.deviceId, request.payload),
    }),
    changed: scope => { void syncScope(scope); } });
  ```
  The device must install the Host's persona hook as its Agent home projection consumer, or it does not advertise
  `agent-home-projection` and the SDK refuses the enqueue (the operation keeps the error).
- **Host jobs.** The store takes the Host job handlers (`{ host, hostJobs: { watchlist } }`), and the sender takes their
  deadline (`hostJobTimeoutMs`). Host code adds each routine once with `addHostJobRoutine`. Every store over one schema
  that a sender or the scheduler uses must have the same handlers.
- **Host intents.** The store takes the Host intent handlers (`{ host, hostIntents: { research } }`). Every store that a
  reconciler uses must have them; a missing one keeps the row open as `handler_failed`. The command entry takes
  `failStuckIntent: (scope, key) => reconciler.failStuckIntent(scope, key)`.

## Tests

```sh
docker compose -f docker-compose.test.yml up -d --wait
BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 \
  bun run --cwd examples/hosted-bot-collaboration test
```

Without `BYOK_TEST_POSTGRES_URL`, the Postgres suites skip. The submitter suite also needs
`BYOK_TEST_S3_ENDPOINT` (`http://127.0.0.1:9100` with the compose file), because the SDK composition takes an
object store. With `BYOK_REQUIRE_DATAPLANE=1`, a missing value is a failure. The CI `dataplane` job sets all
three and runs these suites.

- The D1 commit vectors run on the store and on a reference subject (the pure rules in memory).
- The D2b sync vectors run on the store.
- The message consumer tests port the K4 Host-side message vectors (`host-execution-core/src/message.test.ts`).
- The device binding tests use an SDK tenant in memory for the submit checks. The device hold tests (`device-hold.test.ts`,
  #956) cover a refused Bot's Turn held while another Bot's Turn freezes in the same sync, the due time at once after a bind
  that survives another transaction, and a `team_snapshot` that archives the Bot of a held Turn.
- The topology switch tests (`switch.test.ts`, #957) cover each step's revision checks and refusals, a revoke during a
  switch, the typed refusal of each entry during the freeze and after a commit to L,
  a Turn held during the freeze and frozen after an abort, a submit claimed before the freeze, the drain and cancel with a
  tried intent that holds the commit until it concludes, the cancel of a Host intent with no Turn, a routine fire during
  the freeze and after an abort, a new store that reads the freeze, and home flushes during the switch. Each commit away
  exports the scope first and passes the export's digest.
- The switch export tests (`switch-export.test.ts`, #975) move a scope that holds a retained and compacted Turn, a Bot
  routine with a settled occurrence and routine Turn, a Host intent and an unsent home write into a new L tenant: K8
  `importForSwitch` reads it back to the same digest, and H commits away on its receipt. They cover each export refusal,
  a receipt that is not the export's, a scope that changed after its export, an abort that lifts the fence, the refusal of
  each write path after its own refusals with nothing written, the scans that leave an exported scope out, the backoff
  writes of a scan that raced an export, and a scope lock outside `inSchema`. The import tests take a domain from H to L
  and back to a new H scope, and on to a new L tenant, with every section the one that left H. They cover earlier
  generations, a memory block and a slot replay count, the answers to a message of an earlier task, compaction, the reply
  check of a chain end in a later generation, a pending Host job that runs after the commit, an import that does not
  read back and writes nothing, the import refusals, commit and discard, the refusal of each write path on an
  uncommitted import, the scans that leave it out, and the device's work and the moved home write after the commit.
- The K8 retention vectors (`retentionVectors`) run on the store, with H tests for message replays after retention.
- The compaction tests cover a settled intent and its tombstone, an expiring tombstone of the same identity that becomes
  permanent, a repeated call, a refused freeze of a retired Turn, a K8 veto, an unsettled row, an unknown Turn id, a
  routine intent, and the sync's `result_retired`.
- The routine tests seed each occurrence as the scheduler records it. They cover the outcome actions, the owner API,
  promotion, the claim's `retry_until`, the version switch in each writer that concludes routine work, the refusal of
  an execution routine on the Bot path, and the SQL occurrence and intent key fragments against the K4 functions.
- The D2f-1 routine vectors (`routineVectors`) run on the store, with the scheduler fire and a submitter pass on an SDK
  tenant in memory. The `end_routine` tests cover a refusal that writes nothing and a caller's `routines` port.
- The K8 delivery vectors (`deliveryVectors`) run on the store, its inbound entry and the outbox sender, all 21. After each Host step, the delivery outbox index matches the K8 entities. The
  sender tests cover the projection claim, lease, fence, backoff, race, order and version filter, the archived and
  missing delivery entity, the retention refusal of an unsettled delivery row, a terminal delivery on the reply route,
  a hung readback, the clock read after the scope lock, the readback lease, a readback wait fenced by that lease, a failed
  readback fenced by its attempt, a wait that never moves `next_at` earlier, the option checks, and a wait that cannot be
  written.
- The inbound tests cover owner input with and without a channel and its replay, room input and bot background, the
  audit kinds, an echo that names one delivery, none or two, and the refusal of `receive` in `commit()`.
- The scheduler tests cover on-time and late fires, the supersede in the fire, the device fence and its paging, two
  racing fires, a fire that throws and its backoff, the interval guard, and the start and pass upkeep.
- The reconciliation tests run a real daemon for the completed outcome, a replayed terminal and a busy decline. The
  busy decline runs on L too (K4 with the sync rule's wait), and both conclude `declined` at generation 0. An SDK
  tenant in memory covers the cancel, expiry, lease and identity cases, and the scopes that a pass reports.
- The K8 settlement vectors (`settlementVectors`) run on the store, as on L.
- The K8 coalesce vectors (`coalesceVectors`) run on the store, as on L: a busy Bot's inputs join one batch, the window
  and idle seals, a full batch sealed before any sync, and no batch without a policy. H tests add the policy checks, an
  input admission that a caller cannot replace, and an idle seal in a later round of one sync.
- The K8 card vectors (`cardVectors`) run on the store, as on L: the expiry before a freeze, the decision projection once,
  the `action_result` Turn of a rejected card, and a confirmed card that waits for its result.
- The K8 room vectors (`roomVectors`) run on the store, as on L: the first seat queued and frozen, the deadline cancel of
  an unclaimed seat, a claimed seat released late, a concluded seat, and a Bot that left the room with and without an
  intent. H tests add the conclusion of an untried cancelled seat intent, a tried one kept open, a second room step in
  the same sync after a Turn step blocks a seat, and a rollback.
- The settlement tests build each delegation through the product path (an outcome `delegate`, then a sync), and cover
  each verdict, the units, `target_archived`, the timers, the late terminal audit, the Main Bot cancel in the terminal
  transaction, a rollback, the settlement facts, a verdict at the sync of a reported scope, and the store's refusal of
  invalid delegation timers.
- The K8 reply vectors (`replyVectors`) run on the store, as on L: a reply body that the Host holds answers, after a
  pending read and after a read that throws; no message and a refused message fail with `no_reply`; a held message
  holds; a pending read checks again with backoff, not before its time, and becomes `uncertain` after
  `uncertainAfterMs`; a read that throws and an accepted message with no Host record check again. H tests add the due
  check selection, the settle that writes nothing (a stale fence, after the delegation was answered, before the check
  time), two checkers on one delegation, a chain end with no intent row, a read timeout, and a settle that throws.
- The K8 device vectors (`deviceVectors`) run on the store, as on L: a delivered offer on an offline device waits and
  is queued again once the device connects, with one projection each; the same observation again and a device that
  the read lacks change nothing; nothing changes before delivery (no submit, an uncertain submit, no attempt read),
  after a claim (by the attempt or the claim fact), or for a cancel or a verdict. H tests add the `offeredTo` fact of
  the intent row, the readiness read of the scope, no read when no delegation can change, a read that throws or times
  out, and the presence mapping.
- The K8 card call vectors (`cardCallVectors`) run through the sender, as L's `flushCards`: one call for a confirmed card
  with its result, reported with its `action_result` Turn at the next sync and never called again; a connector error cut
  to 1024 characters; a result that is not JSON; no call for a pending or rejected card. H tests (`cards.test.ts`) add
  the card row and its claim before the call, no row for a rejected card, two senders on one card, a connector timeout
  with its aborted signal, the expired lease that ends the card with no call (owner Q3 A), a stale settle, a Host with no
  connector, a card that is gone, and the option check. The outbox DDL test covers the card, home and Host job kinds.
- The K8 home vectors (`homeVectors`) run through the sender, as L's `flushHomes`: an `applied` or `idempotent` readback
  readies the Bot and is read no more; another terminal status fails the operation with `persona-failed`; an identity
  conflict and a read that throws keep it pending with the error; with no terminal the first request is enqueued, and
  once `retryAt` has passed a retry with the next request id and a backoff; a Bot with an open intent waits without
  blocking another Bot; a Bot's later operation is not read while its oldest one is pending. H tests (`homes.test.ts`) add
  the home row of a committed operation (`retry_persona`) with its lease and settle, the row at `retryAt` after an
  enqueue, the lease kept through a retry enqueue, no call after the lease has passed, two senders on one operation, the wait of a busy Bot, a read timeout, a Host with no home port, and, on the
  hosted SDK with a paired daemon, a Bot readied through the real `enqueueAgentHomeProjection` whose Turn then freezes.
- The Host intent tests (`host-intents.test.ts`) port the cases of L's `host-intents.test.ts`: a handler run once in the
  terminal transaction with its projection and the K8 revision kept, and a replay; the enqueue refusals with nothing
  written; an `unknown_intent` row refused and audited once; a failed, an unconfigured and an async handler; the Main Bot
  FIFO held until the Host intent settles; `failStuckIntent` through the entry for a stuck row, a failed handler (run once,
  in the probe), and a Bot Turn whose outcome throws, with its refusals and a probe error; and compaction of a Host intent.
- The Host job tests (`host-jobs.test.ts`) port the cases of K4 `host-jobs.test.ts` through the scheduler and the sender:
  a summary stored once with a settled row and no intent; the Bot policy kept apart from Host code, and the definition
  checks; a handler throw with its backoff and a retry with the same occurrence key; a missing and a non-JSON summary;
  a result with `execution` concluded `failed`, superseded or not; a timeout with its aborted signal; two senders on one
  row; an expired lease that runs the job again with a stale settle ignored; a missing handler after a restart; a version
  switch after the job; pause, completion and no resume; and the option check.
- The due tests check the stored due time against the K8 rule after each seed, commit, sync and finish, a cancel commit
  with the store's timers, a command that throws, a step that keeps the time, and the DDL check. The due scheduler tests
  cover a due scope whose sync clears it, the clock read for each sync, a stalled scope and a failed sync with their
  backoff, the batch in due order, the version filter, and a reply check in the deployment's `sync` that clears its
  check time.
- The command entry tests cover L's command ids and a replay, a sync after each commit, a missing session and a session
  check that throws, the R2 refusals with their audit lines, room input from a human and from a bot, the binding refusal
  (unbound and revoked) that rolls back, a decision conflict after the sync, and keyless commands.
- The sync test freezes the same Turns in an L ledger with K4 `enqueue`. Each H input is byte-equal to the K4
  execution input, and the H state bytes equal the L state bytes.
- The submitter tests use the hosted SDK composition (`createByokCloud` over `createPostgresCloudStores`, with
  the SDK migrations in its own schema), served over loopback HTTP, and a real daemon paired through the
  public pairing route. The intents are frozen directly, because D2b ships no product entry.
- After each step of two command scripts, the store's state bytes equal the reference subject's state bytes.
