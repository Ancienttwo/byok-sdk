# Implementation Notes: longpoll-auth-parity

> **Status**: Active
> **Plan**: plans/plan-20260813-2106-longpoll-auth-parity.md
> **Contract**: tasks/contracts/20260813-2106-longpoll-auth-parity.contract.md
> **Review**: tasks/reviews/20260813-2106-longpoll-auth-parity.review.md
> **Last Updated**: 2026-08-13 21:15
> **Lifecycle**: notes

## Design Decisions

- **The asymmetry.** `conn.hello` (`ws-server.ts:104-128`) compares the announced `productId` against both the server instance and the device row, so a WS device transitively proved `row.productId == instance.productId`. Every bearer-authed HTTP route (`GET /byok/events`, `POST /byok/messages`, and the blob routes) went through `authenticateBearer` alone, which only ever asked `row == claims`. A single server can mint pairing codes for any product (`createPairingCode` takes the claims per code), so a device paired through a foreign-product code held a genuine, instance-signed token that WS refused with `productId mismatch` while HTTP let it poll events, inject envelopes into the hub, and reserve blobs.

- **The ruling — instance equality is authentication, not routing.** The fourth check goes inside `authenticateBearer` (`auth.ts`), not into each route: `if (device.productId !== deps.productId) return undefined;`. Same silent `undefined` as every other failure, so the 401 stays byte-identical to the unknown / wrong-tenant / revoked answers and no route can turn it into a cross-product existence oracle. Putting it in the shared function is what makes the fix cover the whole class at once — long-poll, blobs, and the WS upgrade's own pre-hello auth — instead of three route-local checks the next route would forget. `AuthDeps` grows a `productId`, wired from `opts.productId` at the single assembly point in `index.ts`; `AttachDeps` keeps its own `productId` because the hello gate reads it for a different fact.

- **Three facts, not one.** Row vs claims says "the token belongs to this row". Row vs instance says "this row belongs to the product this server serves". `conn.hello`'s checks validate the client's ANNOUNCEMENT, which is neither, and stay where they are — the contract froze `ws-server.ts` at zero diff.

- **Red-first evidence.** `packages/server/src/__tests__/bearer-instance-product.test.ts` run against the unfixed code, artifact at `/private/tmp/claude-501/-Users-kito-Projects-byok-sdk/1e383a1a-c63e-4756-be40-ce6e415edc85/scratchpad/bearer-parity-red.txt` (`PRE_FIX_EXIT=1`): all three routes answered 200 for a cross-product token, and `authenticateBearer` handed back a principal for a foreign row. The same-product case passed in that same run, which is what makes the red a defect capture rather than a broken fixture.

## Deviations From Plan Or Spec

- **One existing test was adapted to the new enforcement point** (`tenant-pairing-isolation.test.ts:290`), on the parent's ruling after the executor stopped and reported the break. Old title: *"refuses a hello whose productId disagrees with the device row, before registering the connection"*. New title: *"refuses the upgrade for a device row outside the instance product, before any hello"*. Its intent is unchanged — a cross-product device row never reaches the hub — but the enforcement moved one step earlier. It used to pair into `OTHER_PRODUCT_ID`, let the upgrade succeed, and observe close code 1002 from the hello gate; `authenticateBearer` now refuses the upgrade itself, so the rewritten case asserts a 401 upgrade (no 101, no hello exchange) plus the original "no registered connection for that deviceId" check. The announcement-mismatch path (same-product row, wrong announced `productId` → 1002) is untouched and still covered at `integration.test.ts:391`.

- **`stopServer` (`test-support.ts:41`) now calls `closeAllConnections()` before `close()`, swept there rather than into this slice's suite.** The guard suite passed under vitest but timed out its teardown hook under `bun test`: every `authenticateBearer` 401 short-circuits ahead of `readJsonBody`, so a rejected POST's body is never read, and under bun's `node:http` that connection is never counted idle again — `close()`'s callback never fires. Probed with the pin isolated: a rejected GET (no body) and a 401 whose body IS read both close in 0ms; `Connection: close` does not help. The exposure belongs to every server suite that asserts a rejection (`tenant-pairing-isolation.test.ts` was failing 8/11 in 30s under bun for the same reason, now 7 pass in 0.12s), and the shared fixture is the one home for it — which also de-risks the queued pnpm→bun migration, since that migration would otherwise hit this across the server suites at once.

- **`ws-server.ts:121` (hello's row-vs-announcement check) is now structurally unreachable and deliberately kept.** After the fix `row == instance` always holds, and the hello gate already required `payload == instance`, so `payload == row` follows. It stays as belt-and-braces — defense in depth against a future regression in `authenticateBearer` — and because this slice froze `ws-server.ts` at zero diff. Retire it only in a slice that owns that file.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Per-route instance check in `http.ts` | Rejected | Five call sites to keep in sync and no coverage for the WS upgrade; the next authed route added would silently miss it. |
| Distinguishable 401 (e.g. `{error:'wrong_product'}`) | Rejected | Would tell an unauthenticated caller which product this instance serves and whether a device row exists elsewhere — exactly the oracle `authenticateBearer`'s existing failure shape was built to deny. |
| Add a `protocolVersions` announcement to long-poll | Rejected — explicit waiver | Each long-poll request is standalone; every envelope already passes `EnvelopeSchema` plus `hub.handleInbound`'s gate, so skew surfaces per envelope at the point it would actually break something. An announcement header would only add a field whose sole purpose is to be validated, and a device lying in it would still be caught envelope by envelope. Documented at the §8 section header in `http.ts`. |
| Fix `packages/cloud/src/auth/bearer.ts` in the same slice | Deferred to the ledger | Hosted deployments' instance-product authority is a different (possibly multi-product) shape; copying the check would freeze an undecided deployment form. |

## Open Questions

- Whether a hosted `@byok-sdk/cloud` deployment has a single instance-product authority at all. The ledger entry carries the trigger: next cloud auth slice, or the first hosted deployment serving more than one product.

## Evidence Links

- Pre-fix red run: `/private/tmp/claude-501/-Users-kito-Projects-byok-sdk/1e383a1a-c63e-4756-be40-ce6e415edc85/scratchpad/bearer-parity-red.txt` (`PRE_FIX_EXIT=1`)
- Guard: `packages/server/src/__tests__/bearer-instance-product.test.ts` — 4 passed post-fix
- `pnpm -r run typecheck` — exit 0
- `pnpm --filter @byok-sdk/server run test` — 238 passed / 29 files, 0 failed (after adapting `tenant-pairing-isolation.test.ts`; see Deviations)
- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Held, one occurrence only: a transitive guarantee on one transport is not a repo-wide guarantee. The WS hello gate made `row == instance` look enforced everywhere for as long as WS was the transport people reviewed. Promote after a second instance of the same shape.
