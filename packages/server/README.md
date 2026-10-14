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

`machines.list()[].connected`, ambient device selection for a `dispatch()`
without `deviceId`, the `device ... is not connected` dispatch gate, and
`stats().connectedDeviceCount` all apply one rule: a device is connected while
its last observation (`conn.hello`, any accepted envelope, or the start of a
`GET /byok/events` poll) is at most `presenceTtlMs` old. The default is
`longPollHoldMs + 15_000` (65 seconds with the default 50 second hold), so a
device sitting in a normal held poll stays connected and one that stops polling
reads offline about 15 seconds after its last hold would have ended.
`presenceTtlMs` is configurable and must exceed `longPollHoldMs`, because a held
poll does not renew presence. `lastSeen` is reported alongside. Revoking a device
removes its presence immediately.

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

The self-hosted coordinator rejects this call before task creation unless the
live device advertises `toolset-selection` and its `configuredToolsets`
inventory contains every required ID. `machines.list()` projects that same
logical-ID-only inventory; MCP commands and credentials remain device-local.

## SQLite receipts, ownership and schema adoption

Pairing and authentication share the persisted device directory. Receipt keys
are tenant scoped and first-write-wins. Mailbox retention never deletes
receipts: immutable offer, delivered and canonical terminal facts remain for the
lifetime of the database. There is no receipt TTL or automatic pruning. Monitor
disk usage; exhaustion is an error, not permission to delete identity fences.

### One process per SQLite file

One SQLite file serves exactly one running server. Opening takes an OS lock on
the canonical database path's `<path>-lock` sibling for the lifetime of the server;
symlink aliases resolve to that same lock. A second open of the
same file, from another process or another instance in this one, throws
`SqliteOwnershipError` (`code: 'SQLITE_DATABASE_OWNED'`) before touching the
database. The lock is released by `close()` and by the operating system when the
owning process exits for any reason, including SIGKILL, so a crashed owner never
blocks the next start. To reopen the same file in one process, `await
server.close()` first. Hard-linked database paths are refused before open, since
they have no unique sibling lock or WAL path. The process-local state listed in
[Storage](#storage) is why the file is not shareable: several server instances
behind a load balancer need external stores (`@byok-sdk/cloud` with
`@byok-sdk/cloud-dataplane`) and one shared `tokenSigner`.

### Task snapshots after restart

`stats()` re-reads only live attempts and their approval timelines; absorbing
terminal states are counted once. SQLite history is scanned once at startup,
so repeated stats calls cost O(live tasks), independent of terminal history.
Snapshots read creation time (`recordedAt`) and requested session from the
immutable offer receipt; the canonical terminal's session takes precedence.
These facts survive completion and SQLite restart without a dispatch Map.
Attempts opened before an offer receipt was committed retain the existing
attempt-only snapshot (`createdAt: updatedAt`, no requested session). Malformed
receipts are rejected by the kernel's readback contract.

### Schema adoption

The current schema is v4, which stores the write-once `claimedHarnessId`
stored atomically with task ownership. Stop **all** writers and take a consistent
SQLite backup (including WAL state or using SQLite's backup facility) before
explicit adoption. An already-open old writer is not stopped by the version fence.

- `v1-to-v4` and `v2-to-v4` require no task, mailbox-message, agent-admission or
  advanced cursor history: old in-memory receipts cannot be recovered from task
  status or fabricated from a retry payload. A pristine poll cursor is allowed.
- `v3-to-v4` preserves receipts, unclaimed offers and claims with an identified
  built-in runtime. It rejects any owned task with no `claimed_runtime`, including
  terminal tasks: a lost custom-harness identity cannot be distinguished from an
  identity-free legacy built-in claim. Neither the requested offer nor current
  device inventory proves the actual claiming adapter. Existing rows receive a
  null harness identity; migration never invents one.

Preserve rejected databases for separate reconciliation; do not delete history,
reset cursors or edit version markers to make adoption pass.

Every refusal at open is a `SqliteSchemaError` with `foundVersion` and
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
  storage: { kind: 'sqlite', path, migration: 'v3-to-v4' },
});
await server.close();
```

Remove `migration` from normal startup. Adoption adds the nullable harness column,
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
A caller taskId requires an explicit device; the façade never reselects an
ambient device for that identity. Initial dispatch still requires a connected
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
