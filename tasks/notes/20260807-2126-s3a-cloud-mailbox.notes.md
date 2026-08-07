# Implementation Notes: s3a-cloud-mailbox

> **Status**: Active
> **Plan**: plans/plan-20260807-2126-s3a-cloud-mailbox.md
> **Contract**: tasks/contracts/20260807-2126-s3a-cloud-mailbox.contract.md
> **Review**: tasks/reviews/20260807-2126-s3a-cloud-mailbox.review.md
> **Last Updated**: 2026-08-07 23:20
> **Lifecycle**: notes

## Story → Commit Map

| Story | Commit | Content |
| --- | --- | --- |
| P-001/P-002 | `61393e2` | Scaffold (`platform: 'neutral'`, deps core+protocol+zod+hono); seven cloud-local tenant-first ports (`DeviceDirectory`, `PairingCodeStore`, `NonceStore`, `RequestReceiptStore`, `InboundDedupStore`, `TaskAttemptStore`, `DeviceSequenceStore`) with in-memory impls; auth plane with S1-parity semantics (claims flow, `byok-nonce-v1\n` via injectable WebCrypto port, token triple, uniform 401) |
| P-004/P-005/P-006 | `5591960` | Stateless handlers for the nine device routes + hosted-only `GET /byok/capabilities` (core `CapabilityDeclarationSchema`; declaration drives route mounting — undeclared `blobs.presigned` unmounts the four blob routes); `TenantStores` facade (core's deferred layer-2, constructed only from a principal); inbound gate order reproduced statelessly (rate-limit seam → `DAEMON_TO_SERVER_TYPES` allow-list → ownership via `TaskAttemptStore` → dedup via `InboundDedupStore`); `enqueueOffer` host control input building frozen v1 `task.offer` bytes |
| P-003 | `a098ed5` | I1 route-inventory matrix with bidirectional closure (mounted↔inventoried↔classified; 10 routes: 4 public / 4 device / 2 presigned; no approval route); tenant isolation across every device-class resource (tenant A byte-identical after tenant B's attempts); statelessness constraint test (no module-level mutable state, no Running map, events handler holds no waiter registry); S1-parity negatives (16 cases incl. byte-identical no-oracle responses) |
| E2E | `578ff17` | `fixtures/real-cloud.ts` + `real-cloud-longpoll.test.ts`: unchanged daemon full lifecycle (offer→claim→started→progress→complete) over `GET /byok/events` + `POST /byok/messages`; terminal receipt decoded back to frozen v1 `task.complete` |
| docs | (docs commit, see git log) | Architecture §12.1/§12.2/§11.2/§12.5/§16.1 status; sprint D-5 split record + S3.5 S3a-subset marks |

## Design Decisions

- **`DeviceSequenceStore` as a seventh port** (deviation, ratified): envelope `seq` is internal to the frozen bytes, so it cannot be assigned by mailbox append; a counter in the composition would be mutable state next to the handlers — exactly what the statelessness constraint forbids. Tenant-first port + post-append `mailbox_seq_mismatch` verification instead.
- **Pairing failure responses collapsed to one message** (deliberate divergence from server, stricter): pairing codes are cross-tenant addressable bearer credentials; distinguishing used/expired/unknown is what enumeration buys. Status code and `{error}` shape stay server-identical; byte-identical assertion covers the three cases.
- **Long-poll hold via bounded re-read (sleep loop), not a waiter registry**: a waiter map is cross-request state and invisible to sibling instances in multi-instance deployments; the constraint test pins the events handler to zero Map/Set and a single sleep Promise.
- **Capabilities drive mounting**: `/byok/capabilities` is a new hosted-only route (nothing to mirror — server/protocol/client have no such surface; ADR-002 sanctions new capabilities on the HTTP side, protocol untouched). The composition mounts feature routes from the declaration, which is the S3.5 box-12 semantics at the composition level; daemon-side consumption is a later slice.
- **Cloud-local auth/task ports, not core additions**: S2 deliberately excluded hosted-auth semantics from core; the ports match S4A's schema minimum (`device`, `pairing_code`, `auth_nonce`, `inbound_dedup`, `device_request_receipts`, `task`, `device_stream`) so the durable-home decision lands with the schema work.
- **Client fixture imports cloud by relative path** (no `@byok/client` → `@byok/cloud` devDependency): `packages/client/package.json` is outside allowed paths, and a package edge from client to cloud would both invert the architecture direction and undermine the "daemon cannot tell cloud from server" claim. Cloud re-exports core's `tenantId`/`TenantId` so the fixture never touches core source directly (single branded identity).
- **Crypto via injected WebCrypto port** (Ed25519): keeps cloud runtime-neutral. Node 20's `subtle` Ed25519 support is CI-verified, not locally verified; the fallback is swapping the injected port, no handler change.

## Deviations From Plan Or Spec

- Seven ports instead of six (`DeviceSequenceStore` added) — rationale above.
- No `@hono/node-server` in cloud runtime deps (test/fixture side only), per plan.
- Client production code zero-diff machine-checked; the only client change is two new test files (+213).

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Waiter-registry long-poll (server-style hold) | Rejected | Cross-request state; invisible across instances; sleep-loop hold is bounded and stateless |
| Seq counter in composition closure | Rejected | Mutable module/composition state beside handlers; port keeps it tenant-first and store-owned |
| Server-parity granular pairing errors | Rejected | Enumeration surface on a cross-tenant credential; stricter uniform response chosen |
| `@byok/cloud` devDependency in client | Rejected | Reverses the dependency direction; relative-path fixture import keeps the graph clean |

## Open Questions

- None blocking. S3b owns: `LocalTaskJournal` + `SqliteLocalTaskJournal`, cursor-ack-after-commit, watermarks/GC, crash/disk matrices, and the remaining seven S3.5 boxes. S4A owns the durable home for the seven cloud ports.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Worker-run evidence (after `578ff17`): typecheck 8 projects clean; tests core 167 / keys 328 / protocol 189 / cloud 77 / server 216 / client 874 all green; build 6× success; protocol golden clean; zero-touch machine check clean (`packages/protocol/ packages/keys/ packages/server/src/ packages/client/src/daemon/ packages/client/src/adapters/ packages/client/src/bin/ examples/`).
- Full-repo gates re-run by the acceptance chain (see checks file), not hand-claimed here.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- "Statelessness constraint tests (no module-level mutable state, no waiter maps) catch multi-instance bugs at the single-instance stage" — candidate for `tasks/lessons.md` if S4A/S5 repeat the pattern.
