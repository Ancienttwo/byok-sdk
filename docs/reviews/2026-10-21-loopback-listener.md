# Issue 613: identity-stable native loopback listener

Baseline: `f4860c0f80df8a5f28964d7417d1a87d9e01667c`.
Scope: additive `@byok-sdk/server.listenLoopback`; native embedded daemon and
Host-authenticated MCP mounting. Ref #613, not a complete browser-CORS feature.
The issue was open with no assignee or overlapping open PR when work started.

The caller owns durable identity-scoped read/atomic insert-if-absent port
persistence. A successful socket bind precedes the claim; only durable readback
and handler construction enable dispatch. Collision retries apply only to new
identities, with at most 16 distinct candidates. An assigned or winning port is
bound once, never adopted from another process. Closing does not erase identity.
Caller persistence remains authoritative even when an abort races a commit.

Raw HTTP checks require exact loopback Host and origin-form target; reject
Origin, Cookie, non-native fetch metadata, CONNECT and upgrades. Native Node
fetch's `Sec-Fetch-Mode: cors` remains valid. The actual-byte limit is checked
before dispatch, including chunked uploads, with GET/HEAD framing refused.
The default 2 MiB cap is separate from the SDK blob cap.

The generic handler factory receives the trusted bound URL, allowing MCP origin
configuration without trusting incoming Host. Authentication and per-caller MCP
instances remain Host-owned. No Origin header is rewritten or removed. Optional
browser origin allowlists/preflight from the follow-up issue comment remain open:
MCP's existing Origin policy must be addressed explicitly in that separate slice.

Validation on macOS, Node 24.18.0 / Bun 1.4.3:

- New real-socket helper suite: 9 passed, no skips. Covers native fetch,
  header/target refusal, chunked overflow, Expect/body framing, pending claim,
  stable restart, occupied ports, winning-port rebound, concurrent claimants,
  persistence error/readback mismatch/abort cleanup, embedded daemon pairing.
- Existing embedded integration + initial helper tests: 20 passed, 2 skipped.
  The two skips are existing explicit cases for obsolete task.decline and
  task.started paths in integration.test.ts; neither was changed.
- MCP new + existing HTTP integration: 6 passed, no skips. The new test uses the
  standard MCP HTTP client and confirms wrong Host/Origin and oversized bodies
  never reach the authenticated MCP handler.
- Workspace build and typecheck, API surface and version authority: passed.
  Public declaration and static entry dependency facts updated; no budget raised.
- Linux/macOS/Windows focused checks added to the existing packageability matrix,
  once per OS. Hosted CI results are pending; local results do not prove Windows.
- Full monorepo test suite intentionally not duplicated for this bounded slice.

Independent review completed before commit: the root reviewer and a separate
review agent found no actionable issue in the final patch. The independent pass
checked bind/abort against Node's listening-generation guard, raw filtering,
body bounds, ownership cleanup, API facts, tests and CI coverage. No tests were
duplicated by the reviewer.
