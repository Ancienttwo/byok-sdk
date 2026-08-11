# @byok-sdk/cloud

Stateless hosted BYOK HTTP handlers and an in-memory reference composition over
tenant-first `@byok-sdk/core` ports. It owns device-facing protocol/auth/policy
logic but no durable database or object-storage driver.

Pair it with `@byok-sdk/cloud-postgres` for Postgres + R2 production storage.

MIT licensed. Node.js 22.19.0 or newer.
