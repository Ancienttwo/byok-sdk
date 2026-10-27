# #1035 SQLite approval timeline persistence

Status: implementation authorized. Baseline: `5d0e37020d2fe71f82b73a3287dbbbdfbe4ba42b`.

## Scope and owner decisions

Issue: https://github.com/Ancienttwo/byok-sdk/issues/1035

2026-10-27 owner selected:

- Preserve the existing approval TTL (default ten minutes) and capacity (default 50). Persist only the existing observation authority; do not introduce indefinite pending-approval retention.
- Support newly created databases only at the new schema version. Refuse older files without changing them. Do not add a migration or compatibility path.
- This is pre-launch work outside the 0.31.0 release conditions.

## P1 — Map

`packages/server/src/stores.ts` selects the SQLite composition. Its factory in
`packages/server/src/stores/sqlite/index.ts` overrides tasks, devices and other
durable ports, but inherits `approvals` from `createInMemoryCloudStores`.
`packages/cloud/src/stores/in-memory/approval-timeline.ts` owns that Map.
`ApprovalTimelineStore` in `packages/cloud/src/approval-timeline.ts` is the
existing public contract. Postgres already implements it durably.

## P2 — Trace

`task.await_approval` and `task.approval_resolved` enter the cloud inbound gate,
which validates and appends to `stores.approvals`. Server snapshot projection,
`taskCountsByState`, host approve/reject and `tasks.events(..., { from: 'state' })`
all read this same port. A SQLite reopen currently keeps the attempt but loses
the Map, so the pending request and AwaitApproval projection disappear. The
existing events restart test sends its approval after reopening and does not
cover this sequence.

## P3 — Decision

Add `SqliteApprovalTimelineStore` in `packages/server/src/stores/sqlite/approval-timeline.ts`
and replace only the SQLite composition's approvals port. Keep the memory store
unchanged. No eager restoration, second pending cache or synthetic events.

Use a single `approval_timeline_tail` row per `(tenant_id, task_id)`: JSON entries,
next revision, dropped count, capacity and absolute expiry. Index tenant and
expiry for bounded collection. Read serialized JSON through existing observation
validation; corrupted authority fails closed. Use the existing coordinator and
SQLite transaction for read/compare/append, including `resolvePending`'s exact
source-envelope/revision comparison. Preserve duplicate identity checks,
resolution outcomes and tenant isolation. A duplicate does not extend TTL.

New schema is v6. New files create the approval table with the other authorities;
existing v6 files must already contain its valid schema. Versions 1–5 and unknown
versions are refused without adoption. Remove legacy migration selectors and
their implementation in the same change. Existing files are neither deleted nor
rewritten; operators preserve them and explicitly choose a new path/enrollment.

On reopen, `expiresAt` and revision are unchanged. A request still within TTL
projects through the existing readers; an expired tail returns no pending
approval and cannot authorize a host decision. A terminal task still takes
precedence over a pending observation. Feed cursors remain instance-local.

Tradeoff: JSON rewrites cost O(capacity) per event. At ten times the active task
count, the shared SQLite writer and the existing active-task statistics scan
are the first throughput pressure points. No extra caching or unbounded history
is introduced. This is reopen durability, not new power-loss evidence.

## Task Breakdown

1. Add a failing regression with a real SQLite file: append request, close,
   reopen at the same clock, read the same tail and resolve it.
2. Implement the store and v6-only composition. Reject missing approval schema,
   malformed rows and older files without changing stored data.
3. Cover TTL boundaries, exact replay/conflict, stale resolution, bounded
   collection, tenant isolation and both host decisions across reopen.
4. Add a facade regression: approval arrives before reopen; get/stats/state seed
   still show it afterwards; resolving it updates the same durable authority.
5. Update README/spec/storage API docs and the API snapshot for removal of the
   migration option. Record every changed existing test expectation as a schema
   contract change, never as a relaxation of approval behavior.
6. Run build, typecheck, test, check:api-surface and check:version-authority.
   Review test changes independently before a PR is considered ready.

Test entrypoints: new `packages/server/src/__tests__/sqlite-approval-timeline.test.ts`,
new `packages/server/src/__tests__/sqlite-approval-restart.test.ts`, existing
`packages/server/src/stores/sqlite/__tests__/conformance.test.ts`, and SQLite schema
tests under `packages/server/src/__tests__/`.

## Intake boundaries

Live intake found 27 open issues and seven open PRs. #1034 has no PR but overlaps
the retention files owned by #1042; defer edits until that lane lands. #1012 has
no PR and is a behavior-preserving cloud namespace extraction, after the current
cloud lanes. #1045 explicitly requires design before deciding implementation.
Existing 0.31.0 lanes remain with their owners; open issues with merged fixes
remain subject to their release acceptance criteria. No issues are closed by
this intake or by a local implementation.
