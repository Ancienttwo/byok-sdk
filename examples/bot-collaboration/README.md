# Bot collaboration

This copy-and-own example implements K8a and K8b in the Bot PRD.
It uses the K4 Host execution core and K8-S public schema and calendar APIs.
It has no paid runtime call. Tests use a synthetic adapter with the real SDK,
daemon, HTTP transport, SQLite stores, and `submit_result` helper.
To copy K8 into a Host repository, see [src/VENDOR.md](src/VENDOR.md): what
to copy in each layer, how to resolve K4, and how to record the source.

## Run

Use Node 24.15 or later and Bun. From the repository root:

```sh
bun install --frozen-lockfile
bun run build
bun run --cwd examples/bot-collaboration typecheck
bun run --cwd examples/bot-collaboration test
```

`src/host.test.ts` shows the embedded setup. Create one `BotCollaboration`
per tenant and ledger. Open that ledger with the K8 compact veto:
`new HostLedger(file, tenant, { compactVeto: botCompactVeto })`. The
constructor refuses a ledger without it ([Compaction](#compaction)). Give it a valid Agent execution template and a Host
connector. Route the embedded server's `wake.consume` to `bot.consume`.
Route its `agentMessage.consume` to `bot.consumeMessage`.
Call `bot.recover()` after startup. Call `bot.close()` before closing the SDK
server or the ledger. Do not call the K4 core's mutation methods directly.
Use `input`, `answer`, `decide`, `cancelTurn`, `updateRoutine`, `setRoutineLifecycle`, `endRoutine`, `cancelDelegation`, and `abandonDelegation`.
Use `receive` for IM messages ([IM channel input](#im-channel-input)).
Read `snapshot` or upload K4 projections with `core.flushProjections`.

The execution template selects this Bot's Agent. It must use a runtime profile
without external-effect connector tools or ambient credentials. Required MCP
toolsets are refused by default. A Host may explicitly declare logical IDs with
`readOnlyToolsets: ['market.read']` when it controls the local tool server and
enforces read-only behavior there. The execution's `requiredToolsets` still
selects those IDs through the ordinary daemon admission path. This declaration
is not inferred from model output or MCP annotations and is not proof that a
tool has no effects. The Host connector stays outside the Agent. This example does not
provide a runtime sandbox. The deployment owns that boundary.

The constructor owns copies of execution/model templates and the allowlist;
mutating the caller's configuration later cannot widen admission. Every model, restored non-archived Bot execution and outstanding frozen intent/execution
must satisfy the policy, as must Bot creation,
updates and turn enqueue. A restart with a narrower policy fails closed when
persisted Bot templates or pending execution inputs require removed IDs. The
check covers the current Bot template, so it skips archived Bots. An archived
Bot never runs a new Turn. Its outstanding frozen work still must satisfy the
policy. Settled historical execution records remain readable. Change those
templates through an authorized Host migration before reopening; this slice adds
no migration API.
Effectful actions still use `confirmable_action` and owner confirmation.
This is the same-device read-only toolset slice of #606; external-authority
storage and two-process relay remain separate.

`bot.core` is public, but the rule to avoid direct K4 mutation calls still
holds. To run the Host's own work on this tenant's core, register a handler in
`hostIntents` and call `enqueueHostIntent(input, handler)` (#882). One ledger
transaction enqueues the K4 intent and stores the handler name, so the owner of
the intent survives a restart. A restart refuses an open Host intent whose
handler is not registered. At a `task.complete` terminal, the handler runs
synchronously in the terminal transaction with the result document. Bot output
never reaches it. The call uses the Host's own authority and bypasses Bot
policy. Its execution still passes the read-only toolset admission, because a
restart admits every open intent. A Host intent shares the FIFO of its Agent: on
a Bot's agentRef, that Bot's later Turns wait until it settles. An exact replay
returns the same intent while K4 keeps it.

A K4 terminal that K8 cannot apply leaves its intent open: a key that is neither
a Bot Turn nor a Host intent, for example from a direct `bot.core.enqueue`
(`unknown_intent`), a Host handler that throws or returns a promise
(`handler_failed`), or a Bot Turn whose outcome commit throws, for example a
document outside its frozen schema (`outcome_failed`). After the owner call, the
next sync settles such a Bot Turn as `failed` and reports it. Then `drain()` rejects with
`IntentOutcomeError`, and so does every API that runs a pass, including `input`
and the `wake.consume` hook. The audit gets one row for each key and reason. The
intent stays at the head of its FIFO until its outcome applies, for example
after a restart with a fixed handler, or until the owner calls
`failStuckIntent(key)`. That call runs a K4 drain first, so it also works right
after a restart. If that drain refuses the intent's terminal again, one
transaction settles the intent as `failed` with the K4 `settle` transition and
adds the audit row `Intent failed by owner <code>: <key> <reason>`. The settle
runs no handler, and the intent records no terminal; the server task keeps it.
The drain before the settle applies the terminal once more, so a `handler_failed`
handler runs once inside the call. If that drain applies the outcome, the call
refuses with `Intent already settled`. If that drain rejects and the intent has
no refusal of its own, the call throws the drain error. Later drains move past
the intent. The call settles the key first. Its closing pass, like every API
that runs a pass, rejects if another intent is stuck, and a retry for this key
then says `Intent already settled`. A Host intent keeps its `hostIntents` record until K4 compacts it,
so an exact replay of `enqueueHostIntent` returns the failed intent. The call
refuses an unknown key, a settled intent, and an intent whose terminal K8 did not
refuse, such as one still running. `BotOptions` passes `reconcileMs` (default
100) and `onOutbox` to the K4 core.

## Actions and context

The Host applies management actions, Main Bot delegation cancels, routine
actions, confirmation cards, questions, then delegations. Each turn freezes
the ordinary Bot schema and its ContextPack
when its K4 intent is enqueued. Waiting turns and retries reuse that frozen
input. The wait limit is five minutes before execution starts. For a routine
Turn, it counts from the occurrence record. A started
execution waits for canonical device terminal evidence.
The schema offers delegation, `ask_user`, `confirmable_action`, and the
three routine actions. It offers all current routine ids, up to eight.
It never offers a `target` field. A user input starts one
root budget. Self delegation permits four continuations for that root. A
continuation keeps the hop, authority, and open delegation of its parent.
It does not consume the Bot budget. A refused action
enters only its originating Bot's `ContextPack.rejectedActions`. Other accepted actions still apply.

`BotOptions.outcome` narrows that offer (#881). `actions.turn` lists the
actions of a Bot Turn outside a room, from `delegate`, `ask_user`,
`confirmable_action` and the three routine actions. `actions.main` lists the
extra actions of an owner Main Bot Turn, from the Bot and room management
actions, `team_note` and `cancel_delegation`. A list only removes actions, and
an empty list removes all of that kind. `timeZones` holds 1 to 8 IANA zones for
`create_routine` and `update_routine`, checked by the `@byok-sdk/core` routine
calendar. The default is `UTC` and `America/New_York`. `confirmable` holds 1 to
16 `confirmable_action` branches, each an action name and its draft schema. The
default is `send_message`, and the connector receives only the offered names.
Sixteen branches with the `send_message` draft and 64-byte names fit both
bounds with eight long time zones at the eight-routine limit, with room for
heavier drafts (`CONFIRMABLE_MAX`).
The constructor checks the offer and composes one schema with it. Turns that
froze before keep their schema. A room seat always gets `speech`. A schema
that is over budget even in the flat shape blocks its Turn, as before. The H
sync takes the same offer as `SyncOptions.offer`, a value from `outcomeOffer`.
An offer with `actions.turn` also narrows the system
prompt of a Bot Turn: it keeps only the sentences for every Bot Turn and for the
actions in that Turn's frozen schema (`systemPrompt`, `promptActions`). With only
`delegate`, the prompt names no `ask_user`, `confirmable_action` or routine.
A narrowed prompt never names `speech` or `room_call`, which only a room seat
gets. An offer without `actions.turn` keeps
`SYSTEM_PROMPT`. A narrowed prompt is shorter, so the
`minimumInstructionBytes(SYSTEM_PROMPT)` check still bounds it.

Questions support text and single choice. An answer creates an `answer` turn.
It is a new user input with its own stable budget root. Replaying the same
answer does not reset that budget. Empty updates and duplicate targets or
option ids are refused. Duplicate weekdays are stored as a set.
An expired card can appear in the recent ContextPack window. It creates no model turn.
A confirmation card starts as `pending`. The owner can choose `confirmed` or
`rejected`. A card becomes `expired` after 24 hours. Only a committed
`confirmed` card calls the Host connector. Confirmation results and explicit
rejection return as an `action_result` turn. Passive expiry creates no turn.
Connector success, error, and external id enter that turn.
Late and conflicting decisions return an error. Replaying the same completed
decision is idempotent. Decision projections are committed once, so uploading
them does not cause later syncs to publish them again.

The connector receives an AbortSignal and must deduplicate by the card id.
The Host enforces `connectorTimeoutMs` (default 30 seconds), even if the
connector ignores cancellation. A timeout releases the serial chain and
commits a failed action_result with an unknown external outcome. A late connector
result cannot overwrite that committed result. The Host calls the connector at
most once per card (#958): one transaction claims the call before it runs, and
the transaction that commits its result or error drops the claim. A claim found
with no result at a later pass (a crash after the call, or a failed result
commit) ends the card the same way as a timeout, with no second call. No
exactly-once external effect is claimed.

The system rules are in `src/rules/schema.ts`. K4 carries them in the instruction.
They require an acknowledgement and self delegation for long work. Final text
uses messageEgress. Progress uses messageDraft or typed activity. A failed,
cancelled, or missing-outcome continuation has a failed owner projection.
The Host publishes final turns with `owner`, source, status, and conclusion.
It does not turn an outcome document into a second chat message.

`src/rules/` holds the collaboration rules as pure functions (#606, #739 D1):
room seats, input coalescing, Turns, delegation, the result schema, the
ContextPack and the order of outcome actions. They take rows and K4 intent
facts, do no I/O and import no ledger type. The ContextPack functions take the
Bot's history as an argument. This example reads that history from the device
ledger. The other `src/` files are the K8 adapter around these rules.

From K4, the rules import only `hash` and `canonical`, from the
`@byok-sdk/example-host-execution-core/canonical` entry (#884). That entry
imports only `node:crypto`. The K4 root entry also loads `node:sqlite` and
`node:async_hooks`, so the rules never import it. `src/rules-boundary.test.ts`
holds both rules. The rules still need `node:crypto` and the global `Buffer`.
Workers with `nodejs_compat` have both.

## Routine invariants

Bot routines are K4 routines. Each one is a `hostOccurrence` definition with
the `bot-routine` hook. The K4 ledger stores the definition, the pending
version, the reserved slot, the occurrences and the wake outbox. K8 keeps no
routine state. The Host core uses `nextRoutineOccurrence` as its calendar: a
routine rule is a `RoutineSchedule` whose `tz` is the definition time zone.
K4, K8-S and the SDK all use the 368-day wake horizon.

K8 keeps the Bot policy. A Bot creates routines only for itself. Each owner
has at most eight routines that are not completed. The routine id is
`hash([taskId, 'create_routine', index])`. The hook input holds `owner`,
`authority` and `prompt`, and a new version keeps the owner and the authority.
An update must change the schedule or the prompt. Duplicate weekdays are
stored once. The routine actions run as K4 routine commands in the outcome
commit. A refused action changes no routine.

The hook writes the routine Turn in the occurrence commit. The Turn id is the
K4 intent key `occurrence:<occurrence key>`. The next sync promotes the Turn
with `promoteOccurrence` and its frozen schema and ContextPack. Its wait limit
is five minutes from the occurrence record, not from the promotion. A routine
Turn that ends before promotion, for example on cancel or for an archived
owner, concludes its occurrence as `cancelled`. Redelivery reads the stored
occurrence and does not call the hook again.

K4 keeps a running occurrence and only the latest queued one. A new slot
settles an older queued routine Turn as `superseded`. On update, the new
version stays `pending` while an occurrence is unsettled or an old slot is
due. The old chain gets no new slot, and the version switches when that work
settles. K4 stores only the current and the pending definition; the Host
service keeps the version history. Pause cancels the reserved slot. Resume
keeps the current version while work is unsettled. Cancel marks the routine
completed and stops new occurrences. Accepted work finishes with its old
version. To stop an execution too, use K4 cancellation explicitly. Routine
results are owner turns with source `routine`.

`updateRoutine` and `setRoutineLifecycle` change only the routines of this
Host's Bot. `endRoutine(id)` runs the keyless `end_routine` command (§55c): the
Main Bot completes any open Bot routine, an archived owner's too, as cancel
does. Without it, the routine of an archived Bot would fire at every slot. The
command needs the Main Bot role and gets the K4 rows through the
`CommandPorts.routines` port.

`compact` removes settled routine rows: a promoted
occurrence through its intent key, and a concluded occurrence through its
occurrence key. `botRoutines` reads the Bot routine views from the K4 rows.
Other K4 routines of the Host, for example Host jobs from `BotOptions.hostJobs`,
are not Bot routines. A Host job may return only a summary: L sets K4
`hostJobExecution: 'fail'`, so a result with `execution` concludes its
occurrence `failed` and promotes nothing, as H does, because no K8 Turn could
settle that intent. K4 alone promotes it by default.

### Compaction

A Turn id is its K4 intent key. K8 reads the intent of a Turn after K4 settles
it: the next pass copies the conclusion into the Turn, and delegation, room and
reply checks read it later. So `botCompactVeto` refuses an acknowledged key
while one of these holds:

- its Turn is not concluded, or the Turn still has its K4 intent and its
  conclusion is not reported;
- a delegation without a verdict has the Turn in `chainTurnIds` or as
  `cancel.targetTurnId`, or any delegation has it as `lateTurnId`;
- its room seat is not released;
- one of its reply receipts is not settled: K4 does not hold the receipt for
  message replay, or a delegated reply body has no verdict yet.

K4 runs the veto inside `compact`'s own transaction. A refusal throws
`CompactVetoError` and changes nothing. Retry the key after a later pass.
A key without a Turn, for example a Host job, is not a K8 key.

The veto guards each `HostLedger` instance that has it. Another instance on
the same file without the veto can still compact a Turn intent early. Then the
next pass fails that Turn with conclusion `failed`, because K8 did not see the
K4 result. It writes an audit line and reports the Turn once, with
`reason: 'result_retired'`. The Turn fails even when K4 already applied its
outcome, because K8 does not read the K4 application tombstone. A routine
Turn's intent tombstone expires with its slot. K4 removes the occurrence with
the intent, so the pass also fails a routine Turn whose occurrence is gone,
after its tombstone expired. The check runs before the archived Bot check, so a
retired Turn of an archived Bot also fails with `result_retired`. The archived
Bot check cancels only a Turn that has no conclusion. A retired room seat Turn
also releases its seat as `failed`, with reason `result_retired`, so its round
moves on. At Host start, a business reply receipt of a compacted Turn stays,
also for a routine Turn after its tombstone expired. A due reply check of a compacted chain intent takes
the failed readback path. The Host keeps processing other work.

### Retention

Every transaction reads and rewrites the collaboration state, so settled
history must leave it. `bot.retain({ acknowledgedRoots, now, retentionMs })`
does that on the Host's explicit acknowledgement. It never runs on its own.

- A root is the `root` field of a Turn projection, or the round root that
  `roomInput` and a room `receive` return. One root holds its Turns,
  budget, delegations and their batches and units, replies, schemas, cards,
  questions, the rejections that its Turns consumed, its input batch and
  inputs, its rounds with their seats, seat Turns and `team.roots` row, its
  inbounds, and the deliveries that its Turns queued (each delivery stores
  its `turnId`). A seat Turn belongs to its round's root, but
  its projection shows its seat id as `root`. Acknowledging a seat id throws
  `RetentionRefused` with code `seat_root` and the round's root in
  `roundRoot`. Acknowledge that root instead.
- One ledger transaction moves every row of each acknowledged root into K4
  application rows by map name and id (the K4 row port). It retires the
  root's Turn, input and round ids for good.
- `RetentionRefused` with code `protected_root` rolls back the whole call while a
  root is still in use: a Turn that is not concluded, or that still has its
  K4 intent and is not reported; an unresolved delegation, an unreleased
  batch or a reserved unit; an open card or question; an open input batch; an
  open round or seat; an open delivery or a live reply route; an open routine
  occurrence; or a Turn, card or question in the ContextPack window of its
  Bot (the last `contextTurnLimit` Turns, the last 12 cards and questions).
  Unconsumed rejections stay in the state.
- An unknown root throws. A root that is already archived counts as
  `alreadyArchivedRoots`.
- Each call also moves the command records of archived roots and the records
  with no root. They answer replays for at least `retentionMs`, which must be
  seven days or more; a later call removes them after that. A retry after the
  window decides again, and an archived Turn, input or round id makes the
  commit throw `RetiredIdentityError` and change nothing. A store makes that
  check itself: `commitCommand` hands the ids that `decide` added to
  `CommandStore.admitted`, and the store calls `refuseRetired` before it
  commits. Sync fails a Turn with a retired id instead of running it. A Turn
  id and an input id are one identity space (`retiredIdentity`): an input
  that does not coalesce becomes a Turn with its own id, and the coalescing
  policy can change between retention and a retry.
- The ContextPack window of a Bot with a Turn that has not frozen yet (queued
  or blocked) is its last `contextTurnLimit + 1` Turns, because that Turn
  reads the last `contextTurnLimit` other Turns.
- Each call moves the audit lines, revoked push routes that no delivery uses,
  and settled persona deliveries: applied ones except the newest of each Bot,
  and failures of an older profile revision. These archived rows stay.
- `historyWindow.omitted*` counts only rows still in the state.
- `room.messages` stays in the state: room offsets count from its start.

After retention, a late message for an archived Turn gets `binding_mismatch`,
and an echo can no longer match an archived delivery. Back up the whole SQLite
database: a JSON-only restore loses the archived rows and tombstones.

`CollaborationState.version` is 3. Version 1 kept the routines in K8 state.
The Host refuses a version 1 ledger and changes nothing. Restore a ledger
backup made before this change, or start a new ledger.

The Host drains application commands until all new turns have a K4 intent.
An immediate terminal cannot leave a continuation without a wake.
K4 schedules and cancels routine wakes through its outbox. A resume of the
same key replaces a pending cancel with the schedule, so the SDK holds one
wake. A failed SDK wake call rejects the K4 drain, and the Host call that
started it rejects after its commit. The K4 outbox keeps the row with
`lastError`. The K4 retry timer retries it with backoff from 1 s to 60 s, for
at most about 5 min, and each later drain, wake delivery or `recover()` also
retries it. A failed K4 drain does
not stop the rest of its process pass, and the pass arms the timer, so card
expiry, delivery retries, reply checks, seat deadlines and input batch seals
keep their times. The pass then rethrows the drain error. Startup schedules a reserved wake that the SDK
no longer holds. K4 rejects a wake whose time differs from its reservation,
and the SDK delivers it again. K4 records an unknown, inactive or superseded
wake in `ignoredWakes`. Calendar errors stop the chain, record an audit, and
let the accepted occurrence finish. Pause and resume retry the calendar.

## Boundaries

The collaboration state has version 3. The Host rejects version 2, unsupported
and unversioned stored state. It does not reset or migrate that state. A
version 2 ledger cannot hold archived rows, so restore a ledger backup made
before this change, or start a new ledger.

This example has one team and one owner per ledger. Paid Pi success-rate
measurement belongs to [WO-10b](../../docs/submit-result-measurement.md); the method defines per-runtime/model/platform cells and does not supply live data. Retention of the
collaboration history is explicit ([Retention](#retention)). K4 routine
versions have no retention policy in this small example.

## Commit contract

Each collaboration command goes through one commit (#739 D1,
`src/rules/commit.ts`). A commit takes a scope, a command id, an optional
expected revision and the command. It returns the new revision, the
disposition and the outbox rows that it wrote. One store transaction holds
the state change, the command record and the outbox rows.

- A replay of a command id with the same evidence returns the first result
  and changes nothing. The evidence is the hash of the fields that decide the
  command's effect.
- The same command id with other evidence is an `identity_conflict`. The Host
  keeps the existing error text, for example `Input identity conflict`.
- Without an expected revision, the commit decides on the head. An explicit
  revision that is not the head is a `stale_revision` conflict. A replay is
  checked first, so a retry with its original revision gets its first result.
- The revision counts committed commands only (#739 6b). Each new commit adds
  1, also for a refused disposition. A command that throws commits nothing.
  Host passes that only apply evidence (sync, reconcile, reply checks,
  deliveries, device refresh) do not change the revision.
- A keyless command has no record (#739 6a). Each call applies and adds 1 to
  the revision, so its command id is not a dedup key. Only an explicit expected
  revision protects a retry: the first commit moved the head, so the retry is a
  `stale_revision` conflict.

The keyed commands are owner input, received IM input, room input, answers,
card decisions, team snapshots, and three K4 callbacks: a terminal outcome, an Agent message
and a Bot routine occurrence. The keyless commands are `setMainBot`,
`updateRoom`, `retryPersona`, `personaReady`, `enablePushRoute`, `revokePushRoute`,
`resendDelivery`, `cancelDelegation`, `abandonDelegation`, `cancelTurn` and `endRoutine`.
`src/rules/commands.ts` decides all of them. The Host checks the principal
and the channel before the commit, and it calls K4 cancel and delivers cancel
facts after the commit. `updateRoutine` and `setRoutineLifecycle` are K4
commands on K4 rows and do not commit here; `endRoutine` commits `end_routine`,
whose port runs K4 `setLifecycle`.

In this L example the scope is the ledger tenant. Owner APIs pass no expected
revision. K4 already deduplicates terminals (`applied`) and accepted messages (the
message receipt), so L stores no record for those callbacks. K4 writes no
receipt for a refused message, so L keeps a record for it: a retry gets the
same refusal and does not change the revision. When retention moves that
record, the message hook reads it from the K4 rows of its own transaction. Other content for the same
message id is refused with `message_conflict`. The D1 vectors in
`src/commit-vectors.test-support.ts` run against a pure in-memory store and
against the L ledger; the D2 H adapter runs the same vectors.

### Sync step

A sync step freezes the offer of a Turn without an intent, and settles the
Turn of a concluded intent (#793 D2b). `syncTurn` in `src/rules/sync.ts`
decides it for one Turn. `src/rules/commands.ts` exports it with the
commands. The rule changes the state, publishes projections and returns the
write for the store:

- `freeze`: store this intent input (`key`, `source`, `waitUntil`,
  `execution`). The rule sets `waitUntil` to `now` plus 5 minutes.
- `routine`: a routine Turn joins the FIFO as its occurrence intent.
- `cancel`: the Bot is archived. Cancel the intent, which has not started.
- `ended`: the Turn has no intent and is concluded. A routine Turn concludes
  its open occurrence.

A store runs the step for each stored Turn, in insertion order, in one
transaction under the same scope lock as a commit. It reads the facts inside
that transaction. The projections that the step publishes reach the store's
outbox in the same transaction. A projection with the same id and the same
body adds nothing. Another body for that id throws `Projection identity
conflict`. The step is a Host pass that only applies evidence, so it writes
no command record and keeps the revision. A client's expected revision does
not go stale because of a sync. If one Turn throws, the store writes nothing.
L runs the step in its sync transaction through `syncTurnInLedger`
(`src/commit.ts`), which keeps the K4 writes: `enqueue`, `promoteOccurrence`,
the intent cancel and the occurrence conclusion. The L sync transaction also
runs other Host steps before and after the per-Turn steps. Before them, it
seals due input batches, expires pending cards and advances rooms. After
them, it settles delegations, reports card decisions and adds their action
result Turns, cleans reply tokens and projects input batches. The card steps
are the K8 rule `src/rules/cards.ts` (`expireCards`, `reportCardDecisions`),
which the `cardVectors` hold for L and H. This contract
defines only the per-Turn step. The `syncVectors` in
`src/commit-vectors.test-support.ts` hold these rules for the in-memory store
and for L. The `coalesceVectors` there hold the batch seal before the
per-Turn steps and the batch projection after them, for L and H.

`collaborationDue(state, timers)` in `src/rules/due.ts` lists the times when a
sync has collaboration work to do: each open input batch's seal, each pending
card's expiry, each unreleased seat's deadline, and the delegation times
(`delegationDue`). `src/rules/commands.ts` exports it. L arms its timer with
these times and its own L-only ones. H stores their minimum as the scope's due
time (#793 S4). Routine slots are K4's, so they are not in the list.

The room step of a Host sync is `advanceRoomSeats(state, facts, now, add)` in
`src/rules/rooms.ts` (#793 S6). It runs `advanceRooms` on the seat facts,
fails a seat Turn whose work was not admitted, queues each new seat Turn
through `add` (`seatTurn` gives its fields), and returns the seats whose
admitted work the Host cancels. `src/rules/commands.ts` exports both. L builds
the facts from its K4 intents; H builds them from its intent rows. A Turn
step can release a seat (a blocked or retired seat Turn). Both Hosts then run
the room step and the Turn steps again in the same sync, so the next seat gets
its Turn: L in `advanceRoomsAndTurns` (`src/rooms.ts`), H in its sync loop.
The `roomVectors` run on both.

`checkReply(state, d, check, now, emit, uncertainAfterMs)` in
`src/rules/delegation.ts` decides one reply check of a `reply_pending`
delegation: a reply body that the Host holds answers it, a failed read
retries with backoff, and otherwise the SDK readback decides.
`replyCheckDue(d, now)` selects the due checks. `src/rules/commands.ts`
exports both. L's `flushReplies` runs them with its own SDK read, and H runs
them in `HostedReplyChecker` (#793 S7). The `replyVectors` hold the decision
for L and H.

Known L limit: K4 stores the whole Host ledger, with the collaboration state,
in one JSON row per tenant. Turns, replies, audit rows and command records
make that row grow. Command records are dedup evidence; retention must not
delete a record while a retry of its command can still arrive. Per-entity L
storage and K8 retention are #798.

## External history authority

With the `history` option, the ContextPack history of a Bot Turn comes from an
external authority, not from this ledger (#739 D1, #606). Before a Bot Turn
freezes its offer, the Host reads the Bot's earlier history outside the ledger
transaction. Then one transaction freezes the offer with those rows. The
transaction freezes only a Turn that still has no offer.

- The authority returns rows in the ContextPack row shape: `id`, `root`,
  `source`, `request`, `hop`, `status`, optional `conclusion` and
  `outcomeSummary`. Rows in another shape are refused.
- The rows replace the stored Turns in that ContextPack. The current Turn
  always comes from this ledger.
- The collaboration state does not store the rows. The Turn keeps their hash
  in `historyDigest`. K4 keeps the frozen instruction of the offer, as for
  every offer.
- Cards, questions and rejected actions stay Host state. Room seats read room
  messages, so they read no history.
- A read that throws or returns another shape leaves the Turn queued. The
  timer reads again after about one second.
- A read still open after `historyTimeoutMs` (default 10 seconds) counts as
  failed, so a stalled authority cannot hold the Host queue. The Host does
  not abort the read. Reads run one after another, so a pass waits at most
  `historyTimeoutMs` for each Turn that reads.

With the `roomHistory` option, the room messages of a seat ContextPack come
from an external authority too (#883). Before a seat Turn freezes its offer,
the Host calls `roomHistory({ roomId, botId, turnId })` outside the ledger
transaction, in the same phase as `history`.

- The authority returns the messages that this seat's Bot can see, oldest
  first, as `{ id, from, text, late }` rows. The authority selects them for
  that Bot, so K8 applies no `visibleFrom` of its own. Rows in another shape
  are refused.
- The rows replace `room.messages` in that ContextPack, in the same message
  window. The state does not store them. The seat Turn keeps their hash in
  `historyDigest`.
- K8 still writes `room.messages`. Round counts, mention seats and the seat
  request text read it.
- A read that throws or returns another shape leaves the seat queued, and the
  timer reads again. A read still open after `historyTimeoutMs` or at the
  seat deadline counts as failed.
  The seat deadline still applies, so a seat whose read never succeeds is
  released as `busy` and its Turn expires.
- Each accepted seat post also publishes the projection
  `room-message:<roomId>:<messageId>` with `{ roomId, id, from, text, late }`,
  the row that `room.messages` stores. The message id is the seat id, so a
  replay has the same id and body; the uploader delivers it at least once, and
  the Host deduplicates by id. A `pass` and a refused post publish nothing.
  Without the option, no `room-message:` projection exists.
- The next seat of a room is not read while that room has an undelivered
  `room-message:` projection. K4 drops a projection only after the Host
  uploader's `deliver` resolved, so the Host's `deliver` must resolve only
  after its write can be read back from the authority. The held seat waits
  like a failed read, and its deadline still applies: a projection that never
  delivers releases each later seat of its room as `busy` at its deadline.
- Room input that the Host gives K8 (`roomInput`, or `receive` for a group
  message) is not projected. The Host writes it to its authority first, then
  calls K8, so the next seat reads it.
- The ledger does not store the mode. Each time a Host turns the option on, it
  first writes the posts made while it was off from `snapshot().team.rooms` to
  its authority, deduplicated by id.

The team comes from this ledger, unless the `team: 'external'` option is set.

## External team authority

With `team: 'external'`, an external authority owns the Bots (#739 Q4c). The
constructor creates no Main Bot. The authority sends team snapshots with
`applyTeam({ revision, bots })`. Each Bot has `id`, `name`, `role`,
`persona`, `model` and `mainBot`. The Host maps `model` to its own execution
template.

- The team revision is the authority's revision. It is not the collaboration
  commit revision. It must be a safe integer of 1 or more, and each new
  snapshot must have a higher revision.
- A newer snapshot archives each Bot that it does not list, as `delete_bot`
  does. A new Bot gets its first persona projection. A changed name, role,
  persona or model queues the same projection as `update_bot`. A change of the
  Main Bot flag only sets the flag.
- An archived Bot cannot come back. A snapshot that lists one is refused, and
  nothing changes.
- The command id is the team revision. The same revision with the same Bots
  replays, in any Bot order. The same revision with other Bots is an
  `identity_conflict`. The replay check comes first, so an exact retry of an
  applied older snapshot gets its first result.
- A revision that is not newer and was not applied before refuses with
  `stale_team`. The refusal is a commit, so it adds 1 to the collaboration
  revision.
- The snapshot covers the Bots only. `setMainBot`, `create_bot`, `update_bot`
  and `delete_bot` refuse with `external_team`, and the Main Bot schema does
  not offer those three actions. Rooms, team notes and persona retries stay
  local.
- The ledger stores the mode. A ledger with a local team cannot open in
  external mode, and an external ledger cannot open without the option.

With `persona: 'external'` as well, the Host owns the persona projection of
each Bot (#879). The Host projects the Agent home with its own daemon hook, so
there is one projection writer and one revision for each agentRef.

- Each snapshot Bot carries the Host's `profileRevision`, a decimal string.
  K8 uses it as the Bot revision and as the agentRef `profileRevision` of its
  execution. K8 queues no projection and counts no revision of its own.
- The revision never goes back. A changed name, role, persona or model needs a
  newer revision. A snapshot that breaks either rule is refused, and nothing
  changes. Without the option, a snapshot with `profileRevision` is refused.
- `personaReady(botId, revision)` reports that the Host applied this revision.
  The current revision readies the Bot, an older one changes nothing, and a
  newer one refuses. A Bot's Turns freeze their offers only when it is ready,
  as before. After a newer revision, the Bot keeps its last ready revision, so
  it stays a delegate target while its Turns wait. The Host reports
  `personaReady` only after the snapshot that introduces that revision
  resolves: an earlier report is refused, not stored.
- `retryPersona` refuses with `external_persona`.
- The ledger stores this mode too, so a restart cannot change it. The mode is
  fixed once stored, with no migration. The option needs `team: 'external'`.

With `history` and `team: 'external'` together, the device ledger holds
neither the history nor the team authority.

## Group chat and Main Bot

The supplied Agent template is the initial Main Bot. A team can have multiple
Main Bots. `setMainBot(botId, value)` is an owner API. The Host must authenticate
its owner APIs before calling them, unless it passes a verified principal
([IM channel input](#im-channel-input)). `input(key, request, botId)` selects a Bot.
The default is the initial Main Bot. Ordinary turns keep the K8a actions.

Give the Host the real server home projection API. Install
`createBotPersonaProjection()` as the daemon's `agentHome.projection` consumer.
It validates the opaque profile digest. It writes persona text to the Bot's
own `AGENTS.md` with the SDK `writeHomeFile`, under the SDK writer lease. New
profiles and updates wait for an exact `applied` or `idempotent` readback.
The readback must match device,
AgentRef, request id, and digest. New execution input then uses that revision.
Already frozen executions keep their old input. A pending projection does not
permit dispatch. All management actions participate in the K4 outcome commit.

Main Bot schemas offer six actions: `create_bot`, `update_bot`, `delete_bot`,
`create_room`, `update_room`, and `team_note`. The Host checks the current role
again when applying each action. Creation offers three local Bot slots and one
local room slot. A room can use those Bot slots in the same outcome. Model ids
come from `BotOptions.models`. The default model id is `default`. Each model
has a Host-owned execution template. A Bot update cannot move its device.
Profiles cap the active team at 24 Bots. Team notes cap at 20 entries of 300
characters. Every team Bot receives these notes. Other Bots' private turns and
persona text do not enter its ContextPack. No cross-home memory read occurs.
`delete_bot` archives the profile and cancels unstarted work. Running results
become audit only. Delegated work for the archived Bot is also cancelled when
it runs (see Cross-Bot delegation). It does not delete the Agent home.

Profile deliveries share the Host serial consumer. The consumer waits for known
old intents to settle. Device terminal readback can precede writer cleanup.
A projection can therefore stay pending after it hits that lease. The Host
reads every prior delivery before retry. It stores a new delivery id before
sending the same revision and digest. Delay starts at one second and caps at
60 seconds. Recovery reuses stored ids. Old duplicate controls cannot replace
a newer revision. Each revision remains gated on an exact accepted readback.

Use `roomInput(key, roomId, text, mentions, principal)` for a user message. `mentions` is
an ordered Bot id list or the structured value `all`. The default is empty.
The optional `principal` is the verified sender ([IM channel input](#im-channel-input)).
The Host never scans text for names or `[PASS]`. Rooms support mention mode.
An admin identity grants a larger budget. It does not create an implicit seat.
The optional admin mode is refused. `updateRoom` is an authenticated owner API
for membership, admin, name, and announcement changes.

A room turn is a fresh member Agent execution. It uses `bot-turn-outcome.v1`
with required `speech`, plus optional `room_call`. It has no messageEgress.
`{ speech: { kind: 'post', text: 'Evidence' } }` writes shared history.
`{ speech: { kind: 'pass' } }` is an explicit pass. Empty or blank speech,
missing outcome, and execution failure are visible seat failures. A textual
mention in a post cannot create a seat. Main Bot room seats have the same speech-only authority as other members.
Management actions are available only outside room seats. Only structured `room_call.members` can add seats after a Bot speaks.

Seats run in reservation order within a round. Each seat enters the same K4
FIFO as that Bot's own turns. The waiting grace is 240 seconds. First observed claim starts a separate
240-second running grace. This persisted deadline does not reset on later
scans or recovery. The K4 fallback
waiting bound stays at 300 seconds. Room admission cancels waiting work first.
If the member is still waiting at grace, the seat becomes `busy`. If it has
started, the round can proceed while its writer stays held in K4. A later post
uses its seat id and enters history once. Removed waiting seats are invalid.
Removed running members can produce audit evidence, but cannot post or call.
Already completed post, pass, and failure states remain unchanged.

A round permits initial seats + 4, plus 4 when it has an admin. Each member
gets at most two seats; the round admin gets at most four. A reservation spends
budget even if it fails, passes, or times out. Batch room calls are atomic.
A late room_call after a round closes can open a new round. At most three such
rounds share one user root. At most ten late posts share that root. A new user
message starts a new root. ContextPack selects up to the most recent 100
eligible messages. The 32 KiB budget counts the UTF-8 bytes of the frozen
Request plus the serialized ContextPack. `historyWindow.currentRequestBytes`
records the exact Request size, including the room request wrapper. The Host
drops oldest whole rows until that budget fits. `historyWindow.notice` reports
omitted messages and refusals.
History overflow does not block a seat. The frozen Request section keeps the
complete accepted request. Only a Request that alone exceeds 32 KiB blocks
the turn. The seat reason and blocked projection report its byte count, the
limit, and a request to shorten the input.
For room_call seats, the visible caller post is the current request and its
author id is retained. A pass inherits the earlier visible trigger. This
request is preserved even if it has left the recent message window.
The ledger retains its full audit history. No Summary is generated. Authority
enums and required control metadata are not silently truncated. If non-history
metadata plus the accepted Request exceeds the budget after history is removed,
the notice reports that separate condition. That condition does not block.
Private turns use the same history window. They select at most 100 old turns.
Cards and questions each retain at most 12 items. Pending work takes priority.
The Host removes old refusals, settled items, old messages, then pending items.
`historyWindow.turnLimit` names the message or turn count limit. Both room and
private context also report `omittedTurns`, `omittedMessages`, `omittedCards`,
`omittedQuestions`, `omittedPendingCards`, `omittedPendingQuestions`, and
`omittedRejections`. Zero counts remain explicit. The same byte accounting
includes the Request and all selected context. Full outcomes stay in the
ledger. Context includes action names and the current routine definition.

Rejected feedback is private to its Bot. The next frozen input reserves it.
An execution that fails before it starts releases that reservation.
A turn that cannot pass Request or schema admission has status `blocked` and
`blockedReason`. It creates no intent. `cancelTurn` can cancel it before admission.
Other schema composition errors propagate as Host defects. Only
`schema-over-budget` permits the flat-schedule fallback.

Unmentioned messages are stored as background. They do not create a seat, but
a later selected member can see eligible background messages. Each member has
a persisted append offset in `visibleFrom`. New members see only messages
appended after joining. Retained members keep their offset. Leaving and
rejoining resets it. Both owner edits and Main Bot room edits use this rule.
A pre-join root request is also excluded from a new member's Request section.
A delayed post appended after joining is visible. Already frozen offers keep
their selected window. A room without an earlier offset starts at the next
user input; its older history is not disclosed.

`src/group-chat.test.ts` uses a real embedded SDK, daemon, HTTP transport,
SQLite reopen, persona writes, and submit_result helper. `src/rooms.test.ts`
checks budgets, authority, atomic refusal, and context limits as state rules.
`roomInput` and all other mutations use the same serial Host consumer. Do not
call K4 mutation APIs directly. Upload projections with `core.flushProjections`
or read `snapshot().team` for room history, seats, and profile delivery state.

## Persona delivery failures

A stale or conflicting persona completion stays in the owner ledger. It emits
an owner projection with the Bot id, revision, reason, and recoverable status.
Waiting turns expose `profileFailure`. They remain queued and cannot execute
with an unconfirmed persona. The authenticated owner can call
`retryPersona(botId)` after resolving the device-side problem. This creates
the same desired persona at the next profile revision. It retains the failed
operation for audit. An exact accepted readback still gates dispatch. Retry
also survives a Host restart. It does not bypass schema or persona admission.
A stale device may need profile-state reconciliation before retry can succeed.
Transient delivery errors remain pending and use the existing automatic retry.

The supplied `createBotPersonaProjection` consumer writes `AGENTS.md` with
the SDK `writeHomeFile` (#738). It runs on Windows, Linux and macOS. After a
process crash, `AGENTS.md` has its old or its new persona. On POSIX, an
`applied` readback means that the file and its directory are flushed. On
Windows, it means that the file only is flushed. There, an OS crash or a power
loss after the readback can bring back the old persona while the SDK record
keeps the new revision. This Host does not deliver an acknowledged revision
again, so the old file stays until the next persona update writes it. A process
crash can leave an `AGENTS.md.<pid>-<n>.tmp` file in the home. The next
`writeHomeFile` call for `AGENTS.md` removes it when that process has ended.
The Host failure and retry API does not change these limits.


## Deferred Main Bot routine target

Main Bot `create_routine.target` for another Bot is not implemented. Routine
creation remains self-only in this example. Aimpact did not approve that
extension for this PR. A later K8b work order must add it. Cross-Bot delegation
also stays outside this history-window change.

## Cross-Bot delegation

This section covers slices X1–X6 and X2M of the
[approved plan](../../docs/plans/2026-10-19-k8b-cross-bot.md).
See the [acceptance matrix](VALIDATION.md) for evidence and open rows.
A Bot can delegate requests to other Bots of the same team. The `to` enum
lists this Bot first, then each active team Bot after its first persona
readback. It lists Bot ids only. A room seat has no `delegate` fragment.

One outcome can hold two cross-Bot items. The Host refuses an item with
a delegation verdict and a reason: `room_seat`, `duplicate_target`,
`target_archived`, `hop_limit`, or `budget_exhausted`.
A refusal also enters the initiator's `rejectedActions`.
An accepted item creates a `bot_request` Turn for the target. Its id is
`H(taskId, 'delegate', index)`. Its hop is the initiator's hop plus one, at
most four. B's ContextPack holds B's own history and a `delegation` block.
B's reply cap is `BOT_REPLY_MAX_BYTES` (8 192 UTF-8 bytes).

Each Turn stores `authority`: `owner` for user input and answers, `bot` for a
`bot_request`. Continuations, replies, action results, and routine Turns
inherit it. Management needs a Main Bot and `owner` authority, both in the
schema and at apply time.

`consumeMessage` checks the exact task, device, AgentRef, and destination
binding in one ledger transaction. It stores an accepted delegated reply by
task id. That record is the only reply body authority. At the chain end, the
verdict is `answered` when the record exists. Otherwise the delegation is
`reply_pending`. The Host timer reads `tasks.agentMessage` with a backoff from
1 to 60 seconds. It does not wait for a K4 scan. No message gives `failed`
(`no_reply`). Held gives `reply_held`; `abandonDelegation` then sets
`abandoned`. After `uncertainAfterMs` (default 30 minutes) without a result,
the delegation is `uncertain`.

Other chain ends map to verdicts as follows. `failed` gives `failed`.
`declined` gives `failed` with `busy` or the decline code. `expired` gives
`expired`. A Host cancel with reason `expired` gives `expired`
(`claim_raced_deadline`). A user cancel gives `cancelled` (`user_cancelled`).

`cancelDelegation(id)` works while the delegation is queued, `waiting_device`,
running, or `reply_pending`. `cancelTurn` on a chain Turn calls it. One transaction
freezes `cancel = { requestedAt, targetTurnId, delivered }` on the current
chain Turn. That Turn then accepts no first message and applies no outcome.
Without a K4 intent, the transaction closes the Turn and sets `cancelled`.
It does not call `core.cancel`. With an intent, the Host calls `core.cancel`
after the commit and then sets `delivered`. Each `process` pass delivers an
undelivered cancel to its frozen target, so a restart completes it. When
`core.cancel` fails, `cancelDelegation` rejects, but the cancel stays
committed and the timer delivers it.

A message accepted before the cancel stays. The verdict is then `cancelled`
with that reply marked `partial`. A message after the cancel is refused
(`delegation_cancelled`). A cancel with no terminal after `cancelGraceMs`
(default 60 seconds) shows `uncertain`. A claimed chain Turn with no terminal
after `uncertainAfterMs` also shows `uncertain`. The Host never resubmits and
never starts a new generation. A later terminal gives the normal verdict.

A Main Bot cancels through the `cancel_delegation` outcome fragment. Only a
Main Bot Turn with `authority = owner` outside a room seat gets it. Its
`delegationId` enum lists open delegations: no verdict, no cancel yet, and
status `queued`, `waiting_device`, `running`, or `reply_pending`. The list is
newest first and has at most 24 ids. The ContextPack `openDelegations` block shows each listed
id with its Bots, status, and the first 80 code points of the request. It
also counts the omitted delegations and shows a notice. The owner cancels
those with `cancelDelegation`. Apply runs after the management actions and
before the routine actions. It checks room seat, owner authority, and the
Main Bot role again. Then it runs the same arbitration transaction. The cancel fact records
`reason: 'main_bot_cancelled'`, and the verdict keeps that reason. A resolved
delegation gives the rejected action `already_resolved` and no second
verdict. The Main Bot sees it in its next ContextPack.

`abandonDelegation(id)` ends a `reply_held` or `uncertain` delegation with
`abandoned`. When the attempt can still run, it also writes a K4 cancel. A
terminal after the verdict goes to `audit` only.

When the target Bot is archived, the next `process` pass cancels its open
delegations. It uses the same arbitration transaction, with the cancel reason
`target_archived`. This applies in every open state: queued, `waiting_device`, running,
`reply_pending`, `reply_held`, and `uncertain`. A Turn without a K4 intent
closes at once. A queued intent settles as `cancelled`. A submitted attempt
gets `tasks.cancel` and an attempt readback. A claimed attempt gets
`tasks.cancel`, and the Host waits for its terminal. The verdict is `refused`
(`target_archived`). A reply accepted before the archive does not go to the
initiator. The Host writes an `audit` note for it. A cancel with no terminal
follows the `uncertain` rules above. Archived Bots leave the `to` enum and the
roster at the next schema build. A delegation cancelled by the archive leaves
the `cancel_delegation` enum.

When the initiator is archived, the target's work continues. The verdict is
still written, but the Host creates no `bot_reply` Turn and releases the free
reply slots. The delegation row and its projection show
`undelivered: 'initiator_archived'`.

Every verdict reaches the initiator once, in a `bot_reply` Turn. The accepted
items of one outcome form a batch. The first report waits until each accepted
item has a verdict or is `uncertain`. It holds every verdict of the batch so
far, refusals included. Its id is `H('bot_reply', taskId)` for two accepted
items and `H('bot_reply', delegationId)` for one. When every accepted item is
`uncertain`, there is no batch Turn. A verdict after the first report, or
after that state, reports in its own Turn `H('bot_reply', delegationId)`.
When an outcome has no accepted item, one refusal report Turn
`H('bot_reply', taskId)` holds all its refusals. That
report has no `delegate` fragment. Status changes publish
`delegation:<id>:<revision>` projections.

The root Bot budget is 12 units. An outcome with `n` accepted items reserves
`n + max(n, 1)` units: one B unit and one A reply slot for each item.
Admission counts every open reservation on the root. When the units are not
free, the Host refuses accepted items from the last index
(`budget_exhausted`) and checks again. After each report, the batch releases
its free slots above the number of unreported items. A refusal report
reserves one slot when one is free. Otherwise
it is delivery only: it does not start a model, and it enters the next
ContextPack. A unit is spent at the first observed claim and released when it
can no longer be needed. `spent + reserved <= 12` holds after each transaction.

A `bot_request` or `bot_reply` instruction puts request text and reply bodies
once, as raw UTF-8 in length-framed blocks. History, team notes, rooms, and
routines are trimmed oldest first. `instructionMaxBytes` (default 65 536)
bounds the whole instruction. Construction refuses a value below
`minimumInstructionBytes(SYSTEM_PROMPT)`. The minimum includes the
`openDelegations` block of a Main Bot reply Turn.

A Main Bot with 24 Bots, 8 routines, and a room exceeds the outcome schema cap
of 16 384 bytes. The Host blocks such a Turn with a visible reason. It does
not cut an enum. Without the room, 24 open delegations in the
`cancel_delegation` enum still fit (15 949 bytes).

### Second-device placement and device wait

One embedded server and one Host ledger can serve Bots on two enrolled
devices. Supply `BotOptions.models` with Host-owned templates for each device:

```ts
const models = {
  local: localExecution,
  remote: { ...remoteExecution, deviceId: enrolledSecondDeviceId },
};
```

A `create_bot` action selects `model: 'remote'`. The Host copies that
execution template's device into the Bot profile. A model update keeps the
Bot's device. This is creation placement, not home migration.
Install `createBotPersonaProjection()` on both daemons. Wait for exact persona
readback before dispatch. Device B needs SDK daemon and runtime code, with
its own credential store and Agent homes. It needs no collaboration Host.

Supply `server.machines.list` for wait display. A delivered, unclaimed offer
shows `waiting_device` only when that device's presence has expired. Persona
and FIFO waits remain queued. Missing or failed discovery, including the
one-second I/O bound, supplies no new offline fact. Presence does not control
dispatch or verdicts. K4 keeps the original five-minute deadline. Reconnect
can claim the same frozen task. Expiry cancels and reads the attempt before
reporting `expired` once to A. A claim race still needs terminal evidence.

See [Second device and relay contract](SECOND-DEVICE.md). Its two-process
Topology L relay is a contract only. The synthetic two-daemon test proves
the embedded-server path. Hosted `submitAgentExecution`, two physical
computers, two Host processes, and paid Pi behavior remain outside that proof.

## Input coalescing

This section covers slice I1 of the Octop plan for issue #551.
Input coalescing is an optional Host policy. It runs before K4 enqueue.
K4, the SDK, and the wire do not change.

`BotOptions.coalesce` turns it on. Without it, `input` makes the same state
change as before: one Turn, one K4 intent, and one execution for each input.
A field that you do not give takes its default. Construction refuses a value
that is not an integer or is out of range.

| Field | Default | Range |
| --- | --- | --- |
| `windowMs` | 10 000 | 1 000 to 60 000 |
| `maxItems` | 8 | 2 to 16 |
| `maxBytes` | 8 192 | 1 024 to `contextMaxBytes / 4` |

A Bot is busy when it has a Turn that is not concluded and not blocked.
An input to an idle Bot seals at once as a one-input batch. Its Turn id,
Request, intent key, and frozen instruction are the same as without the policy.
An input to a busy Bot opens a batch or joins the open batch of that Bot.
A Bot has at most one open batch. Inputs join one batch only when the Bot,
conversation, sender principal id, authority, Bot revision, and Bot model are
the same. In this example, each Bot has one 1:1 conversation, so the Bot id
also identifies the conversation. Room input never coalesces.

A sealed batch becomes one `user` Turn. Its id is the id of the first input.
`input` returns this id for each member. The K4 intent key is this Turn id, so
task identity, FIFO order, generation, and cancel readback do not change. The
batch Turn is the budget root. Continuation and delegation budgets count once
for the whole batch, not once for each input. Neither the batch nor its Turn
changes after the seal. The Host never changes an enqueued intent.

A one-input batch keeps the raw text as its Request. A batch with more inputs
has one notice line, then each input in arrival order. Each input is framed
once as raw UTF-8, with the frame of Cross-Bot replies. The metadata line holds
`inputId` and `receivedAt`. The Host renders the merged Request before each
join. If it is larger than `maxBytes`, the Host seals the batch and opens a new
batch for the input. So a merged Request always fits the ContextPack budget.
A long single input stays alone and unframed. An input over the ContextPack
budget blocks with a visible reason, as before.

| Seal reason | Condition |
| --- | --- |
| `idle` | The Bot is idle. |
| `window` | `windowMs` passed after the first input. Later inputs do not extend it. |
| `items` | The batch has `maxItems` inputs. |
| `bytes` | The next input makes the merged Request larger than `maxBytes`. |
| `boundary` | Another new Turn of this Bot arrives. |
| `key_changed` | The sender, authority, or Bot configuration changed. |
| `cancel` | `cancelTurn` names the batch or a member input. |
| `policy_off` | The Host restarted without `coalesce`. |
| `archived` | The Bot is archived. |

Every other new Turn of the Bot seals its open batch first: `answer`,
`action_result`, `routine`, `room_slot`, `bot_request`, `bot_reply`, and
`continuation`. So the queue keeps arrival order. A replayed Turn does not
seal. The seal check runs at the start of each Host sync and before each new
input. `recover()` runs a sync first, so a due batch seals after a restart.

`cancelTurn` takes a batch id or a member input id. It cancels the whole batch.
A replay of `input` with the same key and text returns the batch Turn id and
does not join again. A replay with a changed text throws
`Input identity conflict`. Each input has a durable record in
`snapshot().inputs` with its `batchId`. `snapshot().inputBatches` holds the
batches. The `bot-turn:<id>` projection carries `inputIds` in arrival order.
Show the one reply once, and mark each member message from `inputIds`.

From the second input, a reply can wait up to `windowMs` plus the running
execution. A batch Turn freezes its ContextPack at enqueue, as every waiting
Turn does. The Host does not read message text for meaning, so a later input
such as "never mind" does not withdraw an earlier input. The model reads all
inputs in order and answers them together.

This example does not yet arm a timer at the window end, or publish
`input-batch` projections (slice I2). Until then, a batch of a busy Bot seals
at the next Host call or when the Bot becomes idle.

## IM channel input

This section covers slices M2 and M3 of the Octop plan for issue #552.
The rules are in the [Host IM adapter guide](../../docs/host-im-adapter.md).
A channel adapter takes the sender from authenticated platform data and gives
a `Principal` with an `id` and the `kind` `human` or `bot`. Give principal ids
a namespace that no Bot id uses, for example `im:<platform user id>`. Room
history shows both kinds of id in `from`. The adapter maps the platform chat
to a Bot id (`direct`) or a room id (`group`). It maps mention entities to Bot
ids.

`receive(message)` classifies one `InboundMessage` with `classifyInbound`, in
the order of the guide's §3. The first match wins.

| Sender and conversation | Result |
| --- | --- |
| No verified principal | `unverified_sender`. Audit only. |
| Own bot account, listed in `channel.self` | `echo`. Exact delivery reconciliation only. No Turn or seat. |
| Bot, 1:1 | `bot_audit`. Audit only. No Turn. |
| Bot, group | `bot_background`. A room message without a seat, also with mention entities. |
| Owner, 1:1 | `owner_input`. `input` with the principal. |
| Other human, 1:1 | `not_owner`. Audit only. |
| Human, group | `room_input`. `roomInput` with the principal. Mention entities select seats. |

The input key is `inboundKey(message)`, the hash of channel, conversation id,
and platform message id. A redelivered event returns the same id. The Host
never scans text for mentions.

`BotOptions.owner` is the owner principal id. The default is `owner`. Only the
human principal with this id passes the owner check. These owner APIs take an
optional last `principal`: `input`, `answer`, `decide`, `cancelTurn`,
`cancelDelegation`, and `abandonDelegation`. The check runs first. Without a
principal argument, the call acts as the owner, so the Host must authenticate
the caller. A given `undefined`, `null`, or malformed principal is refused with
`unverified_sender`. Any other principal that is not the owner is refused with
`not_owner`. Each refusal writes an audit row before the call rejects. For an
IM action, pass the principal that the adapter verified. Accept an approval
only from a verified button callback, never from a text command.

`roomInput` takes the same optional `principal`, with the same
`unverified_sender` rule. Any verified human can post. The room message
records the principal id in `from`, and a seat request records it in
`requestFrom`. Without a principal, `from` is `user`. A bot principal's
mentions select no seat. The delivery owner APIs below use the same principal rule.

### Delivery outbox

Set `BotOptions.channel` to enable the Host outbox:

```ts
channel: {
  port: channelPort,
  self: { slack: ['im:our-bot-account'] },
  sendTimeoutMs: 15_000,
}
```

`ChannelPort` sends final text and can read back a delivery id. Its `send`
result is `accepted` with a platform message id, or an explicit `rejected`
result with a code, retryability and optional `retryAfterMs`. The port owns
platform authentication and keeps bot tokens in the Host credential broker.
The Host never puts the port or a channel secret in a Bot toolset.

Add a `replyRoute` to an authenticated `InboundMessage`. Its channel must
match the message, and its `inboundId` must equal `platformMessageId`.
The Host saves it with input admission, before it can process a reply.
An input batch uses its newest member's route. The route reference in a
Delivery is the Host's `inboundKey`; the port receives the original platform
inbound id and credential. Reply tokens stay in Host-only ledger state.
Do not publish or log the raw ledger or `snapshot()` as an IM view.

Push is off by default. These owner APIs operate on a direct Bot conversation
or a group room:

```ts
const routeId = await bot.enablePushRoute(
  { kind: 'direct', id: 'main' }, 'slack', 'platform-conversation-id', principal,
);
await bot.revokePushRoute(routeId, principal);
const newDeliveryId = await bot.resendDelivery(unknownDeliveryId, principal);
```

Enabling a replacement revokes the old push route of that conversation.
A push target is a non-secret platform target, never a reply credential.
Only the owner can enable, revoke or resend. As with the other owner APIs,
an omitted principal means that the Host already authenticated the owner.
A manual resend requires a usable reply route or an active push route. It
creates a new id and preserves the old unknown row. It can show a duplicate
message if the original send arrived.

`consumeMessage` records first acceptance and its pending Delivery in the
same SQLite transaction. Exact redelivery creates no second row. Applied
room posts, confirmation summaries and questions also create deliveries in
their acceptance transaction. Drafts and typed activity create no delivery.
Routine output uses only its own conversation's opted-in push route.
Without a route, the Host keeps the content in its UI and audits
`no_push_route` or `reply_route_expired`.

Each process pass calls `flushDeliveries`. It commits `sending` and an
attempt increment before calling the port. The default business deadline is
15 seconds. A timeout, exception or lost connection gives `unknown` and no
automatic resend. An explicit retryable rejection waits for the larger of
Retry-After and exponential backoff. At most three sends run. A required
wait above 60 seconds is final rejection; it is never shortened.

Call `recover()` before serving work after restart. It maps persisted
`sending` to `unknown`. A port's optional readback can confirm `accepted`,
prove `absent`, or return `unsupported`. Only proven absence permits a
bounded retry. Readback must complete within the adapter's own I/O budget.
Unknown rows have no automatic retry timer. A Host drain can check readback;
an authenticated echo can reconcile them without a drain.

An echo must come from a verified bot principal listed in `channel.self`
for that channel. Match its conversation and either `deliveryId` from native
platform data or an already-known `platformMessageId`. Never take an echo id
from message text. A different bot, human, channel or conversation cannot
confirm a delivery. Echoes can arrive while `send` is pending; they do not
wait behind the send operation.

Reply tokens are removed at expiry. They are also removed after the root
has no open Turn or seat and no pending/sending delivery on that route.
Metadata and delivery audit remain. All delivery state is Host state; it
does not change K4, K7, the SDK message disposition or wire messages.

The ledger is a single-owner reference. Use one Host instance per tenant.
The reusable fake-channel test factory is `channelContract` in
`src/channel-contract.ts`. Its harness lets downstream adapters run the same
Host delivery cases with controlled platform results. A real platform adapter
still needs the downstream acceptance in M4.
