# Private Cloudflare pi-durable host (slice 4a)

This workspace owns the Cloudflare deployment boundary, separate from the Node
client and the environment-neutral cloud domain kernel. It is private: ADR-035's
published package inventory and API baselines remain unchanged. A later public
distribution decision is outside 4a.

`AgentDO` hosts native pi-durable 1.0.0 `Harness` and `Storage`. `openExecution()`
always creates a new ownerless conversation. `appendExecution(id, text)` and
`readExecution(id)` round-trip passive entries without model or tool execution.
The consuming platform must authorize the identity before `getAgentObject()`;
there is no public HTTP route (the Worker returns 404).

```ts
import { getAgentObject } from './src/identity';

const agent = await getAgentObject(env.AGENTS, { tenantId, workspaceId, agentId });
const { conversationId } = await agent.openExecution();
await agent.appendExecution(conversationId, 'execution context');
const entries = await agent.readExecution(conversationId);
```

The name is `agent:` followed by SHA-256 of the UTF-8 JSON array of the three
identity strings. JSON tuple encoding distinguishes embedded separators and
preserves Unicode. `getByName(name)` and `get(idFromName(name))` identify the same
DO. Names route ownership; they do not establish caller authorization.

## Storage and transactions

Both local and DO factories satisfy `DurableStorageFactory<Location>` and return
the unchanged native pi `Storage` interface. The cloud's reference to the client
factory declaration is a type-only import; Wrangler erases it. The cloud does
not import the local engine, replica, tools or credential path.

The DO adapter derives table/index identifiers from pi migrations and prefixes
them with `pi_`, excluding SQL string literals. All adapter calls share one queue.
An async callback runs inside `ctx.storage.transaction()` with a scoped executor;
unrelated calls and close wait until commit/rollback, and escaped handles reject.
Results are consumed synchronously before returning promises. The DO owns the
physical SQLite connection; native storage close invalidates the adapter, and
reopening preserves data. Open one native storage instance per DO at a time.

This follows the async adapter in [Cloudflare Agents d6656161](https://github.com/cloudflare/agents/blob/d6656161/packages/agents/src/harness/pi/session-store.ts).
Current upstream uses a different synchronous pi contract. Pinned pi 1.0.0 takes
async callbacks, so `transactionSync()` cannot host its transaction callback.
Cloudflare documents async SQL transactions on the
[SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

## Build and verification

`bun run build` runs Wrangler 4.123.0's offline deploy dry-run. Config binds
`AGENTS` with a `new_sqlite_classes: ["AgentDO"]` migration. Compatibility date
`2026-08-18` is the latest supported by the workerd pinned with that Wrangler;
the current UTC date `2026-10-02` is rejected by the server binary, and
`2026-10-03` is rejected by Miniflare as a future UTC date. No `nodejs_compat`
flag is required; both Node compatibility modes are explicitly disabled in the
deploy and test configs. The application path calls no Node built-ins. Pi-ai's
bundle contains its lazy local auth fallback; the host supplies an explicit
empty environment/file auth context, and registers no providers in this slice.

`bun run test` uses Vitest 4 and Miniflare's matching pinned workerd. Both backends
run every native pi storage conformance case and the same BYOK-specific contract
function. Tests cover reopening, sibling conversation isolation, a legal 1 MiB
pi entry, a 64-entry atomic batch, full workerd restart, tenant separation, schema
collisions, rollback/operation queue/close, BLOB conversion, and 100 vs 101 SQL
bindings. The 1 MiB payload leaves room for JSON record overhead under the
[2 MB row limit](https://developers.cloudflare.com/durable-objects/platform/limits/).
Exact 2 MB payload edge, 100 KB statement edge, 10 GB capacity, Cloudflare remote
deployment and production crash durability have not been verified.

## Deferred slices

No secrets, user credential fields, model calls, tools/jobs, alarm, inbox or event
log are implemented. 4b supplies platform-only credentials; 4c owns invocation
and interruption policy; 4d owns wake/inbox/event scheduling. Retention needs a
bounded native-document/conversation cleanup design; deleting the DO's database
would erase other executions and host tables, so cleanup is deferred.
