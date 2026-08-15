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
