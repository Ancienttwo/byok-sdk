> **Archived**: 2026-08-21 02:20
> **Related Plan**: plans/archive/plan-20260821-0215-todo-ledger-prune-2.md
> **Outcome**: Superseded
> **Lifecycle**: notes
> **Parent Run ID**: run-20260821-0220

# Implementation Notes: todo-ledger-prune-2

> **Status**: Complete
> **Plan**: plans/plan-20260821-0215-todo-ledger-prune-2.md
> **Contract**: tasks/contracts/20260821-0215-todo-ledger-prune-2.contract.md
> **Review**: tasks/reviews/20260821-0215-todo-ledger-prune-2.review.md
> **Last Updated**: 2026-08-21 02:15
> **Lifecycle**: notes

## Design Decisions

- Removed only three rows whose own evidence says there is no current consumer or triggering runtime shape: scheduled dispatch, assertion capability conditions, and session-level single-flight scheduling.
- Preserved all eleven rows backed by an observed gap in current code, deployment shape, protocol, or governance. In particular, configured MCP toolset IDs do not provide lifecycle health/reload; `RuntimeIdSchema` remains closed; `noteSkippedSeq` still advances outside `onEnvelope`/the hosted journal; tenant character ownership and `blobContentProxy` composition remain unresolved.
- Kept the reusable Hermes/Buzz patterns in `docs/researches/2026-08-12_hermes-buzz-extraction-assessment.md`; the deletion changes backlog commitment, not research history.

## Deviations From Plan Or Spec

- Count correction: the starting ledger contained fourteen deferred rows, not thirteen. The approved three-row deletion therefore leaves eleven rows; plan, contract, and verification were corrected before acceptance.
- `docs/spec.md` and `docs/architecture/sdk-architecture.md` already carried an uncommitted Bun 1.4 documentation projection produced after the prior `packageManager` pin. It is preserved and explicitly allowed, but is not evidence for deleting a Todo row.
- Completed archive was not claimed: `verify-sprint --prepare-acceptance` passed the contract but could not bind evidence because the active contract is uncommitted. The workflow is archived as Superseded rather than manufacturing a current AcceptanceReceipt.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Keep the three rows as deferred goals | Reject | No consumer or trigger exists; this turns external inspiration into an SDK commitment. |
| Delete the research | Reject | The research remains useful if a real trigger appears later. |
| Remove all speculative-looking rows | Reject | The other eleven name concrete current gaps and explicit revisit conditions. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Canonical external-pattern assessment: `docs/researches/2026-08-12_hermes-buzz-extraction-assessment.md` §§5–6.
- Current ledger: `tasks/todos.md` (eleven deferred rows after this batch).

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- None. The durable external-pattern analysis already exists in the canonical research file; duplicating it would create a second authority.
