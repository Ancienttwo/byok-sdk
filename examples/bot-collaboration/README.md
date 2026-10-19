# Bot collaboration

This copy-and-own example implements K8a and K8b in the Bot PRD.
It uses the K4 Host execution core and K8-S public schema and calendar APIs.
It has no paid runtime call. Tests use a synthetic adapter with the real SDK,
daemon, HTTP transport, SQLite stores, and `submit_result` helper.

## Run

Use Node 24.15 or later and Bun. From the repository root:

```sh
bun install --frozen-lockfile
bun run build
bun run --cwd examples/bot-collaboration typecheck
bun run --cwd examples/bot-collaboration test
```

`src/host.test.ts` shows the embedded setup. Create one `BotCollaboration`
per tenant and ledger. Give it a valid Agent execution template and a Host
connector. Route the embedded server's `wake.consume` to `bot.consume`.
Route its `agentMessage.consume` to `bot.consumeMessage`.
Call `bot.recover()` after startup. Call `bot.close()` before closing the SDK
server or the ledger. Do not call the K4 core's mutation methods directly.
Use `input`, `answer`, `decide`, `cancelTurn`, `updateRoutine`, `setRoutineLifecycle`, and `abandonDelegation`.
Read `snapshot` or upload K4 projections with `core.flushProjections`.

The execution template selects this Bot's Agent. It must use a runtime profile
without external connector tools or credentials. The example refuses required
MCP toolsets. The Host connector stays outside the Agent. This example does not
provide a runtime sandbox. The deployment owns that boundary.

## Actions and context

The Host applies management actions, routine actions, confirmation cards,
questions, then delegations. Each turn freezes the ordinary Bot schema and its ContextPack
when its K4 intent is enqueued. Waiting turns and retries reuse that frozen
input. The wait limit is five minutes before execution starts. A started
execution waits for canonical device terminal evidence.
The schema offers delegation, `ask_user`, `confirmable_action`, and the
three routine actions. It offers all current routine ids, up to eight.
It never offers a `target` field. A user input starts one
root budget. Self delegation permits four continuations for that root. A
continuation keeps the hop, authority, and open delegation of its parent.
It does not consume the Bot budget. A refused action
enters only its originating Bot's `ContextPack.rejectedActions`. Other accepted actions still apply.

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
result cannot overwrite that committed result. A crash after the
external effect but before result commit can call it again with that id.
No exactly-once external effect is claimed.

The system rules are in `src/schema.ts`. K4 carries them in the instruction.
They require an acknowledgement and self delegation for long work. Final text
uses messageEgress. Progress uses messageDraft or typed activity. A failed,
cancelled, or missing-outcome continuation has a failed owner projection.
The Host publishes final turns with `owner`, source, status, and conclusion.
It does not turn an outcome document into a second chat message.

## Routine invariants

K4's routine definitions stay immutable. K8a stores its versioned routine state
in the K4 application ledger. This state participates in the outcome commit.
The SDK stores one-shot times only. The Host uses `nextRoutineOccurrence`.
K4, K8-S and the SDK all use the 368-day wake horizon.

Each routine has immutable versions, `current`, `pending`, and a scheduling
`generation`. Its unique slot is `(routineId, version, t)`. A delivery freezes
its decision, trigger, and definition snapshot. Redelivery reads that row.
Late or cancelled hooks cannot recreate a discarded chain.

At most two occurrences remain unsettled for one routine. A third due slot
gets a `capacity` audit decision and no execution. The active version arms
its next time. On update, accepted work and a due undelivered slot stay on
the old version. The Host stops replenishing that chain. It switches only when
accepted work settles and no due old slot remains. It cancels the old future
slot, advances generation, and arms the new version. Further updates replace
`pending` with a new immutable version.

Pause cancels the armed slot. Resume keeps `current` while work is unsettled.
Cancel marks the routine completed and stops new occurrences. Accepted work
finishes with its old snapshot. To stop an execution too, use K4 cancellation
explicitly. Routine results are owner turns with source `routine`.

The wake outbox has persistent sequence numbers and one serial consumer.
The Host drains application commands until all new turns have a K4 intent.
An immediate terminal cannot leave a continuation without a wake.
A schedule must match the active generation and armed slot. A cancel cannot
be overtaken by a later schedule for the same key. Failed operations retain
a retry time. A process timer retries them. Startup repairs a missing armed
wake. A mismatched wake time records an audit and resolves without a retry
loop. A successful cancel retry clears its stale failure status.
Calendar errors stop the chain, record an audit, and let the accepted
occurrence finish. Startup or explicit pause/resume retries the calendar.

