# @byok-sdk/server

The embedded reference coordinator: a façade over the `@byok-sdk/cloud` kernel
that serves one product and one tenant inside your own process. It handles
pairing, device authentication, dispatch, approvals, cancellation and device
presence over protocol v2.

Devices talk to it over HTTP: they send envelopes with `POST /byok/messages`
and receive them by long-polling `GET /byok/events`. An empty poll is held open
for `longPollHoldMs` (default 50 seconds) before it returns. There is no
WebSocket transport and no task lease. For a multi-instance hosted deployment,
use `@byok-sdk/cloud` with `@byok-sdk/cloud-dataplane` instead.

MIT licensed. Node.js 24.15.0 or newer.

## Storage

State is in memory by default. `storage: { kind: 'sqlite', path }` persists:

- the device directory (enrollment and authenticated capabilities);
- request receipts;
- the mailbox;
- task attempts and their Agent message admission records;
- cancellations;
- objects and blobs.

Everything else stays in the process and is lost on restart, in SQLite mode as
well: device presence, `TaskHandle` promises and the task-event relay, the
approval timeline, inbound dedup, nonces, Agent egress receipt readback
(`egress.get`), activity, unredeemed pairing codes, storage quota accounting,
and the token signing key when you do not pass `tokenSigner`.

## Restart

With SQLite storage and no stable `tokenSigner`, a restart makes every
outstanding access token invalid. Each daemon gets one `401`, renews its token
through `POST /byok/challenge` and `POST /byok/token` against the persisted
device directory, and continues; no re-pairing is needed. A device reads as
connected again at its next poll.

What a restart does not keep:

