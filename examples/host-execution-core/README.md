# Host execution core

This is the K4 copy-and-own TypeScript reference for a device-local Host.
It uses the public embedded server API. It does not change the SDK.
Read the [Host guide](../../docs/host-execution-core.md) before integration.

## Run

From the repository root:

```sh
bun ci
bun run build
bun run --cwd examples/host-execution-core typecheck
bun run --cwd examples/host-execution-core test
```

Tests start an embedded SQLite server and a daemon with a fake Pi runtime.
The runtime calls the real reserved `submit_result` helper.
The Bot chat test also reads the exact `accepted` message disposition from the SDK after `messageEgress`.
It shares a FIFO and the outcome transaction with a routine.
They do not call a model provider or require a browser.
The crash test sends SIGKILL to a child Host during wake delivery.

## Files

| File | Responsibility |
| --- | --- |
| `src/core.ts` | FIFO dispatch, exact recovery, cancellation, retry, outcome application and outbox scans. |
| `src/ledger.ts` | A separate Host SQLite ledger with synchronous transactions. |
| `src/model.ts`, `src/transitions.ts` | Durable records, stable identities and atomic state changes. |
| `src/routines.ts` | Occurrence deduplication, next-slot commit, coalescing and lifecycle. |
| `src/schedule.ts` | The default UTC interval calendar and the shared calendar callback type. |
| `src/index.ts` | The example's copy-and-own entrypoint. This is not a published SDK package. |
| `src/*.test.ts` | Contract probes and real server/daemon smoke tests. |

## P1: Boundary

The Host owns intent, occurrence, FIFO, generation and semantic outcome state.
The SDK owns offer admission, claim, cancellation and device terminal evidence.
The example calls `executions.submit`, `tasks.offer`, `tasks.attempt`,
`tasks.deviceTerminal`, `tasks.cancel`, and `wakes.schedule/cancel/pending`.
It consumes wakes through the public `wake.consume` hook.

Each Host instance has one tenant and one ledger owner.
SQLite stores a small JSON ledger in one row. This keeps application state,
outcome markers and outbox records in the same transaction.
Use a separate Host database. Never open the SDK database or an Agent home as this ledger.

## P2: Real path

`addRoutine` commits a definition and its scheduling state.
An in-horizon candidate also adds a schedule outbox record.
The wake hook commits one occurrence, its intent, and the next planned time together.
The scanner reserves the complete execution input before it calls `executions.submit`.
The daemon executes that input. The fake runtime submits a real result document.
The scanner reads the canonical device terminal and applies the opaque outcome once.
The same transaction writes the intent conclusion and its result projection.
An uploader retries projections with stable IDs.
Wake dispatch failure rejects the hook so the SDK retains a retry trigger.
A failed direct call can already have committed its ledger entry. Retry the same input or call `recover`.

SIGKILL recovery opens the same Host and SDK databases.
The scanner reads the existing offer and retains the original input and taskId.
It does not create a new generation to recover an uncertain submission.

## P3: Decision and accepted boundary

Use the existing SQLite and public API conventions from `examples/basic`.
Keep one FIFO per `(tenant, deviceId, agentId)`. Profile changes do not create another FIFO.
Use the embedded wake queue for execution deadlines and backoff.
An out-of-horizon routine candidate uses process-local backoff until K2 can accept it.
Keep outcome semantics in a synchronous injected callback. K8 actions are outside K4.

The owner resolved the initial expiry blocker on 2026-10-18.
The allowed readbacks now include `tasks.attempt` and `tasks.get`.
At a waiting deadline, cancel first and then read the canonical attempt.
An unclaimed cancelled attempt concludes `expired` without a device terminal.
A claimed cancellation holds the FIFO until a device terminal, then concludes `cancelled`.
A claim that wins at the deadline can be interrupted. This boundary is accepted.
See `unclaimed-expiry.test.ts` and the guide for the exact distinction.

## Integration limits

This example is a single-owner reference for a small ledger.
Every transaction reads and rewrites the whole JSON ledger. The example does not clean up history rows.
That includes settled intents, executions with terminal documents, occurrences, slot dedup keys,
outcome markers and calendar audits. They are not a large-dataset storage design.

While work is in flight, the core normally creates a new `host-scan` wake every `reconcileMs`
(default 1,000 ms). Earlier deadlines can cause earlier scans. The SDK retains done wake rows for seven days.
One scan per second is about 86,400 completed rows per day, or 604,800 over seven days, before bounded cleanup.
This is a planning estimate, not a measured capacity limit. Other wakes add rows.
Let the SDK manage its wake retention. Do not delete SDK rows directly.

