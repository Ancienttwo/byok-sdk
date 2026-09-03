# Implementation Notes: wp3b-step1-kernel-increments

> **Status**: Active
> **Plan**: plans/plan-20260903-1330-wp3b-step1-kernel-increments.md
> **Contract**: tasks/contracts/20260903-1330-wp3b-step1-kernel-increments.contract.md
> **Review**: tasks/reviews/20260903-1330-wp3b-step1-kernel-increments.review.md
> **Last Updated**: 2026-09-03 13:50
> **Lifecycle**: notes

## Design Decisions

## Sub-step 1e — instance-product bearer (GAP-6)

Commit `1df290f` — `feat(cloud): optional instanceProductId enforced in authenticateBearer`

Files touched:

- `packages/cloud/src/auth/bearer.ts` — `BearerAuthDeps.instanceProductId?: string`; the new check sits AFTER the existing row==claims check.
- `packages/cloud/src/cloud.ts` — `ByokCloudOptions.instanceProductId?: string`, spread into the single `deviceRouteDeps.bearer` object every device route shares.
- `packages/cloud/src/composition/in-memory.ts` — option passthrough so a composition (and the test harness) can declare it.
- `packages/cloud/src/__tests__/bearer-instance-product.test.ts` — new, 7 tests.

Decisions:

- **Two authorities, not a check plus a fallback.** Absent `instanceProductId` is the multi-product hosted shape, where the device row is the whole product authority; present is the single-product (embedded) shape. Neither is a degraded version of the other, so nothing infers one from the other.
- **Compared against `claims.productId`, not `device.productId`.** The check runs after `device.productId !== claims.productId` has already refused any disagreement, so at that point the two are provably equal and the comparison is the same comparison either way; it is written against the claims because "this token was minted for another product" is what it means. `packages/server/src/auth.ts:404-405` writes the same pair against the row.
- **Same `undefined` as every other failure.** An instance mismatch is indistinguishable from unknown/wrong-tenant/revoked, so a 401 never becomes an oracle for which product an instance serves. Asserted directly (`answers a cross-product token and a garbage token identically`).
- Rejection *shape* therefore stays `{ error: 'unauthorized' }`, 401, on every bearer-authed route — no new code, no new body.

Falsifier run: with the new condition forced to `false`, 2 of the 7 new tests go red (`1 failed (1) / 2 failed | 5 passed (7)`); restored immediately.

Command tails:

```
bun run build            -> byok-sdk build: Exited with code 0
bun run typecheck        -> 15 packages, 0 errors
bun run test             -> cloud 31 files / 284 tests; server 37 files / 289 tests; all packages green
git diff --check         -> clean
git diff --stat origin/main..HEAD -- packages/server  -> empty
```

## Sub-step 1a — approveTask / rejectTask (GAP-1)

Commit `52e965f` — `feat(cloud): approveTask/rejectTask with StaleApprovalError`

Files touched:

- `packages/cloud/src/approval-control.ts` — new. `StaleApprovalError` (moved from `packages/server/src/hub.ts:380`, defined here; server untouched) and `pendingApproval(tail)`.
- `packages/cloud/src/errors.ts` — new code `task_not_awaiting_approval`.
- `packages/cloud/src/cloud.ts` — `ApproveTaskOptions`/`RejectTaskOptions`, `ByokCloud.approveTask`/`rejectTask`, private `resolveApproval`, predicate `isTerminalAttemptStatus`.
- `packages/cloud/src/index.ts` — exports `StaleApprovalError`, `pendingApproval`, `PendingApproval`, `ApproveTaskOptions`, `RejectTaskOptions`.
- `packages/cloud/src/__tests__/approval-control.test.ts` — new, 16 tests.

### The pending-approval derivation rule (the load-bearing decision)

The server keeps one mutable slot per task (`TaskSnapshot.pendingApprovalId`). Cloud adds **no store and no record**: the two observations that move that slot are already durable in the `ApprovalTimelineStore` tail, so the slot is DERIVED per call by folding the tail's entries in revision order, holding exactly one slot:

- `approval_requested` **sets** the slot, superseding whatever it held (mirrors `hub.ts:1399` — a daemon that dispatched a fresh approval has moved on, and the newest request is what an operator is being asked about).
- `approval_resolved(X)` **clears** the slot when the slot's id is `X`, or when the slot has no id at all (a pre-M5 daemon reported none, so the resolution can only be about the single outstanding request). A resolution naming some other id is about an already-superseded approval and leaves the current slot standing (mirrors `hub.ts:1569`).

