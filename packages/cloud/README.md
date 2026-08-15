# @byok-sdk/cloud

Stateless hosted BYOK HTTP handlers and an in-memory reference composition over
tenant-first `@byok-sdk/core` ports. It owns device-facing protocol/auth/policy
logic but no durable database or object-storage driver.

Pair it with `@byok-sdk/cloud-dataplane` for Postgres + R2 production storage.

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
advertise `toolset-selection`. `listPresence(tenant)` includes the optional
`configuredToolsets` reported by each live daemon, so the host can narrow
candidate devices before enqueue. This is TTL-bounded discovery, not execution
authority: the daemon still resolves every required ID locally and declines
fail-closed if its configuration changed.

Reading a task's outcome goes through the same first terminal fact twice:
`readTerminalReceipt(tenant, taskId)` returns the stored envelope raw, and
`readTaskResult(tenant, taskId)` decodes that same receipt into a typed
`TerminalResult` — the state, plus `summary`/`sessionRef`/`artifactRefs`/
`document` on a completion or `reason`/`retryable` on a failure — projected
verbatim with no re-validation:

```ts
const result = await cloud.readTaskResult(tenantId, taskId);
if (result === undefined) {
  // No terminal fact yet. A declined task records none — read the attempt
  // status with `readTaskAttempt(tenant, taskId)` for that case.
} else if (result.state === 'failed' && result.retryable) {
  // re-offer
}
```

`document` is absent, never null, when the daemon sent none; a receipt whose
stored body is not a terminal envelope throws `ByokCloudError` rather than
returning a best-effort shape.

MIT licensed. Node.js 22.22.0 or newer.
