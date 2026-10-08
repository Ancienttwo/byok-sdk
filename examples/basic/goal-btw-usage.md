# Copy-and-own goal / btw Host reference

These files demonstrate Host orchestration using the existing public SDK. They
are private example code, not new SDK API, and do not install pi-goal/pi-btw.
The ordinary fresh execution path has been tested with a real embedded server,
HTTP daemon and a public-contract stub adapter; native providers and downstream
Bot adoption still require acceptance.

## Composition

```ts
import { GoalBtwHost, extractBotResult } from './goal-btw';
import { SqliteGoalBtwStore } from './goal-btw-store';

// Select a separate Host database and namespace matching your server product.
// Do not use an Agent home, .byok or any SDK database path.
const hostState = new SqliteGoalBtwStore(hostDatabasePath, productId);
const bot = new GoalBtwHost(byokServer, hostState, () => Date.now(),
  async (goal, decision) => verifyProductAcceptance(goal.lastTaskId, decision));

// On the device: configure the same egressPolicy selected in the target,
// agentHome, and resultDocument: { extract: extractBotResult }.
const goal = bot.startGoal({
  id: hostGoalId, objective, target, maxSteps: 8, deadline: Date.now() + 600_000,
});
const reserved = bot.reserveGoalStep(goal.value.id, goal.revision, hostTaskId,
  canonicalHostContextSnapshot);
await bot.sendGoalStep(goal.value.id, reserved.revision);

// A Host scheduler calls these explicitly; the helper has no timer or loop.
const current = bot.goal(hostGoalId);
await bot.tickGoal(hostGoalId, current.revision);
const latest = bot.goal(hostGoalId);
const settled = await bot.reconcileGoal(hostGoalId, latest.revision);
// Only if settled.value.status === 'active', construct a new approved context
// and reserve a NEW taskId. waiting/blocked/paused never implicitly dispatch.
```

`target` supplies exact deviceId, AgentRef, runtime and egressPolicy;
requiredToolsets may be selected explicitly. The example uses one internal
result-document channel and no user messageEgress. Fresh result-document support
must be advertised by both ends. The SDK still applies canonical-home admission:
no positive physical release receipt is inferred from a terminal. A busy home
can decline the next step; that is a blocked goal, not an automatic retry.

The Host is responsible for authenticated entrypoints, context budgets, SQL
ownership/permissions/retention, goal-result semantic acceptance and scheduling.
The fixture acceptance callback is not a production goal-quality check. A JSON
`complete` from the model alone is not enough: `acceptGoalResult` must establish
product-specific evidence and be idempotent: a crash/CAS race may evaluate the same terminal again. Unknown contracts are ignored by the extractor;
recognized contracts demand strict JSON and exact fields.

## Result documents and waiting

Goal results are exactly one of:

```json
{"contract":"host-goal-step-v1","outcome":"continue"}
{"contract":"host-goal-step-v1","outcome":"complete"}
{"contract":"host-goal-step-v1","outcome":"blocked","reason":"Needs access"}
{"contract":"host-goal-step-v1","outcome":"wait","reason":"External event","resumeAt":null}
```

A timed wait supplies a future epoch-millisecond `resumeAt` instead of null.
It persists in Host state, not in a native timer. The next explicit reservation
may proceed after that time; an indefinite wait requires explicit `resumeGoal`.
Paused `continue`/`wait` stay paused, but a verified `complete`/`blocked` is retained.
There is no per-step time limit: a stuck step is bounded only by the goal's
deadline and by the Host actually calling `tickGoal`. No token budget is claimed.

Cancellation is durable Host intent followed by SDK cancellation for the exact
reserved taskId. A network failure does not prove cancellation delivery or home
release. Replaying stopped reservations flushes existing cancellation and never
creates a new execution. A submit already in flight may create an offer before
it observes cancellation; the sender/recovery then cancels that same task.

## Restart / submission recovery

Reservation and task-ID uniqueness are one SQLite transaction with revision CAS;
the complete executable input is stored before any SDK submission. Two Host
processes using the same namespace cannot both reserve from an old revision.
The `sending` phase is intent, not proof of mailbox delivery or native execution.

On startup, read `bot.goal(id)` and call `recoverGoalStep(id, revision)` for an
outstanding reservation. Recovery reads the immutable SDK offer/attempt first;
an already delivered matching offer is not submitted again. Unknown/partial
submission uses the existing SDK's exact-input recovery path with the **same**
taskId. A mismatch rejects; it never switches runtime, Agent or context. Native
execution failure, cancellation or decline blocks the goal. Explicit Host
resume may approve another step with a new identity; recovery is not model retry.

## Side questions while work continues

```ts
const reservedSide = await bot.reserveBtw({
  id: sideId, taskId: sideTaskId, mainTaskId,
  mainDestination: 'conversation:main', destination: 'conversation:side',
  snapshotRevision: acceptedPrefixRevision, snapshot: selectedPrefix,
  question, target: explicitDifferentAgentTarget,
});
await bot.sendBtw(sideId, reservedSide.revision);
// Later: reconcileBtw(sideId, bot.btw(sideId).revision).
```

The side target needs a **different agentId**, not merely a different profile
revision; it has its own home. A side answer is exactly
`{"contract":"host-btw-answer-v1","answer":"..."}`. The returned Host record
binds it to its independent destination. This helper never writes a transcript,
steers main work, auto-merges an answer, or cancels the main task when a side is
cancelled. The Host explicitly chooses whether and how to bring an answer back.

Run `bun run --filter @byok-sdk/example-basic test` after the root build. Tests
allocate and clean all databases/homes/stores under owned temporary directories.

This reference assumes one Host scheduling worker. SQLite revision CAS is tested
across connections, but multi-worker send leases/scheduling are not implemented.
At startup, the Host enumerates its own known goal/side IDs: for outstanding
reservations, call recoverGoalStep/recoverBtw before reconcileGoal/reconcileBtw.
It must also schedule ticks while a native step is stuck; helper calls alone
do not provide wall-clock cancellation.

The restart tests reopen the Host SQLite state while the coordinator stays alive.
They do not prove simultaneous coordinator/daemon process restart. For a real
Host process restart, also select the SDK's durable coordinator storage (or a
durable hosted composition) and verify its own recovery receipts; a default
in-memory coordinator does not preserve offer/terminal authority across exit.
