> **Archived**: 2026-08-13 04:52
> **Related Plan**: plans/archive/plan-20260813-0423-route-path-constants.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260813-0452

# Implementation Notes: route-path-constants

> **Status**: Active
> **Plan**: plans/plan-20260813-0423-route-path-constants.md
> **Contract**: tasks/contracts/20260813-0423-route-path-constants.contract.md
> **Review**: tasks/reviews/20260813-0423-route-path-constants.review.md
> **Last Updated**: 2026-08-13 04:23
> **Lifecycle**: notes

## Design Decisions

Route paths are protocol-owned wire contract, exported as named constants +
parameterized builders from `@byok-sdk/protocol` (`packages/protocol/src/http-api.ts`);
every package imports them. Byte-identical strings, zero wire/behavior change,
freeze-guard zero-diff.

### Route inventory (hand-authored literals replaced)

Static path constants (`BYOK_*_PATH`) — used identically by routers and clients:

| Constant | Value | Prior call sites (non-test) |
|---|---|---|
| `BYOK_WS_PATH` | `/byok/ws` | client url.ts; server ws-server.ts |
| `BYOK_PAIR_PATH` | `/byok/pair` | client auth-manager; cloud cloud.ts; server http.ts; testkit simulator |
| `BYOK_CHALLENGE_PATH` | `/byok/challenge` | client auth-manager; cloud; server; testkit |
| `BYOK_TOKEN_PATH` | `/byok/token` | client auth-manager; cloud; server; testkit |
| `BYOK_CAPABILITIES_PATH` | `/byok/capabilities` | client capabilities-client; cloud |
| `BYOK_EVENTS_PATH` | `/byok/events` | client long-poll-transport; cloud; server |
| `BYOK_MESSAGES_PATH` | `/byok/messages` | client long-poll-transport; cloud; server |
| `BYOK_PRESENCE_PATH` | `/byok/presence` | client presence-publisher; cloud; testkit |
| `BYOK_ACTIVITY_PATH` | `/byok/activity` | cloud |
| `BYOK_BOARD_PATH` | `/byok/board` | cloud cloud.ts; cloud coordination-client |
| `BYOK_BOARD_STREAM_PATH` | `/byok/board/stream` | cloud cloud.ts; cloud coordination-client |
| `BYOK_RECORDS_PATH` | `/byok/records` | client truth-memory-client; cloud |
| `BYOK_SKILL_PACKS_PATH` | `/byok/skill-packs` | client skill-pack-installer; cloud |
| `BYOK_BLOBS_PATH` | `/byok/blobs` | client blob-client; cloud; server |

Router-template constants (`BYOK_*_ROUTE`, with `:param`) — used only by routers:

| Constant | Value | Prior call sites |
|---|---|---|
| `BYOK_BOARD_CLAIM_ROUTE` | `/byok/board/:id/claim` | cloud cloud.ts |
| `BYOK_BOARD_UNCLAIM_ROUTE` | `/byok/board/:id/unclaim` | cloud cloud.ts |
| `BYOK_BOARD_STATUS_ROUTE` | `/byok/board/:id/status` | cloud cloud.ts |
| `BYOK_RECORD_ROUTE` | `/byok/records/:kind/:key` | cloud cloud.ts (GET+PUT) |
| `BYOK_SKILL_PACK_FILE_ROUTE` | `/byok/skill-packs/:name/files/:path` | cloud cloud.ts |
| `BYOK_BLOB_FINALIZE_ROUTE` | `/byok/blobs/:id/finalize` | cloud; server http.ts |
| `BYOK_BLOB_URL_ROUTE` | `/byok/blobs/:id/url` | cloud; server http.ts |
| `BYOK_BLOB_CONTENT_ROUTE` | `/byok/blobs/:id/content` | cloud (PUT+GET); server http.ts (PUT+GET) |

Builder functions — reproduce each call site byte-for-byte:

| Builder | Behavior | Prior call sites |
|---|---|---|
| `byokRecordPath(kind, key)` | `encodeURIComponent` both segments | client truth-memory-client `recordPath` |
| `byokSkillPackFilePath(name, path)` | `encodeURIComponent` name + path | client skill-pack-installer |
| `byokBlobFinalizePath(blobId)` | `encodeURIComponent` (client-supplied id) | client blob-client `#finalize` |
| `byokBlobUrlPath(blobId)` | `encodeURIComponent` (client-supplied id) | client blob-client `resolveInstruction` |
| `byokBlobContentPath(blobId)` | NO encode (server-minted id) | cloud in-memory blobs; server blob-store; server sqlite-blob-store |

Counts: 14 static + 8 templates + 5 builders = 27 exported route symbols.

### Parameterized-route decision (template vs builder)

