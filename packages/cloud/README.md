# @byok-sdk/cloud

Stateless hosted BYOK HTTP handlers and an in-memory reference composition over
tenant-first `@byok-sdk/core` ports. It owns device-facing protocol/auth/policy
logic but no durable database or object-storage driver.

Pair it with `@byok-sdk/cloud-dataplane` for Postgres + R2 production storage.

`authenticateHostedDeviceAssertion()` is the hosted connector-binding auth
composition. It adapts the current `DeviceDirectory` row and `CloudCrypto` to
core's single-use authenticator; callers must inject a replay authority and
trusted deployment bindings. Create durable connector state only after it
returns a principal. OAuth refresh tokens and the resulting long-lived profile
remain host-owned and are never stored by this API.

```ts
const authenticated = await authenticateHostedDeviceAssertion(assertion, {
  devices,
  crypto,
  replay,
  clock,
  expected: { issuer, productId, audience: 'connector-binding' },
});
if (authenticated === undefined) throw new Error('unauthorized');
await connectorProfiles.bind(authenticated.device, providerLogin);
```

Hosted compositions name the toolsets on an Agent offer, which the device must
admit with `toolset-selection`:

```ts
await cloud.enqueueAgentOffer(tenantId, deviceId, {
  taskId,
  payload: {
    instruction: 'Research the account and prepare the next sales action.',
    runtime: 'claude',
    agentRef,
    sessionRef,
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
`readTerminalReceipt(tenant, taskId)` returns the stored envelope raw (after
`redactTasks` it throws `task_content_redacted`), and
`readTaskResult(tenant, taskId)` decodes that same receipt into a typed
`TerminalResult` — the state, plus `summary`/`sessionRef`/`artifactRefs`/
`document` on a completion or `reason`/`retryable` on a failure — projected
verbatim with no re-validation:

```ts
const result = await cloud.readTaskResult(tenantId, taskId);
if (result === undefined) {
  // No terminal fact and no Host cancellation yet. A decline is a terminal:
  // it reads back as `failed` with its `code`.
} else if (result.state === 'failed' && result.retryable) {
  // re-offer
}
```

`document` is absent, never null, when the daemon sent none; a receipt whose
stored body is not a terminal envelope throws `ByokCloudError` rather than
returning a best-effort shape.

MIT licensed. Node.js 24.22.1 or newer.


## Immutable offer readback

`readTaskOffer(tenant, taskId)` reads the immutable offer receipt using the
TaskAttempt target and stable message identity. It validates the protocol
payload, target/Agent binding and delivered marker. Corrupt receipts throw;
missing attempt or missing offer receipt returns undefined. The returned
recordedAt is receipt time, not transport time; no mailbox sequence is invented.
A delivered=false read is not evidence that append never happened. Host-only
message context is a separate authority, not part of this offer projection.
The API's persistence is that of the injected receipts store: in-memory restart
and Postgres generic receipt retention are not upgraded by this read method.

## Mailbox wake composition

`createByokCloud` and `tenantStoresFor` require a `mailboxWake` port. It is a
lossy hint: mailbox reads remain the only event/cursor authority. A held poll
subscribes before its first read, re-reads after a hint or the fallback interval,
and closes its subscription on response, error or request abort. Every live
empty response follows a final read, including the replay-floor check.

`createInMemoryByokCloud` defaults to `createInProcessMailboxWake()` and exposes
that same instance as `mailboxWake` for hosts building tenant facades directly.
Direct compositions inject `createInProcessMailboxWake({ fallbackMs: 5_000 })`,
or the Node/Postgres listener from `@byok-sdk/cloud-dataplane`. The default
fallback is `DEFAULT_MAILBOX_WAKE_FALLBACK_MS` (5 seconds). There is no interval
option or alternate polling hold. Append and cancellation hints are emitted
only after their store commits; direct writes to naked stores rely on fallback.

## Hosted Host contract

A Topology H Host on Cloudflare Workers follows the
[hosted Host contract](../../docs/hosted-host-contract.md). It maps each task
state to a Host action. It also gives the rescan, wake, message consume, idle
cost and retention rules.

Runtime dependencies and size budgets: [entry dependency contract](../../README.md#entry-dependencies).