Two ways nothing is pending: no unresolved request on the tail, or no tail at all — it is a bounded, TTL'd ring, not a permanent authority. Both answer `undefined` and both fail closed. A dropped-then-expired approval is never silently approved.

### Gate order and rejection error names

Mirrors `hub.ts:2315-2360`; every gate runs in full before any mailbox row is allocated, so a refused call has zero side effects (asserted: the poll after each refusal returns 0 events).

1. no such task for this tenant -> `ByokCloudError('task_not_found')` — the same code and message shape `cancelTask` already uses (`cloud.ts:1303`).
2. nothing to resolve -> `ByokCloudError('task_not_awaiting_approval')`. **One code, three ways in**, each with its own message: terminal attempt, no unresolved request on the tail, or no `ownerDeviceId`. They are one code because the caller's remedy is identical in all three; the message says which. Checked BEFORE targeting, so it wins when both would apply (server does the same with `TaskNotAwaitingApprovalError`).
3. `opts.approvalId` given AND a pending id exists AND they differ -> `StaleApprovalError(taskId, requestedApprovalId, currentApprovalId)`. When the daemon never reported an id there is nothing to disagree with, so the call proceeds untargeted — exactly the server's `record.pendingApprovalId !== undefined` guard.

`StaleApprovalError` is a **class**, not a `CloudErrorCode`, deviating from this package's one-class taxonomy on purpose: it carries the two ids a caller needs in order to re-target, which a code cannot. This is also what the design packet §3 prescribes (that table moves `StaleApprovalError` to cloud; it does NOT move `TaskNotAwaitingApprovalError`, hence the code above rather than a second class).

Other decisions:

- **Terminal-attempt gate included.** The server's gate 2 is `state !== 'AwaitApproval'`; cloud has no such attempt status, so the equivalent fact is "the attempt is `complete`/`failed`/`cancelled`". Without it, a runtime that resolved locally and ran to completion (the implicit path, with no `task.approval_resolved` ever sent) would still show an unresolved request on the tail and accept an approve. Covered by `refuses a task that already reached a terminal, even with an unresolved request on the tail`.
- **Delivery to `TaskAttempt.ownerDeviceId`, not `deviceId`.** An approval belongs to the runtime actually paused on it, which is the claiming device; the offered device is not necessarily it. An unclaimed attempt therefore has nothing to notify and is refused rather than delivered to the offer target.
- **Outgoing `approvalId` = caller's ?? pending ?? omitted**, matching `hub.ts:2326`, so the daemon's own exact-match check can still run whenever this cloud has an id to offer at all. `reason` on reject is carried verbatim and stays absent on the wire when absent.
- **Return type is `EnqueuedAgentControl`, not `void`.** Every other cloud enqueue returns the seq + envelope, and a host that wants a delivery-position receipt should not have to re-read the mailbox. Step 2's façade can drop it.
- **No new store, no new route.** Delivery reuses the private `enqueueAgentControlEnvelope` (`cloud.ts:849`) with a fresh `messageId` per call — the wire message has always been a best-effort notification, not an idempotent command. Task approval remains absent from the HTTP route table: it is an operator action, not a device-credentialed one (`cloud.ts`'s existing comment on that).
- **`isTerminalAttemptStatus` is a predicate, not a `Set`.** `constraints.test.ts` keeps every in-process `Map`/`Set` inside a store class; a `new Set<TaskAttemptStatus>([...])` in `cloud.ts` failed that scan on the first run. The predicate needs no collection.

Command tails:

```
bun run build            -> byok-sdk build: Exited with code 0
bun run typecheck        -> 15 packages, 0 errors
bun run test             -> cloud 31 files / 284 tests; server 37 files / 289 tests; conformance 147; all packages green
git diff --check         -> clean
git diff --stat origin/main..HEAD -- packages/server  -> empty
```

### Known, out of scope

- `bun run check:api-surface` fails on `@byok-sdk/cloud` only, with an **additive-only** diff (no removed lines): `approval-control.d.ts` (`StaleApprovalError`, `PendingApproval`, `pendingApproval`), `ApproveTaskOptions`/`RejectTaskOptions`, `approveTask`/`rejectTask`, `task_not_awaiting_approval`, and `instanceProductId` on `ByokCloudOptions`/`BearerAuthDeps`. Goldens are regenerated once at the end of the slice, per the plan's T2 — deliberately not touched here.
- `packages/cloud-dataplane/src/__tests__/worker-packaging.test.ts > dry-runs wrangler deploy over worker-smoke` failed once under the full parallel run and passed on isolated re-run and on the full re-run. Pre-existing flake, unrelated to this slice; not touched.


## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| ... | ... | ... |

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
