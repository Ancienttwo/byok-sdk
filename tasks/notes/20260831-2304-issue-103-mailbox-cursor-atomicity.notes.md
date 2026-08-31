# Implementation Notes: issue-103-mailbox-cursor-atomicity

> **Status**: Complete
> **Plan**: plans/plan-20260831-2304-issue-103-mailbox-cursor-atomicity.md
> **Contract**: tasks/contracts/20260831-2304-issue-103-mailbox-cursor-atomicity.contract.md
> **Review**: tasks/reviews/20260831-2304-issue-103-mailbox-cursor-atomicity.review.md
> **Last Updated**: 2026-08-31 23:47
> **Lifecycle**: notes

## Design Decisions

- Add required `MailboxStore.recordDelivery` and persist `deliveredSeq`
  beside `ackedSeq`. Mailbox reads remain pure; only the authenticated events
  route records the exact cursor it is about to return.
- Make both store implementations serialize delivery and acknowledgement on
  the per-device authority. Postgres keeps acknowledgement selection and
  outbox marking in one guarded CTE statement requiring
  `acked_seq <= requested <= delivered_seq`.
- Add forward-only migration `0016`: existing acknowledged positions are the
  only safe backfill authority, so `delivered_seq` starts from `acked_seq`
  before the database constraint `acked_seq <= delivered_seq` is installed.
- Reject client cursors outside the JavaScript safe-integer range with 400;
  reject a safe future cursor with 409 and no mailbox mutation.

## Deviations From Plan Or Spec

- The first independent gate found that the original Postgres statement used
  sibling data-modifying CTEs for row creation and cursor movement. PostgreSQL
  gives those siblings the same statement snapshot, so a zero acknowledgement
  could not see the newly inserted stream row. The statement now uses mutually
  exclusive `moved_zero` (guarded upsert) and `moved_positive` (guarded update)
  branches and unions only their returned row. This keeps row creation, cursor
  movement, and outbox marking inside one atomic statement without relying on
  sibling-CTE visibility.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Server-owned delivery watermark | selected | It distinguishes returned cursors from merely enqueued sequence values across processes. |
| Derive the bound from `next_seq` / max outbox seq | rejected | Enqueue is not delivery and would preserve the forged-ack gap. |
| Handler-local mutex or token | rejected | It cannot arbitrate multiple cloud processes and would add a second authority. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Pre-fix failure: `tasks/notes/20260831-2304-issue-103-mailbox-cursor-atomicity.pre-fix.txt`
- Clean-base root-cause run: 15 focused route tests, 14 pass / 1 expected
  failure; forged `Number.MAX_SAFE_INTEGER` returned 200; tracked artifact
  records `PRE_FIX_EXIT=1`.
- Fixed focused route: 15/15 pass.
- In-memory core: 252/252 pass; root conformance: 145/145 pass.
- Corrected composition conformance: in-memory core 71/71 and real disposable
  Postgres core 71/71, including the missing-row zero-cursor case identified by
  the first independent gate.
- Real disposable Postgres: 72/72 across cloud conformance, cleanup, and catalog
  invariants, including future-ack no-mutation and zero-cursor parity.
- Corrected focused route 15/15, cloud-dataplane typecheck, and
  `git diff --check`: pass.
- Strict contract verification: 33/33 criteria fulfilled; strict task-workflow
  check passed. The contract now names runnable test entrypoints and carries
  the disposable Postgres/S3 environment required for fail-closed dataplane
  execution.
- Independent re-gate: PASS with no P0-P3 finding. The reviewer reran real
  Postgres core 71/71, route 15/15, in-memory core 71/71, and real Postgres
  cloud/cleanup/catalog 72/72; root typecheck, build, deploy SQL, strict
  workflow, and diff checks also passed.
- Root `bun run build`, `bun run typecheck`, and `bun run test`: pass.
  The first full test hit the Wrangler dry-run's fixed 5-second cold timeout;
  the unchanged targeted test passed 6/6 when warm, and the complete rerun
  passed.
- No production migration was applied. Only the forward migration source was
  exercised against disposable Postgres.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
