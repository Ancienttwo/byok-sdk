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

## SQLite enrollment and schema adoption

`storage: { kind: 'sqlite', path }` persists device enrollment, authenticated
capability declarations and the six coordination stores. Pairing and subsequent
challenge/token reads share one directory; revoke and same-machine replacement
delete durable grants. Presence and unredeemed pairing codes remain ephemeral.
Keep the daemon OS credentials and the host token signer stable across restart.
This does not restore TaskHandle promises, subscriptions or runtime processes.

This build writes schema v2. Before adopting a v1 database, stop **all** server
processes that can access it and take a consistent SQLite backup (including WAL
state, or use SQLite's backup facility). An already-open old process is not
stopped by the version fence. With writers stopped, explicitly open once:

```ts
const server = createByokServer({
  productId,
  tokenSigner,
  storage: { kind: 'sqlite', path, migration: 'v1-to-v2' },
});
await server.close();
```

Remove `migration` from normal startup configuration. Adoption creates an empty
device directory and updates the schema marker in one transaction while
retaining tasks, mailbox and artifact data. Failed adoption rolls back. The old
in-memory directory cannot be reconstructed: existing v1 installations require
one explicit pairing after adoption; enrollments created on v2 survive restart.
Unknown versions, missing metadata and missing durable tables fail closed.

**Breaking storage boundary:** 0.16 and earlier refuse to open v2. Do not edit
the version marker to downgrade. Restoring a backup loses later state and can
restore old grants; it requires a separately audited recovery procedure, never
an automatic runtime fallback. This change belongs to the next MINOR release;
local candidate artifacts are not a published upgrade.
