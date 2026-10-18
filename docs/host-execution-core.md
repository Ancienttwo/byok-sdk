# Host execution core guide

Use this guide for fresh Agent work from user input, routines and Bot triggers.
The [K4 reference](../examples/host-execution-core/README.md) is copy-and-own code.
It is not a new SDK service or hosted BYOK executor.
The rules come from [platform PRD sections 9.2 and 12](researches/2026-10-13_bot-platform-prd.md).
The cancellation rule includes the owner's WO-05 ruling of 2026-10-18.

## 1. Ownership and topology

| Record | Meaning | Authority |
| --- | --- | --- |
| Routine | Work, rule, time zone, Agent, destination, lifecycle and definition version. | Host service; the device holds a mirror. |
| Occurrence | One planned time, its trigger, attempts and conclusion. | Device-local Host ledger. |
| Intent | One item in the Agent FIFO. | Host execution core. |
| Execution | One SDK task, with offer, attempt and terminal evidence. | SDK. |

A daily check is a routine. Today's check is an occurrence. Its SDK task is an execution.
A retry can create another execution for the same occurrence, after eligible terminal evidence.

Topology L has an embedded server and daemon on the device. Use SQLite for durable wakes.
Memory storage loses its wakes at exit. The daemon runs with the user's local credentials.
Topology H has no device-local Host. Its service schedules calls to the Cloud fresh-execution API.
The embedded wake queue is not a hosted scheduler.
Neither topology runs BYOK work in the cloud or keeps the user's model keys there.

## 2. Composition and clocks

Construct one core per embedded tenant. Use a separate Host database.
Assign the core before yielding to the event loop, so recovered wakes have a consumer.

```ts
import { createByokServer } from '@byok-sdk/server';
import { HostExecutionCore, HostLedger } from '../examples/host-execution-core/src/index';

let core: HostExecutionCore;
const server = createByokServer({
  productId: 'my-product',
  storage: { kind: 'sqlite', path: './sdk.sqlite' },
  wake: { consume: (wake, signal) => core.consume(wake, signal) },
});
const ledger = new HostLedger('./host.sqlite', 'product:my-product');
core = new HostExecutionCore(server, ledger, {
  applyOutcome(document, tx) {
    if (document !== undefined) {
      tx.application[tx.intent.taskId] = JSON.parse(JSON.stringify(document));
    }
  },
});
await core.recover();
```

`enqueue` takes a stable intent key, source, complete execution template, waiting deadline and retry policy.
`addRoutine` takes an immutable definition mirror.
An execution has an explicit runtime, AgentRef, egress policy and terminal projection.
Freeze all input context, including any selected server-held message context.
The core assigns taskId. It never adds SessionRef or changes execution mode.

Execution waiting deadlines and backoff use the one-shot SDK wake queue.
Out-of-horizon routine candidates use one process-local retry timer. Topology H uses service-owned timers.
`HostOptions.now` is for tests only. It must use the same wall clock as the SDK wake scheduler.
The default calendar is `{ anchorMs, everyMs }` with `timeZone: 'UTC'`.
Optional `quietHours: { startMinute, endMinute }` uses UTC minutes since midnight.
Quiet hours can cross midnight. Defer the slot to their end; do not drop it.
Inject a shared pure `nextOccurrence` function for cron, other zones, DST or business calendars.
Use that same function in the Host service. Return a time strictly after the input time, or null.
The core checks the current 366-day K2 horizon before writing a schedule outbox row.
After K8-S raises the running SDK's limit to 368 days, update the Host's `WAKE_HORIZON_MS` to match.
Until then, annual routine candidates more than 366 and up to 368 days ahead use `schedule_retrying` backoff without blocking other work.
It retains a later candidate on the routine with status `schedule_retrying`, without a schedule row.
Process-local backoff starts at 60 seconds, doubles to one hour, and retries the same candidate.
Startup also retries it. A wall-clock rollback rejection from the SDK enters the same state.
An SDK horizon rejection stores its original code and message in `routine.lastError`, in the same transaction.
This evidence remains after recovery. A Host horizon precheck creates no SDK error.
A wake dispatch failure cannot skip the other Agent queues. The scan reports failures after those queues run.
Periodic rules remain Host-owned.

