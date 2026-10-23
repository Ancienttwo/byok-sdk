# Hosted Bot collaboration (H)

Private reference example for #793 (#606 D2). It is the hosted (H) adapter of the K8 collaboration
commit contract (`examples/bot-collaboration`, #739 D1), on Node and Postgres.

Status: the commit store, the intent submitter (D2b-1), the sync step (D2b-2), the message consumer (D2c), result
reconciliation (D2d), the device binding (D2e), retention (D2g) and routines without their scheduler (D2f-2). The command
entry and the routine scheduler come in later slices of #793.
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
| `outbox` | projection or delivery that a commit wrote |
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

In history mode, `options.history` maps each Turn id to that Turn's history rows, as L reads them. A Turn without
an entry does not freeze.

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
- The command entry and the routine scheduler take the same check when they are built.

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
- The namespace and id of each archived row are checked against the K4 limits (128 and 1024 characters).

## Routines

D2f-2 stores K4 routines and occurrences and runs the K4 and K8 routine rules on them. The scheduler that records
occurrences comes in D2f-3.

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
- The routine tests seed each occurrence as the D2f-3 scheduler will record it. They cover the outcome actions, the
  owner API, promotion, the claim's `retry_until`, the version switch in each writer that concludes routine work, and
  the `bot-routine` refusal.
- The reconciliation tests run a real daemon for the completed outcome, a replayed terminal and a busy decline. The
  busy decline runs on L too (K4 with the sync rule's wait), and both conclude `declined` at generation 0. An SDK
  tenant in memory covers the cancel, expiry, lease and identity cases.
- The sync test freezes the same Turns in an L ledger with K4 `enqueue`. Each H input is byte-equal to the K4
  execution input, and the H state bytes equal the L state bytes.
- The submitter tests use the hosted SDK composition (`createByokCloud` over `createPostgresCloudStores`, with
  the SDK migrations in its own schema), served over loopback HTTP, and a real daemon paired through the
  public pairing route. The intents are frozen directly, because D2b ships no product entry.
- After each step of two command scripts, the store's state bytes equal the reference subject's state bytes.
