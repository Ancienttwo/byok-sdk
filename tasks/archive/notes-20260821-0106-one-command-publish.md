> **Archived**: 2026-08-21 01:06
> **Related Plan**: plans/archive/plan-20260820-2324-one-command-publish.md
> **Outcome**: Superseded
> **Lifecycle**: notes
> **Parent Run ID**: run-20260821-0106

# Implementation Notes: one-command-publish

> **Status**: Active
> **Plan**: plans/plan-20260820-2324-one-command-publish.md
> **Contract**: tasks/contracts/20260820-2324-one-command-publish.contract.md
> **Review**: tasks/reviews/20260820-2324-one-command-publish.review.md
> **Last Updated**: 2026-08-21
> **Lifecycle**: notes

## Design Decisions

- Treat GitHub/npm/Salesko readbacks as release evidence, not as a substitute for the original contract's missing exact test and command evidence.
- Rebind to `ledger-closeout` with explicit `Workflow Profile: strict`; this supplies deterministic risk input and narrows write authority to closeout surfaces.
- Archive as `Superseded`, not `Completed`: the implementation/release remains real, but an AcceptanceReceipt is absent and must not be invented.

## Deviations From Plan Or Spec

- The original plan's post-landing test matrix is deliberately not rerun after publication.
- `--execute` is not rerun; this slice does not tag, publish, push, or deploy.
- Salesko `main@1877150` pins the public train and a fresh subject-bound `bun run check` on the unchanged SHA exits 0 with 1,643/1,643 tests, all typechecks/builds, byok-control 17/17, and local-agent 23/23. The older loader-time missing-export failure remains recorded as non-reproduced history rather than an asserted source-code root cause.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Reconstruct product acceptance | Reject | Historical contract requirements are invalid and have no receipt. |
| Archive as Completed | Reject | Completion would claim an acceptance authority that does not exist. |
| Archive as Superseded | Use | Product release evidence remains intact while stale workflow state is removed. |

## Open Questions

- None; this closeout has no open product-design decision.

## Evidence Links

- Research projection: `docs/researches/2026-08-12-salesko-consumption-evidence.md` §4A.
- Contract verification report: `.ai/harness/checks/contract-verify.latest.json` (derived, overwritten by the closeout check).

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
