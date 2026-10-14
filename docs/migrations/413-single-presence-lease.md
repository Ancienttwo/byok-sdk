# Reference server: one TTL presence lease (#413)

This is a 0.x breaking API change. The owner decision keeps #403's reference
server TTL (`longPollHoldMs + 15_000`, default 65 seconds), with no ambient
selection or dispatch presence gate.

- Pass `deviceId` on every `dispatch()` call. The SDK never picks a target.
  Registered offline targets receive queued offers. Unknown/revoked legacy
  targets throw `ByokCloudError` with `code: 'device_not_found'` before a task or
  mailbox row is created. Agent capability admission remains unchanged.
- `machines.list()[].connected` remains the canonical boolean projection of
  the single lease. `lastSeen`, release, runtime and toolset discovery come
  from that same live core hint and are absent after expiry. Revoked devices
  disappear entirely. The presence publisher supplies discovery facts;
  `conn.hello` remains durable capability admission. Runtime discovery contains
  `id`, optional `version` and `authPresent`; runtime capabilities are no longer
  copied from an independent connection registry.
- Hello, accepted envelope, poll start and heartbeat observations share the
  existing core `PresenceStore`. No second device registry or TTL rule exists.
  A held poll renews once on entry; it does not continually renew the lease.
- `presenceTtlMs` must remain greater than `longPollHoldMs`. Expiry is governed
  by core `expiresAt`: at the deadline the observation is absent.
- The server retains durable capability gates, while device-local toolset
  inventory validation belongs to the daemon. Hosts may consult presence for
  UI or their own early refusal, but the SDK does not use it for dispatch.

SQLite ownership and server shutdown are outside this migration (#414).
HubStats's public shape and task counting stay owned by #415; this change only
replaces its removed presence dependency.
