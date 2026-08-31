# Implementation Notes: issue-107-tenant-quota

> **Status**: Active
> **Plan**: plans/plan-20260901-0253-issue-107-tenant-quota.md
> **Contract**: tasks/contracts/20260901-0253-issue-107-tenant-quota.contract.md
> **Review**: tasks/reviews/20260901-0253-issue-107-tenant-quota.review.md
> **Last Updated**: 2026-09-01 02:56
> **Lifecycle**: notes

## Design Decisions

- One controller-wide promise tail is the process-local tenant append authority for both reliable write variants.
- `spoolFor`, tenant-total observation, and physical append stay in the same critical section because opening a durable spool can change the aggregate authority.
- Sanitization remains before the tail; cursor allocation and per-Agent quotas remain inside the selected spool.
- A reservation ledger was rejected because it would duplicate spool-owned byte/identity authority and require commit/rollback reconciliation.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Controller-wide promise tail | selected | Smallest coherent linearization point for one controller. |
| In-memory reservation ledger | rejected | Creates a second byte authority and rollback protocol. |
| Shared transactional store | deferred | Needed only for a future multi-process tenant-writer contract. |

## Open Questions

- A write/sync failure with uncertain durability and an append queued across `deactivate()` are separate lifecycle/durability risks; they are recorded but not expanded into #107.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Pre-fix failure: `tasks/notes/20260901-0253-issue-107-tenant-quota.pre-fix.txt`
- Audit baseline `7a937e5ed8eb5aef102eacb0df9183f296da7e1f` failed both public cross-Agent races with two winners and `PRE_FIX_EXIT=1`.
- The isolated candidate passes the focused egress/home contract suite: 2 files, 32 tests.
- Client typecheck/build, exact diff whitespace check, and strict workflow check passed before root verification.
- Frozen-source root `bun run build`, `bun run typecheck`, and `bun run test` passed across every selected workspace package; client reported 1566 passed / 11 skipped.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
