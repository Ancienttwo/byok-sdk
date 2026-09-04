# WP3B long-poll-only coordination snapshot

> **Status**: Implemented candidate
> **Date**: 2026-09-04
> **Capability**: `root` / `sdk-root`
> **Plan**: `plans/plan-20260904-1324-wp3b-step4b-step5-closeout.md`

## Boundary

`@byok-sdk/server` is an embedded HTTP façade over the `@byok-sdk/cloud` domain kernel. It does not own a second coordination state machine or a WebSocket hub. The daemon uses one authenticated bidirectional transport contract:

- `GET /byok/events?cursor=N` reads after the last successfully processed cursor and acknowledges through `N`.
- `POST /byok/messages` carries device-to-cloud envelopes.
- `ConnectionManager` owns FIFO processing, durable cursor advancement, local duplicate suppression, capability freshness, revocation, and bounded shutdown.
- `LongPollClient` owns GET/POST lifecycle, retry cadence, abort, and route diagnostics.

The deleted socket implementation, route/URL helpers, WS-first retry state,
periodic recovery probe, and degraded connection state are not compatibility
surfaces. Reintroducing them would create a second transport lifecycle and
requires a new approved architecture decision with real consumers.

## Invariants

1. A mailbox row is acknowledged only after its handler succeeds; eager delivery/dedup state never becomes the wire cursor.
2. A failed handler remains redeliverable; repeated in-flight delivery is locally suppressed and backed off.
3. Stop or revocation aborts the held GET and retry delay while preserving the existing bounded POST drain contract.
4. Poll-response capabilities are the only current server capability snapshot; transport failure invalidates them rather than retaining stale authority.
5. Runtime code, route constants, public declaration goldens, and current documentation move together in one cutover.

## Scale pressure

At 10x device or backlog load, the first pressure point is repeated post-cursor reads and serialized handler latency. The current bounded controls are long-poll hold time, retry/idle backoff, per-session duplicate suppression, and cancellation. A future low-latency wake mechanism may be added only as a non-authoritative hint over the same mailbox cursor contract; it must not restore a second delivery or acknowledgement authority.

## Verification surface

- `packages/client/src/daemon/connection-manager.ts`
- `packages/client/src/daemon/long-poll-transport.ts`
- `packages/client/src/__tests__/real-cloud-longpoll.test.ts`
- `packages/client/src/__tests__/real-server-longpoll-only.test.ts`
- `api-surface/client.d.ts`
- `api-surface/protocol.d.ts`
- `repo-harness run check-architecture-sync`
