# Implementation Notes: agent-home-idempotent-repair

> **Status**: Active
> **Plan**: plans/plan-20260824-1254-agent-home-idempotent-repair.md
> **Contract**: tasks/contracts/20260824-1254-agent-home-idempotent-repair.contract.md
> **Review**: tasks/reviews/20260824-1254-agent-home-idempotent-repair.review.md
> **Last Updated**: 2026-08-24 12:55
> **Lifecycle**: notes

## Design Decisions

- `docs/host-local-storage-layout.md` already requires the product hook to own
  an atomic/idempotent write. Reuse `apply` as the exact desired-state ensure;
  do not add a second lifecycle or helper.
- Exact replay retains the public `idempotent` outcome. Re-apply is a repair of a
  deterministic projection, not a new Profile revision.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Explicit second `ensure` API | Rejected | Duplicates an invariant already required by host-storage docs. |
| Re-run documented idempotent `apply` | Adopted | Smallest fix; no public API or downstream composition change. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Downstream guard source: Salesko `0ee5537`,
  `apps/local-agent/src/private-agent-profile-reconciliation.falsifier.ts`,
  sha256 `d9ca7aeff0136354fdcf8cc93c279f89e442cf14a59bf1caa048339fe63da56a`.
- Captured downstream failure: expected `applied`, received `idempotent`, with
  `profile.json` absent and `PHASE_2_EXIT=1`; the corrected semantic expectation
  is `idempotent` plus restored opaque product bytes.
- Upstream regression artifact records the real pre-fix `ENOENT` after the
  exact replay returned idempotent without recreating the derived file. The
  focused fixed guard covers product-only loss, whole-home loss, hook failure
  with unchanged ordering state, and serialization against an execution lease.
- Existing ordering/daemon coverage was updated so exact replay invokes the
  consumer, while stale/conflict remain hook-free and restart redelivery still
  keeps completion/cursor behind the local lifecycle.
- Source freeze gates pass: full repository build, sequential typecheck and full
  tests; client reports 1,394 passing tests including the four new repair guards.
  Release graph closes the aligned dispatch train at 0.8.1 and keys at 0.3.2.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
