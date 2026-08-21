# Implementation Notes: transport-diagnostics

> **Status**: Active
> **Plan**: plans/plan-20260821-2336-transport-diagnostics.md
> **Contract**: tasks/contracts/20260821-2336-transport-diagnostics.contract.md
> **Review**: tasks/reviews/20260821-2336-transport-diagnostics.review.md
> **Last Updated**: 2026-08-21 23:36
> **Lifecycle**: notes

## Design Decisions

- **Client**: `TransportEndpoint {transport, host, path}` + `describeEndpoint()` in `packages/client/src/daemon/url.ts` is the SINGLE construction site. Redaction is structural, not a scrub pass: the projection reads `URL.host`/`URL.pathname` off a parsed URL, so userinfo, query and fragment (the only places a bearer token or presigned signature travels in this SDK) cannot survive. One site means a future diagnostic cannot reintroduce a credential-bearing component by formatting a raw URL of its own.
- `WsUnexpectedStatusError(status, endpoint)` — the endpoint is computed once per `openSocket()` and shared by all three outcome sites, so `onConnectOutcome(acked, err, endpoint)` always reports the route the attempt was aimed at.
- `LongPollRouteError(endpoint, status, cause)` — thrown-error detail rides in `cause` rather than being flattened into the message. `status: undefined` means the request never produced a response at all. Warned through `warnRouteFailure`, deduped by `path:status` (same soft-cap-reset discipline as `warnedValidationFailureSeqs`) because the fallback loop re-fails every `retryDelayMs`.
- **Cloud**: `BlobContentProxy.readContent` now returns `BlobReadResult | undefined`, mirroring the existing `BlobWriteResult` union idiom on the same interface. `undefined` KEEPS its not-found meaning (404) — not-found is deliberately not spelled as a failure code.
- The two `BLOB_READ_ERROR_CODES` split on where the failure landed relative to the upstream response, the only part a proxy can observe:
  - `blob_upstream_unavailable` — failed BEFORE the upstream response started (unreachable/refused); nothing was delivered.
  - `blob_upstream_stream_interrupted` — failed AFTER it started; whatever the caller holds is a truncated prefix, not a short blob.
- Both map to 502 via `BLOB_READ_ERROR_HTTP_STATUS` in `handlers/blobs.ts`. The CODE carries the distinction, not the status: client status handling stays a two-way split (404 missing / 502 upstream) while the body still says which half failed.
- `InMemoryBlobContentProxy.readContent` returns `{ok: true, content}` and can never return `{ok: false}` — it holds the bytes in-process, so there is no upstream to be unreachable and no stream to interrupt. Both codes are structurally unreachable there; a real object-storage proxy is where they become live. That is also why the new cloud test uses a stub proxy rather than the in-memory store.
- Only implementor swept: `packages/server`'s `BlobStore.readContent` is a DIFFERENT port and was not touched.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| ... | ... | ... |

## Open Questions

- None.

## Verification

- `bun run build` — pass
- `bun run typecheck` — pass
- `bun run test` — pass
- `packages/client/src/__tests__/transport-error-diagnostics.test.ts` — 4 tests pass (real `node:http` 401 upgrade; mocked-fetch long-poll route warnings on `/byok/events` and `/byok/messages`; redaction).
- `packages/cloud/src/__tests__/blob-content-proxy-failure-modes.test.ts` — 4 tests pass (404 / 502+unavailable / 502+stream_interrupted / 200 ok).

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