A calendar `null` keeps lifecycle `active` with status `no_occurrence_within_horizon`.
Startup and an explicit refresh through `addRoutine` recompute it. The definition must remain identical.
New definitions are evaluated when added; changing the same ID is still outside K4.
The default calendar can complete a routine when its explicit `endAt` excludes all later slots.

Stop the core before stopping the server. Close the ledger after scans finish.
The reference has one owner and stores a small JSON ledger in one SQLite row.
A larger Host can use indexed tables while preserving the same transactions.
Never use the SDK database or an Agent home for Host storage.

## 3. FIFO and stable task identity

Use one FIFO per `(tenant, deviceId, agentId)` for user, routine and Bot triggers.
A profile revision does not create another queue. Default order is committed enqueue order.
Any priority rule must be explicit. Do not rely on daemon queuing for product work.
The core permits at most one writer execution in flight per Agent.
Other Agents can progress independently. SDK Agent-home admission remains the final authority.
A device terminal does not prove native session cleanup or home release.
The next offer can still receive a typed busy decline.

The task ID is `SHA-256([intentKey, generation])` over canonical JSON.
Persist the complete execution input before submit. Retain those bytes for recovery.
Transport retries do not change generation or increment the attempt count.

If a submit response is lost, read `tasks.offer(taskId)`.
Compare taskId, deviceId, offer type and the complete payload with the frozen input.
`delivered` means durably enqueued, not claimed or running.
For partial admission, resubmit the same persisted input.
A delivered task can reject resubmission with `agent_task_already_exists`.
Read it back exactly. Do not allocate another taskId.
An input conflict stays in the outbox for operator action.

## 4. Waiting deadlines and cancellation

Every intent has a finite waiting deadline. A queued, never-submitted intent can expire locally.
An earlier observed claim removes that waiting deadline from a running execution.
Execution duration limits are separate Host and runtime policies.

For submitted work with no earlier observed claim when the deadline arrives:

1. Persist cancellation reason `expired` before calling the SDK.
2. Call `tasks.cancel(taskId, 'expired')`.
3. Read `tasks.attempt(taskId)` after cancellation.
4. If status is `cancelled` and there is no claimed runtime or owner, conclude `expired`.
   The unclaimed offer cannot run. No device terminal is required or expected.
5. If status is `cancel_requested`, or claim evidence exists, keep the FIFO occupied.
   Wait for `tasks.deviceTerminal(taskId)`, then conclude `cancelled`.

The owner accepts the deadline/claim race. A claim that wins just before cancellation can start and then be interrupted.
The Host does not create another execution or release the FIFO early.
Cancellation alone never permits a new generation.
Claimed work without a device terminal stays unsettled.
The reference also uses `ownerDeviceId` as a conservative claim witness if runtime is absent.

Use canonical attempt readback for cancellation authority.
`tasks.get` is a product snapshot, not a substitute for the cancellation record.
A successful terminal after accepted cancellation does not authorize outcome application.
If success won before cancellation, it can settle normally.

Embedded `tasks.cancel` returns void. Returning the underlying TaskAttempt is a small SDK improvement for the owner to decide.
It is outside K4. The reference performs the additional attempt readback.

## 5. Settlement and retry

Store execution evidence separately from intent conclusion.
Keep input, attempt observation and canonical device terminal for each execution.
Give each intent exactly one conclusion.
Advance generation only after one of these terminals:

- `task.decline` with code `agent_home_writer_busy` or `agent_home_reader_busy`.
- `task.fail` when the source policy permits retry and the terminal does not prohibit it.

Never parse reason text to classify busy. Other declines do not retry automatically.
The reference defaults to three attempts, with five-minute and fifteen-minute backoff.
Failure retries are off by default. The waiting budget and next routine slot can end retry eligibility earlier.
Generation changes only when backoff expires and the old terminal has already been stored.

## 6. Occurrence transaction

Use `SHA-256([routineId, definitionVersion, { kind, plannedAt }])` as the occurrence key.
Trigger kind is `scheduled` or `catch_up`. Preserve the original planned time.
Commit the occurrence, its intent and the next time together.
Compute the next time from the current wall clock. Skip intervening missed slots.
One overdue wake creates at most one catch-up after sleep.
A repeated wake uses the committed trigger and next time. It cannot reclassify the same slot later.

