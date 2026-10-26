# @byok-sdk/cloud-do

This package hosts a pi-durable session in a Cloudflare Durable Object.
It provides native SQLite storage, inline tools, wake and inbox processing,
usage limits, settlement hooks, and transcript reads.

The current stable release is 0.30.1, in the nine-package release set,
published on npm `latest`. From 0.28.2, keys carries the same version. The npm
registry read on 2026-10-24 at 19:19 UTC lists 0.30.1 as `latest` for all nine
packages. See the [release notes](../../docs/releases/v0.30.1.md).
The earlier stable releases were 0.30.0 (published 2026-10-24, UTC), 0.29.0
(published 2026-10-23, UTC), 0.28.3 and 0.28.2 (published 2026-10-22, UTC),
0.28.1 / keys 0.13.1 (published 2026-10-21, UTC) and 0.28.0 / keys 0.13.0
(published 2026-10-20, UTC); see the
[0.30.0 release notes](../../docs/releases/v0.30.0.md), the
[0.29.0 release notes](../../docs/releases/v0.29.0.md), the
[0.28.3 release notes](../../docs/releases/v0.28.3.md), the
[0.28.2 release notes](../../docs/releases/v0.28.2.md), the
[0.28.1 release notes](../../docs/releases/v0.28.1.md) and the
[0.28.0 release notes](../../docs/releases/v0.28.0.md).

The stable release before them was 0.27.0, with keys 0.12.0. Complete registry
readback and isolated installation passed. See the
[publication record](../../docs/releases/v0.27.0-publication.md).
The `rc` channel remains 0.27.0-rc.2 / keys 0.12.0-rc.2.
See the [release notes](../../docs/releases/v0.27.0.md) for the Host upgrade
steps. Host acceptance (#195) remains separate and open.

The `latest` release before 0.27.0 was 0.26.1, in the nine-package release set with
keys 0.11.1. Registry readback and isolated installation passed on 2026-10-12.
See the [publication record](../../docs/releases/v0.26.1-publication.md).
The earlier stable release was 0.26.0 / keys 0.11.0; its
[publication record](../../docs/releases/v0.26.0-publication.md) remains historical.
The earlier published 0.26.0-rc.4 (see the
[rc.4 publication record](../../docs/releases/v0.26.0-rc.4-publication.md))
is superseded by 0.27.0-rc.2; 0.26.0-rc.1 to rc.3 are superseded. See the
[release notes](../../docs/releases/v0.26.1.md#version-set-and-channel).
Live Host acceptance remains separate.
The package needs Node 24.22.1 or later for build tooling.

## Install and subclass

The following install example names the unpublished 0.30.2 source candidate.
Use 0.30.1 until publication is confirmed.
Use an installed package to verify the consumer path.

~~~sh
npm install @byok-sdk/cloud-do@0.30.2
npm install --save-dev @cloudflare/workers-types
~~~

The package is ESM. Its root entry imports cloudflare:workers.
Run it in workerd. It cannot load in a Node process.

~~~ts
import { AgentDO, getAgentObject, getSessionObject } from '@byok-sdk/cloud-do';

export class ProductAgentDO extends AgentDO {
  protected instructions(): string {
    return 'Use the configured platform tools.';
  }
}

export default {
  fetch(): Response {
    return new Response('Not found', { status: 404 });
  },
};
~~~

Configure the subclass binding and SQLite migration in wrangler.jsonc:

~~~json
{
  "name": "product-agent",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-18",
  "compatibility_flags": ["no_nodejs_compat", "no_nodejs_compat_v2"],
  "durable_objects": {
    "bindings": [{ "name": "AGENTS", "class_name": "ProductAgentDO" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["ProductAgentDO"] }
  ]
}
~~~

Consumers need @cloudflare/workers-types to resolve the ambient Workers
module and the Durable Object types. Use ES2022 and Bundler module resolution.
The installed-package smoke uses skipLibCheck: true, as the SDK does.
Node compatibility is off in the tested configuration. A consumer with other
flags must verify its complete Worker graph.

## Identity and caller access

The platform must authorize the tenant, workspace, agent, and session before
it calls getSessionObject(). It must authorize the three agent identity
fields before it calls getAgentObject().

Names route storage. They do not authorize callers. The helper names use
SHA-256 over JSON identity tuples. One session owns one named Durable Object.
Public HTTP routing and caller access checks belong to the consumer.
The default Worker returns HTTP 404.

## Platform keys and execution

Set AIPHABEE_ZAI_API_KEY and AIPHABEE_DEEPSEEK_API_KEY as Worker secrets
for the profiles your platform uses. Each environment has its own secrets
and Durable Object namespace. Never put key values in source or request data.

The supported profiles are zai_openai and deepseek_direct. The model URLs
and model names are fixed in this package. Cloud execution uses platform keys.
Local BYOK keys do not enter this runtime.

A task with #654 sealed payload `sealing` must not go to this runtime. It
runs the model with platform keys, so it reads the instruction and the
output in plaintext. See [protocol §2.5](../../docs/protocol.md#25-sealed-payload-v1-654-gated-addition).

Configure the session and supply a dispatcher before tool execution.
The subclass can supply instructions, createDispatcher, admitWake,
renew, settleRun, projectInvocation, and onInvocationSettled hooks.
The platform owns entitlement checks, billing, and external settlement.
A terminal run precedes the settlement hook. Failed settlement is retried
through the Durable Object alarm. The consumer must make settlement idempotent.

The provider transport guards text before it enters durable storage.
Keys are used only in auth headers. The transport rejects redirects.
The guard checks exact keys and defined encodings. It cannot detect every
obfuscation or short fragment. Do not treat it as caller authorization.

## Storage and the public types

DurableObjectSqliteDatabase adapts the Durable Object SQLite connection.
openDurableObjectStorage has the local structural factory type
(location: DurableObjectStorage) => Promise<Storage>.
Storage is pi-durable's native interface. The package does not import client
source or keys types. Its three runtime dependencies are pi-durable, pi-ai,
and chord, each pinned to 1.4.0.

The Durable Object owns the physical connection. Closing the adapter
invalidates that adapter. It does not close the Durable Object database.

This follows the async adapter in [Cloudflare Agents d6656161](https://github.com/cloudflare/agents/blob/d6656161/packages/agents/src/harness/pi/session-store.ts).
Current upstream uses a different synchronous pi contract. Pinned pi 1.4.0 takes
async callbacks, so `transactionSync()` cannot host its transaction callback.
Cloudflare documents async SQL transactions on the
[SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

RunRow and InboxRow are public as they are. They include internal state,
revision, admission, settlement, usage, and text-handoff fields. The API
golden locks these types. A later breaking type cut requires a MINOR release
under the SDK's pre-1.0 policy.

## Package checks

The library build emits dist/index.js and a local declaration closure.
The dist check rejects missing or escaped declaration paths and undeclared
external type imports. The entry dependency contract enforces runtime builtin policy. A separate Wrangler dry run writes
dist-worker. That Worker output is not in the npm package.

Release verification installs a real tarball in a temporary consumer.
It typechecks the subclass, bundles it with Wrangler, and runs its hook,
Durable Object RPC, identity helper, and SQLite adapter in real workerd.
The same smoke runs in the Linux, macOS, and Windows release-pack jobs.

Runtime dependencies and size budgets: [entry dependency contract](../../README.md#entry-dependencies).
