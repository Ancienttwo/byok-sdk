# Implementation Notes: live-activity-timeline-pr5-approval-authority

> **Status**: Active
> **Plan**: plans/plan-20260816-2138-live-activity-timeline-pr5-approval-authority.md
> **Contract**: tasks/contracts/20260816-2138-live-activity-timeline-pr5-approval-authority.contract.md
> **Review**: tasks/reviews/20260816-2138-live-activity-timeline-pr5-approval-authority.review.md
> **Last Updated**: 2026-08-16 21:52
> **Lifecycle**: notes

## Design Decisions

- Approval lifecycle is a separate bounded observation stream. Its monotonic
  `revision` is assigned per tenant/task by the store and has no ordering
  relation to ActivityTail batch/event keys.
- Both stores retain exact native request/resolution fields and use
  `sourceEnvelopeId` as idempotency identity. Reusing one source ID for
  different event content fails closed.
- Capacity is 50, TTL is 10 minutes, and approval request summaries are capped
  at 16 KiB UTF-8 so the JSONB row is bounded by both count and payload size.
- The Postgres store serializes even first concurrent inserts with a
  transaction-scoped advisory lock before row locking/allocation.
- The real inbound gate validates persistence input before recording dedup,
  then appends only after rate-limit/type/ownership checks.

## Deviations From Plan Or Spec

- The approved draft proposed tightening existing wire-v1 `approvalId` strings
  to nonblank. `docs/protocol.md` explicitly classifies in-place constraint
  tightening as a breaking change requiring protocol v2. PR5 therefore keeps
  protocol and golden byte-for-byte unchanged and enforces nonblank identity at
  the new cloud persistence boundary. This preserves the V1 train without
  accepting malformed persisted authority.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Append approvals to ActivityTail | Rejected | No shared authoritative order key exists across progress and approval envelopes. |
| One row per observation | Rejected for V1 | The only read is a complete bounded tail; a row-per-event table adds query/trim cost without a consumer. |
| JSONB tail + store revision | Selected | Smallest independently usable read authority and replaceable behind the port if a hot task becomes contentious. |
| Tighten frozen wire v1 | Rejected | Would require protocol v2 for a constraint change to an existing field. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Targeted cloud: 13 files / 167 tests passed.
- Targeted conformance: 3 files / 135 tests passed.
- Postgres/MinIO dataplane: 19 files passed, 258 tests passed, 4 pre-existing
  conditional skips; approval conformance and cleanup integration passed.
- `bun run build`, `bun run typecheck`, and `bun run check:deploy-sql` passed
  before subject freeze.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
