# @byok-sdk/server

Embed the `@byok-sdk/cloud` coordination kernel in a Node.js process serving
one product and one tenant. The server handles pairing, device authentication,
dispatch, approvals, cancellation and device discovery over protocol v4.
Use `@byok-sdk/cloud` with `@byok-sdk/cloud-dataplane` for a multi-instance
hosted deployment.

Requires Node.js 24.22.1 or newer. MIT licensed.

## Embed the server

```ts
import { createByokServer } from '@byok-sdk/server';

const server = createByokServer({
  productId: 'my-product',
  storage: { kind: 'sqlite', path: './byok.sqlite' },
});

// Mount server.hono at the root of your HTTP application, or serve its .fetch.
// The Host owns its HTTP listener and authentication for Host-facing routes.

// On shutdown, stop accepting HTTP requests and release the SDK's resources.
await server.close();
```

Omit `storage` for process-local memory. Explicit SQLite storage fails closed
if the file cannot be opened; it does not fall back to memory. The Host closes
its HTTP listener separately.

## Identity-stable loopback listener

`listenLoopback` is an opt-in Node HTTP listener for a device-local Host. Pass
an identity-scoped durable `LoopbackPortStore`: `read()` returns the immutable
assigned port or null for a genuinely new identity; `claim(candidate)` must
atomically insert only if absent, commit durably, and return the winning port.
Use a database transaction or equivalent interprocess compare-and-set. Never
implement claim as an unlocked read followed by a write. Missing/corrupt port
state for an existing paired identity must throw, not return null.

```ts
import { listenLoopback, type LoopbackPortStore } from '@byok-sdk/server';

// Supplied by your Host's durable identity store, not by the SDK.
declare const portStore: LoopbackPortStore;
const listener = await listenLoopback({
  portStore,
  createHandler: () => request => server.hono.fetch(request),
});
// Persist this exact URL with the daemon configuration. The cursor identity
// includes serverUrl, so do not substitute localhost or change the port.
const serverUrl = listener.serverUrl;

// Stop the daemon before closing its listener; close the SDK separately.
await listener.close();
await server.close();
```

New identities draw at most 16 distinct ports from `[24000, 32768)`, retrying
only `EADDRINUSE`/`EACCES`. `portRange: { min, maxExclusive }` can override this
range for the Host's network policy; OS ephemeral ranges can be reconfigured.
An existing assigned port is attempted exactly once and fails closed if busy.
The helper binds exclusively to `127.0.0.1` before claiming the port. Requests
receive 503 until claim/readback and handler construction finish. A losing
claim closes its candidate and tries the durable winner once; it never adopts
another process's listener. Persistence errors, changed readback, handler
construction failures and abort release the owned socket. A failed or aborted
claim may already have committed: the helper never clears durable assignments.
The caller must keep claims immutable for the identity's entire lifetime.

`close()` is idempotent, closes active connections, and leaves the assignment
and SDK resources alone. An optional `signal` aborts startup and closes the
listener afterward; it cannot cancel or roll back caller-owned persistence.

The listener requires one exact `Host: 127.0.0.1:<bound port>`, rejects Origin,
Cookie, absolute-form targets and browser fetch metadata. A single
`Sec-Fetch-Mode: cors` is allowed because Node's native fetch sends it. It
rejects upgrades and CONNECT. This is a native-client transport, not browser
CORS support and not authentication: Host-facing routes still need Host auth.

Bodies are completely buffered before application dispatch and limited to
2 MiB of actual bytes, including chunked uploads. Oversized bodies return 413;
GET/HEAD body framing is refused. `maxBodyBytes` configures this transport cap
for all routes, including blobs; the embedded SDK's separate blob cap does not
raise it. Keep the cap appropriate for your Host's memory and upload needs.

To mount an authenticated MCP endpoint, use the factory's trusted bound URL:

```ts
const listener = await listenLoopback({
  portStore,
  createHandler: serverUrl => {
    // Construct your Host-authenticated MCP router with origin: serverUrl.
    // Each authenticated caller must keep its own createMcpHttpServer instance.
    return makeAuthenticatedMcpRouter({ origin: serverUrl }).fetch;
  },
});
```

The helper does not remove/rewrite Origin or bypass MCP's own Origin check.

### Browser clients from loopback origins