When adopting this code, define a retention policy for the Host ledger:

- Keep unsettled intents, their execution evidence, and every unacknowledged outbox row.
- Archive settled records and large outcome documents after result acknowledgement and the product's retention period.
- Keep task application and slot dedup tombstones through the maximum replay, upload retry and backup-restore window.
  Include at least the SDK's seven-day completed-wake replay window. Do not reuse retired identities.
- Apply archive and tombstone changes atomically. Measure JSON rewrite cost before selecting a storage budget.

Set `HostOptions.reconcileMs`, for example `{ reconcileMs: 10_000 }`, to reduce normal scan frequency.
The default is unchanged. A larger interval increases terminal observation and FIFO release latency.
Choose the interval from the product's latency budget and measured write load.

The default calendar supports fixed UTC intervals and UTC quiet hours.
Inject a shared pure calendar for cron, other time zones, DST or business calendars.
After you fix a `calendar_error`, await `lifecycle(id, 'paused')`, then await `lifecycle(id, 'active')`; `recover()` and same-definition `addRoutine()` do not recover that state.
The SDK still receives only one-shot times.
The Host's `WAKE_HORIZON_MS` uses the public `WAKE_MAX_FUTURE_MS` export from `@byok-sdk/server`, currently 368 days.
Candidates beyond that horizon use `schedule_retrying` backoff without blocking other work.

The Host service owns definition versions, CAS commands, sync, authentication,
result upload policy, visibility, retention and deletion. This example mirrors an
immutable definition. The Host service must retain its version history and command receipts.
The example does not implement the service's version-change workflow, command API or UI.

The Aimpact scope ruling of 2026-10-18 assigns the service rows in platform PRD section 14.1
to the downstream Host service after K2 and A2, as specified in that PRD.
These rows cover routine sync with the browser closed, `sync_failed`, 409, `device_offline`,
`missed`, security and cost. This reference covers the device-local Topology L execution rows.

The same ruling assigns same-routine-ID version changes to K8a with `update_routine`.
This includes current/pending versions, scheduling generation and the in-flight limit.
This reference keeps each routine ID's definition immutable. Use a new ID to change a definition.

K8 actions and group chat remain in their own work orders.
P5a adds Host memory commands and Linux synthetic memory tests below.

See [VALIDATION.md](VALIDATION.md) for commands, results and acceptance limits.

## P5a memory page

`src/memory.ts` adds the Host half of memory intents. It uses the existing SDK wire.
The Host stores pending bodies in its separate SQLite ledger.
It removes the body in the same transaction that stores a terminal readback.
This is logical removal. It does not erase database backups or old WAL pages.

Use `HostMemoryPage.approve` only after the Host authenticates the user and authorizes
one exact operation. Supply the current device and Agent profile from Host state.
Bind `transport(deviceId)` to the authenticated device, then inject it as
`DaemonConfig.agentMemoryIntents`. Do not take the device ID from a request body.
Call `flushNotices` after approval and at Host startup. Retry it after a transport error.
Its callback calls the public cloud `enqueueAgentMemoryIntentNotice` API.
The embedded server facade has no memory-notice method. The callback must use the
owning cloud composition. Never insert a mailbox row by hand.

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

The embedder redactor can emit the Host-owned opaque JSON profile
`{"residentMemory":"policy-approved resident text"}` through the existing projection port.
Use `null` when the snapshot has no `MEMORY.md`. Send no paths or raw source revisions.
This profile is not an SDK edit-view format and conveys no completeness proof.
Set `authorizeProjection` to check the exact task, device, session, runtime, grant,
policy revision and writer epoch from trusted Host records. The model destination
must also be allowed by that policy. The example calls this check again at ContextPack read.

Pass the memory page to `HostExecutionCore` as `options.memory`.
The scanner adds only the resident text and projection metadata to the inline instruction.
It freezes this input before submit. Blob instructions need an embedder-owned composition step.
Notes do not enter this ContextPack. The model can recall them through the SDK tools.
An absent projection or null resident text omits resident memory from the instruction.
This lets a new Agent run its first task and publish at task close. A new profile revision
uses the same bootstrap path. No manual projection publish is required.
Text above 8192 UTF-8 bytes puts the queue head in persisted `memory_blocked` state.
Blob instructions also park with a clear reason. The Host can cancel that intent and
enqueue a new intent with an inline instruction.
No text is truncated. The block spends no attempt or generation.
Only deadline wakes remain while blocked. Accepted projections recheck the blocked binding
and commit a reconciliation wake. Startup recovery also rechecks stored blocks.

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
