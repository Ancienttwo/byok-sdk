# Host execution core

This is the K4 copy-and-own TypeScript reference for a device-local Host.
It uses the public embedded server API.
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
| `src/core.ts` | FIFO dispatch, exact recovery, cancellation, retry, outcome application, occurrence hooks and outbox scans. |
| `src/ledger.ts` | A separate Host SQLite ledger with synchronous transactions. |
| `src/model.ts`, `src/transitions.ts` | Durable records, stable identities, atomic state changes, and the FIFO head and queued expiry rules. |
| `src/canonical.ts` | Canonical JSON and its SHA-256. The `./canonical` entry exports only these two and imports only `node:crypto` (#884). |
| `src/submit.ts` | The frozen-offer submit protocol: readback first, the frozen offer check and the stop hook. Shared with the hosted lane. |
| `src/routines.ts` | Occurrence deduplication, next-slot commit, coalescing, lifecycle, version switches and Host occurrence transitions. |
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
The outbox keeps the failed wake call with `lastError`. A process timer of that row drains
after 1 s, 2 s, 4 s and so on, up to 60 s, for at most 10 timed drains (about 5 min).
Each drain retries all failed wake calls. After the last timed drain, only later drains,
wake deliveries or `recover()` retry the row. The row and its `lastError` stay until it is sent.
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

## Integration limits

This example is a single-owner reference for a small ledger.
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

## Host jobs and execution-free occurrences

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

## Host occurrences

A `hostOccurrence` routine lets the Host write its own state in the commit that records the
occurrence. The Host decides later whether the occurrence needs an Agent execution:

```ts
import { concludeOccurrence, promoteOccurrence } from '@byok-sdk/example-host-execution-core';

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

## Routine versions

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

### Routine commands in an outcome

`OutcomeTransaction.routines` runs `create`, `update` and `lifecycle` in the outcome commit, with
the rules of `addRoutine`, `updateRoutine` and `lifecycle()`. `list()` returns copies of the
routine rows, with the changes made earlier in the same commit. A refused command throws before it
changes any state, so a Host can catch the error and commit the rest of the outcome. The scan that
applied the outcome sends the new wake changes to the SDK.

## Agent execution retention

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
result upload policy, visibility, retention and deletion. This example mirrors the
current definition and at most one pending version; see [Routine versions](#routine-versions).
The Host service must retain its version history and command receipts.
The example does not implement the service's command API or UI.

The Aimpact scope ruling of 2026-10-18 assigns the service rows in platform PRD section 14.1
to the downstream Host service after K2 and A2, as specified in that PRD.
These rows cover routine sync with the browser closed, `sync_failed`, 409, `device_offline`,
`missed`, security and cost. This reference covers the device-local Topology L execution rows.

The owner decisions of 2026-10-22 for #606 (O1, O2 and O8) move same-routine-ID version changes
into K4 `updateRoutine`. K4 keeps its overlap rule: a new slot settles queued older work and keeps
the running one. Since #737, K8 Bot routines are K4 `hostOccurrence` routines.

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

### Explicit tree restore

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
This example adds no backup upload, remote restore authorization, automatic retention
policy, or Windows memory admission.

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

### Memory retention

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

### Optional projection outbox capacity

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