By default the listener refuses every request that carries Origin. To serve a
browser MCP client, list its exact loopback origins in `allowedOrigins`. Each
entry must be a canonical `http:` or `https:` origin on `localhost`,
`127.0.0.1` or `[::1]`, with no path or trailing slash. Other values throw
before the port store is read.

```ts
const browser = 'http://localhost:5173';
const listener = await listenLoopback({
  portStore,
  allowedOrigins: [browser],
  createHandler: serverUrl => {
    // MCP checks Origin itself. List the same origins there.
    return makeAuthenticatedMcpRouter({ origin: serverUrl, allowedOrigins: [browser] }).fetch;
  },
});
```

For a listed origin, the listener:

- Accepts `Sec-Fetch-Mode: cors`, `Sec-Fetch-Dest: empty` and any
  `Sec-Fetch-Site`. A page on `localhost` is cross-site to `127.0.0.1`, so the
  origin list is the check. When the browser sends fetch metadata, the
  listener refuses navigation, `no-cors`, `Sec-Fetch-User` and other values.
  A request from a listed origin without fetch metadata is accepted, as for
  older browsers.
- Answers a preflight (`OPTIONS` with `Access-Control-Request-Method`) with 204
  and does not dispatch it. A preflight with body framing gets 400. The
  response allows `GET, POST, DELETE` and the headers `authorization,
  content-type, accept, last-event-id, mcp-session-id, mcp-protocol-version`.
  These lists are fixed: a Host that authenticates with another header cannot
  serve it to a browser. The preflight caches for 600 seconds.
- Adds `Access-Control-Allow-Origin: <origin>`, `Vary: Origin` and
  `Access-Control-Expose-Headers: Mcp-Session-Id` to every response, including
  503, 413 and 400 refusals. A handler header with the same name replaces the
  listener value. `WWW-Authenticate` is not exposed, so a browser client cannot
  read it for OAuth discovery.

The listener never sends `Access-Control-Allow-Credentials`, and it still
refuses Cookie. The Host Header check is unchanged, so the browser client
must use the `127.0.0.1` URL in `serverUrl`, not `localhost`. Unlisted origins
get 403 with no CORS headers. The list does not authenticate the caller: each
request still needs Host authentication, such as a bearer token. Private
Network Access preflights are not handled. A listed loopback page does not
need them.

## HTTP long-poll delivery

Devices send envelopes to `POST /byok/messages` and receive them through
`GET /byok/events`. There is no WebSocket transport or task lease.

A held poll subscribes to a `MailboxWake` before reading the durable mailbox.
A committed append wakes the poll so it can read and return available
envelopes. With nothing to deliver, it waits up to `longPollHoldMs` (default
50 seconds). The server composes the in-process wake automatically for both
memory and SQLite; `createByokServer` needs no mailbox-wake option.

Hints do not carry message authority. Lost hints trigger another read after the
wake port's default five-second fallback, bounded by the remaining hold time.
Duplicate hints do not acknowledge messages or advance a cursor. Every read
checks the replay floor: lost retained history produces `409 cursor_too_old`,
including when collection happens during a hold.

## Storage

State is in memory by default. `storage: { kind: 'sqlite', path }` persists:

- the device directory (enrollment and authenticated capabilities);
- request receipts;
- the mailbox;
- task attempts and their Agent message admission records;
- cancellations;
- approval timelines, bounded by their existing TTL and capacity;
- objects and blobs.

Everything else stays in the process and is lost on restart, in SQLite mode as
well: device presence, `TaskHandle` promises and the task-event relay (so
`tasks.events` cursors), the
inbound dedup, nonces, Agent egress receipt readback
(`egress.get`), activity, unredeemed pairing codes, storage quota accounting,
and the token signing key when you do not pass `tokenSigner`.

