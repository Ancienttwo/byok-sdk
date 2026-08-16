# Implementation Notes: live-activity-timeline-pr2-typed-activity-projection

> **Status**: Active
> **Plan**: plans/plan-20260816-1958-live-activity-timeline-pr2-typed-activity-projection.md
> **Contract**: tasks/contracts/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.contract.md
> **Review**: tasks/reviews/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.review.md
> **Last Updated**: 2026-08-16 20:17
> **Lifecycle**: notes

## Design Decisions

- `@byok-sdk/core` remains protocol-free; activity DTO/store ownership moved to
  `@byok-sdk/cloud`, the existing common dependency boundary for core + protocol.
- `TimelineEventSchema` is the typed JSONB authority. Postgres reads parse it
  directly and reject pre-cutover `{ at, detail }` rows; no shape detector or
  translator exists.
- `sourceEnvelopeId` is identity authority, while `(taskId,batchSeq,eventIndex)`
  is order/cursor authority. Inbound validates the payload sequence before
  recording dedup state.
- The Postgres upsert keeps its single-statement row-lock serialization and now
  sorts the combined JSONB tail before capacity trimming.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Keep activity in core | Rejected | It would create the forbidden `core -> protocol` dependency. |
| Add a parallel typed store | Rejected | Dual writes/readers would preserve two semantic authorities. |
| Translate old JSONB rows | Rejected | Activity is TTL-bounded; a stop-writer + TTL drain is the explicit migration. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Shared in-memory conformance: 5/5 passed.
- Real Postgres activity conformance + legacy-row rejection + 100-writer burst
  passed with `BYOK_REQUIRE_DATAPLANE=1`.
- Final strict contract verification: 18/18 passed, including build, typecheck,
  the full workspace test suite against real Postgres/MinIO, and strict workflow.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
