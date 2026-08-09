# BYOK SDK

BYOK SDK lets a SaaS product dispatch work to coding-agent runtimes already
authenticated on an end user's machine. It includes a local daemon, a
self-hosted reference coordinator, and a hosted multi-tenant composition over
Postgres and R2.

```sh
npm install byok-sdk
```

```ts
import { client, cloud, cloudPostgres, core, protocol, server } from 'byok-sdk';
```

The umbrella uses namespaces so each contract keeps its package owner. The
same modules are also directly installable as `@byok-sdk/client`,
`@byok-sdk/server`, `@byok-sdk/cloud`, `@byok-sdk/cloud-postgres`,
`@byok-sdk/core`, and `@byok-sdk/protocol`.

## Choose a composition

- Self-hosted: use `server` for the in-memory coordinator and `client` for the
  local daemon. This is the smallest complete deployment and does not require
  Postgres or object storage.
- Hosted: use `cloud` for stateless device routes and `cloudPostgres` for the
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

## Runtime and license

Node.js 20 or newer. MIT licensed.
