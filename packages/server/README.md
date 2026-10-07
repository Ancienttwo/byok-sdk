# @byok-sdk/server

The self-hosted SaaS-side reference coordinator: pairing, authenticated device
HTTP/WebSocket/long-poll transport, task leasing, approvals, and in-memory
stores over the frozen v1 protocol.

Use `@byok-sdk/cloud` plus `@byok-sdk/cloud-dataplane` for the durable hosted
composition.

Toolset-aware dispatch names logical device-local MCP toolsets; it never sends
their commands or credentials:

```ts
const task = await server.dispatch({
  deviceId,
  instruction: 'Find five qualified prospects and draft follow-ups.',
  runtime: 'claude',
  policy: { mode: 'auto' },
  requiredToolsets: ['salesko.prospecting'],
});
```

The self-hosted coordinator rejects this call before task creation unless the
live device advertises `toolset-selection` and its `configuredToolsets`
inventory contains every required ID. `machines.list()` projects that same
logical-ID-only inventory; MCP commands and credentials remain device-local.

MIT licensed. Node.js 24.15.0 or newer.

## SQLite enrollment, receipts and schema adoption

`storage: { kind: 'sqlite', path }` persists device enrollment, authenticated
capabilities, request receipts and the six coordination interfaces. Pairing and
authentication share the device directory. Receipt keys are tenant scoped and
first-write-wins across connections and restart. Mailbox retention never deletes
receipts: immutable offer, delivered and canonical terminal facts remain for the
lifetime of the database. There is no receipt TTL or automatic pruning. Monitor
disk usage; exhaustion is an error, not permission to delete identity fences.

Unredeemed pairing codes, presence and other unmodified ports remain ephemeral.
Keep daemon OS credentials, server URL and token signer stable across restart.
This does not restore TaskHandle promises, subscriptions or provider processes.

This candidate writes schema v4, including the write-once `claimedHarnessId`
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
new state or restore old grants. This belongs to the next MINOR release; these
local changes are not a published upgrade.


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
