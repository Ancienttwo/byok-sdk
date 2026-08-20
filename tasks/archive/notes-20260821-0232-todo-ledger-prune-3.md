> **Archived**: 2026-08-21 02:32
> **Related Plan**: plans/archive/plan-20260821-0228-todo-ledger-prune-3.md
> **Outcome**: Superseded
> **Lifecycle**: notes
> **Parent Run ID**: run-20260821-0232

# Implementation Notes: todo-ledger-prune-3

> **Status**: Active
> **Plan**: plans/plan-20260821-0228-todo-ledger-prune-3.md
> **Contract**: tasks/contracts/20260821-0228-todo-ledger-prune-3.contract.md
> **Review**: tasks/reviews/20260821-0228-todo-ledger-prune-3.review.md
> **Last Updated**: 2026-08-21 02:28
> **Lifecycle**: notes

## Design Decisions

- Removed four solution-shaped rows whose own revisit triggers remain unmet.
- Kept seven rows tied to current MCP authorization/operability, hosted auth,
  documentation drift, forward-protocol journaling, tenant identity, or cloud
  composition gaps.
- Historical design evidence remains in archived Todo snapshots and research;
  the active ledger no longer serves as its duplicate index.

## Deviations From Plan Or Spec

- `verify-sprint --prepare-acceptance` passed all eight contract checks but
  correctly refused SHA-bound evidence because the contract is uncommitted.
  Closeout therefore must use `Superseded`, matching the prior ledger-only
  cleanup, instead of claiming release-grade external acceptance.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Keep all four as deferred commitments | Reject | No current consumer crossed their stated triggers. |
| Implement one of the four proactively | Reject | That would create protocol/process/storage abstractions without demand evidence. |
| Remove from active ledger, retain archive/research | Accept | Preserves recall without manufacturing priority. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Runtime IDs remain closed at `packages/protocol/src/messages.ts:17`; current
  downstream uses the built-in Claude runtime and no non-built-in consumer was found.
- MCP configuration remains a single private Gmail-style example; Salesko's
  long-running local-agent does not configure `mcpToolsets`, so browser/LinkedIn
  dogfood and second-stdio-connector triggers are absent.
- `SqliteLocalTaskJournal` remains the shipped crash-safe implementation; no
  host requesting structured Git-backed history was found.
- Device and skill-pack audit files exist, but no enterprise retention/query
  consumer or shared immutable-query contract was found.
- Recovery source for all four rows:
  `tasks/archive/todo-20260821-0220-todo-ledger-prune-2.md`.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- None. The durable evidence already exists in archived Todo snapshots and
  current source comments; another summary would create duplicate authority.
