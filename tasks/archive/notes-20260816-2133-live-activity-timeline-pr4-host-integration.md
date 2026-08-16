> **Archived**: 2026-08-16 21:33
> **Related Plan**: plans/archive/plan-20260816-2112-live-activity-timeline-pr4-host-integration.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260816-2133

# Implementation Notes: live-activity-timeline-pr4-host-integration

> **Status**: Active
> **Plan**: plans/plan-20260816-2112-live-activity-timeline-pr4-host-integration.md
> **Contract**: tasks/contracts/20260816-2112-live-activity-timeline-pr4-host-integration.contract.md
> **Review**: tasks/reviews/20260816-2112-live-activity-timeline-pr4-host-integration.review.md
> **Last Updated**: 2026-08-16 21:32
> **Lifecycle**: notes

## Design Decisions

- Keep PR4 in a private example because the repository has no SaaS user identity
  authority. The example injects authenticate/authorize rather than presenting
  device auth as browser auth.
- Use a standard Fetch handler and conditional GET over the bounded cursor. A
  required `representationRevision` joins the ETag authority so redaction or
  presentation policy rollouts invalidate old browser representations.
- Redact typed events before `replayTimeline`; re-parse the redactor output and
  reject changes to identity, order, type, tool correlation, or native outcome.
- Pass only the sanitized `TaskTimelineSnapshot` to the presentation callback.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Public host auth package | Reject | No second real host or identity provider proves a reusable authority. |
| Device-authenticated cloud GET | Reject | A device credential is not a SaaS user/task authorization. |
| SSE | Defer | Conditional polling is sufficient for the existing bounded tail and avoids an unproven stream lifecycle. |
| `toThreadMessageLike()` | Omit | It is optional and no real host consumer proves that presentation contract. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Delivery: PR #75 merged to `main` as `2b15d45e739a2d5b396c8d503f80289d96453d12` after 42/42 GitHub checks passed.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
