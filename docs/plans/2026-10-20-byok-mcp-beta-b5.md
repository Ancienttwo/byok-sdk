# B5: external-Bot beta memory read tool

Issue: [#587](https://github.com/Ancienttwo/byok-sdk/issues/587). Source: [beta plan §3.3/§8/§9 Q9](2026-10-19-byok-mcp-server-external-bot-beta.md).
Base: `4d428c14`. B4 (#586, #590, [plan](2026-10-20-byok-mcp-beta-b4.md)) is on `main`.
This slice changes the private copy-and-own example. It does not change SDK APIs.
Scope: `byok_memory_read` only. `byok_memory_propose` waits for §9 Q9 and PRD P5.

## P1: map

- Key contract: `examples/byok-mcp-server/src/model.ts` (B2). `memory.read` needs one
  AgentRef per key. The scope check is `BetaLedger.authorize`.
- SDK hosted projection: `packages/protocol/src/agent-memory-projection.ts` and
  `packages/cloud/src/agent-memory-projection.ts`. The device sends one redacted full
  snapshot as opaque bytes. Source paths, source revisions and raw content never
  cross. The cloud store port offers no read, and `createByokServer` does not wire it.
- Host receiver and reader: K4 `HostMemoryPage` (`examples/host-execution-core/src/memory.ts`).
  `projectionPort(deviceId)` accepts `agent.memory.projection` mutations in the
  Host profile `{ residentMemory: string | null }` (MEMORY.md only). `contextPack(binding)`
  is the one read. It refuses a changed placement or profile, a revoked projection
  grant and text over 8 KiB. It hides a projection that an applied MEMORY.md write
  made stale. K4's core uses the same read for its ContextPack.

## P2: one real path

1. The device daemon redacts MEMORY.md with the Host's redactor and publishes the
   mutation through the Host's `projectionPort(deviceId)`. The page checks placement,
   grant, hash and ordering, then stores the text.
2. A standard MCP client calls `byok_memory_read` over Streamable HTTP with a key.
3. The handler checks the input (`path` is absent or `MEMORY.md`) and the current key
   (`memory.read`). It takes the AgentRef from the key, never from arguments.
4. The Host's `placement(agentRef)` names the device. The device must be granted to the key.
5. `contextPack({ deviceId, agentRef })` returns the resident memory or nothing. The
   result is `{ path, text, revision: mutationId, projectedAt }` or `{ path, text: null }`.

## P3: decisions and invariants

- K4's page is the only memory read authority. The tool stores no memory text, reads
  no K4 ledger rows and derives no binding key.
- The plan's "hosted `agent.memory.projection`" is this Host-side page. The SDK cloud
  store has no read surface, and adding one would change the SDK.
- `revision` is the projection `mutationId`, not a hash of the text. The projection
  carries no source revision, so a file-like hash would look like a CAS base and be
  wrong whenever redaction changes the text.
- `path` accepts only `MEMORY.md`. The plan names `notes/**`, but K4's profile carries
  no notes. A Host redactor profile with notes is out of scope; a notes path is
  `invalid_input`.
- `placement` is a Host callback. A key can grant several devices, and the Agent home
  lives on one. Trying each device would need error-message parsing. The callback must
  use the same trusted state as the page's `isCurrent`.
- A page refusal maps to one fixed `unavailable` message. `MemoryBlockedError` is not
  exported by K4, and forwarding error text could leak Host details.
- No quota counter: the beta plan sets none for memory reads.
- Out of scope: `byok_memory_propose`, notes projection, a Host redactor, and the
  real-device projection path (it needs the secure memory filesystem: Linux native,
  macOS helper).

## Verification

`memory.test.ts` runs K4's `HostMemoryPage` on a real temporary SQLite ledger, the beta
ledger and the beta MCP endpoint on a loopback origin with the standard MCP HTTP
client. The device side is synthetic: tests publish redacted mutations through the
page's own `projectionPort`, and apply a MEMORY.md write through the page's intent
transport. No runtime, model or account is used. Keep the repository's default test
time limits. Change no existing assertion. Run all five required root checks on the
final source.

## Task Breakdown

- [x] Map the B2 key contract, the SDK projection contract and K4's memory page. Record P1/P2/P3.
- [x] Implement `byok_memory_read` on `HostMemoryPage.contextPack` with a Host placement callback.
- [x] Prove read, newer projections, stale hiding, isolation, refusals and revocation over MCP.
- [x] Run the five root checks and record results in the example README.