A SQLite file has one owner at a time; see
[One process per SQLite file](#one-process-per-sqlite-file).

## One process per SQLite file

One SQLite file serves exactly one running server. The server's own connection
sets `PRAGMA locking_mode=EXCLUSIVE` before it enters WAL mode and keeps
SQLite's lock for as long as that connection is open. The lock is released when
the owner closes or its process exits for any reason, SIGKILL included. No pid
or lock file is involved, so a dead owner never blocks the next open.

A second owner gets an error instead of a shared file:

- A second `createByokServer` on the same file, in this process or in another,
  waits for the 5-second busy grace and then throws `SqliteOwnershipError`
  (`code: 'SQLITE_DATABASE_OWNED'`, with the `path`) from `createByokServer`
  itself. If the first owner closes or exits inside the grace, the second open
  succeeds.
- A symlink to the file is the same database and is refused the same way. A
  file with more than one hard link is refused at open with an error, because
  the other name could not recover the WAL.
- Every other SQLite connection, read-only ones included, is locked out while
  the server is open. Close the owner before you inspect or back up the file.

Token signing keys (unless you pass `tokenSigner`), presence, the task-event
relay and the other in-process state listed under [Storage](#storage) live in
the owning process, so a second process on the same file would split them. To
run several instances, use external stores (`@byok-sdk/cloud` with
`@byok-sdk/cloud-dataplane`) and one shared `tokenSigner`.

### Shutdown

`await server.close()` is the shutdown API. It closes the maintenance and
one-shot wake schedulers, waits for an in-flight maintenance pass and accepted
storage work, then releases task-event feeds and closes the database. It is safe
to call more than once. Await it before reopening the file, inspecting it or
taking a consistent backup.
Use a local filesystem; NFS is unsupported.

Before upgrading, stop all old owners and external SQLite connections and take
a consistent backup. Databases opened by unreleased builds between #403 and
#442 can have an obsolete `<path>-lock` sibling: remove it only after all old
owners have stopped. The current SDK neither opens nor deletes that file.

## Restart

A restart is `await server.close()`, or a crash, followed by `createByokServer`
on the same file (see [Shutdown](#shutdown)).

With SQLite storage and no stable `tokenSigner`, a restart makes every
outstanding access token invalid. Each daemon gets one `401`, renews its token
through `POST /byok/challenge` and `POST /byok/token` against the persisted
device directory, and continues; no re-pairing is needed. A device reads as
connected again at its next poll.

SQLite also keeps unexpired approval requests and resolutions. Reopening does
not extend their expiry (default ten minutes since the last new observation).
`tasks.get`, stats and `tasks.events(taskId, { from: 'state' })` read the same
stored timeline. Expired requests are not restored or silently approved.

What a restart does not keep:

- `TaskHandle` promises and event subscriptions. Provider processes run on
  devices; recover server coordination after restart with `tasks.offer(taskId)`
  and `tasks.get(taskId)` (see
  [Persistent host request identity](#persistent-host-request-identity));
- task event history and cursors. `tasks.events` refuses a cursor from before
  the restart, and starts a task that is still live at its current state (see
  [Task event feed](#task-event-feed));
- with memory storage, everything, including enrollment: devices must pair
  again.

## Device presence

`machines.list()[].connected` projects the core store's unexpired TTL
observation, joined to the durable device directory. Authenticated hello,
accepted envelopes, long-poll starts and heartbeat publications renew this same
lease. Its default TTL is `longPollHoldMs + 15_000` (65 seconds with the default
50 second hold); `presenceTtlMs` must exceed `longPollHoldMs`. Expiry sets `connected` to
false and removes live discovery facts from the read model. Revocation removes
the device entirely.

Every dispatch requires an explicit `deviceId`. Presence never gates dispatch:
registered offline targets receive queued offers; unknown or revoked
targets fail with `device_not_found` before task/mailbox creation. Durable
capabilities remain admission authority; the daemon validates local toolsets.

## Maintenance and retention

The server always schedules one maintenance pass every 5 minutes with ±20%
jitter. Configure `maintenance: { intervalMs, policy, limit }` at construction;
policy overrides are positive bigint milliseconds. Defaults are acked mailbox
24h, unacked mailbox 7d, request receipts 24h, orphan objects 24h, and 500 rows
per step. There is no disable option.

Each pass calls the kernel's `ByokCloud.runMaintenance` for this server's tenant.
`await server.maintenance.runNow()` joins an in-flight pass. `await server.close()`
clears the timer, waits for that pass to settle, then closes storage. A pass
returns twelve ordered step results and emits `maintenance.completed`, or
`maintenance.failed` when a step failed. A failed event with `report` carries
step results; one with `errorCode` means the pass itself could not return a report.

With SQLite storage the `proofReceipts` step deletes used device-proof request
ids recorded more than 24 hours ago; within that window a `requestId` stays
single-use. The memory composition does not prune them: the step reports
`not-configured` and every used `requestId` is kept for the life of the process.

Acked rows past policy are deleted; old unacked rows become retained `expired`
rows, moving `recoverableFrom` so lost cursors receive `409 cursor_too_old`.
Mailbox collection never changes accounting counters. Orphan collection deletes
real bytes before settling their charge. Identity receipts and redeemed pairing
codes stay protected. See the [migration](../../docs/migrations/412-retention-maintenance.md)
and [runbook](../../deploy/runbooks/cloud-cleanup.md) for the port contract.

### Receipt retention

Receipt keys are tenant scoped and first-write-wins. All SDK receipt families
and unknown prefixes are identity fences: immutable offer, delivered and
canonical terminal facts remain for the lifetime of the database. The kernel's
derived `request` class is currently empty, so its configured 24-hour policy
does not expire SDK identity receipts. Monitor disk usage; exhaustion does not
authorize deleting those fences.

Offer and terminal receipts hold wire bytes, and a wire v4 server reads only
v4 bytes. There is no migration: a SQLite file a v3 build wrote is not
supported, so a v4 server starts on a new file. See
[the wire v4 upgrade note](../../docs/releases/925-wire-v4.md).

## Stats and liveness

`await server.stats()` returns a plain `HubStats` snapshot. It is in-process
only: this package never serves it over HTTP, so an embedder that wants it
remotely wraps it in its own authenticated route. `healthzRoute: true` mounts
an unauthenticated `GET /healthz` that returns only `{ ok: true, uptimeMs }`; it
is off by default.

- `connectedDeviceCount`: devices with a live presence lease (see
  [Device presence](#device-presence)). Process-local.
- `taskCountsByState`: read from the task stores, not from a count kept in the
  process. One aggregate over stored attempts and cancellation markers, then a
  walk of the active attempts and their approval timelines. SQLite keeps
  attempts, cancellations and unexpired approval timelines across a reopen;
  pending approvals keep their AwaitApproval projection until resolution or
  expiry. Nothing is scanned at startup.
- `envelopesIn`, `dedupDrops`, `rateLimitEvents`: counted since this server
  instance was created. They reset on every reopen, SQLite mode included.
- `inboundRefusals`: one counter per reason in `INBOUND_REFUSAL_REASONS`
  (exported by `@byok-sdk/cloud`), all present and zero-filled. Each inbound
  envelope the gate refuses increments its reason. Counted since creation and
  reset on reopen. Rate limiting is counted by `rateLimitEvents`, not here.
- `uptimeMs`: since `createByokServer` returned.

The task read is several store calls, not a transaction. It is exact when the
server is quiet; a task that settles between the aggregate and the active walk
can be briefly absent from one snapshot. The aggregate scans stored rows, and
the page and approval reads scale with the number of active tasks.

A task snapshot reads its creation time and requested session from the
immutable offer receipt, and the canonical terminal's session takes precedence.
This survives completion and a SQLite restart. An attempt opened before its
offer receipt was committed keeps the attempt-only snapshot (`createdAt` equal
to `updatedAt`, no requested session).

Custom cloud stores must implement `TaskAttemptStore.countByStatus` and the
`TaskAttemptListQuery.active` filter; `ByokCloud.countTaskAttempts` exposes the
aggregate.

## Toolset-aware dispatch

An Agent offer can name logical device-local MCP toolsets in
`requiredToolsets`; it never sends their commands or credentials:

```ts
await server.executions.submit({
  taskId,
  deviceId,
  payload: {
    instruction: 'Find five qualified prospects and draft follow-ups.',
    runtime: 'claude',
    agentRef,
    egressPolicy,
    terminalProjection: { mode: 'none' },
    requiredToolsets: ['salesko.prospecting'],
  },
});
```

`dispatch` takes the same field when it resumes a session. The coordinator
requires the durable `toolset-selection` capability before creating the
task. The daemon validates its actual configured inventory when
it accepts the offer; presence discovery does not gate admission.

## Device-side one-shot wakes

`server.wakes` schedules Host work; it is separate from the mailbox wake that
releases held HTTP polls.

Only the embedded server has this queue; hosted `@byok-sdk/cloud` has no routine
timer. Cron/periodic rules and execution/occurrence ledgers remain Host-owned.
Memory storage loses wakes on exit; use SQLite for restart-safe routines.

```ts
const server = createByokServer({
  productId,
  storage: { kind: 'sqlite', path },
  wake: {
    async consume(wake, signal) {
      // Host durably deduplicates occurrence identity, schedules its next wake,
      // and submits execution before resolving. Do not await execution completion.
      await host.consumeWake(wake, signal);
    },
  },
});
await server.wakes.schedule({
  dedupKey: 'routine:r1:v3:slot', availableAt: Date.now() + 60_000, payload: 'r1',
});
const unfinished = await server.wakes.pending();
await server.close();
```

schedule deduplicates exact key/time/payload, returning the original wakeId with
accepted:false. Changed content throws `WakeConflictError`. Keys are 1–256
Unicode characters; availableAt is a nonnegative safe integer at most 368 days
in the future; payload is at most 4 KiB UTF-8. Bad input throws `WakeInputError`.
Use `WAKE_MAX_FUTURE_MS` from `@byok-sdk/server` to check this time limit in the Host.
A missing hook throws `WakeHookMissingError` without writing; opening a queued
SQLite wake database without that hook is also refused and releases ownership.

Wakes are delivered serially by next due time and wakeId. One unref'd timer caps
waits at 60 seconds and compares wall clock, including after a forward jump;
idle queues have no timer. Rejections retry in 60 seconds with unchanged
availableAt and updated deliveries/retryAt/lastError (at most 1 KiB UTF-8).
Deadline is also 60 seconds: token invalidates before signal abort; old settlement
is ignored and the next due wake proceeds. A timed-out, uncooperative hook may
overlap a later delivery of the SAME wake. Host persistent dedup is required for
this at-least-once contract. SDK imposes no attempt cap and discards no late wake.

cancel deletes only queued wakes. False for an in-flight wake means it was **not
cancelled**; rejection/deadline still retries it. Cancel again once queued, or
record abandonment in the hook and resolve. pending sorts by availableAt and
wakeId and reports queued/delivering, delivery count and optional lastError/retryAt.
Completed keys remain for seven days; bounded collection removes only old done
rows (up to 100 per automatic call). close aborts after token invalidation,
rejects new calls and drains storage, without waiting for an uncooperative hook.
An unfinished committed delivery remains queued and replays after close/crash
with its next delivery number. There is no persisted delivering state, hosted
timer, cron parser or parallel legacy path. Real sleep timing is not proven by
fake timers.

## SQLite schema version

The current schema is v6. It includes a durable approval timeline alongside the
existing task, enrollment, receipt and wake authorities. Only a new database or
an existing v6 file can open. Versions 1–5 and unknown versions are rejected;
there is no migration selector or automatic adoption path.

Preserve existing databases. Stop the previous owner and explicitly select a
new state path and enrollment for v6. Do not delete history or edit version
markers to make an old database open. Approval observations that existed only
in an old process's memory cannot be recovered.

Open failures use `SqliteSchemaError` with `foundVersion` and `requiredVersion`:

- `SQLITE_SCHEMA_UNSUPPORTED`: unsupported schema or removed migration option.
- `SQLITE_SCHEMA_INVALID`: a required authority is missing or malformed.
- `SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED`: pending mailbox bytes are not wire v4.

A declared v6 file missing its approval table fails closed instead of silently
recreating an empty authority. Existing database contents are not adopted,
rewritten or deleted on a version refusal. New files create their schema and
version marker in one transaction. Older builds cannot open v6.

## Persistent host request identity

Before enqueue, durably bind the authenticated scope and external execution key
(including cycle/pass where applicable) to one taskId, explicit deviceId and
immutable execution input. Fresh Agent work uses `executions.submit(input)` and
requires the Host-owned taskId. Its strict nested payload names runtime,
AgentRef, egressPolicy and terminalProjection. A `result-document`
terminalProjection carries its frozen outcome `schema` (the wire's JSON Schema
subset, at most 16 KiB); a schema outside the subset is refused before any row
is written. messageEgress is optional;
selecting it requires agentMessageContext and a registered Agent message consumer.
The return is EnqueuedOffer, with durable recovery through tasks.offer; no fresh
egress TaskHandle is returned. Resubmitting a delivered taskId throws
`agent_task_already_exists`; recover through exact `tasks.offer(taskId)` readback.
A registered device that is offline is enqueued normally. Exact resume and
prepared submission retain their existing contracts. `dispatch` takes only
`AgentResumeDispatchInput`: `dispatch({ agentRef, sessionRef })`, with or
without `egressPolicy`, resumes an exact session (it is refused before any
write without `sessionRef`; fresh execution is `executions.submit`). `dispatch`
may omit taskId.
`executions.submit` and `dispatch({ agentRef })` take an optional `agentMemory`
(`'none'`, `'read'`, `'read-write'`, `'read-if-admitted'` or `'read-write-if-admitted'`) for
that one task. The device must advertise `agent-memory-selection`, and also
`agent-memory-read-if-admitted` for `'read-if-admitted'` or
`agent-memory-read-write-if-admitted` for `'read-write-if-admitted'`; the client
README describes the semantics. Both refuse `'read-write'` and
`'read-write-if-admitted'` with `homeAccess: 'memory-reader'` before the task
exists.
A caller taskId requires an explicit device; the façade never reselects a
missing device for that identity. Initial dispatch requires a registered
device. Concurrent calls for one caller identity in one façade are rejected
while the first is in flight.

After restart use `tasks.offer(taskId)` to read the kernel's immutable executable
offer and delivered marker, and `tasks.get(taskId)` for its state and result.
These reads work offline. Duplicate dispatch can still throw a kernel conflict:
only treat it as recovery after matching the original scope/target/type/payload
and durable delivery. Missing or mismatched readback is not success. A false
delivered marker does not prove mailbox append never happened. `tasks.offer`
returns no invented transport sequence or reconstructed TaskHandle. Host-only
agentMessageContext is not part of this executable-offer projection; callers
must preserve its original binding and its separate consumer authority.

`await server.tasks.cancel(taskId, reason)` uses the same kernel cancellation
and relay notification as a live handle; it does not require a connected device.
Missing tasks reject. A host must separately persist cancellation intent if it
can crash before this call, and prevent dispatch of a cancelled prepared request.

## Task event feed

`tasks.events(taskId, { after?, from?, signal? })` follows one task's notifications:
state changes, Agent progress, artifacts (inline, or a `blobRef` for
`blobs.getDownloadUrl`) and approval requests, whose `approvalId`
`tasks.approve` and `tasks.reject` take. It works for a task
`executions.submit` created; `TaskHandle.events()` reads the same feed without
cursors.

```ts
const start = lastCursor === undefined ? { from: 'state' as const } : { after: lastCursor };
for await (const { cursor, event } of byok.tasks.events(taskId, { ...start, signal })) {
  send({ id: cursor, data: event }); // e.g. an SSE message; resume with `after: cursor`
}
```

- Without `after`, a read starts at the oldest retained entry. With
  `from: 'state'` it starts at the task's current state: its latest `state`
  entry, after the pending `await_approval` request while it awaits approval.
  Those entries are kept even after the buffer dropped them, so a reader that
  just needs "now, then live" always gets them first. Give `after` or `from`,
  not both.

- Order is this instance's arrival order. Progress, artifacts and approvals
  have no protocol-level total order, so do not infer causality from adjacent
  entries.
- The feed ends after the terminal state, when `signal` aborts, or on
  `close()`. Read the terminal result with `tasks.get`.
- A cursor is valid only for this instance's current feed of the task. Each
  feed holds at most `taskEventBufferLimit` entries (default 1000); a reader
  that resumes behind the oldest one first gets one
  `{ kind: 'error', reason: 'events_truncated' }`. A terminal task's feed is
  kept for `taskEventRetentionMs` (default 5 minutes).
- The first `next()` throws, before any entry: a `TypeError` for `after` and
  `from` together, `ByokCloudError` `task_not_found` for an unknown task, `TaskEventsUnavailableError` with
  `reason: 'cursor_unknown'` for a cursor this feed never handed out (after a
  restart, another task's, malformed), or `reason: 'feed_expired'` for a
  terminal task whose feed is gone. After `cursor_unknown`, read again with
  `from: 'state'`; after `feed_expired`, `tasks.get` has the final state.
- After a restart, a task that is still live gets a feed that starts with its
  current state read back from the stores, after the pending plaintext
  approval request while it awaits one; earlier events are not reconstructed,
  and those entries can appear twice. A sealed approval request is not
  announced, as on a live feed. A task whose Host cancellation was accepted
  counts as terminal here, as in `tasks.get`.
- Authorization is the Host's: the feed carries raw tool input and output, so
  authenticate the user and redact before forwarding it to a browser.

The feed is a notification stream, not a record; task facts stay with
`tasks.get`, `tasks.attempt` and `TaskHandle.result()`.

The [protocol contract](../../docs/protocol.md) and
[coordination specification](../../docs/spec.md) define the durable facts behind
these reads. They do not replace Host authentication or consumer acknowledgement.

Runtime dependencies and size budgets: [entry dependency contract](../../README.md#entry-dependencies).
