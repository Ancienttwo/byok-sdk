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

`src/host.test.ts` is the complete embedded setup. Create one `BotCollaboration`
per tenant and ledger. Give it a complete Agent execution template and a Host
connector. Route the embedded server's `wake.consume` to `bot.consume`.
Call `bot.recover()` after startup. Call `bot.close()` before closing the SDK
server or the ledger. Do not call the K4 core's mutation methods directly.
Use `input`, `answer`, `decide`, `cancelTurn`, `updateRoutine`, and `setRoutineLifecycle`.
Read `snapshot` or upload K4 projections with `core.flushProjections`.

The execution template selects this Bot's Agent. It must use a runtime profile
without external connector tools or credentials. The example refuses required
MCP toolsets. The Host connector stays outside the Agent. This example does not
provide a runtime sandbox. The deployment owns that boundary.

## Actions and context

Each turn freezes the ordinary Bot schema and its ContextPack in the K4 input.
The schema offers self delegation, `ask_user`, `confirmable_action`, and the
three routine actions. It offers all current routine ids, up to eight.
It never offers a `target` field or another Bot id. A user input starts one
root budget. Self delegation permits four continuations for that root. It
keeps hop at zero and does not consume the delegation budget. A refused action
enters `ContextPack.rejectedActions`. Other accepted actions still apply.

Questions support text and single choice. An answer creates an `answer` turn.
It is a new user input with its own stable budget root. Replaying the same
answer does not reset that budget. Empty updates and duplicate targets or
option ids are refused. Duplicate weekdays are stored as a set.
A confirmation card starts as `pending`. The owner can choose `confirmed` or
`rejected`. A card becomes `expired` after 24 hours. Only a committed
`confirmed` card calls the Host connector. All three decisions return as an
`action_result` turn. Connector success, error, and external id enter that turn.
The connector must deduplicate by the supplied card id. A crash after the
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
wake. Calendar errors stop the chain, record an audit, and let the accepted
occurrence finish. Startup or explicit pause/resume retries the calendar.

## Boundaries

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
mention in a post cannot create a seat. A Main Bot room turn also has management
actions. Only structured `room_call.members` can add seats after a Bot speaks.

Seats run in reservation order within a round. Each seat enters the same K4
FIFO as that Bot's own turns. The room grace is 240 seconds. The K4 fallback
waiting bound stays at 300 seconds. Room admission cancels waiting work first.
If the member is still waiting at grace, the seat becomes `busy`. If it has
started, the round can proceed while its writer stays held in K4. A later post
uses its seat id and enters history once. Removed waiting seats are invalid.
Removed running members can produce audit evidence, but cannot post or call.

A round permits initial seats + 4, plus 4 when it has an admin. Each member
gets at most two seats; the round admin gets at most four. A reservation spends
budget even if it fails, passes, or times out. Batch room calls are atomic.
A late room_call after a round closes can open a new round. At most three such
rounds share one user root. At most ten late posts share that root. A new user
message starts a new root. Group history caps at 100 entries and ContextPack
caps at 64 KiB. Excess data blocks the seat with an explicit projection. The
Host does not truncate history, summarize it, or silently drop enum members.

`src/group-chat.test.ts` uses a real embedded SDK, daemon, HTTP transport,
SQLite reopen, persona writes, and submit_result helper. `src/rooms.test.ts`
checks budgets, authority, atomic refusal, and context limits as state rules.
`roomInput` and all other mutations use the same serial Host consumer. Do not
call K4 mutation APIs directly. Upload projections with `core.flushProjections`
or read `snapshot().team` for room history, seats, and profile delivery state.
