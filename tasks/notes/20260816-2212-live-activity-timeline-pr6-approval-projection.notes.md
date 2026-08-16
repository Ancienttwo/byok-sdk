# Implementation Notes: live-activity-timeline-pr6-approval-projection

> **Status**: Active
> **Plan**: plans/plan-20260816-2212-live-activity-timeline-pr6-approval-projection.md
> **Contract**: tasks/contracts/20260816-2212-live-activity-timeline-pr6-approval-projection.contract.md
> **Review**: tasks/reviews/20260816-2212-live-activity-timeline-pr6-approval-projection.review.md
> **Last Updated**: 2026-08-16 22:19
> **Lifecycle**: notes

## Design Decisions

- Approval projection is a sibling pure fold, not a branch of the activity fold. It consumes only `ApprovalTimelineTail` revision authority and exports separate snapshot/types.
- Native `approvalId` is the only correlation key. Missing request IDs and unmatched resolutions become explicit items; no `toolCallId`, adjacency, or text heuristic is present.
- Tail replay validates strictly increasing revisions and exact cursor agreement. Incremental event folding accepts out-of-order arrival, sorts by revision, and converges with replay.
- The host reads both bounded tails only after one authorization binding, redacts each before folding, and presents two separate snapshots. Activity remains route-existence authority; absence of an approval row projects an empty approval snapshot.
- Approval redaction may replace request summary content but must preserve source identity, revision, event type, native ID, decision, resolver, and resolution time.

## Deviations From Plan Or Spec

- The plan's shorthand said presentation receives `{ activity, approvals }`; the host makes `approvals` a concrete empty snapshot when the store has no row. This is the deterministic projection of no observed approval authority, not a retention or lifecycle fallback.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Merge approval into activity fold | Rejected | No authoritative cross-stream order exists. |
| Make approval snapshot optional | Rejected | Every authorized activity response can expose a stable empty read model without inventing an approval. |
| Correlate missing IDs by order/summary | Rejected | Would synthesize semantic authority and can pair unrelated approvals. |
| Pure sibling fold with required host read/redactor | Selected | Keeps one deterministic projection and one host security boundary. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Targeted `@byok-sdk/ui-runtime`: 3 files / 15 tests passed; build and typecheck passed.
- Targeted `@byok-sdk/example-live-activity-host`: 1 file / 21 tests passed; typecheck passed.
- Full workspace `bun run build` and `bun run typecheck` passed before subject freeze.
- Final strict contract: 15/15 exit criteria passed, including the full workspace test suite and strict workflow check.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
