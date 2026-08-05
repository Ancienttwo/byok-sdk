# Implementation Notes: port-shadowing-fixture

> **Status**: Active
> **Plan**: plans/plan-20260805-2057-port-shadowing-fixture.md
> **Contract**: tasks/contracts/20260805-2057-port-shadowing-fixture.contract.md
> **Review**: tasks/reviews/20260805-2057-port-shadowing-fixture.review.md
> **Last Updated**: 20260805-2057
> **Lifecycle**: notes

## Design Decisions

- Pinned `hostname: '127.0.0.1'` on the four hostname-less `serve({ port: 0 })` fixture calls rather than changing the URLs the fixtures hand out. The URLs are already `127.0.0.1` everywhere (including the WS urls in `test-support.ts:172`), and repo precedent — `packages/client/src/__tests__/fixtures/test-server.ts:103` — already binds `listen(0, '127.0.0.1')`. Binding what we dial is the smaller and more consistent change.
- Introduced a single `LOOPBACK` constant in `packages/client/src/__tests__/fixtures/real-server.ts` so the three fixture variants bind and dial one value instead of three literals paired with three separate template strings. `packages/server/src/__tests__/test-support.ts` has only one bind site, so it keeps the literal and carries the explanation in `startServer`'s doc comment.
- Promoted only the first of the two draft guard tests from `packages/server/_ops/guard/port-shadowing.guard.ts`. The second stands up a decoy `127.0.0.1` listener to demonstrate the shadowing mechanism; it passes both before and after the fix, so it is a witness rather than a gate, and a permanent suite should not pay its cost on every run. The gitignored draft stays in `_ops/` untouched.

## Deviations From Plan Or Spec

- The plan cited `/tmp/byok-diag/pre-fix-port-shadowing.log` (the diagnosis pass's own capture against the draft guard) as `pre_fix_failure_artifact`. The bugfix gate requires the artifact to contain the `regression_guard` path string, and the draft capture names `_ops/guard/port-shadowing.guard.ts`. Recaptured as `/tmp/byok-diag/pre-fix-port-shadowing-guard.log` by reverting the `hostname` addition, running `npx vitest run --root . packages/server/src/__tests__/port-shadowing.test.ts`, and restoring the fix — `PRE_FIX_EXIT=1`, received `"::"` against the expected `"127.0.0.1"`.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Dial `localhost` instead of pinning the bind | Rejected | Resolver order is machine-dependent, so the v4/v6 ambiguity moves rather than disappears |
| Retry pairing on 401 | Rejected | A compatibility fallback that hides an address-family defect behind flakiness |
| Also narrow the `serve()` calls in `examples/` and `templates/` | Rejected | Real deployments need wildcard binding; those are not fixtures |

## Open Questions

- None.

## Evidence Links

- Pre-fix failure: `/tmp/byok-diag/pre-fix-port-shadowing-guard.log` (`PRE_FIX_EXIT=1`)
- Guard: `packages/server/src/__tests__/port-shadowing.test.ts`
- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Candidate for `tasks/lessons.md` if it recurs: a test fixture that binds one address family and dials another fails as an auth error, not as a network error, so the symptom points away from the cause. Held here until a second instance appears.
