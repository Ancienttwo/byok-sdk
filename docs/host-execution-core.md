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
Use the server package's [identity-stable loopback listener](../packages/server/README.md#identity-stable-loopback-listener)
with an immutable Host-owned port assignment to preserve the daemon's cursor URL across restarts.
Topology H has no device-local Host. Its service schedules calls to the Cloud fresh-execution API.
The embedded wake queue is not a hosted scheduler. A Topology H Host on Cloudflare Workers also follows the [hosted Host contract](hosted-host-contract.md).
Neither topology runs BYOK work in the cloud or keeps the user's model keys there.

An IM channel is a Host adapter. See the [Host IM adapter guide](host-im-adapter.md).

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
`addRoutine` takes a definition mirror, and `updateRoutine` stages its next version
(see [routine versions](../examples/host-execution-core/README.md#routine-versions)). A definition can select `hostJob` instead of
`execution` for deterministic Host work. Registered handlers return a persisted summary
and may explicitly request an Agent intent. See [Host job registration, failure and replay
semantics](../examples/host-execution-core/README.md#host-jobs-and-execution-free-occurrences).
A definition can also select `hostOccurrence`: a registered synchronous hook writes Host state in the
occurrence commit, and the Host later promotes or concludes the occurrence (see
[Host occurrences](../examples/host-execution-core/README.md#host-occurrences)).
`applyOutcome` gets `tx.routines` to create, update or pause routines in the outcome commit.
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
The core checks the SDK horizon, currently 368 days, before writing a schedule outbox row.
The Host's `WAKE_HORIZON_MS` uses the public `WAKE_MAX_FUTURE_MS` export from `@byok-sdk/server`.
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
Input coalescing is an explicit Host policy before enqueue ([example](../examples/bot-collaboration/README.md#input-coalescing)).
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

The SDK daemon also makes one local execution record for each started execution (#553).
The record tells whether the SDK saw the whole event trajectory: `complete`, `partial` or `unknown`.
It is diagnostic evidence only. K4 does not read it.
It does not change the device terminal, `retryable`, outcome application, the intent conclusion or generation.
Do not retry, cancel or conclude an intent because of the record.
If the Host keeps the record, store it as evidence of the execution with the same taskId.
Show `unknown` for an execution with no record. Topology H gets no record, because the record does not leave the device.
The reference core has no daemon handle, so it does not read or show the record.
The [K4 execution record test](../examples/host-execution-core/src/execution-record.test.ts) uses a policy that retries failures.
In that test, a `partial` run and a `complete` run both conclude `succeeded`, with one attempt, generation 0 and one outcome application.
Read paths and display text are in section 7 of the [downstream diagnostics guide](agent-diagnostics-integration.md).

## 6. Occurrence transaction

Use `SHA-256([routineId, definitionVersion, { kind, plannedAt }])` as the occurrence key.
Trigger kind is `scheduled` or `catch_up`. Preserve the original planned time.
Commit the occurrence, its intent and the next time together.
Compute the next time from the later of the current wall clock and the delivered slot. Skip intervening missed slots.
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

### Device sleep (optional)

This is a Host feature. The SDK daemon and launcher hold no power assertion.
The Host can prevent idle system sleep while it has work to run. The setting is off by default.

Three mechanisms are independent:

- Idle-sleep prevention keeps the device awake while it has admitted work. This subsection defines it.
- The SDK wake queue rechecks the wall clock after sleep. The rules above do not change.
- Catch-up after sleep creates at most one occurrence (section 6). Its rules do not change.

A sleeping or powered-off device runs no routine. This is a BYOK limit in [platform PRD section 15](researches/2026-10-13_bot-platform-prd.md).
This feature does not change that limit. It does not wake the device for a routine.
The setting text must tell the user this.

Rules:

1. Off by default. If the user has not enabled the setting, the Host never requests an assertion.
2. Hold the assertion only when `enabled && onAC && activeCount > 0`.
3. Prevent idle system sleep only. Let the display sleep.
4. Hold one assertion for all active work. Release it immediately when the count becomes zero,
   the device changes to battery power, or the user disables the setting.
   Request it again when the device is on AC power and the count is above zero.
5. Do not block user sleep, lid-close sleep or low-battery sleep.
6. Leave no assertion after the Host process exits, also after a crash.
   Use an OS mechanism that the kernel or OS service releases with the process.
7. Show the state and its cause: off; active with the task count; inactive with no active task;
   inactive on battery power; or inactive because the OS denied the request.

The active count includes these items for this device. Count each taskId once.

- A claimed execution with no device terminal.
- The FIFO head of each Agent, which is the open intent with the lowest `sequence`.
  Count it when its phase is `queued` or `inflight`, or `backoff` with `notBefore <= now`.

Do not count a head in phase `memory_blocked` or in a future `backoff`. Do not count intents behind a head.
They cannot run until the head settles. When the head settles, the next intent becomes the head in the same commit.
So the assertion stays between two FIFO items of one Agent.
Recompute after each Host ledger commit, each observed claim or device terminal,
each power source change, each setting change and Host start.

| Platform | Request | Release | Process exit | Power source | Assertion list |
| --- | --- | --- | --- | --- | --- |
| macOS | `IOPMAssertionCreateWithName` with `kIOPMAssertionTypePreventUserIdleSystemSleep` | `IOPMAssertionRelease` | Released by the OS | IOKit power source; Electron `on-ac` and `on-battery` | `pmset -g assertions` |
| Windows | `PowerCreateRequest`, then `PowerSetRequest(PowerRequestSystemRequired)` | `PowerClearRequest`, then `CloseHandle` | Handle closes with the process (inferred) | `GetSystemPowerStatus`; Electron `on-ac` and `on-battery` | `powercfg /requests` |
| Linux, GNOME | gnome-session `Inhibit` with flag 4 (suspend) | `Uninhibit`, or disconnect from the session bus | Released at bus disconnect | Poll Electron `powerMonitor.isOnBatteryPower()` | `gnome-session-inhibit --list` |
| Linux, other | logind `Inhibit("idle", who, why, "block")` | Close the returned file descriptor | The kernel closes the descriptor | Same as GNOME | `systemd-inhibit --list` |

Sources: [Apple assertion type](https://developer.apple.com/documentation/iokit/kiopmassertiontypepreventuseridlesystemsleep),
[IOKit release notes](https://developer.apple.com/library/archive/releasenotes/Darwin/RN-IOKitPowerManagment/index.html),
[PowerSetRequest](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powersetrequest),
[modern standby](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/prepare-software-for-modern-standby),
[logind inhibitor locks](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.login1.html),
[logind.conf](https://www.freedesktop.org/software/systemd/man/latest/logind.conf.html),
[gnome-session Inhibit](https://gnome.pages.gitlab.gnome.org/gnome-session/re04.html),
[Electron powerSaveBlocker](https://www.electronjs.org/docs/latest/api/power-save-blocker) and
[Electron powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor).

- macOS: this assertion type does not stop lid-close, Apple menu or low-battery sleep. The display can sleep.
  Do not copy `caffeinate -dimsu`. Its `-d` keeps the display awake. Its `-s` creates a system-sleep assertion.
- Electron: use `powerSaveBlocker.start('prevent-app-suspension')`. It allows the display to sleep.
  Do not use `prevent-display-sleep`. It has higher precedence and keeps the display on.
  Electron has no `on-ac` or `on-battery` event on Linux, so poll the power source there.
- Windows: prefer a power request to `SetThreadExecutionState`. That state belongs to the calling thread.
  No Microsoft document says that a power request ends with its process. Test rule 6 on a real device.
- Windows conflict: `PowerSetRequest` says that user sleep ends power requests.
  Examples of user sleep are the power button, lid close and the Start menu.
  The modern standby guide says that a power request on AC power can block one standby phase indefinitely.
  Test lid close and the power button on a Modern Standby device. Use the result in the setting text.
- Linux: do not take a `sleep` lock. Since systemd 257, a `block` lock also stops sleep that its own holder requests.
  The power and sleep keys obey it, so it breaks rule 5. Lid close ignores inhibitors by default (`LidSwitchIgnoreInhibited=yes`).
- Linux, GNOME: a logind `idle` lock is not sufficient. That lock affects only logind `IdleAction`, which defaults to `ignore`.
  GNOME automatic suspend checks gnome-session inhibitors. This comes from gnome-settings-daemon source, not from a document.
  gnome-session documents `Inhibit` as an internal D-Bus API. Record the GNOME version in the checklist.
- Linux, other desktops: the desktop power manager decides automatic suspend. Test each desktop before you claim support.
  A logind `idle` lock is effective only where the desktop power manager or `IdleAction` obeys it.
  Taking a logind lock needs polkit permission. Report a denied request as inactive with its cause.

#### Device sleep acceptance

This repository has no Host app, so it records no device result.
The downstream Host runs this checklist on one real device for each platform: macOS, Windows and Linux.
Record the command output for each row. On Linux, record the desktop and its version.
Claim support only for the desktops that you tested.

| Rule | Scenario | Expected result | Evidence |
| --- | --- | --- | --- |
| 1 | Setting off. A task runs. Idle time exceeds the system sleep time. | The system sleeps as configured. | No Host assertion in the list. |
| 2, 3 | Setting on, AC power. A task runs. The user is idle. | The system stays awake. The display sleeps as configured. | Exactly one Host assertion. Its reason includes the Host name. |
| 4 | Setting on. The last task ends. | The assertion is released. | No Host assertion in the list. |
| 4 | Setting on. A task runs. Disconnect AC power. | The assertion is released. Battery sleep settings apply. | No Host assertion in the list. |
| 4 | Setting on, battery power. A task runs. Connect AC power. | The assertion is requested again. | Exactly one Host assertion. |
| 5 | Setting on. Close the lid with no external display. | The system sleeps. | System log after wake. |
| 5 | Setting on. The user selects sleep, or presses the power button. | The system sleeps. | System log after wake. |
| 6 | Setting on. Kill the Host process with `kill -9` or Task Manager. | The assertion is released. | No Host assertion in the list. |
| 4 | Setting on. The user disables the setting. | The assertion is released. | No Host assertion in the list. |
| — | A routine is due while the system sleeps. | It does not run. After wake, at most one catch-up runs. | Host ledger. |
| 5 | Windows Modern Standby device, AC power. Close the lid. | Record the actual result. Compare it with the Windows conflict above. | `powercfg /requests`, `powercfg /sleepstudy`. |

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
The example mirrors the current definition and at most one pending version. `updateRoutine` stages version
`max(current, pending) + 1` and switches when no occurrence is unsettled and no old slot is due.
It does not implement command transport or the service's version workflow.

The owner decisions of 2026-10-22 for #606 (O1, O2 and O8) move same-routine-ID version changes into K4.
The Host service keeps the version history. K8 keeps its own routine model until #737 moves it onto K4.

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

## P5a: Host memory commands and ContextPack

The [memory example](../examples/host-execution-core/README.md#p5a-memory-page) adds
`HostMemoryPage`. It keeps memory intent state in the Host ledger. The SDK keeps the
at-most-once CAS ledger in the Agent home. These are separate authorities.

The path is approval, durable intent, capability-gated notice, device fetch, leased CAS,
Host terminal commit, readback and device ACK. `fetch` with no reservation releases no
content and changes no intent state. Terminal readback binds the tenant, device, Agent,
path, operation and digest. The first terminal fact wins. Conflicting later completions
return that stored fact. `uncertain` stays a terminal non-success.

The user can replace a whole file or delete a note. `MEMORY.md` deletion remains a device
rejection. EMPTY-base attempts are authorized writes. They cannot safely query a revision.
A conflict requires a new user decision. No automatic rebase runs. Redacted projections
cannot supply an ordinary edit baseline. This follows WO-01 v2 and leaves P5b unchanged.

A Host-owned redactor emits only policy-approved resident text in the existing opaque
projection bytes. The receiver checks the outer schema, hash, grant and monotone ordering.
It stores Host receipt time with the text. ContextPack checks authorization again and reads
only the exact device and Agent profile. Missing or null resident memory is omitted, so
bootstrap can submit the first task. Text over 8 KiB parks the intent in persistent
`memory_blocked` state before submit. Unauthorized projections also park until repair.
A changed placement or profile and a blob instruction settle as `failed` before submit.
The result records `preparationError`. These failures spend no attempt or generation.
The next intent for that Agent can start. Startup recovery also settles old blocks
whose cause cannot be repaired by a projection.
Blocked heads keep deadline wakes. They do not schedule now+1 polling wakes.
Accepted projections recheck the exact blocked binding and commit a reconciliation wake.
If that schedule fails, the core makes one attempt to restore a deadline wake.
A duplicate projection publish can request an earlier scan again. If the fallback
also fails, the deadline stays in the durable outbox. Recovery or a later drain
retries it. Startup recovery covers a crash between projection commit and wake.

A verified applied `MEMORY.md` replacement of at most 8192 raw UTF-8 bytes invalidates
the old display for ContextPack. The queued task can then run without resident memory.
The SDK publishes a real policy-approved snapshot at task close. The replacement body
is not a projection and never enters ContextPack directly. Old ordering metadata stays.
Late old-task projections cannot clear the refresh marker. The core binds the next
submission to that marker before sending it to the SDK. Only its task-close projection
can clear the marker. A valid pack is frozen with the execution input.

Terminal memory intent rows and their approval keys stay in the Host ledger until the Host
selects them with `acknowledgedMemoryIntentIds` in an explicit `HostLedger.compact` call.
Pending rows and rows of an unfinished restore are refused. Compaction moves each row to an
expiring retired copy outside the JSON body. Until the copy expires, an approval replay returns
the original row and device replays get the stored readback. After that, the same approval
reference is a new request. See [memory retention](../examples/host-execution-core/README.md#memory-retention).

The example supplies copy-and-own Host functions. A downstream Host owns authenticated
user and device routes, grant records, current placement, notice retry scheduling and UI.
P5a does not add SDK wire fields or an edit-view profile. Synthetic Linux tests cover the
real mailbox and filesystem path. They do not establish macOS or Windows platform proof.

## K8b: Cross-Bot delegation

The [collaboration example](../examples/bot-collaboration/README.md#cross-bot-delegation)
adds same-team Bot delegation above K4. Keep one collaboration Host per ledger
tenant. User, routine and Bot work share each device/Agent FIFO. The Host
owns Bot placement, authority, budgets, verdicts and report membership.
K4 owns immutable submit input, attempt generations and canonical settlement.

Wire `createByokServer({ agentMessage: { consume } })` to
`BotCollaboration.consumeMessage`. Supply the server's home projection APIs
and `tasks.agentMessage` readback. Install `createBotPersonaProjection()` on
each daemon. Supply `machines.list` for device wait display. Authenticate the
owner before using `input`, `cancelDelegation` or `abandonDelegation`, or pass
the verified principal supported by the example. Do not call K4 mutation APIs
around the collaboration Host's serial consumer.

A delegates through its `submit_result` outcome. The Host freezes B's
AgentRef and device from the team profile. It creates B's `bot_request` Turn
and submits it through K4. B sees its own context and the delegation metadata.
B's accepted message record is the reply body authority. A terminal or an
outcome document alone cannot supply that body. The verdict arrives in A's
`bot_reply` Turn. A runs a fresh execution to process the report.

A fan-out accepts at most two targets. One report joins their verdicts when
each target has a verdict or is uncertain. No report starts while both are
uncertain. A later verdict has its own report. `replyTurnId` gives each
delegation at most one report membership. Root admission includes every open
reservation: `spent + reserved <= 12`. Continuations have their separate
four-execution budget. Hop cannot exceed four. A Bot-origin Turn and its
successors never gain management authority from a Main Bot role.

The reference emits `delegation:<id>:<revision>`. Deduplicate by event id and
keep the highest revision per delegation. Show target, request, status and
refusal reason in both relevant conversations. Show Cancel for queued,
waiting, running and reply-pending work. Show End for uncertain or held work.
End sets `abandoned`. After a verdict, late device results enter audit only.
A partial reply is visible only when acceptance committed before cancellation.
A's conversation does not display B's draft as A's message.

`waiting_device` is a presence display for a delivered, unclaimed offer.
Discovery is bounded to one second. Its failure does not stop submission or
decide expiry. Reconnect keeps the same frozen input. K4 cancels at the
original wait deadline and reads the attempt. A claim racing that cancel
needs terminal evidence. A lost claimed device follows the existing uncertain
rules. No replacement execution starts from uncertain state alone.

The [second-device contract](../examples/bot-collaboration/SECOND-DEVICE.md)
defines the unimplemented two-process relay. The
[acceptance matrix](../examples/bot-collaboration/VALIDATION.md) separates real
embedded SDK evidence from synthetic runtime and downstream gaps. Hosted
`submitAgentExecution`, two Topology L Host processes and paid Pi acceptance
remain open. Product PRD Q19 does not waive the cross-device §14.2 rows.

## Required reply ingestion

Install the core's bound `consumeMessage` callback as `agentMessage.consume` and
provide a synchronous `applyMessage(input, tx)` option. For example:

```ts
const core = new HostExecutionCore(server, ledger, {
  applyMessage(input, tx) {
    tx.publish(`reply:${input.taskId}`, { body: input.payload.body });
    return { outcome: 'accepted' };
  },
});
// The server consumer can forward to core.consumeMessage after construction.
```

K4 checks tenant, device, Agent reference and message context against the frozen
execution before invoking the hook. The SDK still validates message payloads,
contracts and wire admission. Unknown tasks return `unknown_task`; a new message
for an older execution generation returns `stale_generation`. Binding mismatches
return `binding_mismatch`, and a different message id or content hash after first
acceptance returns `message_conflict`. An absent hook returns
`message_handler_unconfigured`.

The hook's application changes, projections and accepted receipt share one SQLite
transaction. Throwing or returning a Promise rolls the transaction back. Do not
perform external I/O; use `tx.publish` and `flushProjections`. The hook receives a
copy of the intent and cannot retain usable publish authority after returning.
A refusal can persist business refusal/audit state but must not publish a reply.

A committed exact accepted replay returns `accepted` without calling the hook,
even after the intent advances to another generation. It cannot recreate an
already uploaded projection. This handles interruption after the Host commit but
before the SDK stores its disposition. External projection delivery is still
at-least-once; the receiving service must deduplicate the projection id.

Receipts live on execution records, at most one per execution, and are removed
with acknowledged history by explicit ledger compaction. Replay after removal is
`unknown_task`. K8 reuses this admission method while keeping its business reply
and delivery records. During reopen it promotes existing K8 receipts only when
the retained turn/execution relationship is valid; conflicting or unexplained
orphan records fail closed. Proven retired intents may retain business receipts
without recreating execution acceptance. Legacy receipts did not store a second
copy of device/Agent/context, so promotion does not reconstruct those values;
incoming replay is checked against the retained frozen execution.
