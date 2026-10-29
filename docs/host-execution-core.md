# Host execution core guide

Use this guide for fresh Agent work from user input, routines and Bot triggers.
The Host execution core (K4) is `@byok-sdk/server/execution-core`; see the [API reference](#13-api-reference).
It runs inside the Host's embedded server. It is not a hosted BYOK executor.
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
import { HostExecutionCore, HostLedger } from '@byok-sdk/server/execution-core';

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
(see [routine versions](#routine-versions)). A definition can select `hostJob` instead of
`execution` for deterministic Host work. Registered handlers return a persisted summary
and may explicitly request an Agent intent. See [Host job registration, failure and replay
semantics](#host-jobs-and-execution-free-occurrences).
A definition can also select `hostOccurrence`: a registered synchronous hook writes Host state in the
occurrence commit, and the Host later promotes or concludes the occurrence (see
[Host occurrences](#host-occurrences)).
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
The core mirrors the current definition and at most one pending version. `updateRoutine` stages version
`max(current, pending) + 1` and switches when no occurrence is unsettled and no old slot is due.
It does not implement command transport or the service's version workflow.

The owner decisions of 2026-10-22 for #606 (O1, O2 and O8) move same-routine-ID version changes into K4.
The Host service keeps the version history. Since #737, K8 Bot routines are K4 `hostOccurrence` routines.

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
It does not add consensus, a new queue authority or a recovery protocol to the core.

## P5a: Host memory commands and ContextPack

The [memory page](#p5a-memory-page) is
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
reference is a new request. See [memory retention](#memory-retention).

The core supplies the Host memory functions. A downstream Host owns authenticated
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

## 13. API reference

`@byok-sdk/server/execution-core` is the Host execution core (K4). Hosts import it; they do not copy it (#1106).
`@byok-sdk/server/execution-core/canonical` exports only `hash` and `canonical` and imports only `node:crypto`,
so code that runs where `node:sqlite` and `node:async_hooks` do not exist (Workers with `nodejs_compat`, K8 `rules/`)
can load it (#884). The Agent memory contract the core shares with the device (`AgentMemoryExport`,
`AgentMemoryIntentTransport`, `AgentMemoryProjectionPort`, `validateAgentMemoryPath`, the memory error bases)
comes from `@byok-sdk/protocol/agent-memory`. The [K4 demo](../examples/host-execution-core/README.md) composes these
entries with a real server and daemon.

| Module (`packages/server/src/execution-core/`) | Responsibility |
| --- | --- |
| `core.ts` | FIFO dispatch, exact recovery, cancellation, retry, outcome application, occurrence hooks and outbox scans. |
| `ledger.ts` | A separate Host SQLite ledger with synchronous transactions, and the tenant dump, load and discard of a topology switch. |
| `model.ts`, `transitions.ts` | Durable records, stable identities, atomic state changes, and the FIFO head and queued expiry rules. |
| `canonical.ts` | Canonical JSON and its SHA-256: the `./execution-core/canonical` entry. |
| `submit.ts` | The frozen-offer submit protocol: readback first, the frozen offer check and the stop hook. Shared with the hosted lane. |
| `sealed-routine.ts` | The member side of a sealed routine: the template binding and `sealRoutineTemplate` (#953). |
| `routines.ts` | Occurrence deduplication, next-slot commit, coalescing, lifecycle, version switches and Host occurrence transitions. |
| `schedule.ts` | The default UTC interval calendar and the shared calendar callback type. |
| `memory.ts`, `memory-restore.ts` | `HostMemoryPage`: Host memory approvals, intents, projections, ContextPack and explicit tree restore. |
| `index.ts` | The `./execution-core` entry. |

### Migrating to the published core (#1106)

Before #1106 a Host copied `examples/host-execution-core/src/` and resolved
`@byok-sdk/example-host-execution-core` to the copy. Now:

1. Delete the copy, and any provenance record or check that compares its files
   with this repository. For AiphaBee that is `packages/byok-host/vendor/host-execution-core/`,
   `PROVENANCE.json` and the K4 part of `scripts/check-byok-sdk-compatibility.mjs`.
2. Depend on `@byok-sdk/server` and `@byok-sdk/protocol` of the release you install.
   Import the K4 root entry from `@byok-sdk/server/execution-core` and `hash`/`canonical`
   from `@byok-sdk/server/execution-core/canonical`. The exported names and behavior are those
   of the copy; `MemoryBlockedError` is now exported too.
3. Import `AgentMemoryFile`, `AgentMemorySnapshot`, `AgentMemoryExport`,
   `AgentMemoryProjectionPort`, `AgentMemoryIntentFetchInput`, `AgentMemoryIntentTransport`,
   `validateAgentMemoryPath`, `AgentMemoryError` and `AgentMemoryValidationError` from
   `@byok-sdk/protocol/agent-memory`. `@byok-sdk/client` and `@byok-sdk/client/agent-memory`
   no longer export them. The error classes now have one runtime definition, so
   `instanceof AgentMemoryError` holds for an error thrown by either client entry.
4. Keep the existing Host ledger file. The core opens it with the same tables and JSON body.

A breaking change to these entries ships in a MINOR release before 1.0 and is
listed in the upgrade manifest.

### P1: Boundary

The Host owns intent, occurrence, FIFO, generation and semantic outcome state.
The SDK owns offer admission, claim, cancellation and device terminal evidence.
The core calls `executions.submit`, `tasks.offer`, `tasks.attempt`,
`tasks.deviceTerminal`, `tasks.cancel`, and `wakes.schedule/cancel/pending`.
It consumes wakes through the public `wake.consume` hook.

Each Host instance has one tenant and one ledger owner.
SQLite stores a small JSON ledger in one row. This keeps application state,
outcome markers and outbox records in the same transaction.
Use a separate Host database. Never open the SDK database or an Agent home as this ledger.

### P2: Real path

`addRoutine` commits a definition and its scheduling state.
An in-horizon candidate also adds a schedule outbox record.
The wake hook commits one occurrence, its intent, and the next planned time together.
The scanner reserves the complete execution input before it calls `executions.submit`.
The daemon executes that input. The fake runtime submits a real result document.
The scanner reads the canonical device terminal and applies the opaque outcome once.
The same transaction writes the intent conclusion and its result projection.
An uploader retries projections with stable IDs.
Wake dispatch failure rejects the hook so the SDK retains a retry trigger.
The outbox keeps the failed wake call with `lastError`. A process timer of that row drains
after 1 s, 2 s, 4 s and so on, up to 60 s, for at most 10 timed drains (about 5 min).
Each drain retries all failed wake calls. After the last timed drain, only later drains,
wake deliveries or `recover()` retry the row. The row and its `lastError` stay until it is sent.
A failed direct call can already have committed its ledger entry. Retry the same input or call `recover`.

SIGKILL recovery opens the same Host and SDK databases.
The scanner reads the existing offer and retains the original input and taskId.
It does not create a new generation to recover an uncertain submission.

### P3: Decision and accepted boundary

Use the existing SQLite and public API conventions from `examples/basic`.
Keep one FIFO per `(tenant, deviceId, agentId)`. Profile changes do not create another FIFO.
Use the embedded wake queue for execution deadlines and backoff.
An out-of-horizon routine candidate uses process-local backoff until K2 can accept it.
Keep outcome semantics in a synchronous injected callback. K8 actions are outside K4.
A callback that throws rolls the terminal transaction back. The intent stays open at the head
of its FIFO, its outbox row keeps `lastError`, and each scan applies the terminal again. To end
such an intent without its outcome, the Host calls the exported `settle(state, intent, conclusion)`
transition inside `ledger.transaction`. The settled intent records no terminal; the server task
keeps it. K8 `failStuckIntent` does this.

The owner resolved the initial expiry blocker on 2026-10-18.
The allowed readbacks now include `tasks.attempt` and `tasks.get`.
At a waiting deadline, cancel first and then read the canonical attempt.
An unclaimed cancelled attempt concludes `expired` without a device terminal.
A claimed cancellation holds the FIFO until a device terminal, then concludes `cancelled`.
The server emits no event when that terminal arrives. So after `tasks.cancel`, the core
reads the device terminal of each such task on its own backoff. The interval starts at
25 ms and doubles up to 1 s, and it is never more than `reconcileMs`. Each task gets at
most 20 reads, about 15.6 s in all. A read does not write the Host ledger. A found
terminal ends the reads of that task and starts one drain.
After the last read, only the `reconcileMs` scans remain.
A claim that wins at the deadline can be interrupted. This boundary is accepted.
See `unclaimed-expiry.test.ts` and the guide for the exact distinction.

### Integration limits

The ledger is a single-owner store for a small Host.
Every transaction reads and rewrites the whole JSON ledger. History cleanup is explicit through
`HostLedger.compact`, described below; it never runs automatically. Uncompacted settled intents,
executions with terminal documents, occurrences, slot dedup keys, outcome markers, terminal memory
intents and calendar audits remain in that JSON body. This is not a large-dataset storage design.

An application can keep settled rows out of the body with the row port of the same transaction:

```ts
ledger.transaction((state, rows) => {
  rows.put('turns', turnId, row);
  rows.retire('turns', turnId);
  delete (state.application.turns as Record<string, unknown>)[turnId];
});
```

The port reads and writes rows by namespace and stable id in the `host_application_row` table.
`get` returns a copy, `put` replaces a row and `delete` reports whether a row existed.
`put(namespace, id, value, expiresAt)` marks a row as removable from `expiresAt` on, and
`expire(namespace, now)` removes those rows of one namespace. Until that call, an expired row still
answers `get`; a `put` without `expiresAt` makes the row permanent again. `retire`
records a permanent identity tombstone, and `isRetired` reads it. The port has no way to clear a
tombstone, and `compact` never removes one. The rows commit or roll back with the body. The port
reads and writes only this ledger's tenant. It closes when `apply` returns or throws, so a kept
reference or a write after an `await` throws. The caller never gets the database handle: all SQL,
the transaction end and the retired-identity tables stay in K4. The `applyMessage` hook gets the
same port as `tx.rows`, so it reads the rows of its own message commit.

Ignored routine wakes are visible in `ledger.snapshot().ignoredWakes`. The optional
array retains the newest `IGNORED_WAKE_AUDIT_LIMIT` (128) observations in delivery
order, discarding the oldest. Each record contains `at`, `reason`, and `wakeKeyHash`
(SHA-256 of `canonical(dedupKey)`, computable with the exported `hash` helper).
It stores no raw wake key, ID, or payload. The digest is unsalted: guessable keys
can be dictionary-matched; this is not anonymization. Reasons are `unknown_key`,
`stale_scan` (a non-current key in the reserved `host-scan:` namespace),
`missing_routine`, `inactive_routine`, and `reservation_mismatch` (no current
reservation or a different key). Repeated ignored deliveries each leave an
observation; this bounded history is diagnostic, never replay/dedup authority.
Already committed slots still increment their occurrence's replay count, and
current scan wakes are not ignored. A matching reservation with altered time or
payload still throws and rolls back; it is not treated as an ignored delivery.
Stale scan observations share the same 128-entry ring and can evict older diagnostics.
`compact` does not delete `ignoredWakes`. These records persist with the Host ledger and are absent before the first ignored
wake, including in previously created version-1 ledgers.

### Host jobs and execution-free occurrences

Register trusted Host handlers when constructing the core, before `recover()`:

```ts
const core = new HostExecutionCore(server, ledger, {
  hostJobs: {
    watchlist: async ({ input, occurrenceKey, signal }) => {
      // Host-owned I/O; deduplicate external effects by occurrenceKey.
      const summary = await checkWatchlist(input, { idempotencyKey: occurrenceKey, signal });
      return { summary }; // No Agent intent or execution.
      // To request Agent analysis, return { summary, execution: completeTemplate }.
    },
  },
});
await core.recover();
await core.addRoutine({
  id: 'watchlist:abc', version: 1, timeZone: 'UTC',
  rule: { anchorMs: Date.now() + 1000, everyMs: 60_000 },
  hostJob: { type: 'watchlist', input: { list: 'abc' } },
  waitMs: 60_000, lateAfterMs: 1000,
});
```

A definition supplies exactly one of `execution`, `hostJob` or `hostOccurrence`
(see [Host occurrences](#host-occurrences)). The registry is copied
at construction; register every persisted job type on each startup. Missing handlers,
non-JSON inputs/results and invalid execution templates fail explicitly. Arbitrary
unreserved wake keys are still audited; use `addRoutine` to obtain scheduling,
reservation validation, replay deduplication, catch-up and recovery. `host-scan:` is
reserved and cannot begin a routine ID.

The occurrence and pending `host-job` outbox row commit before invoking the handler.
The handler runs outside SQLite transactions, synchronously or asynchronously, inside
the serialized drain. Its arguments include `occurrenceKey`, `routineId`,
`definitionVersion`, `trigger`, `type`, `input`, `attempt` and a core-lifetime `signal`.
The required JSON `summary` is stored as `occurrence.job.summary`; keep it small and
exclude secrets. Inputs and summaries are plaintext in the Host ledger.

Returning only a summary settles the occurrence as `succeeded` with no `intentId`,
no SDK execution and zero Agent attempts. Returning `execution` atomically stores
the summary and creates the existing FIFO intent. Its waiting deadline is measured
from occurrence admission (`recordedAt + waitMs`), not handler completion. A newer
committed slot supersedes a late escalation; pause removes the cancelled successor
cutoff. Normal Agent validation, retry and terminal settlement then apply.

Promotion is the default (`hostJobExecution: 'promote'`). A Host with no owner for
such an intent sets `hostJobExecution: 'fail'`: a result with `execution` then stores
its summary and concludes the occurrence `failed`, with no promotion and no retry, and
the drain rejects with `host_job_execution_unsupported`. K8's L and H Hosts do not promote.

`executionRoutines` is the same choice for `execution` routines. `allow` is the default.
A Host with no owner for an occurrence intent sets `executionRoutines: 'refuse'`. Then
`addRoutine`, `updateRoutine` and `OutcomeTransaction.routines` refuse an `execution`
definition, and no routine row is written. The constructor also refuses a ledger with
a routine that is not completed and whose current or pending version is `execution`;
the error names the routine. To open such a ledger, complete the routine first, on a
core without the option. An intent that an earlier slot already enqueued stays as it is.
K8's L Host sets `refuse`.

Committed results are never rerun on wake replay or `recover()`. On handler failure
or invalid output, the pending outbox retains `lastError`, `job.attempts` increases,
and the drain rejects after processing other work. SDK wake redelivery, `recover()`
or another drain retries pending work. Every admitted Host job remains pending until
it succeeds; later slots do not silently discard failed Host work. Pause/completed
stop new slots, while already admitted jobs can finish. `recover()` also restores
missing successor wakes. Host job attempts are separate from Agent attempt counts.

External effects are **at least once**: a crash after the effect but before the result
commit can repeat the handler. Use the stable occurrence key for external idempotency.
Keep handlers short and bounded; they serialize with other jobs and Agent dispatch.
The SDK's 60-second hook deadline can expire while a handler is running; redelivery
shares the drain and cannot start a second concurrent invocation. The handler signal
is aborted by `close()`, not that hook deadline. `close()` waits for the handler;
handlers must honor the signal. Rejection with its abort reason (including a Node
`AbortError` wrapping that reason) leaves the job pending for recovery without
failing shutdown; unrelated handler errors still propagate. A result returned
after shutdown is not committed. Do not await core methods that drain from inside a
handler (that would wait on its own drain).

Host-only occurrences can be explicitly acknowledged and compacted:

```ts
ledger.compact({
  acknowledgedIntentKeys: [],
  acknowledgedOccurrenceKeys: [occurrenceKey],
  now: Date.now(), tombstoneRetentionMs: 30 * 24 * 60 * 60 * 1000,
});
```

Only settled, intent-less Host job or Host occurrence rows qualify. Pending, unknown or promoted keys
reject the whole batch; compact promoted occurrences through `acknowledgedIntentKeys`.
The returned `occurrences` count includes both kinds. Unlike caller intent keys, a
removed occurrence key is unknown on a second selection. The slot tombstone prevents
replay through its retention window. After expiry, replay against an advanced active
routine is audited as `reservation_mismatch` (or inactive/missing if its state changed).
The same rule bounds the identity rows of Agent routine occurrences; see
[Agent execution retention](#agent-execution-retention).
The JSON ledger and failed-job backlog remain small-Host reference storage: at 10x
volume, whole-document rewrites and serialized handlers are the first bottlenecks.

### Host occurrences

A `hostOccurrence` routine lets the Host write its own state in the commit that records the
occurrence. The Host decides later whether the occurrence needs an Agent execution:

```ts
import { concludeOccurrence, promoteOccurrence } from '@byok-sdk/server/execution-core';

const core = new HostExecutionCore(server, ledger, {
  occurrenceHooks: {
    // Synchronous. No external I/O and no core or ledger calls.
    'bot-routine': (run, tx) => {
      tx.application[`turn:${run.occurrenceKey}`] = { input: run.input, plannedAt: run.trigger.plannedAt };
    },
  },
});
await core.recover();
await core.addRoutine({
  id: 'digest', version: 1, timeZone: 'UTC',
  rule: { anchorMs: Date.now() + 1000, everyMs: 86_400_000 },
  hostOccurrence: { type: 'bot-routine', input: { prompt: 'Summarize the day' } },
  waitMs: 300_000, lateAfterMs: 60_000,
});

// Later, in a Host transaction that also updates the Host state:
ledger.transaction(state => { promoteOccurrence(state, ledger.tenant, occurrenceKey, executionTemplate); });
// Or, when no execution is necessary:
ledger.transaction(state => { concludeOccurrence(state, occurrenceKey, 'cancelled'); });
await core.drain();
```

- Register every persisted hook `type` at construction, on each startup. `addRoutine` and
  `updateRoutine` refuse an unregistered type. The input must be JSON.
- The core calls the hook in the transaction that writes the occurrence, its slot and the next
  reservation. Both persist, or neither does. The hook gets copies of `type`, `input`,
  `occurrenceKey`, `routineId`, `definitionVersion` and `trigger`, and a transaction with
  `application` and `publish`. `publish` closes when the hook returns.
- A replay of the slot does not call the hook again. The ledger state is exactly once, but an
  external effect in a hook is not: a crash can roll the commit back after the effect. Keep
  hooks free of I/O.
- A hook that throws or returns a thenable rolls the occurrence back. The wake hook rejects, the
  SDK delivers the wake again after 60 seconds, and the routine reserves no later slot until a
  delivery commits. This is a fail-closed stall: repair the Host state or the hook.
- The hook runs inside the serialized drain transaction. A slow hook slows the whole core, like
  `applyOutcome`. A hook that calls core or ledger methods starts a second transaction and fails.
- The occurrence has `hook: {}` and no intent. It stays unsettled until the Host calls one of
  these exported transitions inside `ledger.transaction`, then `drain()`:
  - `promoteOccurrence(state, tenant, occurrenceKey, execution)` adds intent `occurrence:<key>`
    to the FIFO. The waiting deadline is `recordedAt + waitMs`, so a late promotion can expire
    at the next scan. Settlement writes the occurrence conclusion.
  - `concludeOccurrence(state, occurrenceKey, conclusion)` settles the occurrence without an
    execution.

  Each occurrence is promoted or concluded once. Both transitions refuse Host job and Agent
  occurrences.
- A newer slot marks an unpromoted occurrence with `hook.executionSuperseded`. A later promotion
  then settles as `superseded` at once. This is the rule for a late Host job escalation.
- An unsettled occurrence blocks a version switch. Promote or conclude every occurrence.
- `compact` removes a concluded occurrence through `acknowledgedOccurrenceKeys`, and a promoted
  occurrence through its intent key. It does not remove the Host's `application` rows.

A core without `hostOccurrence` support refuses these definitions and fails each of their wakes.
Settle the open occurrences and complete these routines before you roll back to such a core.

### Routine versions

`addRoutine` creates a routine. It is idempotent for the same definition and refuses a
different definition for the same ID. `updateRoutine` changes the version of an existing ID:

```ts
await core.updateRoutine({ ...current, version: current.version + 1, rule: newRule });
```

- The version must be `max(current, pending) + 1`. The Host service assigns it and keeps the
  version history and command receipts. The ledger keeps only the current definition and at
  most one staged `pending` definition.
- An exact replay of the current or the pending definition does nothing.
- A lower or skipped version, or the same version with other content, throws.
- The destination cannot change: an Agent routine stays an Agent routine, a Host job keeps its
  `type`, and a Host occurrence routine keeps its hook `type`. An unknown or completed routine throws.
- The new definition gets the `addRoutine` validation. Its calendar runs once before the update commits.

The pending version replaces the current one when the exported pure function
`versionSwitchDue(routine, occurrences, now)` is true: the routine is active, no occurrence of
the routine is unsettled, and no reserved old slot is due (`next` is null or later than `now`).
The switch cancels the old wake and reserves the first new slot after `now`. Admitted work
finishes with the version that admitted it.

- While a version is pending, a reserved old slot still records its occurrence, but the core
  reserves no later old slot. `recover()` and a same-definition `addRoutine()` do not refill the
  old chain either.
- The core checks the switch in the update commit, in `lifecycle()`, after each scan and after a
  memory change. No wake has to follow the last settlement.
- Pause keeps the pending version. Resume switches when the switch is due; otherwise the current
  version reserves its next slot. `completed` drops the pending version. This includes a resume
  that completes the current version because its `endAt` has passed.
- An old wake that arrives after the switch is audited as `reservation_mismatch`.
- A Host job occurrence stays unsettled until its handler succeeds. A handler that keeps failing on
  the current input therefore also blocks the switch to a version that changes the input. The
  admitted occurrence runs with the `type` and `input` of the current definition.

A core without `updateRoutine` ignores `pending`: it keeps the current version and refills its
chain. Let pending versions switch, or restore a backup, before you roll back to such a core.

### Sealed routines

A sealed routine (#654 E3d-4, design §6.3) runs an execution whose task input only a member and
the device can read. A member seals one routine template for one routine version with
`sealRoutineTemplate`: family `routine.template`, the routine id and version
in place of a task id, no device, the Agent, the category list and the expiry `notAfter`. The Host
stores the template and puts it, byte for byte, in the `sealed` member of each occurrence's
`task.offer` (its sealed branch, with `session: { mode: 'fresh' }`), next to the plaintext `routineRef`. It never
sees the scope key or the instruction.

- A routine `execution` is a plain `ExecutionTemplate` or a `SealedExecutionTemplate` (the payload
  has `sealing`). `enqueue`, on the core and as the exported transition, takes a plain execution
  only and refuses a sealed one: no stored routine checks its `routineRef` there, so
  `source: 'routine'` would be only a label. A sealed execution must parse as the sealed offer
  payload, and K4 takes it only as a routine template occurrence that seals `task-input` alone:
  - It must carry `routineRef` and enter as an occurrence of its routine: the routine's own
    `execution`, or `promoteOccurrence`. A task-bound ciphertext names one task id,
    and a retry generation gets a new one, so only the template binding, which names no task, can
    be resubmitted unchanged.
  - Its `sealing.categories` is exactly `['task-input']`: the core settles from the plaintext
    terminal and reads its outcome.
  - Its `sealed` member is inline: between occurrences no task holds a `ciphertextRef` blob, so
    orphan GC could delete it. `sealRoutineTemplate` refuses a template above the inline limit.
- `routineRef` must name the routine's own id and version: `addRoutine`, `updateRoutine` and
  `promoteOccurrence` refuse another one. Every version needs its own template, and a retry
  generation reuses the frozen bytes.
- The Host does not check `notAfter`; the device declines a passed one (#843).
- A sealed intent takes no memory ContextPack: with `options.memory` it fails with
  `A sealed execution takes no Host memory ContextPack`, and no plaintext is written next to the
  sealed instruction.
- Sealed dispatch is the optional `submitSealed` of `ExecutionServer.executions` and
  `FrozenSubmitPort`, the cloud's `submitSealedAgentExecution`. Without it, the core fails a
  sealed intent before any submit (`preparationError: 'sealed_dispatch_unavailable'`), and
  `submitFrozen` throws `SealedDispatchUnavailableError` before its readback. The core checks the
  lane at every submit: when a server loses it while a sealed submit is uncertain, the reconcile
  still verifies the frozen offer, but runs no submit readback and no submit until the lane
  returns or the intent expires.
- `sealRoutineTemplate` seals exactly `['task-input']`, the only category list K4 runs. The embedded `ByokServer` has none,
  because it declares no `e2ee.member` and so no daemon paired to it advertises `sealed-payload-v1`.
- `sameFrozenOffer` checks the offer type (`task.offer` for both lanes) and the canonical payload: a plain
  readback never matches a sealed input, nor the reverse, because only the sealed payload carries `sealing`. The payload compares exactly, because the Host resubmits its
  frozen bytes and the cloud keeps the first ciphertext.
- The outcome, an outbox projection and anything else the Host derives from the terminal stay
  plaintext, even when they carry content derived from the sealed input.

#### Routine commands in an outcome

`OutcomeTransaction.routines` runs `create`, `update` and `lifecycle` in the outcome commit, with
the rules of `addRoutine`, `updateRoutine` and `lifecycle()`. `list()` returns copies of the
routine rows, with the changes made earlier in the same commit. A refused command throws before it
changes any state, so a Host can catch the error and commit the rest of the outcome. The scan that
applied the outcome sends the new wake changes to the SDK.

### Agent execution retention

For tasks submitted successfully by the current core, `server.events` terminal
notifications trigger immediate reconciliation. Task readbacks remain authoritative.
The bounded event feed can drop hints, so a process-local timer still reconciles
at `reconcileMs` (default 1,000 ms) and at waiting deadlines. This reduces durable
wake writes, not reconciliation CPU or Host ledger writes. No default interval changes.

Recovered tasks, uncertain submissions and servers without events retain durable
`host-scan` wakes. A closed or failed event stream also restores that fallback.
One durable scan per second is about 86,400 completed rows per day, or 604,800
across the SDK's seven-day retention window, before cleanup. This is a planning
estimate, not a measured capacity limit. Other wakes add rows. Let the SDK manage
its wake retention; never delete SDK rows directly. Custom `events.subscribe()`
iterators must implement `return()` that releases a pending `next()`; otherwise
omit `events` and use durable reconciliation. The embedded server supports this
cancellation without closing other subscribers.

`HostOptions.admitSubmit(intent, state)` (#957) lets the Host hold a submit. The
core asks it in the transaction that begins a submit and again in the readback
right before the SDK call, with the intent and the ledger state. `false` holds
the intent: a queued or `backoff` intent keeps its phase and generation, so it
gets no new task id, and a begun intent is not sent. A held queued or `backoff`
intent arms the scan only for its expiry, so the Host calls `drain()` after it
admits again. A cancel still settles a held intent. It covers every submit of the core:
the timer drain, `recover()`, and direct `enqueue` calls. It must return a
boolean synchronously; any other value is a drain error on the intent's outbox
row. Without it, every submit is admitted.

`HostOptions.onOutbox(signal)` is a coalesced, serialized post-commit hint that a
result projection is available, including conclusions produced by internal drains.
The callback may call `flushProjections`, enqueue new work, or read the committed
ledger. Durable outbox records remain the authority; use stable projection IDs
and receiver deduplication. A callback failure retains projections and records
`lastError`. It does not spin on errors: retry via `recover()` or a later projection
notification. `recover()` also announces existing unacknowledged projections.

`close()` stops new hints, aborts the callback's signal and waits for a running
callback before returning to an external caller. Callbacks should honor the signal
when waiting on I/O. A callback may await `close()` itself; that invocation skips
waiting for its own callback to avoid a deadlock. A later external `close()` still
waits for that callback to finish. Close the ledger only after external core close.

When adopting this code, define a retention policy for the Host ledger:

- Keep unsettled intents, their execution evidence, and every unacknowledged outbox row.
- Archive settled records and large outcome documents after result acknowledgement and the product's retention period.
- Keep task application and slot dedup tombstones through the maximum replay, upload retry and backup-restore window.
  Include at least the SDK's seven-day completed-wake replay window. Do not reuse retired identities.
- Apply archive and tombstone changes atomically. Measure JSON rewrite cost before selecting a storage budget.

After acknowledging results, completing any required external archive, and satisfying your product's
retention period, explicitly select the intent keys to delete:

```ts
const result = ledger.compact({
  acknowledgedIntentKeys: ['chat-turn-42'],
  now: Date.now(),
  tombstoneRetentionMs: 30 * 24 * 60 * 60 * 1000, // Choose your actual replay/restore window.
});
console.log(result.beforeBytes, result.afterBytes);
```

Selection is an assertion by the caller that these results may be removed. The core does not infer
acknowledgement or product retention from timestamps. The method rejects unsettled intents, pending
intent/result outbox records, unknown keys, and inconsistent execution/occurrence associations. An
invalid selection or database failure rolls back the entire batch, including tombstones. Repeating
an already compacted key is harmless and reports `alreadyCompactedIntents` while its identity row
exists; duplicate keys count once. A routine occurrence key is unknown again after its row expires.
An empty selection explicitly expires eligible tombstones without selecting additional history.

An application that keeps its own rows by intent key can register one veto when it opens the
ledger: `new HostLedger(file, tenant, { compactVeto })`. `compact` calls it in its own transaction,
before it removes anything, once for each selected intent key that still has an intent and once for
the derived `occurrence:` key of each selected occurrence. A veto returns a reason to refuse that
key, or `undefined` to allow it. A refusal throws the exported `CompactVetoError` with stable
`code: 'compact_vetoed'` and the refused `intentKey`, and the whole batch rolls back. A veto must
not change the state; a change also rolls the batch back. The veto guards each compaction through
that `HostLedger` instance. Another instance opened without it does not run it.

One SQLite transaction deletes the selected intent's execution generations, terminal documents,
settled occurrence, slot and application markers, and writes replacement tombstones. No outbox row,
business `application` value, routine or calendar audit is deleted. Memory rows are deleted only
when selected through `acknowledgedMemoryIntentIds` (see [memory retention](#memory-retention)).
Custom projections have no intent ownership metadata and remain untouched, including any payload
copies they contain. `core.intent(key)` returns `undefined` after compaction. Enqueuing a retired key
throws the exported `RetiredIntentIdentityError` with stable `code: 'retired_intent_identity'`, even
with the same input; this applies to the exported `enqueue` transition inside `ledger.transaction` as well.
Use a new identity for new work.

The core derives each routine occurrence intent key as `occurrence:` followed by the 64 lowercase
hex characters of its occurrence key. This key shape is reserved. The core admits such a key only
together with its own occurrence; a direct enqueue throws `RetiredIntentIdentityError`, also after
the identity row expires. Other keys that start with `occurrence:` are ordinary caller keys.

The additive `host_retired_identity` table keeps intent identity hashes outside the hot JSON body,
together with expiring task-application and wake-slot evidence. Retention starts at compaction and
must be at least seven days; choose the maximum of your actual replay, upload retry and restore
windows. `ledger.hasTombstone(kind, identity, now)` queries that evidence. Application tombstones
are evidence for the Host, queried with `hasTombstone('application', taskId, now)`; the core does not
consume them or replay removed application results. Retained wake replays do
not create occurrences or dispatch work. At the exact expiry time slot/application evidence is no
longer returned; a subsequent explicit compaction removes those rows.

Caller intent identities (every key outside the derived routine shape) never expire. That part of
the table grows with the count of compacted caller intents. A routine occurrence identity expires
with its slot row. The next reservation is always later than the delivered slot, also when the Host
clock is behind the SDK scheduler. So after expiry, the routine reservation refuses the old slot and
the reserved key shape refuses direct reuse. Each compacted Agent routine occurrence keeps one
intent row, one slot row and, after an applied outcome, one application row until a compaction at
or after expiry deletes them. A Host-only occurrence keeps only its slot row. For example, 200 rules that run every
5 minutes make 57,600 occurrences per day. A 7-day window then holds about 1.2 million rows and a
30-day window about 5.2 million rows, plus the rows that wait for the next compaction. These numbers
are calculated from the row counts, not measured. Rows that an earlier version wrote as permanent
stay permanent: the table stores only a hash, so the core cannot identify the routine rows among them.

Removed core payloads no longer enlarge each JSON rewrite. Host-owned application data, custom
projections, routines and audits can still grow independently; compact does not claim a total
disk-size bound or run VACUUM.

Opening an existing version-1 ledger adds the tables without changing its JSON format. Back up and
restore the **whole SQLite database atomically**, including the identity, retired memory and application row tables
(and SQLite's WAL state through a supported backup mechanism). Restoring JSON alone or running an
older copy of the core loses the retirement guard. Do not downgrade to an earlier version after using
this API: an older writer ignores the new tables and can reuse retired identities, routine keys and
memory approval references. Seven days is a minimum SDK replay horizon, not proof that an old
backup is safe to restore; coordinate restores with your external acknowledgement/replay policy.
This API performs deletion, not external archival, and must only be invoked under the Host's policy.

Set `HostOptions.reconcileMs`, for example `{ reconcileMs: 10_000 }`, to reduce fallback scan frequency.
The default is unchanged. A larger interval increases terminal observation and FIFO release latency
after a lost notification or restart; delivered terminal hints still reconcile promptly.
Choose the interval from the product's latency budget and measured write load.

The default calendar supports fixed UTC intervals and UTC quiet hours.
Inject a shared pure calendar for cron, other time zones, DST or business calendars.
After you fix a `calendar_error`, await `lifecycle(id, 'paused')`, then await `lifecycle(id, 'active')`; `recover()` and same-definition `addRoutine()` do not recover that state.
The SDK still receives only one-shot times.
The Host's `WAKE_HORIZON_MS` uses the public `WAKE_MAX_FUTURE_MS` export from `@byok-sdk/server`, currently 368 days.
Candidates beyond that horizon use `schedule_retrying` backoff without blocking other work.

The Host service owns definition versions, CAS commands, sync, authentication,
result upload policy, visibility, retention and deletion. The core mirrors the
current definition and at most one pending version; see [Routine versions](#routine-versions).
The Host service must retain its version history and command receipts.
The core does not implement the service's command API or UI.

The Aimpact scope ruling of 2026-10-18 assigns the service rows in platform PRD section 14.1
to the downstream Host service after K2 and A2, as specified in that PRD.
These rows cover routine sync with the browser closed, `sync_failed`, 409, `device_offline`,
`missed`, security and cost. This reference covers the device-local Topology L execution rows.

The owner decisions of 2026-10-22 for #606 (O1, O2 and O8) move same-routine-ID version changes
into K4 `updateRoutine`. K4 keeps its overlap rule: a new slot settles queued older work and keeps
the running one. Since #737, K8 Bot routines are K4 `hostOccurrence` routines.

K8 actions and group chat remain in their own work orders.
P5a adds Host memory commands and Linux synthetic memory tests below.

See the [recorded validation](../examples/host-execution-core/VALIDATION.md) for commands, results and acceptance limits.

### Topology switch dump (#975)

A topology switch moves a whole coordination domain, which is one ledger tenant on L.
The ledger copies a tenant as stored. The switch preconditions (freeze, drain, no memory
state) and the neutral switch format belong to the caller (K8).

- `ledger.dumpForSwitch()` returns a `LedgerDump` read in one transaction:
  - the ledger `body`;
  - `tombstones`: every `intent`, `application`, `slot` and `row` tombstone, each with its
    `expiresAt`, or `null` for one that never expires;
  - `rows`: every application row, with its `expiresAt` or `null`;
  - `memoryTombstones`: every retired memory intent.

  Each list is ordered by its key. Expired rows that no `compact` or `expire` has removed
  yet are included. The dump has no tenant id.
- `ledger.loadForSwitch(dump, verify)` writes a dump into this tenant in one transaction:
  - It refuses unless the tenant is empty: the body of a new ledger, and no row in the
    other tables.
  - It refuses while a core is bound to this ledger. Load first, then start the core. The
    loaded work stays inert until then, and the load sends no outbox hint.
  - It refuses a malformed dump. It also refuses a body intent that the dump's own `intent`
    tombstones retire, and a derived `occurrence:<key>` intent outside its occurrence. These
    are the checks of `transaction()`.
  - The dump must be bound to this tenant, because some stored identities include the tenant:
    - each intent's `agent` must be `agentKey(tenant, execution)`; otherwise imported work
      would queue apart from new work for the same device and Agent;
    - a `host-scan:` wake key (`scanWake`, or a pending schedule or cancel) must name this
      tenant;
    - there must be no memory state (no memory record and no retired memory intent). Memory
      binds the tenant inside its digests and does not move (D4).

    A dump from a tenant of the same id loads as it is. For a new tenant id, the caller
    builds the dump with that tenant's keys.
  - Every expiry is kept, never reset, so replay evidence ends when it would have ended on
    the source.
  - After the writes, before the commit, it reads this tenant back with the queries of
    `dumpForSwitch` and calls `verify(readBack)`. A throw rolls the whole load back, so a
    caller that checks the read-back leaves either a verified tenant or an empty one.
  - Any failure, a duplicate key included, rolls the whole load back.

  A dump loaded into an empty tenant whose tenant-derived identities it names dumps back equal.
- `ledger.discard()` deletes every row of this tenant in one transaction, tombstones
  included, and then closes the ledger. It cannot be undone, and the retired identities of
  that tenant become usable again under its id.
  - Use it only for a tenant that never ran work, such as an aborted switch import.
  - It refuses while a core is bound.
  - Other `HostLedger` instances open on the same tenant stay open.
  - Reopening the tenant id creates an empty tenant, as the constructor does for any new
    tenant.

A switch format derives some stored values again from the values that move. The core exports
each of its encodings as one function and calls it itself, and K8 calls them too:
`routineWakeKey(id, version, at)` (the inverse of `parseRoutineWakeKey`),
`occurrenceIntentKey(occurrenceKey)`, `isOccurrenceIntentKey(key)` and its inverse
`occurrenceOfIntentKey(key)`,
`frozenInput(execution, taskId)` (the input of one generation), `taskId(key, generation)`,
`agentKey(tenant, execution)` and `validateRetry(retry)`.

### P5a memory page

`HostMemoryPage` (`packages/server/src/execution-core/memory.ts`) is the Host half of memory intents. It uses the existing SDK wire.
The Host stores pending bodies in its separate SQLite ledger.
It removes the body in the same transaction that stores a terminal readback.
This is logical removal. It does not erase database backups or old WAL pages.

Use `HostMemoryPage.approve` only after the Host authenticates the user and authorizes
one exact operation. Supply the current device and Agent profile from Host state.
Bind `transport(deviceId)` to the authenticated device, then inject it as
`DaemonConfig.agentMemoryIntents`. Do not take the device ID from a request body.
Call `flushNotices` after approval and at Host startup. Retry it after a transport error.
For an embedded server, inject `notify: (deviceId, notice) =>
server.enqueueAgentMemoryIntentNotice(deviceId, notice)`. The server binds its own
tenant and preserves the cloud capability, revocation and exact-notice checks.
A hosted composition uses `cloud.enqueueAgentMemoryIntentNotice(tenant, deviceId, notice)`.
Both APIs send only `{ intentId, agentRef }`; intent fetch, approval and terminal
readback remain on the authenticated Host transport. Never insert a mailbox row by hand.

P5a supports explicit whole-file replacement and note deletion. It has no normal editor.
A user can authorize an initial write with `baseRevision` omitted. This uses sha256 of
empty bytes. It can create or replace an empty file, or delete an empty note.
It is not a read-only revision probe. A conflict ends the intent and returns `observed`.
For a nonempty file, use two approvals:

1. The user approves the exact whole-file body with an EMPTY base. The first intent
   returns `conflict{observed}` and changes no file. The Host shows that result.
2. The user makes a new decision to replace the whole file, including unseen content.
   The Host creates a new `intentId` and `approvalRef`. It sets `baseRevision` to
   `observed.revision`, sets the approved body and recomputes the operation digest.
   A concurrent device write can still return another conflict.

If the file is absent or empty, the first write can apply. A second approval is then unnecessary.
`observed` gives a revision, not the hidden contents. This is explicit whole-file replacement.
The Host never puts the observed revision on an old draft by itself.
Redacted text is read-only. P5b owns edit-view and `contentComplete`.

#### Explicit tree restore

`HostMemoryPage.restore` coordinates an approved complete memory tree through the
existing per-file intents. Configure `MemoryOptions.exportMemory(binding)` as a
trusted device-bound call to the explicitly enabled daemon's
`exportAgentMemory(binding.agentRef)`. This is raw local export, never the
redacted projection. A restore-enabled page and `HostExecutionCore` must share
the **same HostLedger instance**, not merely a tenant or filename. This allows
restore admission and execution admission to inspect one transactional state.
Projection-only compositions retain their existing behavior.

A restore request has `{deviceId, agentRef, restoreId, files, mode, observed?,
expiresAt}`. `files` is a complete exported-format target tree including
`MEMORY.md`, with validated content/revisions/byte counts, at most 128 files and
1 MiB. Paths use the existing memory policy. In `initial` mode a fresh local
export must contain only empty `MEMORY.md`; otherwise every target is reported
as a preflight conflict and **no write intent is created**. In `overwrite` mode,
`observed` must be the exact export whose revisions the user approved replacing.
The coordinator recomputes its digest, rejects a changed current tree without
writes, freezes those approved bases, and deletes observed notes absent from the
target. It never silently refreshes overwrite authority. Unchanged files return
`unchanged` without a write. The empty-backup target is one empty `MEMORY.md`;
that file cannot be deleted.

Before export or notification, the ledger commits a `preparing` restore and a
durable gate for that device/Agent home. A matching in-flight K4 execution,
independent pending memory intent, or another restore refuses admission. During
restore, ordinary approvals are blocked and `contextPack` uses the existing
`MemoryBlockedError` / `memory_blocked` queue mechanism. Other Agents continue.
No running task is cancelled. The gate covers K4 submissions only, not external
filesystem writers or other execution systems.

After preflight, all deterministic per-path approval identities and their new
intent rows commit together. Call `flushNotices()` to deliver them through the
existing embedded/cloud notification adapter. `restoreResult(binding, restoreId)`
returns per-file and aggregate progress. The gate remains until every committed
intent has a durable terminal readback. Mixed applied/conflict/rejected/uncertain
results are preserved; aggregate priority is uncertain, conflict, rejected, then
applied. A terminal uncertain result permits the queue to resume only after all
files are terminal; it does not establish the resulting tree or claim rollback.
This is **not an atomic filesystem tree transaction**. Concurrent external edits
can cause partial CAS results. Conflict never automatically mints a new intent.

At Host startup, call `await page.recoverRestores()`, then `await core.recover()`
and `await page.flushNotices()`. A preparing export failure retains the gate and
durable request; same-id/same-payload retry resumes it. Changed reuse is rejected.
`cancelRestore(binding, restoreId)` can explicitly cancel only a preparing row;
a late export result cannot commit after cancellation. Once intents commit,
cancellation cannot promise rollback and is refused. Expiry does not silently
release an applying gate: device terminal readbacks are still required. Do not
downgrade to a core that ignores restore gates while any restore is active.

Pending restore input (including the approved observation) is retained only
through preparation and purged when intent rows take ownership of pending bodies.
Terminal restore rows retain metadata and outcomes; they are not compacted. Their
intent rows can be compacted after the restore ends (see [memory retention](#memory-retention)).
The core adds no backup upload, remote restore authorization, automatic retention
policy, or Windows memory admission.

The embedder redactor can emit the Host-owned opaque JSON profile
`{"residentMemory":"policy-approved resident text"}` through the existing projection port.
Use `null` when the snapshot has no `MEMORY.md`. Send no paths or raw source revisions.
This profile is not an SDK edit-view format and conveys no completeness proof.
Set `authorizeProjection` to check the exact task, device, session, runtime, grant,
policy revision and writer epoch from trusted Host records. The model destination
must also be allowed by that policy. The core calls this check again at ContextPack read.

Pass the memory page to `HostExecutionCore` as `options.memory`.
The scanner adds only the resident text and projection metadata to the inline instruction.
It freezes this input before submit. Blob instructions need an embedder-owned composition step.
Notes do not enter this ContextPack. The model can recall them through the SDK tools.
An absent projection or null resident text omits resident memory from the instruction.
This lets a new Agent run its first task and publish at task close. A new profile revision
uses the same bootstrap path. No manual projection publish is required.
Text above 8192 UTF-8 bytes puts the queue head in persisted `memory_blocked` state.
Unauthorized projections also park until repair. A changed placement or profile and
a blob instruction settle as `failed` before submit. The result includes `preparationError`.
The next intent for that Agent can start. Submit a new intent with an inline instruction
to replace a failed blob intent.
No text is truncated. The block spends no attempt or generation.
Only deadline wakes remain while blocked. Accepted projections recheck the blocked binding
and commit a reconciliation wake. If that schedule fails, the core makes one attempt
to restore a deadline wake. Duplicate publish can request an earlier scan again.
If the fallback fails too, the durable outbox keeps its deadline for recovery or a later drain.
Startup recovery also rechecks stored blocks and settles failures that cannot be repaired.

To refresh after the size block, the user approves a whole-file `MEMORY.md` replacement
of at most 8192 raw UTF-8 bytes. A verified `applied` completion invalidates the old display
for ContextPack and wakes the parked queue. It keeps the old ordering metadata.
The next core task runs without resident memory. Its normal task close sends a fresh,
policy-approved projection. The replacement body never enters ContextPack directly.
Late projections from older tasks keep the refresh pending. Only a projection from a
new core submission after the repair clears it. Conflict, rejected, uncertain and
oversized replacements cannot bypass the size block.

Projection receipt time is `projectedAt`. It is not the device's file modification time.
An applied intent does not create a projection. Task-close projection may still be old.
The original timestamp stays with the old display. An invalidated display is omitted from ContextPack.

Linux tests use a real cloud mailbox, daemon, home lease, native CAS and device ACK.
The runtime is synthetic. No model provider is called.
Run `bun run --cwd examples/host-execution-core test src/memory-linux.test.ts` on Linux.
These Linux tests skip on other platforms. macOS and Windows proof stay in P2.

#### Memory retention

Terminal memory intent rows and their approval keys stay in the Host ledger until the Host
selects them. After the Host acknowledges a readback, pass its intent ID to the same explicit
compaction call:

```ts
ledger.compact({
  acknowledgedIntentKeys: [],
  acknowledgedMemoryIntentIds: [intentId],
  now: Date.now(), tombstoneRetentionMs: 30 * 24 * 60 * 60 * 1000,
});
```

Only rows with a terminal readback qualify. A pending row, an unknown ID, or a row that a
preparing or applying restore uses rejects the whole batch. Rows that are not selected do not
change. The transaction moves each selected row and its approval key from the JSON body to the
additive `host_retired_memory_intent` table. The row holds metadata and the readback, never memory
content. The retired copy expires at the later of `now + tombstoneRetentionMs` and the approval's
own `expiresAt`. The result counts removed rows in `memoryIntents`, a repeated ID inside the window
in `alreadyCompactedMemoryIntents`, and deleted expired copies in `expiredTombstones`.

Until the copy expires, `approve` with the same request and `approvalRef` returns the original
row, and a changed request throws the existing identity conflict. Device `fetch` and `complete`
replays get the stored terminal readback. `page.intent(intentId)` returns `undefined`, and
`revoke(intentId)` throws because the intent is not found. At the expiry time the lookup stops
returning the copy, and the next compaction deletes it. The same `approvalRef` is then a new
request with a new `intentId`, and a device replay of the old intent fails as unknown. Set the
retention to at least your approval replay and notice redelivery windows. The replay lookup reads
`MemoryOptions.now`, which must return integer milliseconds, as `Date.now` does. Pass `compact` the
same clock. A compaction `now` ahead of `MemoryOptions.now` can delete a copy while `approve` still
accepts its approval. A restore with the same `restoreId` still returns its stored result, because
restore rows stay.

#### Optional projection outbox capacity

A Host can opt into backpressure without deleting undelivered projections:

```ts
const ledger = new HostLedger(filename, tenant, {
  projectionOutboxLimits: { maxCount: 1000, maxBytes: 8 * 1024 * 1024 },
});
const { count, bytes } = ledger.projectionOutboxUsage();
```

These numbers are illustrative Host choices, not defaults. Omitted limits are
unlimited; supplied limits must be nonnegative safe integers (zero disallows growth).
The constructor copies the configuration. Limits apply to this ledger owner and
must be supplied again when reopening it. They do not change the database schema.

`count` counts projection rows only. `bytes` sums the UTF-8 byte length of
`JSON.stringify([outboxKey, { kind, id, value }])` for each projection row. It includes
its stored identity and value, but excludes retry diagnostic `lastError`, other
outbox kinds, and all other ledger state. This is not a total disk or ledger-size
limit. Failed delivery can still record its bounded diagnostic and retry safely.

Exceeding capacity throws the exported `OutboxFullError` (`code: 'outbox_full'`)
without including identities or payloads. The complete ledger transaction rolls
back, including application writes, applied markers and terminal settlement.
Replaying an identical projection does not consume additional capacity. If an
existing database already exceeds either configured limit, transactions may keep
or decrease both current count and bytes, but may increase neither until within
limits. Control transactions and projection delivery/removal therefore remain
available; nothing is evicted to satisfy a newly configured limit.

Capacity is checked at commit, not reserved by `enqueue`: future result sizes and
custom outcome publications are unknown. A result requiring more than the entire
configured capacity cannot settle until the Host increases its limit. On capacity
refusal, the core restores scan scheduling no earlier than the existing `reconcileMs`
interval before rejecting the drain or wake hook;
a concurrent wake-dispatch failure is retained alongside the capacity error in
`AggregateError.errors`. Flush acknowledged projections, then retry `drain()`.
Outcome callbacks must remain synchronous, transaction-local and safe to retry.

This option does not bound control outbox rows or memory rows. Memory readback is
not a client acknowledgement; [memory retention](#memory-retention) describes the
explicit compaction of acknowledged memory intents.