- pending approvals, because the approval timeline is in memory;
- `TaskHandle` promises, event subscriptions and provider processes. After a
  restart, read tasks with `tasks.offer(taskId)` and `tasks.get(taskId)` (see
  [Persistent host request identity](#persistent-host-request-identity));
- with memory storage, everything, including enrollment: devices must pair
  again.

## Device presence

`machines.list()[].connected` projects the core store's unexpired TTL
observation, joined to the durable device directory. Authenticated hello, accepted envelopes,
long-poll starts and heartbeat publications renew this same lease. Its default
TTL remains `longPollHoldMs + 15_000` (65 seconds with the default 50 second
hold); `presenceTtlMs` must exceed `longPollHoldMs`. Expiry sets `connected` to false and removes live discovery facts
from the read model, and revocation removes the device entirely.

Every dispatch requires an explicit `deviceId`. Presence never gates dispatch:
registered offline targets receive queued offers; unknown or revoked legacy
targets fail with `device_not_found` before task/mailbox creation. Durable
capabilities remain admission authority; the daemon validates local toolsets.

## Mailbox retention

The server runs no retention timer. `mailbox.collectRetired({ ackedBefore,
expireUnackedBefore })` is a pass-through to the kernel: acked rows appended
before `ackedBefore` are deleted, and unacked rows appended before
`expireUnackedBefore` are marked `expired` and stay visible, which moves
`recoverableFrom` so a device polling from a lost cursor gets
`409 cursor_too_old`. You choose both cutoffs and when to call it. Without a
call, an embedded server retires nothing. Retention never deletes receipts (see
below).

## Stats and liveness

`stats()` returns a plain snapshot: connected device count, task counts by
state, inbound envelope, dedup and rate-limit counters, and uptime. It is
in-process only; this package never serves it over HTTP. `healthzRoute: true`
mounts an unauthenticated `GET /healthz` that returns only `{ ok: true,
uptimeMs }`; it is off by default.

## Toolset-aware dispatch

Toolset-aware dispatch names logical device-local MCP toolsets; it never sends
their commands or credentials:

```ts
const task = await server.dispatch({
  deviceId,
  instruction: 'Find five qualified prospects and draft follow-ups.',
  runtime: 'claude',
  requiredToolsets: ['salesko.prospecting'],
});
```

The coordinator requires the durable `toolset-selection` capability before
creating the task. The daemon validates its actual configured inventory when
it accepts the offer; presence discovery does not gate admission.

## SQLite receipts, ownership and schema adoption

Pairing and authentication share the persisted device directory. Receipt keys
are tenant scoped and first-write-wins. Mailbox retention never deletes
receipts: immutable offer, delivered and canonical terminal facts remain for the
lifetime of the database. There is no receipt TTL or automatic pruning. Monitor
disk usage; exhaustion is an error, not permission to delete identity fences.

### One process per SQLite file

One SQLite file serves exactly one server process. The actual database connection
sets `PRAGMA locking_mode=EXCLUSIVE` before entering WAL mode and retains its
SQLite lock until `await server.close()` or process exit, including SIGKILL.
A second open, in this process or another, waits for the existing 5-second busy
grace and then throws `SqliteOwnershipError` (`code: 'SQLITE_DATABASE_OWNED'`).
External SQLite readers and writers are excluded while the server is open;
inspection, backup and raw test mutations require the owner to close first.
EXCLUSIVE WAL needs no shared-memory file. No sibling ownership file is created.
Symlink aliases use SQLite's canonical database identity. Hard-linked paths are
refused before open because distinct WAL names cannot safely recover one file.
Token signing keys (unless you pass `tokenSigner`), presence, the task-event relay
remain process-local. Multiple instances need external
stores (`@byok-sdk/cloud` with `@byok-sdk/cloud-dataplane`) and one shared
`tokenSigner`.

### Migration from sibling-lock ownership (#403)

This is a breaking 0.x API change: replace `server.stop()` with
`await server.close()`. `close()` is the sole server shutdown path; await it before
reopening storage. `SqliteOwnershipError` and its error code remain unchanged.
Stop every old server and external SQLite connection, take a consistent backup,
and only then start the new owner. An idle old NORMAL-mode connection can still
block the new EXCLUSIVE owner. Do not run old and new writers together: the old
sibling lock is no longer an ownership authority. After all old owners have
stopped, operators may remove their leftover `<path>-lock` files; the SDK neither
opens nor automatically deletes them. The owner-lock refactor itself leaves persisted data and wire contracts
are unchanged. Use the server facade for live reads, or close the owner before
external inspection or backup.

### Task snapshots after restart

`stats()` reads one store aggregate, active attempt pages and their approval
timelines. It keeps no task-count mirror and does not scan history at startup.
The aggregate scans stored rows; page/approval call counts depend only on active
tasks. This multi-read observation is exact at quiescence; a task settling
between reads can be temporarily absent. SQLite preserves attempt/cancellation
counts, while its approval timeline resets at reopen. Traffic counters and the
zero-filled `inboundRefusals` map start at server creation and reset on reopen.
Snapshots read creation time (`recordedAt`) and requested session from the
immutable offer receipt; the canonical terminal's session takes precedence.
These facts survive completion and SQLite restart without a dispatch Map.
Attempts opened before an offer receipt was committed retain the existing
attempt-only snapshot (`createdAt: updatedAt`, no requested session). Malformed
receipts are rejected by the kernel's readback contract.

Custom cloud stores must implement `TaskAttemptStore.countByStatus` and the
`TaskAttemptListQuery.active` filter. `ByokCloud.countTaskAttempts` exposes the
aggregate; `INBOUND_REFUSAL_REASONS` owns the closed refusal vocabulary.

Unredeemed pairing codes, presence and other unmodified ports remain ephemeral.
Keep daemon OS credentials, server URL and token signer stable across restart.
This does not restore TaskHandle promises, subscriptions or provider processes.

### Device-side one-shot wakes (routine K2)

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
Unicode characters; availableAt is a nonnegative safe integer at most 366 days
in the future; payload is at most 4 KiB UTF-8. Bad input throws `WakeInputError`.
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

### Schema adoption

The current schema is v5, retaining write-once `claimedHarnessId`
stored atomically with task ownership and adding the embedded wake table. Stop **all** writers and take a consistent
SQLite backup (including WAL state or using SQLite's backup facility) before
explicit adoption. An already-open old writer is not stopped by the version fence.

- `v1-to-v5` and `v2-to-v5` require no task, mailbox-message, agent-admission or
  advanced cursor history: old in-memory receipts cannot be recovered from task
  status or fabricated from a retry payload. A pristine poll cursor is allowed.
- `v3-to-v5` preserves receipts, unclaimed offers and claims with an identified
  built-in runtime. It rejects any owned task with no `claimed_runtime`, including
  terminal tasks: a lost custom-harness identity cannot be distinguished from an
  identity-free legacy built-in claim. Neither the requested offer nor current
  device inventory proves the actual claiming adapter. Existing rows receive a
  null harness identity; migration never invents one.

- `v4-to-v5` only creates the wake table and indexes; all existing rows stay
  unchanged. Pre-v5 files already containing a wake table are refused.

Preserve rejected databases for separate reconciliation; do not delete history,
reset cursors or edit version markers to make adoption pass.

Schema refusals at open are a `SqliteSchemaError` with `foundVersion` and
`requiredVersion`, so a host can check the file at startup and branch on `code`:

- `SQLITE_SCHEMA_UNSUPPORTED`: the file needs an explicit `migration` selector
  (older version) or a newer build (newer version).
- `SQLITE_MIGRATION_REFUSED`: the selected migration would lose history;
  preserve the file.
- `SQLITE_SCHEMA_INVALID`: the file contradicts its declared schema or is not a
  BYOK database.

```ts
const server = createByokServer({
  productId,
  tokenSigner,
  storage: { kind: 'sqlite', path, migration: 'v4-to-v5' },
});
await server.close();
```

Remove `migration` from normal startup. Every source gains an empty wake table;
v1–v3 adoption also adds the nullable harness column,
adds receipts for v1/v2 and an empty device directory for v1, and updates the marker
atomically; any failure rolls back. Existing v2/v3 devices and artifacts remain.
V1 enrollment was in-memory and needs explicit pairing. Unknown versions, missing
authorities and malformed receipt columns/primary key fail closed. Broader
validation of legacy table constraints is a separate tracked concern.

**Breaking storage boundary:** schema-v1/v2/v3 writers refuse v4. The public
`v1-to-v3` / `v2-to-v3` selectors are replaced by the corresponding target-v4
selectors, with no alias or silent reinterpretation: callers must update their
one-shot migration configuration after checking eligibility and backing up.
Restore of a backup requires a separate recovery procedure because it can lose
new state or restore old grants. Schema v4 shipped in 0.24.0.

## Persistent host request identity

Before enqueue, durably bind the authenticated scope and external execution key
(including cycle/pass where applicable) to one taskId, explicit deviceId and
immutable dispatch input. Pass that taskId to `dispatch` or
`dispatchFreshAgentEgress`. Omitting taskId retains fresh-task semantics.
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

The runnable public-package fixture is
`docs/researches/2026-09-09-g1c-facade/public-consumer-probe.mjs`. It demonstrates
pre-enqueue binding and recovery, not product authentication or consumer ACK.
