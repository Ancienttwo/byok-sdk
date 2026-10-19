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

It does not implement Bot delegation, group chat, confirmable actions, routine outcome
actions, memory pages or synthetic end-to-end slices beyond chat, routines and crash recovery.

See [VALIDATION.md](VALIDATION.md) for commands, results and acceptance limits.
