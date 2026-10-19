# B2: external-Bot beta authorization and admission ledger

Track: #514. Source: [beta plan §4/§5/§8](2026-10-19-byok-mcp-server-external-bot-beta.md).
Base: `649f9f0bebf8e026330bd3fbed7e6b72bc32cdee`.
This slice changes the private copy-and-own example. It does not change SDK APIs.

## P1: map

- B1: `packages/client/src/mcp-server/http.ts` exposes a Host-mounted transport.
  Each authenticated caller must have a separate transport instance.
- Persistence reference: `examples/host-execution-core/src/ledger.ts` uses local
  SQLite and synchronous `BEGIN IMMEDIATE` transactions. Its database stays separate.
- Dispatch truth: `packages/server/src/index.ts` and `docs/spec.md` require a saved
  execution identity. Duplicate submission is a conflict, not a second execution.
- This slice lives in `examples/byok-mcp-server`. It adds no SDK dependency edge
  to a sibling example, no model credential custody and no HTTP admin API.

## P2: one real path

1. The Host issues a random byok bot key once. SQLite stores its salted hash,
   tenant, label, scopes, device/runtime allow lists, optional AgentRef and quotas.
2. Every HTTP request authenticates its Bearer against current ledger state.
   Constant-time digest comparison runs before the key is accepted.
3. The authenticated key selects its B1 transport. Tool calls check scope again
   after the body wait. No identity comes from tool arguments or session headers.
4. A synchronous lookup can recover a saved admission before B3 resolves a device.
   For a new admission, one SQLite transaction rechecks the active key and
   idempotency, validates its selected device/runtime, checks quotas and saves
   the task ID, immutable input/binding and quota slot. It commits before dispatch.
5. A retry returns the saved binding. It consumes no new running or hourly slot.
   B3 will call the public SDK, recover exact offers and project task results.

## P3: decisions and invariants

- Store a 256-bit random secret as a salted SHA-256 digest. Use `timingSafeEqual`.
  Return the secret only from local key issuance. Public key views contain no hash
  or salt. Missing, unknown, wrong and revoked credentials get the same refusal.
- Bind one ledger handle to one trusted tenant. Mint immutable in-process caller
  handles on authentication. Recheck active ledger state for every admission.
  A plain object or stale revoked handle cannot grant authority.
- Keep key grants immutable. Revoke and issue a new key to change grants.
  Routine and memory grants require an AgentRef. Beta v1 registers no memory writes.
- Persist task/routine ownership. Foreign and unknown IDs both give `not_found`.
  The example stores admission references, not a second SDK task/result state.
- Defaults: 4 occupied task slots, 60 accepted task admissions per rolling hour,
  8 routine slots, 32 KiB instructions and 120 owned-task status reads per minute.
  Duplicate admissions are checked before quota refusal. Release a slot only from
  an exact SDK device-terminal readback under trusted Host reconciliation.
  A missing SDK task, Host cancellation, key revocation and MCP cancellation do
  not release it. Routine slot release belongs to trusted Host/K4 completion.
- Explicit request IDs derive task identity from tenant, key ID and request ID.
  A changed payload conflicts. Without an ID, find the first saved admission
  for the canonical argument hash in the previous 15 minutes. Anchor each new
  window at that admission. Preserve the first saved device/Agent binding.
- Keep explicit identities and ownership across reopen. Status-rate events are
  pruned inside the same transaction. Use trusted Host wall time and bound each
  rate read to (now - window, now]. Clock corrections can affect these abuse
  windows. Do not persist a future clock that can lock out a key after NTP repair.
- One Host process exclusively owns a dedicated private SQLite file. Its metadata
  fixes one tenant. Key issuance and revocation are in-process commands. Drop the
  revoked key's cached transport, without releasing task slots or cancelling SDK
  tasks. Fail closed on unknown schema, unsafe paths or unavailable storage.
  Do not add a busy timeout, retry loop or new timer.
- B2 accepts Host-supplied scoped tool registrations. It does not implement the
  B3 task catalogue, dispatch, K4 routines, memory tools or a standalone listener.

## Verification

Use real temporary SQLite files. Prove key secrecy, reopen, revocation, scopes,
ownership, atomic quota admission, rolling windows, duplicate accounting and
canonical identity boundaries. Use the standard MCP HTTP client over real local
sockets to prove Bearer auth, per-key session isolation and next-call revocation.
Use injected ledger time for boundary tests. Do not add a test timeout or change
an existing assertion. Run all five required root checks on the final source.
Run one independent read-only review for security and test integrity before push.

## Task Breakdown

- [x] Map the B1, SDK identity and SQLite boundaries. Record P1/P2/P3 and apply the design review corrections.
- [x] Implement the private key, caller, ownership, quota and idempotency ledger.
- [x] Wire per-key B1 transports with explicit scopes and current-state revocation.
- [x] Verify 22 local tests with SQLite, real MCP sockets and the SDK device simulator.
- [x] Complete independent security/test review and self-review. Preserve all existing assertions and time limits.
- [x] Run all five root checks. Full test: 9,721 Vitest and 10 Node passes; 237 skips. Record results in the example README.
