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

MIT licensed. Node.js 22.22.0 or newer.

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
This does not restore TaskHandle promises, subscriptions or provider processes,
or add caller taskId/read/cancel methods to the server façade.

This candidate writes schema v3. Stop **all** writers and take a consistent
SQLite backup (including WAL state or using SQLite's backup facility) before
explicit adoption. An already-open old writer is not stopped by the version
fence. Only legacy databases with no task, mailbox-message, agent-admission or
advanced cursor history can migrate: old in-memory receipts cannot be recovered
from task status or fabricated from a retry payload. A pristine poll cursor is
allowed. Preserve rejected databases for separate reconciliation; do not delete
history, reset cursors or edit version markers to make adoption pass.

```ts
const server = createByokServer({
  productId,
  tokenSigner,
  storage: { kind: 'sqlite', path, migration: 'v2-to-v3' },
});
await server.close();
```

Use `v1-to-v3` for a v1 database meeting the same eligibility rules. Remove
`migration` from normal startup. Adoption adds receipts, adds an empty device
directory for v1, and updates the marker atomically; any failure rolls back.
Existing v2 devices and artifacts remain. V1 enrollment was in-memory and needs
explicit pairing. Unknown versions, missing authorities and malformed receipt
columns/primary key fail closed. Broader validation of legacy table constraints
is a separate tracked concern.

**Breaking storage boundary:** published 0.16 (schema v1) and earlier schema-v2
candidate writers refuse v3. The previous unpublished `v1-to-v2` selector is
replaced, without a compatibility alias. Restore of a backup requires a separate
recovery procedure because it can lose new state or restore old grants. This
belongs to the next MINOR release; these local changes are not a published upgrade.
