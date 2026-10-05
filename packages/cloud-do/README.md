# Private Cloudflare pi-durable host (slices 4a–4b)

This workspace owns the Cloudflare deployment boundary, separate from the Node
client and the environment-neutral cloud domain kernel. It is private: ADR-035's
published package inventory and API baselines remain unchanged. A later public
distribution decision is outside 4a.

`AgentDO` hosts native pi-durable 1.0.1 `Harness` and `Storage`. `openExecution()`
always creates a new ownerless conversation. `appendExecution(id, text)` and
`readExecution(id)` round-trip passive entries without model or tool execution.
The consuming platform must authorize the identity before `getAgentObject()`;
there is no public HTTP route (the Worker returns 404).

## Platform model submissions

The platform sets `AIPHABEE_ZAI_API_KEY` and `AIPHABEE_DEEPSEEK_API_KEY` as Worker
secrets. Each environment has its own secrets and DO namespace. Use
`agent.submit({ instruction, profile? })` after platform identity authorization.
The default profile is `zai_openai` (`glm-5.3-flash`). The other profile is
`deepseek_direct` (`deepseek-v4-flash`). URLs and models are fixed in
`src/platform-credentials.ts`. This slice has no Gateway fallback or tools.

The RPC returns a `Response`. Admission errors use HTTP 400. A missing or invalid
secret uses HTTP 503. The error body has a fixed code and `retryable: false`.
Preflight failure causes no model request or storage write. An accepted response
uses SSE. It sends `text_delta`, then `done` or a fixed `error` code.
Each submission uses a new native pi conversation.
The response uses a native byte stream. A request-only keepalive probe runs at
most once per 250 ms. It detects a lost reader after RPC transfer. It sends an
SSE comment. A disconnect aborts the provider. This probe does not use a DO alarm.

The Web transport uses pi's existing `ProviderStreams` interface. It does not
import the Node OpenAI transport. A bounded SSE parser decodes JSON before the
guard checks text. Each guard holds at most `3K-1` characters for an ASCII key
of length `K` (16–512). Two lane guards and one merged guard stop interleaving
from hiding a key. They check raw, base64 and percent-encoded forms. They check
sensitive fragments of at least 16 characters. It covers three base64 alignments.
Each lane can hold up to `2(3K-1)` characters before client release. Total guard
tails hold at most `3(3K-1)` characters. They do not grow with the reply.
A match cancels the provider and drops the pending tail. Text already released
remains. Unchecked text does not enter pi events or SQLite. EOF triggers a final
tail check. The transport drops vendor metadata and response headers.
The guard does not detect arbitrary obfuscation or every short fragment.

Unknown request fields are rejected. Credential fields are rejected at any
level. A best-effort detector rejects known user-key formats in instruction text.
It can reject examples that look like keys. Before input storage, the guard also
checks the exact platform key and its defined forms. Keys use only auth headers.
The transport rejects every 3xx response.
The host limits a request to 4096 output tokens and a 65,536-token context.
These are host limits. Pi cost fields are zero and do not state provider prices.
The consumer owns billing and provider price data.

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
Current upstream uses a different synchronous pi contract. Pinned pi 1.0.1 takes
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
bundle contains its lazy local auth fallback. The host supplies an explicit
empty environment/file auth context. Platform auth uses an explicit resolver.
Provider retries and durable generation retries are disabled.

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

4b adds platform-only model credentials and text streaming. Tools/jobs, alarm,
inbox and event scheduling remain deferred. 4c owns invocation and interruption
policy. 4d owns wake/inbox/event scheduling. Retention needs a
bounded native-document/conversation cleanup design; deleting the DO's database
would erase other executions and host tables, so cleanup is deferred.

## Consumer hooks and durable transcript

Cloud 4e-2 adds protected `instructions(profile)`, `renew(request, signal)` and
`settleRun(run, signal)` hooks. Instructions enter the native pi system message.
Renew runs before each model send gate and each tool dispatch, including recovery.
The fixed run caps are 100 credits, 128,000 input tokens and 32,768 output tokens.
A tool may cross the credit cap once. Its result and actual credits stay recorded.
The next paid gate stops the run.

The execution row records token usage, credits, model gate passes and
`sentRequests`. The latter is durable dispatch intent. The host builds the final
request, checks cancellation, writes the mark and calls fetch without an await
between the last three steps. A failure before the mark is known-unsent.
A positive mark with no usage is uncertain. A crash after the mark can occur
before the provider receives the request. The consumer does not refund or retry
that uncertain call. A run with no marks, tokens or credits is unpaid and gets
compensation. Mixed runs settle their earlier paid usage before the unpaid
remainder is released. The consumer owns billing and refunds.

Settlement runs after the terminal transaction. Success writes `settlementAck`
and `run.settlement` together. Failure leaves the terminal run unacked. Only
settlement is retried. The existing alarm generation retries up to six times.
After exhaustion, the next enqueue, release or boot can rearm the alarm.

`readTranscript({after?, limit?})` returns runs, turns and inbox items. The limit
is 1 to 50, with a default of 20. Return `next` unchanged as the next `after`.
Its horizon fixes turn membership for the whole pass. A null run or item cursor
means that list has ended. Current turn state and its run link carry a durable
revision. Real native input is the text authority. The inbox retains text until
that input is durable and requeue is no longer possible. Never-run text stays
until the seven-day inbox purge. A large final answer returns a preview; use
`readRunOutput` to read its full text.

Legacy membership is backfilled once from committed input. Progress commits per
run and resumes on restart. Missing clocks, state and current links stay unknown.
The transcript keeps the historical source text without inventing current
ownership. The product route must remove final answer text until settlement is
acknowledged. The SDK remains private at version 0.0.0.

Settlement is isolated per run. Delivery tries every unacked run concurrently.
A failed run stays unacked. Later runs can ack and new work can start. The batch
still reports failure to the existing alarm retry generation. The native lease
is released before consumer delivery. For N runs, the batch uses N concurrent
hooks and at most N hook deadlines. The asynchronous wait is at most 60 seconds,
plus setup and ack processing. Local work and memory are O(N). The consumer must
bound its external connections. There is no added SDK retry timer.

Legacy backfill reads each pending run at most once per boot. Its cost is one
context read per pending run plus at most 16 membership checks and one transaction.
The scan pages by 25. A failed native read stays pending and retries next boot.
Healthy legacy runs and new work remain usable. Transactional backfill write
failures still fail recovery without a partial write. Pending unreadable legacy
context is omitted from model history and remains unknown in transcript reads.

Legacy backfill can keep real input after a requeued item expires and is purged;
a released live membership is excluded from a new transcript horizon.
The default settlement hook adds one `run.settlement` event per terminal run.
