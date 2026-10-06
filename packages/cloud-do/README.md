# @byok-sdk/cloud-do

This package hosts a pi-durable session in a Cloudflare Durable Object.
It provides native SQLite storage, inline tools, wake and inbox processing,
usage limits, settlement hooks, and transcript reads.

The approved source candidate is stable 0.24.0, included in the complete
ten-package release set with keys 0.9.0. npm publication is still pending;
source preparation does not establish registry or live-Host acceptance. See the
[release gates](../../docs/releases/v0.24.0.md#approved-stable-version-set).
The package needs Node 24.15.0 or later for build tooling.

## Install and subclass

The following install example names the current source version, which is pending
publication. Install an exact approved version only after registry readback, or
use verified accepted CI tarballs for pre-publication integration. Do not use a
workspace source import as installed-package acceptance evidence.

~~~sh
npm install @byok-sdk/cloud-do@0.24.0
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
and chord, each pinned to 1.0.4.

The Durable Object owns the physical connection. Closing the adapter
invalidates that adapter. It does not close the Durable Object database.

This follows the async adapter in [Cloudflare Agents d6656161](https://github.com/cloudflare/agents/blob/d6656161/packages/agents/src/harness/pi/session-store.ts).
Current upstream uses a different synchronous pi contract. Pinned pi 1.0.4 takes
async callbacks, so `transactionSync()` cannot host its transaction callback.
Cloudflare documents async SQL transactions on the
[SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

RunRow and InboxRow are public as they are. They include internal state,
revision, admission, settlement, usage, and text-handoff fields. The API
golden locks these types. A later breaking type cut requires a MINOR release
under the SDK's pre-1.0 policy.

## Package checks

The library build emits dist/index.js and a local declaration closure.
The dist check rejects Node builtins, missing or escaped declaration paths,
and undeclared external type imports. A separate Wrangler dry run writes
dist-worker. That Worker output is not in the npm package.

Release verification installs a real tarball in a temporary consumer.
It typechecks the subclass, bundles it with Wrangler, and runs its hook,
Durable Object RPC, identity helper, and SQLite adapter in real workerd.
The same smoke runs in the Linux, macOS, and Windows release-pack jobs.