For an in-horizon successor, the transaction also writes a schedule outbox record. Dispatch it after commit.
Exact wake key, time and payload make replay idempotent.
Routine keys are `<routineId>:<version>:<t>`, with `t` in canonical decimal epoch milliseconds and no payload.
Parse the last two colon-separated fields from the right, so routine IDs can contain colons.
The hook still compares the complete key with `routine.next.dedupKey` before admitting a slot.
After restart, scan the persistent outbox and reconcile pending wakes.
Recovery must not depend on browser polling.

Keep at most one running and one queued occurrence per routine.
The reference keeps the latest queued slot and concludes older queued slots as `superseded`.
The next slot invalidates old retries. It does not interrupt the running occurrence.
Bound attempts and store their count with the occurrence.

## 7. Wake behavior

The SDK rechecks the wall clock at least once every 60 seconds. It delivers late wakes.
The Host owns the catch-up decision. The SDK retries a rejected hook after 60 seconds.
It aborts a hook at its 60-second delivery deadline. An old hook can overlap a later delivery.
Durable deduplication must cover both concurrent and restarted delivery.

The hook commits intent and scheduling state, dispatches work and returns.
It must not wait for execution completion.
The reference scans unsettled outbox rows through another one-shot local wake.
Dispatch errors remain on their outbox rows for retry and restart recovery.
One failed row does not stop intent reconciliation. The scan throws after all Agent queues run.
If an in-horizon successor wake cannot be persisted by the SDK, the consume hook rejects.
The SDK keeps the current wake and retries it after 60 seconds.
A direct entrypoint also rejects after a wake dispatch failure, even if its ledger transaction committed.
Retry the same input or call `recover`; do not create another intent or routine identity.
The error contains the retained outbox failure. An initial dispatch failure is not reported as successful scheduling.
Calendar exceptions are separate. The hook records an audit entry and status `calendar_error`, clears the successor, and resolves.
The current occurrence can still finish. The SDK does not redeliver the wake for that calendar error.
After you fix the calendar, await `lifecycle(id, 'paused')`, then await `lifecycle(id, 'active')` to recalculate the next time.
`recover()` and `addRoutine()` with the same definition do not recover the stored `calendar_error` state.
`wakes.cancel` removes queued wakes only. A delivering wake can still run or retry.
The hook must check current lifecycle and the reserved wake identity.
Do not depend on cancel returning true to pause a routine.

## 8. Outcome, messages and upload

User-visible output uses optional required `messageEgress`.
Structured internal output uses `submit_result` and `terminalProjection: result-document`.
Freeze the schema in the offer. A staged document is not success.
Only a successful device terminal authorizes outcome application.
Failure, cancellation and interruption do not authorize staged documents.

Read failure terminals even when no user message arrived.
Execution can fail before message publication, including an egress size failure.
Do not leave the occurrence waiting forever for a message.
Keep message disposition evidence in the Host message ledger when that lane is selected.
The K4 reference settles structured work through canonical device terminal readback.

The injected outcome callback runs synchronously inside the SQLite transaction.
Revalidate each action against current application state. Reject an invalid action without discarding unrelated valid actions.
Record rejection for the initiating Agent's next ContextPack. K4 treats the document as opaque; K8 defines actions.
Commit application state, the applied-task marker, intent conclusion and result outbox together.
A thrown callback rolls back them all. Recovery can invoke it again after rollback.
Only one application commits per taskId.
Do not do network I/O or external effects in the callback. Use its transactional `publish` method.

`flushProjections` delivers durable rows with stable projection IDs.
The receiver must deduplicate those IDs. A response can be lost after receiver acceptance.
Remove only acknowledged rows. The service owns uploader cadence and retry policy.
Filtering “no change” notifications is a Host delivery policy.

## 9. Definitions, commands and lifecycle

The Host service stores immutable definition versions.
Each edit produces a command receipt and uses state-version CAS.
Permit one pending command per routine. Return 409 for another edit until acknowledgement.
The device pulls commands with device credentials through the existing conditional sync call.
Sync must work without a browser.

Persist the device command receipt before apply, then acknowledge it.
The same command ID returns the same acknowledgement.
Reject stale versions as `version_conflict`; do not merge on the device.
Finish the current occurrence before switching definitions.
The example accepts an immutable mirror. It does not implement command transport or the version-change workflow.

