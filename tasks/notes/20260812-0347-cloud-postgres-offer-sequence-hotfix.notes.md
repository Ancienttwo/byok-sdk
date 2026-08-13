# Implementation Notes: cloud-postgres-offer-sequence-hotfix

> **Status**: Active
> **Plan**: plans/plan-20260812-0347-cloud-postgres-offer-sequence-hotfix.md
> **Contract**: tasks/contracts/20260812-0347-cloud-postgres-offer-sequence-hotfix.contract.md
> **Review**: tasks/reviews/20260812-0347-cloud-postgres-offer-sequence-hotfix.review.md
> **Last Updated**: 2026-08-12 11:41
> **Lifecycle**: notes

## Design Decisions

- `MailboxStore.append` is the single sequence authority. Its
  `materialize(seq)` callback lets a protocol-aware producer encode the opaque
  envelope without adding a core-to-protocol dependency.
- Allocation, materialization, and insert are serialized per device. Postgres
  holds the `device_stream` row lock in one transaction; in-memory chains a
  per-device promise tail.
- The public `DeviceSequenceStore` port and both implementations were removed;
  no compatibility/dual-authority path remains.
- Normal append and dead-letter replay share one internal Postgres allocator.
  Replay rebinds the original server-to-daemon envelope to the new seq and
  recomputes SHA-256/byte-size before quota accounting.
- Deep review found and closed two sibling races before commit: in-memory
  cursor advancement now shares the per-device mutation serializer with async
  materialization, and replay rechecks its idempotency key after taking the
  device allocator lock, rolling back an unused allocation when normal append
  won.

## Deviations From Plan Or Spec

- Harness recovery advertised `lite/zero ceremony`, but the live edit hook
  blocked implementation without an active plan. The minimal approved
  work-package/contract was created solely to satisfy that gate.
- The first full dataplane test read a stale `cloud-postgres/dist` bundle.
  Rebuilding the package restored the documented test precondition; no
  out-of-scope source fix was made.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Pass a preallocated seq into mailbox | Rejected | Concurrent row 2 could commit before row 1; ack 2 would hide late row 1. |
| Parse seq out of opaque JSON in core/Postgres mailbox | Rejected | Duplicates protocol authority and breaks core's protocol-free boundary. |
| Mailbox-owned body factory | Chosen | One atomic authority and identical in-memory/Postgres semantics. |

## Open Questions

- None.

## Evidence Links

- Pre-fix red: `tasks/notes/20260812-0347-cloud-postgres-offer-sequence-hotfix.pre-fix.md`
- Durable root-cause/fix report: `docs/researches/2026-08-12-cloud-postgres-offer-sequence-p0.md`
- Real dataplane: `@byok-sdk/cloud-postgres` 13 files / 204 tests passed.
- Required checks: `pnpm -r run typecheck`, `pnpm -r run test`, and
  `pnpm -r run build` passed; `repo-harness run check-task-workflow --strict`
  and `git diff --check` passed.
- Deep review: security, architecture, and adversarial passes all returned
  PASS on pinned base `bf8d711`; the two initial adversarial findings are
  guarded by in-memory conformance and a real-Postgres replay/append race test.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- None. The atomic opaque body-factory decision and concurrency falsifier are
  already recorded in the P0 research report; no global lesson is warranted.
