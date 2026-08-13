# @byok-sdk/cloud

Stateless hosted BYOK HTTP handlers and an in-memory reference composition over
tenant-first `@byok-sdk/core` ports. It owns device-facing protocol/auth/policy
logic but no durable database or object-storage driver.

Pair it with `@byok-sdk/cloud-postgres` for Postgres + R2 production storage.

Hosted compositions enqueue the distinct toolset offer message explicitly:

```ts
await cloud.enqueueToolsetOffer(tenantId, deviceId, {
  taskId,
  payload: {
    instruction: 'Research the account and prepare the next sales action.',
    runtime: 'claude',
    policy: { mode: 'auto' },
    requiredToolsets: ['salesko.prospecting'],
  },
});
```

Unlike the live self-hosted coordinator, this stateless enqueue API cannot
infer current device capabilities; the host must route to a device known to
advertise `toolset-selection`.

MIT licensed. Node.js 22.19.0 or newer.
