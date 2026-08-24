# Implementation Notes: agent-home-idempotent-repair

> **Status**: Active
> **Plan**: plans/plan-20260824-1254-agent-home-idempotent-repair.md
> **Contract**: tasks/contracts/20260824-1254-agent-home-idempotent-repair.contract.md
> **Review**: tasks/reviews/20260824-1254-agent-home-idempotent-repair.review.md
> **Last Updated**: 2026-08-24 12:55
> **Lifecycle**: notes

## Design Decisions

- Preserve `apply` as a new-state lifecycle because the public 0.8.0 contract
  does not promise it is safe to replay. Add an explicit idempotent `ensure`
  lifecycle and a clearly named opt-in helper instead.
- Exact replay retains the public `idempotent` outcome. Ensure is a repair of a
  deterministic projection, not a new Profile revision.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Replay every existing `apply` | Rejected | Silently replays potentially non-idempotent host side effects. |
| Explicit idempotent `ensure` | Adopted | Additive, fail-closed opt-in with preserved ordering outcomes. |

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

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
