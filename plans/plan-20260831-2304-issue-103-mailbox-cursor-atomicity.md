# Plan: Issue 103 mailbox cursor delivery authority

> **Status**: Executing
> **Created**: 20260831-2304
> **Slug**: issue-103-mailbox-cursor-atomicity
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: GitHub issue #103
> **Artifact Level**: work-package
> **Promotion Reason**: User explicitly approved the bounded #103 reliability fix; it changes the core mailbox contract, both compositions, and the hosted route.
> **Verification Boundary**: Deterministic forged-cursor regression, in-memory/Postgres conformance, migration invariant readback, package tests/typechecks/builds, strict workflow verification, and an independent acceptance gate.
> **Rollback Surface**: Revert the delivery-watermark port, both store implementations, migration, events route composition, and their regression tests as one unit.
> **Spec**: `docs/spec.md`
> **Task Contract**: `tasks/contracts/20260831-2304-issue-103-mailbox-cursor-atomicity.contract.md`
> **Task Review**: `tasks/reviews/20260831-2304-issue-103-mailbox-cursor-atomicity.review.md`
> **Implementation Notes**: `tasks/notes/20260831-2304-issue-103-mailbox-cursor-atomicity.notes.md`

## Agentic Routing

- Selected route: bugfix
- Routing reason: GitHub issue #103 identifies a durable-data loss path caused by accepting an unbounded client cursor.
- Due diligence:
  - P1 map: `GET /byok/events` composes authenticated device input with the protocol-free core mailbox port; `InMemoryMailboxStore` and `PostgresMailboxStore` are the two authorities; `device_stream` persists sequence/cursor state.
  - P2 trace: authenticated query cursor -> integer parse -> `readCursor` -> unconditional monotonic `advanceCursor` -> durable `acked_seq` and outbox state mutation -> later messages below the forged value become unreadable.
  - P3 decision rationale: persist a server-owned delivery watermark and make `advanceCursor` atomically require `ackedSeq <= deliveredSeq`; keep mailbox reads non-acknowledging and add no fallback authority.

## Workflow Inventory

- Active plan: `plans/plan-20260831-2304-issue-103-mailbox-cursor-atomicity.md`
- Sprint contract: `tasks/contracts/20260831-2304-issue-103-mailbox-cursor-atomicity.contract.md`
- Sprint review: `tasks/reviews/20260831-2304-issue-103-mailbox-cursor-atomicity.review.md`
- Implementation notes: `tasks/notes/20260831-2304-issue-103-mailbox-cursor-atomicity.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: contract `allowed_paths`
- Execution isolation: `/Users/kito/Projects/byok-sdk-wt-issue-103-mailbox-cursor-atomicity` on `codex/issue-103-mailbox-cursor-atomicity`.

## Captured Planning Output

### Why

`GET /byok/events?cursor=N` currently treats any authenticated non-negative integer as an acknowledgement. A future value can move durable `acked_seq` beyond every delivered and queued envelope, suppressing later control messages until sequence allocation catches up.

### Scope

- Reject non-safe-integer cursors at the HTTP boundary.
- Add a server-owned monotonic delivery watermark to the core mailbox contract and both store implementations.
- Record only a cursor the server is returning to the device.
- Atomically reject acknowledgement beyond that watermark without changing cursor or outbox state.
- Add deterministic route, in-memory, Postgres, migration, and conformance coverage.

Out of scope: client cursor/journal behavior, protocol shape changes, mailbox retention policy, deployment, production migration execution, publication, merge/push/PR, and GitHub issue mutation.

### Evidence Contract

Required evidence is: the unfixed route advances to a forged cursor and suppresses a newly enqueued envelope; the fixed route returns 409 and leaves acknowledgement unchanged; unsafe integers return 400; normal monotonic ack/replay remains unchanged; in-memory and Postgres stores reject future ack atomically; migration readback proves `acked_seq <= delivered_seq`. Stop if the fix would infer delivery from enqueue state or reintroduce read-as-ack semantics.

## Task Breakdown

- [x] Freeze a deterministic pre-fix route guard for forged future and unsafe cursors.
- [x] Extend the core mailbox contract with one delivery-watermark authority.
- [x] Implement in-memory and Postgres atomic delivery/ack invariants plus migration.
- [x] Recompose the events handler to record the returned cursor before response and map future ack conflicts clearly.
- [x] Run focused, conformance, real Postgres, migration, package, and strict workflow gates.
- [x] Obtain an independent gatekeeper verdict on the exact diff.

## Evidence Contract

- **State/progress path**: this plan, its linked contract, review, and notes artifacts.
- **Verification evidence**: tracked pre-fix failure, deterministic route/store/conformance suites, real Postgres readback, migration invariant check, and `.ai/harness/checks/latest.json`.
- **Evaluator rubric**: the review must bind to the final normalized subject and recommend pass with no unresolved P0-P3 finding.
- **Stop condition**: every task breakdown item and machine-verifiable exit criterion passes; semantic acceptance remains a separate explicit gate.
- **Rollback surface**: revert the port, stores, migration, route, and tests together.

## Promotion Gate

- **Merge/PR unit**: the complete #103 mailbox delivery-watermark work package.
- **Rollback surface**: the core contract, both implementations, migration, route composition, and tests are one unit.
- **Verification boundary**: focused route/store tests, both compositions, real Postgres/migration evidence, package builds/typechecks, and strict workflow verification.
- **Review/acceptance boundary**: exact final diff review and a separately recorded typed acceptance receipt.
- **High-risk surface**: durable cursor state and forward-only schema migration.
- **Why not checklist row**: the change crosses the shared core port and two durable compositions.