Routers mount the `:param` template form; clients build a concrete path with
`encodeURIComponent`. These are two different byte shapes for the same route, so
each parameterized route exports both a `*_ROUTE` template and a `byok*Path(...)`
builder. Builders faithfully reproduce the pre-existing encoding decisions rather
than normalizing them — notably `byokBlobContentPath` does NOT encode the id
(server-minted token; matches the reference stores' raw `${blobId}`), while
`byokBlobFinalizePath`/`byokBlobUrlPath` do encode (client-supplied id). Keeping
each as-was is what makes the presigned URLs and client requests byte-identical.

### Freeze-guard

`freeze-guard.test.ts` snapshots only the frozen envelope/message/http-body
schema fingerprints (an explicit schema allow-list), never the module's full
export surface, so adding route symbols cannot trip it. Verified zero-diff:
golden dir unchanged; `git diff --stat -- packages/protocol/src` additive only
(http-api.ts +94, index.ts +27, zero deletions).

### Byte-drift proof

`packages/protocol/src/__tests__/http-routes.test.ts` (new) asserts every
constant/builder equals its exact prior literal, expected strings spelled out in
full as an independent witness (incl. the encode/no-encode asymmetry). Plus a
repo grep: no hand-authored `/byok/*` literal remains in any package `src`
outside protocol's definition, except comments/JSDoc, test files, and the one
deliberate boundary exception below.

### Deliberate boundary exception (conformance)

`packages/conformance/src/simulator/harness.ts:174` keeps `path:
'/byok/capabilities'`. `@byok-sdk/conformance` does NOT depend on
`@byok-sdk/protocol` (deps: cloud/core/testkit); importing the constant would
invent a new dependency edge for a single test-assertion path — exactly the
falsifier the contract names. It is a conformance assertion literal (external
contract check), defensible as a fixture literal. Left as-is. Clean deferred
follow-up: add protocol to conformance deps and swap this one literal.

## Deviations From Plan Or Spec

**SCOPE FLAG — B-6(a) touched `packages/core`, which is outside the contract's
`allowed_paths`.** The task prompt names it ("core/attestation.ts already
centralizes siblings; move both to import from core"), but `allowed_paths` lists
only protocol/client/cloud/server/testkit/conformance. Files edited in core:
`attestation.ts` (add+export `DEVICE_PROOF_HEADER`), `index.ts` (re-export),
`__tests__/constraints.test.ts` (add the symbol to core's frozen public-export
list). The orchestrator must either widen `allowed_paths` to include
`packages/core/` or revert B-6(a). Surfaced, not silently widened.

## B-6 fold-in dispositions

- **(a) DEVICE_PROOF_HEADER — CONSOLIDATED.** Was `'x-byok-device-proof'`
  defined twice (client truth-memory-client.ts:15, cloud handlers/truth.ts:32).
  A wire header both sides must agree on — same drift class as routes. Authority
  moved to `core/attestation.ts` (already centralizes sibling proof constants),
  exported from core index; both client and cloud already depend on core (no new
  dep edge). Cloud's handlers/truth.ts imports from core and re-exports so
  cloud's public API is unchanged — single authority, no dual literal. See SCOPE
  FLAG above.
- **(b) base64url — LEFT.** cloud `crypto/web-crypto.ts` (public encode/decode
  pair in a dependency-free runtime-neutral WebCrypto port) vs testkit
  `identity.ts` (private encode-only helper). Encode bodies match, but this is an
  implementation primitive (not a wire contract requiring agreement; two correct
  copies cause no drift) living in intentionally self-contained modules.
  Consolidating adds a core export and couples both to it for a 4-line function —
  bloat vs the route work, low payoff. Left per "natural shared home without a
  new dep edge / opportunistic, don't bloat".
- **(c) dispatchSelection.runtimeId — LEFT.** client `task-runner.ts` vs server
  `hub.ts`. The only shared portion is a one-line `?? ` coalesce; the guard's
  failure semantics diverge fundamentally (client `decline`s with a retryable
  flag + client message; server `throw`s with a different message). Extracting
  over ~1 shared line with package-specific error paths is forced abstraction.
  No natural home. Left.

## Verification

- `pnpm --filter @byok-sdk/protocol test` — pass (freeze-guard + new byte-drift test).
- `pnpm -r run typecheck` — pass (all packages).
- `pnpm -r run test` — exit 0 (all packages). One client daemon-ownership-lease
  test is a known port/mutex flake under parallel load (passed 30/30 in
  isolation and on full re-run; unrelated to this diff).
- `pnpm -r run build` — pass (all packages).

## Open Questions

- Whether the orchestrator widens `allowed_paths` to include `packages/core/`
  for B-6(a), or reverts it. (See SCOPE FLAG.)

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
