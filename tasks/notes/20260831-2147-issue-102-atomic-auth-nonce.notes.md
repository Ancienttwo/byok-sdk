# Implementation Notes: issue-102-atomic-auth-nonce

> **Status**: Active
> **Plan**: plans/plan-20260831-2147-issue-102-atomic-auth-nonce.md
> **Contract**: tasks/contracts/20260831-2147-issue-102-atomic-auth-nonce.contract.md
> **Review**: tasks/reviews/20260831-2147-issue-102-atomic-auth-nonce.review.md
> **Last Updated**: 2026-08-31 22:16
> **Lifecycle**: notes

## Design Decisions

- Replace the hosted `NonceStore.validate` / `markUsed` pair with one
  `consumeIfValid(tenant, deviceId, nonce)` authority. The port inventory,
  in-memory adapter, Postgres adapter, AuthPlane, handler, and conformance suite
  cut over together; no compatibility alias remains.
- Preserve `resolve device -> verify domain-separated signature -> atomic
  consume -> mint` so an invalid signature cannot burn a legitimate nonce and
  only the store-selected winner can mint.
- Implement Postgres arbitration as one guarded `UPDATE ... RETURNING` over the
  exact tenant, device, nonce, unused state, and injected-clock expiry predicate.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Store-native atomic mutation | selected | It keeps the data authority at the row and remains correct across processes and pools. |
| Handler/controller mutex | rejected | It cannot arbitrate multiple processes or durable adapters. |
| Validate then compensate/rollback | rejected | It preserves the race and creates a second mutation authority. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Pre-fix route failure: `tasks/notes/20260831-2147-issue-102-atomic-auth-nonce.pre-fix.log`
- Focused cloud route/store tests: 19 passed.
- Full cloud tests: 237 passed.
- In-memory conformance: 59 passed.
- Real disposable Postgres nonce guard with `BYOK_REQUIRE_DATAPLANE=1`: 2 passed,
  including two store instances over separate pools racing the same nonce.
- Cloud, cloud-dataplane, and conformance typechecks; cloud and
  cloud-dataplane builds; root build/typecheck; strict workflow check; and
  `git diff --check`: passed.
- Independent gatekeeper re-review after removing the test-only contract cast:
  PASS with no P0-P3 findings.
- `verify-sprint --prepare-acceptance` fulfilled all 30 contract checks, but
  evidence binding correctly stopped because the active contract is still
  untracked/uncommitted; no commit authority was inferred from implementation
  approval.
- The disposable compose stack was removed and Colima returned to its initial
  stopped state after verification.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
