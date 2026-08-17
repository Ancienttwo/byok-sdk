# Implementation Notes: device-assertion-authenticator

> **Status**: Complete
> **Plan**: plans/plan-20260817-1205-device-assertion-authenticator.md
> **Contract**: tasks/contracts/20260817-1205-device-assertion-authenticator.contract.md
> **Review**: tasks/reviews/20260817-1205-device-assertion-authenticator.review.md
> **Last Updated**: 2026-08-17 12:40
> **Lifecycle**: notes

## Design Decisions

- Device assertion is a short-lived, single-use exchange credential for a
  host-owned connector binding; it is never the long-lived connector session.
- The SDK authenticator owns exact issuer/product/audience binding, current-row
  identity/revocation, and atomic JTI consumption. Provider OAuth refresh
  credentials and connector profile/session storage remain host-owned.
- The port is named `DeviceAssertionReplayAuthority`, not `*Store`: core's
  executable constraints reserve every exported `*Store` interface for the
  tenant-first `CoreStores` composition. This authority is injected only into
  assertion exchange and does not widen `CoreStores`.
- The first durable adapter is Postgres because the existing assertion contract
  presents assertions to the host cloud. SQLite remains deferred until a real
  device-local verifier exists.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Per-connector verification | Rejected | Duplicates a security authority and permits missing deployment/replay checks. |
| Assertion as long-lived bearer | Rejected | Contradicts the bounded TTL and creates revocation/cache authority outside the daemon. |
| Core authenticator + injected replay authority | Selected | Keeps runtime neutrality without violating the `CoreStores` inventory invariant. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Core: 251 tests passed, including exact deployment binding, row-derived
  principal, replay, concurrent single-use, cleanup, and replay outage.
- Cloud: 171 tests passed, including hosted directory/crypto composition and
  the host-owned binding ordering/failure boundary.
- Real Postgres: `device-assertion-replay.test.ts` passed 4 tests against the
  Docker substrate, including 64 concurrent full exchanges with exactly one
  authenticated principal plus shared replay conformance and bounded cleanup.
- Independent gatekeeper: PASS against frozen normalized subject
  `sha256:d89865df0995a80c924007557d6856afd71a9b185647eb46c1e051af76cefed6`;
  no findings. Typed AcceptanceReceipt protocol 2 recorded as `external_pass`
  with verification evidence
  `sha256:c969d0f3c4fba24e455877eede456be2002803c373eef91324f930779eca57ee`.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
