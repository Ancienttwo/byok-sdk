# Implementation Notes: live-activity-timeline-pr3-ui-runtime

> **Status**: Active
> **Plan**: plans/plan-20260816-2045-live-activity-timeline-pr3-ui-runtime.md
> **Contract**: tasks/contracts/20260816-2045-live-activity-timeline-pr3-ui-runtime.contract.md
> **Review**: tasks/reviews/20260816-2045-live-activity-timeline-pr3-ui-runtime.review.md
> **Last Updated**: 2026-08-16 20:45
> **Lifecycle**: notes

## Design Decisions

- `@byok-sdk/cloud` remains the typed tail/schema authority and
  `@byok-sdk/protocol` remains the known/unknown event authority. The UI
  runtime imports both rather than copying DTOs or discriminants.
- Public state is immutable and stores one validated, ordered event set. Items
  and gaps are pure projections, so overlap and out-of-order incremental input
  converge without a second mutable correlation authority.
- Tool items stay at their earliest contributing event and pair only by native
  `toolCallId`. Missing IDs and unsupported approval observations remain
  explicit timeline items.
- Unknown events expose only identity/type classification. Their opaque payload
  is not projected into the view model.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Reducer inside `@byok-sdk/cloud` | Rejected | Storage/host ownership would absorb a separately consumable UI view-model boundary. |
| Incrementally mutate derived item maps | Rejected | The bounded tail makes deterministic reprojection simpler and makes out-of-order convergence structural. |
| Import cloud/protocol authorities | Adopted | Avoids duplicate schemas and keeps direct dependencies inside the BYOK release train. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Targeted reducer/constraint tests: 8/8 pass.
- Release graph: 8 dispatch manifests / 7 umbrella namespaces pass.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