The Aimpact scope ruling of 2026-10-18 assigns same-routine-ID version changes to K8a with `update_routine`.
This includes current/pending versions, scheduling generation and the in-flight limit.
This reference keeps each routine ID's definition immutable. Use a new ID to change a definition.

Store only `active`, `paused` and `completed` lifecycle values.
Pause prevents new occurrences and cancels the planned wake.
Existing admitted work can finish. The reference also permits an already queued occurrence to finish.
Pause removes the retry cutoff for the cancelled successor slot. The intent's original waiting deadline still applies.
To stop admitted work, explicitly cancel its intent.
Complete stops future scheduling and preserves history.
Deletion belongs to a separate privacy process.
Derive “past end time” when reading; do not store another lifecycle value.

## 10. Visibility, cost and credentials

Derive status on reads. Do not add a cloud watchdog or cron just for visibility.

| State | Read-time condition |
| --- | --- |
| `synced` | Applied version equals current version and the last acknowledgement is applied. |
| `pending_sync` | Applied version is absent or older and the command is not acknowledged. |
| `sync_failed` | The device rejected the command. Show its error code. |
| `device_offline` | Last device sync is older than about three sync intervals. |
| `missed` | Expected time plus grace has passed, with no completed result after the expected time. |
| `on_schedule` | Neither offline nor missed applies. |

Compute health only for active, synced routines.
Use the next time from the last current-version result, or the shared calendar when no result exists.
Set grace to at least twice the longest occurrence duration, including sync, queue wait and execution timeout.
Throttle last-sync timestamp writes to the sync interval.

Do not meter executions. An idle device makes at most one lightweight Host service call per 60 seconds.
Batch command pulling with existing sync. Local SDK reconciliation is not a cloud request.
Use no official shared model key, service-side user key custody or cloud-do BYOK execution.
Keep user model keys out of Host logs and result storage.

## 11. Host checklist (platform PRD section 12.10)

- [ ] Store definitions and commands on the service with versions and CAS.
- [ ] Pull commands on the device without a browser.
- [ ] Persist receipts before apply. Make acknowledgement idempotent.
- [ ] Deduplicate occurrence keys. Advance the next time in the same transaction.
- [ ] Skip missed slots. Run one catch-up after sleep.
- [ ] Bound attempts and invalidate old retries at the next slot.
- [ ] Derive taskId from intent and generation. Persist complete input before submit.
- [ ] Recover uncertain submits by exact readback without a new taskId.
- [ ] Advance generation only after eligible device terminal evidence. Cancellation alone is not enough.
- [ ] Classify busy only through typed decline code.
- [ ] Put user, routine and Bot work in one bounded FIFO per Agent.
- [ ] Cancel, then read attempt at the waiting deadline. Keep claimed cancellation unsettled until terminal.
- [ ] Stop new occurrences on pause. Explicitly cancel admitted work when needed.
- [ ] Commit application, outcome marker, result and upload outbox together.
- [ ] Reconcile executions with no message through terminal readback.
- [ ] Derive sync, offline and missed state on reads.
- [ ] Keep idle service traffic to one lightweight call per device per 60 seconds.
- [ ] Use no official shared key, service key custody or execution metering.

## 12. Acceptance scope

Tests cover the K4 routine smoke path, sleep catch-up, SIGKILL recovery, shared FIFO,
busy terminal gating, retry limits, quiet hours, lifecycle, cancellation, outcome rollback and upload IDs.
The Bot chat test covers PRD section 5.8's first item: `executions.submit`, `messageEgress`,
an exact `accepted` disposition readback, and successful terminal settlement.
It uses the same FIFO and outcome transaction as a routine.
They use a fake runtime and real SDK transport and storage.
They do not prove native model behavior or a downstream deployment.

The Aimpact scope ruling of 2026-10-18 assigns the service rows in platform PRD section 14.1
to the downstream Host service after K2 and A2, as specified in that PRD.
These rows cover routine sync with the browser closed, `sync_failed`, 409, `device_offline`,
`missed`, security and cost. This reference covers the device-local Topology L execution rows.
See the [recorded validation](../examples/host-execution-core/VALIDATION.md).

The RAFT comparison in platform PRD section 12.11 is a design reference.
It does not add consensus, a new queue authority or a recovery protocol to this example.
