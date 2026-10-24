# Hosted Bot collaboration (H)

Private reference example for #793 (#606 D2). It is the hosted (H) adapter of the K8 collaboration
commit contract (`examples/bot-collaboration`, #739 D1), on Node and Postgres.

Status: the commit store, the intent submitter (D2b-1), the sync step (D2b-2), the message consumer (D2c), result
reconciliation (D2d), the device binding (D2e), retention (D2g), routines (D2f-2), their scheduler (D2f-3), the outbox
sender (D2b-out-2) and delegation settlement (D2f-5). The command entry and the inbound echo path come in later slices of #793.
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
- A command reads the intent facts (K8 `CommandPorts.intents`) from the intent rows, under the scope lock, as L reads its
  K4 intents in the commit transaction. A caller's ports cannot supply them. The committed intents of an outcome
  (`outcome.committed`, which a Main Bot cancel reads) come from the same rows.
- A new commit that leaves a delegation cancel fact to deliver (`cancel_turn` of an open chain Turn,
  `cancel_delegation`, `abandon_delegation`) delivers it in the same transaction, as L `settleChain` runs
  `deliverCancels` after its commit: the K4 cancel of the fact's frozen target, then `delivered`.
- The other outcome ports (`createRoutine`, `updateRoutine`, `cancelRoutine`, `manage`) still come from the caller of
  `commit()`. Only the terminal transaction builds them from the store. The command entry must not take callback
  commands (`outcome`, `message`, `occurrence`) from a client.
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
| `scope` | scope: the store version and the frame (the state without its rows) |
| `entity` | map entry of the state (Turn, card, Bot, room, delivery, ...), keyed by its id |
| `entry` | element of a list (audit, rejected, team note, home operation, room message), keyed by position |
| `command` | command record: the dedup evidence, the first result and the retention root (nullable) |
| `outbox` | projection or delivery to send: a projection's value and send state, or a delivery's scan index (pending owner §54a) |
| `intent` | Turn intent: the frozen SDK input, the stable task id, the FIFO order, the submit state and the SDK result read back |
| `device_binding` | device of a scope: its mode (`L` or `H`), its mode revision and its revoke time |
| `retired_identity` | K8 identity that retention retired for good: `hash([namespace, id])` |
| `archived_row` | row that retention moved out of the state, by namespace and id; a command record has an expiry |
| `routine` | K4 routine of a Bot: its definition, staged version, lifecycle, status and next slot |
| `occurrence` | K4 occurrence of a routine slot; its conclusion only when it has no intent |

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
  newer slot marked the occurrence. It takes no K4 retry policy. The freeze checks the device binding.
- `ended`: a routine Turn that ends before promotion concludes its occurrence `cancelled` (K8 `concludeRoutineTurn`).
  Nothing for another Turn.

Every frozen instruction lists the scope's Bot routines, in insertion order; the store reads them itself.

The sync runs to a fixed point, as the L pass drains again after a step that changed K4. While a round froze or
promoted an intent, concluded an untried intent on `cancel`, or concluded an occurrence on `ended`, it reads the intent
facts again and runs every Turn again. So one sync ends a Turn whose promotion settled `superseded` at once, or whose
untried intent it cancelled. Each of those steps happens once per intent or occurrence, so the rounds end.

In history mode, `options.history` maps each Turn id to that Turn's history rows, as L reads them. A Turn without
an entry does not freeze.

### Delegation settlement

Each sync round runs K8 `settleDelegations` after its Turn steps, as L's `sync()` does (#793 D2f-5). It reads its K4
facts from the intent rows again after the steps wrote: `intent`, `started` (the reconciliation's claim, or a terminal
that is not a decline; H has generation 0 only) and `declineCode`. `offeredTo` throws: settlement never reads it.
Settlement spends or releases units, moves a claimed delegation to `running`, writes the `lateTurnId` audit line,
freezes the `target_archived` cancel, resolves a cancel once its target concluded, shows `uncertain` after the delegation
timers, and gives a chain end that did not succeed its verdict. A verdict can add the `bot_reply` Turn of a batch join.

The same round then delivers each new delegation cancel fact (`deliverCancels`), as the L pass does after its sync. A
round that delivered a fact or added a Turn runs again, so one sync freezes the report to A. `options.timers` are the K8
`DelegationTimers`; without them the rule's defaults apply.

The terminal transaction delivers the Main Bot cancel that its outcome froze, after the row's conclusion and before the
version switch, as L runs `core.cancel` after its terminal transaction. An untried target concludes `cancelled` there;
the verdict comes at the next sync of the scope.

H does not yet run these L sync and pass steps: `sealDueBatches`, card expiry, `advanceRooms`, the card decision
projections and their `action_result` Turns, `projectInputBatches`, the reply checks (`reconcileReply`, `retryReply`),
the device observation (`observeDevices`), and the card and Agent home flushes. Some of them (the batch seal, card
expiry and the reply checks) need a due time per scope, which H does not store; their placement is owner item O-4.

The projections that the rule publishes reach the outbox in the same transaction. A sync writes no command
record and keeps the revision. A throw writes nothing. The rule's `executionStarted` fact is the intent's `started`
column, which the reconciliation sets. H retires no Turn id before D2g.

## Message consumer

`hostedMessageConsumer(store, { scopeOf, ports })` is the `agentMessage` option of `createByokCloud`. Its
`consume` decides each Agent message in one transaction under the scope lock, in the order of K4
`consumeMessage`:

1. A tenant whose scope has no row, or a task with no frozen intent: `unknown_task`.
2. A device, Agent or message context that differs from the frozen input: `binding_mismatch`.
3. Another message than the task's accepted reply: `message_conflict`. A task has one accepted reply.
4. Otherwise the `message` command commits under the id `taskId:messageId`. A replay returns the decision of
   its command record. Other content for that id is `message_conflict`.

Steps 1 to 3 write nothing. A replay gets the same decision, because the frozen input never changes and an
accepted reply stays. H never returns `held`. A throw writes nothing and leaves the SDK admission pending.

Two decisions differ from K4. A message for another tenant gets `unknown_task`, because H maps each tenant to
its own scope. H has no `stale_generation`, because each H task is generation 0.

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
- H never retries a task, so each task stays at generation 0. L does not retry a K8 Turn either: each K8 wait window
  (`OFFER_WAIT_MS`, `ROUTINE_WAIT_MS`) is at most the first K4 retry delay. A K8 test pins that.
- Each SDK call runs outside the scope lock. Each write takes the lock and is fenced on `conclusion IS NULL`.
- A row with no terminal is read again after `pollMs`. The SDK task observer does not wake the reconciler yet.

## Device binding

The mode binding of plan §4.1 is a Host record, not an SDK field. `HostedCollaborationStore.bindDevice(scope, deviceId)`
binds a device to H at mode revision 1. `revokeDevice(scope, deviceId, revokedAt)` sets `revoked_at` and raises the
mode revision in one write, and keeps the row as the tombstone.

- A second bind and a second revoke change nothing. A revoked device id is never bound again (O1 option A): a
  returning device pairs under a new id. A revoke of a device id that was never bound is final too: it writes a
  tombstone row in the default mode L at revision 2 (creating the scope row if needed), so a later bind of the id is
  refused.
- Each write that can create execution checks the binding under the scope lock, and throws `DeviceBindingError`
  unless the device has an active binding in mode H: the freeze of a new intent (so a sync that would freeze a Turn
  for such a device throws and writes nothing), and the submit claim (the row backs off with the error).
- Right before the SDK call, the submitter reads the binding again. A revoked or changed binding throws, so the try
  backs off with the error. It does not record an expiry.
- The reconciliation and the message consumer do not check the binding: the result of work that started still lands
  under its own identity. A revoke does not cancel the open intents of the device. One that was not delivered concludes
  `expired` at its `wait_until`, through the claim's queued expiry or through the reconciliation, with the revoke
  reason in `last_error`. A delivered task keeps reconciling under its own identity.
- One device with no active H binding stalls the sync of its whole scope. The sync writes every Turn of a scope in one
  transaction, and a freeze for that device throws, so no Turn, cancel or projection of the scope is written. An
  accepted delegation to a Bot on an unbound or revoked device triggers it too. The owner recovers with a command that
  does not check the binding: `cancel_turn` for the Turn, `abandon_delegation` for the delegation, or a `team_snapshot`
  that moves the Bot to a bound device. A per-device refusal (a K8 sync fact per Turn, plus a refusal at the command
  entry) waits for owner question §55a.
- The routine scheduler checks it before a fire (see Routines). The command entry takes the same check when it is built.

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
- H keeps every intent row, settled or not. Intent row compaction, and its permanent intent tombstones, is later work.
- The namespace and id of each archived row, and of each row read (a moved command record or a tombstone), are checked
  against the K4 limits (128 and 1024 characters), as K4 checks every row read in L.
- A scope with no row has nothing to retain: the call returns zero counts and writes nothing, as L does on an empty ledger.

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
- H runs only `bot-routine` routines. A Host-job or execution-template routine is refused.
- Each transaction that can conclude routine work then switches a staged version that is due: the claim expiry, the
  sync, the reconciliation conclude, the terminal transaction and the owner API. K4 does this after each drain; H has
  no drain.
- Retention refuses a routine root while its occurrence is open, as L does.

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
so fenced rows and failed rows cannot fill it. A fenced fire (`pass.fenced`) and a fire that throws (`pass.failed`) write
nothing, and the routine waits `backoffMs` (default 60 s, in memory only) before its next try: a stuck row keeps its
old slot, which sorts ahead of every healthy row. A wait that has ended is dropped at the start of a pass. Each fire
reads the clock, as K4 does when it consumes a wake; the pass time only selects the due rows. The pass also sets `ok` on
a `schedule_retrying` routine once its slot is within the K4 horizon, as K4 `scheduleNext`.

`start()` runs once when the scheduler starts, as K4 `recover`: an active routine with no slot within the horizon is
planned again, and a staged version that is due switches.

H has no timer. The deployment reads `scheduler.intervalMs` and runs `run()` at that interval. The default is 5 s, and
the constructor refuses an interval at or above the K8 late bound (`ROUTINE_LATE_AFTER_MS`, 60 s): with a longer
interval every slot would fire as `catch_up`, and its occurrence key would differ from L's.

- Each pass reads the fenced and failed due rows again, and skips them while they wait. Their fire transactions run
  once per `backoffMs`.
- A routine that waits fires late. Its next try records `catch_up` when the wait ends past the K8 late bound.
- A promoted occurrence keeps `conclusion IS NULL` for good, so `occurrence_open` holds every promoted occurrence of a
  routine. The slice load still scans that history for the unpromoted open rows, so a fire costs more as the routine
  ages. A fix (a `promoted` flag, or moving unpromoted rows) is a DDL change.

## Outbox sender

`HostedOutboxSender.run()` is one pass over the unsettled outbox rows that are due, across scopes (`outbox_due`). Each row
runs in its own steps, and a failed row does not stop the later rows. A scope of an unknown store version is left out
before the limit. The outbox DDL is the D2b-out plan text, pending owner §54a. Each claim and settle reads the clock after
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
  old one. K8 publishes each id once (plan §3.3); the check of that on L (plan §4) is in D2b-out-3.
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
  `unknown` at that attempt. L awaits a readback with no deadline.
- **The K8 delivery entity is the authority.** The outbox delivery row is a scan index that one hook in each store
  transaction writes from the entity diff: a row for each new delivery, `settled_at` once it is `accepted` or
  `rejected`, and `next_at` for a `pending` one. So the push fallback that `refuseRoute` inserts with no outbox intent
  gets its row too. A seed writes no outbox row.
- **The store owns the channel outbox port.** With `{ channel: true }`, a K4 callback (an Agent message or an outcome)
  queues its deliveries with K8 `queueDelivery`, which reads the intent conclusions of the scope as they were before
  the transaction wrote, as L reads its committed ledger. A caller's ports cannot supply `deliver`.
- The sync and each delivery settle drop expired or unneeded reply tokens (`cleanReplyTokens`). L's sync does it too;
  L's call in each flush pass is a call in each delivery settle here. H drops an expired token at the next sync or settle
  of its scope.
- An unsettled delivery row whose entity is not in the state fails as drift (`Delivery outbox row unsettled for an
  archived entity`) and waits `backoffMs`, as a row with no entity anywhere does (`Delivery not found`). Nothing is
  settled for it.
- Retention refuses a root while an outbox row of one of its deliveries is unsettled. It is a drift guard: the
  transaction that settles a delivery entity settles its row too, so no product path reaches it. Projection rows are left
  out: a projection row carries its own value and belongs to no root.
- Reply readback, Agent home projections and connector card calls are not in the sender (§54c A).

## Deployment config

H is not deployed yet (see Status). A deployment composes these parts. For the tests, `hosted-cloud.test-support.ts`
composes the SDK side (the Postgres and object stores, the token signer and a paired daemon) and the SDK task port (submit, readbacks, cancel); the
message consumer tests (`messages.test.ts`, `retention.test.ts`) build `hostedMessageConsumer` themselves.

- **Database.** One Postgres database. The store takes its own `pg.Pool` and its own schema
  (`new HostedCollaborationStore(pool, schema)`), and `migrate()` creates the H tables there. The SDK tables come from
  the `@byok-sdk/cloud-dataplane` migrations (`migrate(pool, migrationsDir())`), in the same database or another one.
  No path assumes one atomic commit across the two (see Database). A scope row of an unknown store version is refused.
- **Object storage.** The SDK stores need an S3-compatible endpoint: `objectStorage` with `endpoint`, `bucket`,
  `accessKeyId`, `secretAccessKey`, `region` and a `signingClock`, passed to `createPostgresCoreStores` and
  `createPostgresCloudStores`. H stores no objects itself.
- **Host auth.** The Host resolves each request to the product user that owns it, and passes that user's scope. One
  scope belongs to one SDK tenant: the submitter's and reconciler's `port(scope)` and the message consumer's
  `scopeOf(tenant)` are inverse maps, and that map is the tenant check (see Message consumer). A command for another
  scope is a `scope_mismatch` conflict. The command entry comes in a later slice of #793.
- **Enrollment.** A device pairs with the SDK through a pairing code (`cloud.createPairingCode(tenant, { productId })`).
  The Host then binds it to H with `bindDevice(scope, deviceId)`, and `revokeDevice` ends that binding for good (see
  Device binding). Each tenant needs a storage entitlement (`core.quota.writeEntitlement`) before a mailbox append.
- **Signing.** `createByokCloud` takes a `tokenSigner` (for example `createHmacTokenSigner(key, clock)`) and a `crypto`
  port (`createWebCrypto()`). The key is a deployment secret; H never reads it.
- **Retention.** The Host calls `retain(scope, input, limits)` with the acknowledged roots. `retentionMs` must be at
  least seven days (see Retention). The SDK side has its own `retentionPolicyId` in the tenant's entitlement.
- **Workers.** The Host runs, each on its own interval: `HostedSubmitter.run()`, `HostedReconciler.run()`,
  `store.sync(scope, …)` for each scope that changed (the `changed` option of `HostedReconciler`, for a conclusion or
  a first claim, and of `HostedRoutineScheduler`, for a fire, and the scope of each commit and consume), and for every scope on its own interval as
  the fallback for timers (there is no due index), `HostedOutboxSender.run()` with the projection receiver and the channel,
  and `HostedRoutineScheduler.run()` every `intervalMs` after one `start()`. A Host with a channel opens its store with
  `{ channel: true }`.
  `hostedMessageConsumer(store, …)` is the `agentMessage` option of `createByokCloud`.

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
- The device binding tests use an SDK tenant in memory for the submit checks.
- The K8 retention vectors (`retentionVectors`) run on the store, with H tests for message replays after retention.
- The routine tests seed each occurrence as the scheduler records it. They cover the outcome actions, the owner API,
  promotion, the claim's `retry_until`, the version switch in each writer that concludes routine work, and the
  `bot-routine` refusal.
- The D2f-1 routine vectors (`routineVectors`) run on the store, with the scheduler fire and a submitter pass on an SDK
  tenant in memory.
- The K8 delivery vectors (`deliveryVectors`) run on the store and the outbox sender, except the echo vectors 10 and 14,
  which wait for the H inbound echo path (D2b-out-3). After each Host step, the delivery outbox index matches the K8 entities. The
  sender tests cover the projection claim, lease, fence, backoff, race, order and version filter, the archived and
  missing delivery entity, the retention refusal of an unsettled delivery row, a terminal delivery on the reply route,
  a hung readback, the clock read after the scope lock, the readback lease, a failed readback fenced by its attempt, a
  wait that never moves `next_at` earlier, the option checks, and a wait that cannot be written.
- The scheduler tests cover on-time and late fires, the supersede in the fire, the device fence and its paging, two
  racing fires, a fire that throws and its backoff, the interval guard, and the start and pass upkeep.
- The reconciliation tests run a real daemon for the completed outcome, a replayed terminal and a busy decline. The
  busy decline runs on L too (K4 with the sync rule's wait), and both conclude `declined` at generation 0. An SDK
  tenant in memory covers the cancel, expiry, lease and identity cases, and the scopes that a pass reports.
- The K8 settlement vectors (`settlementVectors`) run on the store, as on L.
- The settlement tests build each delegation through the product path (an outcome `delegate`, then a sync), and cover
  each verdict, the units, `target_archived`, the timers, the late terminal audit, the Main Bot cancel in the terminal
  transaction, a rollback, the settlement facts, a verdict at the sync of a reported scope, and the refusal of invalid
  delegation timers.
- The sync test freezes the same Turns in an L ledger with K4 `enqueue`. Each H input is byte-equal to the K4
  execution input, and the H state bytes equal the L state bytes.
- The submitter tests use the hosted SDK composition (`createByokCloud` over `createPostgresCloudStores`, with
  the SDK migrations in its own schema), served over loopback HTTP, and a real daemon paired through the
  public pairing route. The intents are frozen directly, because D2b ships no product entry.
- After each step of two command scripts, the store's state bytes equal the reference subject's state bytes.
