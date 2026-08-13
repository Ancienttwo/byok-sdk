# BYOK SDK

BYOK SDK lets a SaaS product dispatch work to coding-agent runtimes already
authenticated on an end user's machine. It includes a local daemon, a
self-hosted reference coordinator, and a hosted multi-tenant composition over
Postgres and R2.

## 0.4.0 custom RuntimeAdapter migration

0.4.0 intentionally removes the old `id`, `capabilities()`, optional
`environmentRequirements()`, `supportsDispatchSelection`, and direct `start()`
adapter shape. Custom adapters must expose one frozen `descriptor` and a
required, side-effect-free `prepare()` method that returns either `{ kind:
'reject', ... }` or `{ kind: 'prepared', operation }`. The operation's
`start({ manifest, instruction, env, ... })` runs only after the daemon has
sealed its credential-free manifest and claimed the offer. Do not ship an
adapter that supports both shapes or allocates process/temp/workspace/session
resources during `prepare()`; reject unsupported input before claim instead.

```sh
npm install byok-sdk
```

```ts
import { client, cloud, cloudDataplane, core, protocol, server } from 'byok-sdk';
```

The umbrella uses namespaces so each contract keeps its package owner. The
same modules are also directly installable as `@byok-sdk/client`,
`@byok-sdk/server`, `@byok-sdk/cloud`, `@byok-sdk/cloud-dataplane`,
`@byok-sdk/core`, and `@byok-sdk/protocol`.

## Choose a composition

- Self-hosted: use `server` for the in-memory coordinator and `client` for the
  local daemon. This is the smallest complete deployment and does not require
  Postgres or object storage.
- Hosted: use `cloud` for stateless device routes and `cloudDataplane` for the
  durable Postgres + R2 data plane. The host owns authentication, scheduling,
  migration execution, deployment, signing, updater channels, and operations.

Both profiles share the frozen v1 protocol, tenant isolation, durable device
proof, truth CAS, explicit capabilities, and fail-closed policy handling.

## Key management is separate

`@byok-sdk/keys` stores provider credentials and makes direct provider calls.
It is intentionally outside `byok-sdk` and the entire dispatch dependency
graph. Install it explicitly when that security model is required:

```sh
npm install @byok-sdk/keys
```

## Host connector composition

[`examples/salesko-connector-broker`](examples/salesko-connector-broker) is a
private reference composition for a Salesko-style local connector. It combines
device-local OS credential custody, exact correspondent-domain policy, a
real desktop Google OAuth + read-only Gmail metadata adapter, and a
metadata-only stdio MCP projection with the daemon's logical toolset injection.
It is integration guidance, not a published connector catalogue; Google
verification/assessment, LinkedIn, social-media, and browser connectors are not
included.

## Runtime and license

The dispatch SDK requires Node.js 22.19.0 or newer. The independently
installable `@byok-sdk/keys@0.1.0` package retains Node.js 20 support. MIT
licensed.
