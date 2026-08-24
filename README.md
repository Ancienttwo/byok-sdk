# BYOK SDK

BYOK SDK lets a SaaS product dispatch work to coding-agent runtimes already
authenticated on an end user's machine. It includes a local daemon, a
self-hosted reference coordinator, and a hosted multi-tenant composition over
Postgres and R2.

## Current release

The current release is `byok-sdk@0.8.0`, with the independently versioned
`@byok-sdk/keys@0.3.1`. It binds the daemon tenant to the authenticated pairing
response and persists that non-secret identity atomically in the local
`DeviceRecord`; legacy 0.6.x records fail closed and must re-pair. It also
includes durable Agent-first local homes, exact Agent/session identity across
hosted dispatch, task-free exact-device Agent-home projection, explicit
fresh-session Agent dispatch, policy-controlled local/cloud egress with reliable
Agent-local evidence, atomically reloadable device-local MCP toolsets, Pi
web/MCP extension loading, and self-hosted Local Agent release readback. The
hosted data plane ships migrations `0001` through `0013` and verifies their
exact ledger before serving traffic.

The bundled Pi runtime authority remains the exact
`@earendil-works/pi-coding-agent@0.84.2` dependency. Release SemVer is
observability only; protocol intersection and advertised capabilities remain
the execution gates.

All ten npm artifacts were frozen from one source commit and passed registry
integrity, dependency-edge, fresh-import, and single-version closure readback.
The release does not perform a production migration or deployment for a host.

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
npm install byok-sdk@0.8.0
```

```ts
import { client, cloud, cloudDataplane, core, protocol, server, uiRuntime } from 'byok-sdk';
```

The umbrella uses namespaces so each contract keeps its package owner. The
same modules are also directly installable as `@byok-sdk/client`,
`@byok-sdk/server`, `@byok-sdk/cloud`, `@byok-sdk/cloud-dataplane`,
`@byok-sdk/core`, `@byok-sdk/protocol`, and `@byok-sdk/ui-runtime`.

## Choose a composition

- Self-hosted: use `server` for the in-memory coordinator and `client` for the
  local daemon. This is the smallest complete deployment and does not require
  Postgres or object storage.
- Hosted: use `cloud` for stateless device routes and `cloudDataplane` for the
  durable Postgres + R2 data plane. The host owns authentication, scheduling,
  migration execution, deployment, signing, updater channels, and operations.
  The same data plane also hosts on Cloudflare Workers via Hyperdrive through
  the `@byok-sdk/cloud-dataplane/runtime` subpath — see
  [`@byok-sdk/cloud-dataplane`'s deployment compositions](packages/cloud-dataplane#deployment-compositions).
- Timeline projection: use `uiRuntime` to fold a typed cloud activity tail into
  a deterministic, React-free Live Activity Timeline view model. Browser auth,
  redaction, transport, and presentation remain host responsibilities.

Both profiles share the frozen v1 protocol, tenant isolation, durable device
proof, truth CAS, explicit capabilities, and fail-closed policy handling.

## Agent-first local homes and egress

The additive Agent execution path treats a task as one run of a durable Agent.
The host supplies an absolute branded `hostStorageRoot` plus an exact
`AgentRef`; the SDK alone composes `<hostStorageRoot>/agents/<agentId>`,
initializes and preserves `MEMORY.md`/`notes/`, enforces one writer, and seals
that canonical home as the Pi/Claude/Codex cwd. An Agent dispatch requires the
target daemon's durable `agent-home-contract` capability and never falls back
to `workspaceRoot/<taskId>`.

Profile projection content and every non-`.byok` Agent file remain downstream
owned and opaque. In particular, `artifacts` is not an SDK schema or a required
directory. See [the host local-storage contract](docs/host-local-storage-layout.md).

The Agent egress contract adds one consumed `AgentEgressPolicy`.
Metadata/status activity is the safe default; contentful trajectory is an
explicit capability-gated opt-in. Reliable evidence is fsynced under the
canonical Agent home and retried with stable cursors until an exact ack, while
latest-value activity remains replaceable and reports typed drop reasons.
The daemon's tenant binding comes only from the authenticated pair response
atomically persisted in its local `DeviceRecord`; Agent egress has no
host-authored `tenantId` setting and never parses the access token. Workspace,
transcript, and artifact reads are separately disabled/enabled,
path/MIME/size checked locally, audited per Agent, and represented to cloud by
content-free receipts plus authenticated `BlobRef`s. Salesko supplies tenant
authorization and pairing authority, stable Agent/Profile identity, policy and retention; it does
not compose Agent paths, implement SDK journals, or mirror the full local
transcript as shared history.

## Key management is separate

`@byok-sdk/keys` stores provider credentials and makes direct provider calls.
It is intentionally outside `byok-sdk` and the entire dispatch dependency
graph. Install it explicitly when that security model is required:

```sh
npm install @byok-sdk/keys@0.3.1
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

The dispatch SDK and the independently installable `@byok-sdk/keys@0.3.1`
require Node.js 22.22.0 or newer. MIT licensed.
