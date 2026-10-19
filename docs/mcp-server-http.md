# MCP server over Streamable HTTP

`@byok-sdk/client/mcp-server/http` exports `createMcpHttpServer`.
It frames the existing tools-only MCP core over Web `Request` and `Response`.
It does not start a listener. The Host mounts it at one MCP endpoint.
The existing `@byok-sdk/client/mcp-server` stdio entry stays unchanged.

```ts
import { createMcpHttpServer } from '@byok-sdk/client/mcp-server/http';

// Create one instance for each authenticated caller. Keep it across requests.
const mcp = createMcpHttpServer({
  origin: 'https://host.example',
  serverInfo: { name: 'host-tools', version: '1' },
  tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
  callTool: async ({ arguments: args }) => ({
    content: [{ type: 'text', text: JSON.stringify(args ?? {}) }],
  }),
});

// After Host authentication, route the caller's MCP requests here.
const response = await mcp.fetch(request);
// On caller revocation or Host shutdown:
mcp.close();
```

The Host owns authentication, caller selection, TLS, routing and network deadlines.
Select the instance from trusted authenticated state. Do not share an instance
between callers or select it from an MCP session header. A session ID is not an
authentication credential. Per-Bot keys, scopes and quotas belong to beta B2.
Mount only the intended endpoint. Bind local listeners to loopback.

## HTTP contract

The transport follows the [MCP 2025-11-25 Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
It supports protocol revisions `2025-11-25` and `2025-06-18`.
Legacy `2024-11-05` remains available on stdio only.
It implements no legacy HTTP+SSE fallback and no 2026-era protocol extensions.

- POST accepts `application/json`. Accept must include `application/json` and `text/event-stream`.
- Initialization returns one JSON response and a cryptographically random `Mcp-Session-Id`.
- Later requests must carry that session ID. Unknown or expired IDs return 404.
- A supplied `MCP-Protocol-Version` must be supported and match the session.
  If omitted after initialization, the session supplies the negotiated version.
- Notifications return 202 with no body. Requests return JSON. Invalid envelopes
  retain the core's validation. Malformed JSON and unsupported input return 400.
- DELETE closes the session and aborts active MCP calls. It returns 204.
- GET returns 405 by default. Supplying `toolsListChanged` enables one SSE stream
  per session. It sends only the core's notifications. A second open GET returns 409.
- SSE has no replay log or event IDs. Notifications without an open stream are
  dropped. A full 4 MiB stream queue closes that stream. Clients can open another.
- A disconnected HTTP response does not cancel a call. An explicit
  `notifications/cancelled` aborts its call signal and ends the original POST with
  202. The core suppresses a late result. It does not cancel a byok task.

Configure `origin` from trusted Host configuration. It must be one canonical
HTTPS origin or loopback HTTP origin, without a trailing slash or credentials.
An absent Origin is accepted for native clients. A present Origin must match
the configured origin exactly, on POST, GET and DELETE. Other values return 403.
No CORS or arbitrary-Origin allow list is provided.

## Bounds and ownership

The default request-body cap is 4 MiB. `maxBodyBytes` can lower it.
Declared length, streamed bytes and the encoded core message are checked before
MCP dispatch. A JSON number can grow when encoded. An oversized encoded message
returns 413 for that POST and preserves the session and its other calls.
The parser rejects invalid UTF-8. `maxOutboundFrameBytes` keeps the core's
1 MiB default. An oversized result closes its session without a partial frame.
The inherited core writer also closes a session above 4 MiB or 256 pending frames.

`maxSessions` defaults to 64. At capacity, admission evicts the oldest session
with no pending core reply. It returns 503 when every session has a pending reply.
This covers standard clients that close their connection without sending DELETE.
`idleTimeoutMs` defaults to 15 minutes. A session expires only when it has no
pending core reply. An open SSE GET alone does not reset that idle time. Expiry
or eviction closes its stream. The client must initialize again after a 404.
`maxInFlight` defaults to 64. It bounds concurrent body reads, pending replies
and running tools for the instance. A cancelled or closed tool still counts
until its handler settles. This prevents new sessions from bypassing the bound.
These are transport resource bounds. They are not caller billing or quotas.
The Host must also bound response writes and apply network read deadlines.

`close()` is idempotent. It cancels body readers, aborts call signals, closes
streams, releases emitter subscriptions and resolves pending POSTs with 503.
It does not wait forever for a handler that ignores its signal.

## B1 evidence and design trace

P1: `mcp-server/index.ts` owns MCP method routing and stdio framing. Its injectable
streams are the reuse boundary. The new HTTP subpath does not change that entry
or the four reserved helpers. No new runtime dependency is required.

P2: a real loopback socket carries a standard `@modelcontextprotocol/client`
`StreamableHTTPClientTransport` request into `fetch`. The framing selects the
session, forwards the message through the core's streams, and maps its response
back to that HTTP POST. The core owns tool results, errors and cancellation.
GET carries optional `list_changed` events from the same core subscription.

P3: reuse the existing stream boundary instead of duplicating method handlers.
The HTTP build imports the published stdio core instead of bundling a second
copy. A distribution test verifies that the public `McpServerToolError` retains
its custom code and data through the HTTP entry.
Keep HTTP session state separate from task state. Keep caller authentication
with the Host. The standard client proves the generic transport without a
Grok Bot account, provider credential or model request.

The tests are in `packages/client/src/__tests__/mcp-server-http.test.ts`.
They exercise both supported versions, errors, cancellation, independent clients,
Origin refusal, byte limits, session limits, disposal, idle expiry and bounded SSE.
Existing stdio core and interop assertions are unchanged.
The release checks for S0 items 1–4 remain open under the plan's
2026-10-19 19:24 SGT ruling. This transport does not claim that client acceptance.

### Verification record: 2026-10-19

Node `v24.21.0`, Bun `1.4.3`, macOS arm64. The final full build ran before
the final root test, so the distribution smoke used fresh build output.

| Command from the repository root | Result |
| --- | --- |
| `bun run build` | Exit 0. |
| `bun run typecheck` | Exit 0. |
| `bun run test` | Exit 0. 9,669 Vitest tests passed; 237 skipped. All 10 Node tests passed. |
| `bun run check:api-surface` | Exit 0 in check mode. All 9 package goldens match. |
| `bun run check:version-authority` | Exit 0. |
| `bun run --cwd packages/client test src/__tests__/mcp-server-http.test.ts src/__tests__/mcp-server-core.test.ts src/__tests__/mcp-server-interop.test.ts` | Exit 0. 91 tests passed. |

The optional Docker/Postgres substrate was not started. Skips are not verified
cases. No paid model run or external client account was used. Read-only Claude
Opus review, round 2, accepted the five fixes conditional on the final root test.
That condition is now met. No existing test assertion changed.

One optional Low remains from source review. It was not reproduced: admission
can evict a session while its POST body is still being read. That POST returns
503 before MCP tool dispatch. The Host must handle this transport failure.
