# Implementation Notes: release-0-11-agent-foundations

> **Status**: Active
> **Plan**: plans/plan-20260830-1915-release-0-11-agent-foundations.md
> **Contract**: tasks/contracts/20260830-1915-release-0-11-agent-foundations.contract.md
> **Review**: tasks/reviews/20260830-1915-release-0-11-agent-foundations.review.md
> **Last Updated**: 2026-08-30 19:16
> **Lifecycle**: notes

## Design Decisions

- Compose from two already accepted local branches; do not treat either branch's standalone package projection as the final release authority.
- Reuse `d8e36b6` as the version-train input, then verify its manifests and lockfile against the combined final source.
- Run exact `pack-and-smoke` once after the combined source is frozen; publication and registry readback remain separate gates.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Re-bump versions manually on the foundations branch | Rejected | It would create a second 0.11.0 release authority and risk divergence from the accepted memory train. |
| Merge the accepted memory/release line into an isolated composition branch | Selected | It preserves source ancestry and gives the combined candidate one verifiable identity without touching main or external state. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
