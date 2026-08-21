# Implementation Notes: host-cancellation-contract

> **Status**: Active
> **Plan**: plans/plan-20260821-1645-host-cancellation-contract.md
> **Contract**: tasks/contracts/20260821-1645-host-cancellation-contract.contract.md
> **Review**: tasks/reviews/20260821-1645-host-cancellation-contract.review.md
> **Last Updated**: 2026-08-21 16:45
> **Lifecycle**: notes

## Design Decisions

- `cancel_requested` is a hosted task-attempt delivery state, not a new frozen
  wire `TaskState`. Device protocol remains `task.cancel` / `task.cancelled`.
- `TaskCancellationStore.request()` is the sole atomic authority for the host
  tombstone and durable mailbox row. Both in-memory and PostgreSQL serialize
  cancel against claim/terminal state mutation rather than repairing two writes.
- Product terminal truth prefers an accepted cancellation tombstone. A late
  device terminal receipt may remain raw evidence but cannot advance the board.
- Long-poll scans past a fully filtered cancelled-offer page because the client
  advances from delivered envelope sequence numbers, not an empty response cursor.
- PostgreSQL idempotency retains the cancellation tombstone after an acknowledged
  mailbox row ages out; a missing delivery while still `cancel_requested` remains
  an integrity error.

## Deviations From Plan Or Spec

- No protocol source change was required: the live wire and client interruption
  contract already existed. The implementation added only the hosted attempt
  state/API/store/migration plus regression evidence.
- The real PostgreSQL pass added a second rollback fault after outbox insertion,
  direct tenant-isolation coverage, and acknowledged-delivery retention replay
  beyond the initial handoff matrix.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Separate task update and mailbox append | Rejected | Allows accepted-but-undeliverable cancellation. |
| Add wire message or process-kill API | Rejected | Existing client Session interrupt/close and frozen messages already carry the contract. |
| Return late success after accepted cancel | Rejected | Would create two terminal authorities and unsafe business projection. |
| Host-side repair/retry fallback | Rejected | Atomic mutation and fail-closed integrity errors keep one authority. |

## Open Questions

- External acceptance remains pending under the contract's frozen policy; local
  verification and internal review cannot substitute for it.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Cloud ordering/race matrix: `packages/cloud/src/__tests__/task-cancellation.test.ts`
- One-row filtered-offer cursor regression: `packages/cloud/src/__tests__/mailbox-cursor.test.ts`
- Client interrupt/quiescent-close integration: `packages/client/src/__tests__/real-cloud-longpoll.test.ts`
- PostgreSQL atomicity/parity: `packages/cloud-dataplane/src/__tests__/task-cancellation.test.ts`
- Migration catalog invariant: `tests/sql/control_plane_invariants.sql`
- Verified with pinned Bun 1.4.0: workspace build, typecheck, and test; targeted
  real PostgreSQL/MinIO cancellation plus invariants; deploy SQL order; strict
  task workflow.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
