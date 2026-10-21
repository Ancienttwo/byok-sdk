# Issue 613: loopback browser origins and CORS

Baseline: `fb34cb7915fbc6ac2d2d3ec5a9d4a0d1f8f07a9e`.
Scope: the remaining optional slice of #613, from the AiphaBee follow-up
comment. The native slice shipped in #638; see
[the native listener review](2026-10-21-loopback-listener.md).

P1: `listenLoopback` in `packages/server/src/loopback.ts` filters raw HTTP
before the Hono adapter. `createMcpHttpServer` in
`packages/client/src/mcp-server/http.ts` has its own exact Origin check.

P2: a browser page on `http://localhost:5173` calls the `127.0.0.1` listener.
The browser sends a preflight, then a POST with `Origin` and fetch metadata.
The listener admits the listed origin, answers the preflight, and passes the
POST with the original Origin to the Host handler. The MCP transport then
checks Origin again.

P3: the listener does not rewrite Origin (#638 invariant). So the MCP check
needs its own list. Both options are opt-in and default to none. Without them,
behavior is unchanged. The Host Header check, Cookie refusal and body cap stay.
No credentials are allowed.

Decisions:

- `allowedOrigins` accepts only canonical loopback `http:`/`https:` origins.
  Remote browser origins stay out of scope for a loopback listener.
- Preflight allow lists are fixed: `GET, POST, DELETE` and the MCP request
  headers plus `authorization`. They are not reflected from the request.
- The expose list is `Mcp-Session-Id` only. `WWW-Authenticate` is not exposed.
- Private Network Access preflights are not handled; loopback-to-loopback
  requests do not need them.

Validation on macOS, Node 24.21.0 / Bun 1.4.3:

- Server package: 587 passed, 19 skipped (existing skips).
- Client package: 4262 passed, 84 skipped (existing skips).
- `examples/byok-mcp-server`: 42 passed. The new end-to-end test sends a
  preflight and a browser-shaped MCP session through the real listener and
  `createMcpHttpServer`. Without the MCP `allowedOrigins`, it fails with
  `Invalid Origin` (mutation check).
- Build, typecheck, API surface and version authority: exit 0.
- Closure sizes: `@byok-sdk/client/mcp-server/http` 36482 → 36534 bytes (budget
  raised to the exact measurement); `@byok-sdk/server` 678020 → 679863 bytes
  (budget 700489 unchanged).

Independent read-only review: PASS, no must-fix finding. Fixed: preflight body
framing now gets 400; the expose header is set before the startup 503; the docs
describe the fetch-metadata rule only for browsers that send it; one test case
is labeled as a duplicate-metadata case; the spec links the new README section.
Documented, not changed: fixed preflight header list, no `WWW-Authenticate`
exposure, a handler `Vary` replaces `Vary: Origin`.

Residual risk: no real-browser run. Node fetch with browser-shaped headers
stands in for the browser. Chrome Local Network Access behavior is from the
specification, not measured.