## Boundaries

The collaboration state has version 1. The Host rejects unsupported or
unversioned stored state. It does not reset or migrate that state.

This example has one team and one owner per ledger. Paid Pi success-rate
measurement belongs to WO-10b. Application history,
versions and audit rows have no retention policy in this small example.


## Group chat and Main Bot

The supplied Agent template is the initial Main Bot. A team can have multiple
Main Bots. `setMainBot(botId, value)` is an owner API. The Host must authenticate
its owner APIs before calling them. `input(key, request, botId)` selects a Bot.
The default is the initial Main Bot. Ordinary turns keep the K8a actions.

Give the Host the real server home projection API. Install
`createBotPersonaProjection()` as the daemon's `agentHome.projection` consumer.
It validates the opaque profile digest. It writes persona text to the Bot's
own `AGENTS.md` under the SDK writer lease. New profiles and updates wait for
an exact `applied` or `idempotent` readback. The readback must match device,
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
become audit only. It does not delete the Agent home.

Profile deliveries share the Host serial consumer. The consumer waits for known
old intents to settle. Device terminal readback can precede writer cleanup.
A projection can therefore stay pending after it hits that lease. The Host
reads every prior delivery before retry. It stores a new delivery id before
sending the same revision and digest. Delay starts at one second and caps at
60 seconds. Recovery reuses stored ids. Old duplicate controls cannot replace
a newer revision. Each revision remains gated on an exact accepted readback.

Use `roomInput(key, roomId, text, mentions)` for a user message. `mentions` is
an ordered Bot id list or the structured value `all`. The default is empty.
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
includes the Request and all selected context. Full outcomes and old routine
versions stay in the ledger. Context includes action names and the current
routine definition.

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

The supplied `createBotPersonaProjection` consumer requires POSIX directory
open and fsync support. It is not supported on Windows. Node on Windows can
return EPERM when it opens a directory. This consumer does not skip that
barrier or claim Windows durability. A Windows deployment must supply its own
persona consumer with a defined persistence contract. The Host failure and
retry API does not remove that platform limit.


## Deferred Main Bot routine target

Main Bot `create_routine.target` for another Bot is not implemented. Routine
creation remains self-only in this example. Aimpact did not approve that
extension for this PR. A later K8b work order must add it. Cross-Bot delegation
also stays outside this history-window change.

## Cross-Bot delegation

This section covers slice X1 of `docs/plans/2026-10-19-k8b-cross-bot.md`.
A Bot can delegate one request to another Bot of the same team. The `to` enum
lists this Bot first, then each active team Bot after its first persona
readback. It lists Bot ids only. A room seat has no `delegate` fragment.

The Host applies one cross-Bot item for each outcome. It refuses an item with
a delegation verdict and a reason: `room_seat`, `duplicate_target`,
`target_archived`, `hop_limit`, `fan_out_not_enabled`, or `budget_exhausted`.
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
`abandoned`. After 30 minutes without a result, the delegation is
`uncertain`. A failed, cancelled, or expired chain end gives `failed`,
`cancelled`, or `expired`.

Every verdict reaches the initiator once, in a `bot_reply` Turn. Its id is
`H('bot_reply', delegationId)`. When an outcome has no accepted item, one
refusal report Turn `H('bot_reply', taskId)` holds all its refusals. That
report has no `delegate` fragment. Status changes publish
`delegation:<id>:<revision>` projections.

The root Bot budget is 12 units. An accepted item reserves one B unit and one
A reply slot. A refusal report reserves one slot when one is free. Otherwise
it is delivery only: it does not start a model, and it enters the next
ContextPack. A unit is spent at the first observed claim and released when it
can no longer be needed. `spent + reserved <= 12` holds after each transaction.

A `bot_request` or `bot_reply` instruction puts request text and reply bodies
once, as raw UTF-8 in length-framed blocks. History, team notes, rooms, and
routines are trimmed oldest first. `instructionMaxBytes` (default 65 536)
bounds the whole instruction. Construction refuses a value below
`minimumInstructionBytes(SYSTEM_PROMPT)`.

A Main Bot with 24 Bots, 8 routines, and a room exceeds the outcome schema cap
of 16 384 bytes. The Host blocks such a Turn with a visible reason. It does
not cut an enum.
