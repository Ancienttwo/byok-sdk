# Implementation Notes: s1-tenant-identity-cut

> **Status**: Active
> **Plan**: plans/plan-20260807-1720-s1-tenant-identity-cut.md
> **Contract**: tasks/contracts/20260807-1720-s1-tenant-identity-cut.contract.md
> **Review**: tasks/reviews/20260807-1720-s1-tenant-identity-cut.review.md
> **Last Updated**: 2026-08-07 18:40
> **Lifecycle**: notes

## Story → Commit Map

| Story | Commit | Content |
| --- | --- | --- |
| T-001/002/003/004/005 | `5dc1b3e` | `PairingCodeClaims {tenantId, productId}` required at mint; `redeemPairingCode(code): PairingCodeClaims`; `DeviceRecord` + required `tenantId/productId`; `AccessTokenClaims`/`AuthenticatedDevice` carry tenant/product/device; `authenticateBearer` does tenant-scoped composite-key lookup (claims are the key, the row is authority); WS hello gains device-row product equality on top of the static instance check; fixture claims sweep (35 files) |
| T-006 | `d248caf` | `NONCE_SIGNING_DOMAIN = 'byok-nonce-v1\n'` both ends: server `verifyNonceSignature` applies the prefix internally (raw signatures 401, no dual mode); client `device-keys.ts` `signNonce` signs prefixed bytes |
| T-008 | `c4495d0` | `tenant-pairing-isolation.test.ts` (~400 lines): I2/I5/I9 + S1.3 negative matrix incl. no-existence-oracle assertions and raw-vs-prefixed signature cases |
| T-007 | `515736d` | `examples/basic/server.ts` mints with explicit claims |
| scope amend | `decc49a` | contract widened to `packages/client/scripts/` (smoke scripts hit by the authorized API cut; `ipc-smoke` is a standalone CI job) |
| smoke + T-009 | (docs commits, see git log) | three smoke scripts pass claims; `docs/protocol.md` §6.1-6.3 re-pinned (domain-prefixed nonce), `docs/security.md` identity model + breaking note, architecture ledger closes GAP-004/GAP-005 |

## Design Decisions

- **Claims are lookup keys, never trusted input** (§12.6.2 layer 5): `authenticateBearer` looks up `(tenantId, deviceId)` as a composite key — a token claiming a tenant that does not own the device finds no row and gets the same 401 as an unknown device. No "naked lookup then compare" step exists.
- **`DeviceRegistry` left the public export surface entirely.** The challenge/token DTOs carry no tenant (by design — the device cannot self-report), so a deviceId-only resolution (`resolveByDeviceId`) must exist internally for those two pre-tenant endpoints. Keeping the class public while claiming "no naked lookup on public paths" would be a lie; the class was never injectable anyway. `DeviceRecord`/`AccessTokenClaims`/`TokenSigner` types stay exported; `TenantId`/`AuthenticatedDevice`/`PairingCodeClaims`/`PairingCodeInfo` are new exports. Verified against `dist/index.d.ts`.
- **`verifyEd25519Signature` became module-private**; the only exported verifier is `verifyNonceSignature`, which applies the domain prefix in one place — a route that accepts raw signatures is now unwritable, not just untested.
- **`isRevokedOrUnknown` deleted**: zero callers after the tenant-first reshape (challenge uses `resolveByDeviceId`; bearer needs the row itself to build the principal).
- **No `options?` on `createPairingCode`**: the sketched `CreatePairingCodeOptions` has no defined field anywhere in the repo; adding an empty bag is a placeholder, and adding it later is non-breaking.
- **Commit 1/2 of the dispatch merged**: token claims and tenant-first lookup are mutually dependent — an intermediate commit would neither compile nor run; the batch stays four commits, each independently green.
- **Nonce domain constant defined per-end with the same literal** (no shared package): S2's `@byok/core` is the future home; a cross-package import today would invert the dependency plan.

## Deviations From Plan Or Spec

- The API cut reached three `.mjs` smoke scripts outside the original allowed_paths; worker stopped per Stop Conditions, parent amended the contract (`decc49a`) — one-line claims fix each, no behavioral change.
- `pnpm -r run test` had one timing flake on first run (`long-poll.test.ts` hold-window assertion under 4-package parallel vitest load; the file's diff is import + claims params only); two subsequent full runs green. Known load-sensitive assertion, not introduced by S1.
- `packages/protocol/**` and `packages/keys/**` untouched (machine-checked: `git diff --exit-code main -- packages/protocol/`; `git diff --stat main -- packages/keys` empty).

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Optional/defaulted tenant during transition | Rejected | R-003 (偷渡); a default tenant is a shared-tenant vulnerability; repo forbids steady-state compatibility paths |
| Dual-mode nonce acceptance (raw + prefixed grace) | Rejected | Sprint S1.5 forbids it; unpublished packages need no grace; single verification path makes the dual mode unwritable |
| Keep `DeviceRegistry` exported with tenant-first methods only | Rejected | The pre-tenant endpoints force an internal deviceId-only resolver; exporting the class would re-open the naked-lookup public path S1.4 forbids |
| `keyId/keyEpoch` in principal now | Rejected | S6 proof-envelope semantics; would be permanently empty half-wired fields |

## Open Questions

- None blocking. Release note must state: S1 is a breaking pair/auth cut — all existing pairings invalidate, recovery is forced re-pair; nonce signature format switches in the same batch.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Worker-run evidence (after `515736d`): `pnpm -r run typecheck` 6/6 clean; `pnpm -r run test` protocol 328 / keys 189 / server 216 (25 files) / client 873 (89 files) all green; `pnpm -r run build` success; golden dir clean; `git diff --exit-code main -- packages/protocol/` clean. S1.3 matrix 11 cases + pairing suite 14 cases listed green in the worker report (verbose reporter lines captured there).
- Full-repo gates re-run by the acceptance chain (see checks file), not hand-claimed here.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- "Pre-tenant endpoints force an internal deviceId resolver; the honest move is shrinking the public surface, not annotating the naked path" — candidate for `tasks/lessons.md` if the same shape recurs in S2+ store ports.
