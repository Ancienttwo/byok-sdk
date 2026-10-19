# Single Bot collaboration

This copy-and-own example implements the single Bot part of K8a.
It supports self continuations. Delegation to other Bots is deferred by Aimpact.
Platform PRD sections 9.4 and 14.2 are not fully implemented here.
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

The Host applies routine actions, confirmation cards, questions, then self
continuations. Each turn freezes the ordinary Bot schema and its ContextPack
in the K4 input.
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
An expired card stays in the next ContextPack. It creates no model turn.
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
returns an action_result with an unknown external outcome. A late connector
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

The collaboration application state has version 1. Unsupported and unversioned
stored state is rejected without a reset or automatic migration.

This example has one Bot and one owner. Cross-Bot delegation stays deferred.
The full K8a first-row acceptance is not complete.
Group chat and Main Bot actions belong to K8b. Paid Pi success-rate measurement belongs to WO-10b. Application history,
versions and audit rows have no retention policy in this small example.

PENDING-AIMPACT: ContextPack size, window, and history policy; K4 stacking;
and the relative imports into K4 internals. This change does not select or
change those policies. The PRD remains Aimpact's authority.
