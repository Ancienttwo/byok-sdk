# Plan: Cloud Postgres offer sequence P0 hotfix

> **Status**: Executing
> **Created**: 20260812-0347
> **Slug**: cloud-postgres-offer-sequence-hotfix
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: docs/researches/2026-08-12-cloud-postgres-offer-sequence-p0.md
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: real Postgres offer/replay regressions plus monorepo required checks
> **Rollback Surface**: cross-package mailbox contract diff; no schema migration
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260812-0347-cloud-postgres-offer-sequence-hotfix.contract.md`
> **Task Review**: `tasks/reviews/20260812-0347-cloud-postgres-offer-sequence-hotfix.review.md`
> **Implementation Notes**: `tasks/notes/20260812-0347-cloud-postgres-offer-sequence-hotfix.notes.md`

## Agentic Routing
- Selected route: main-thread
- Routing reason: Captured from codex-plan planning output.
- Source ref: docs/researches/2026-08-12-cloud-postgres-offer-sequence-p0.md
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260812-0347-cloud-postgres-offer-sequence-hotfix.md`
- Sprint contract: `tasks/contracts/20260812-0347-cloud-postgres-offer-sequence-hotfix.contract.md`
- Sprint review: `tasks/reviews/20260812-0347-cloud-postgres-offer-sequence-hotfix.review.md`
- Implementation notes: `tasks/notes/20260812-0347-cloud-postgres-offer-sequence-hotfix.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260812-0347-cloud-postgres-offer-sequence-hotfix.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260812-0347-cloud-postgres-offer-sequence-hotfix.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260812-0347-cloud-postgres-offer-sequence-hotfix.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/20260812-0347-cloud-postgres-offer-sequence-hotfix.contract.md`
- Review file: `tasks/reviews/20260812-0347-cloud-postgres-offer-sequence-hotfix.review.md`
- Implementation notes file: `tasks/notes/20260812-0347-cloud-postgres-offer-sequence-hotfix.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260812-0347-cloud-postgres-offer-sequence-hotfix.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260812-0347-cloud-postgres-offer-sequence-hotfix.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: cross-package mailbox contract diff; no schema migration
- **Verification boundary**: real Postgres offer/replay regressions plus monorepo required checks
- **Review/acceptance boundary**: `tasks/reviews/20260812-0347-cloud-postgres-offer-sequence-hotfix.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260812-0347-cloud-postgres-offer-sequence-hotfix.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260812-0347-cloud-postgres-offer-sequence-hotfix.contract.md`, `tasks/reviews/20260812-0347-cloud-postgres-offer-sequence-hotfix.review.md`, and `tasks/notes/20260812-0347-cloud-postgres-offer-sequence-hotfix.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260812-0347-cloud-postgres-offer-sequence-hotfix.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: cross-package mailbox contract diff; no schema migration

## Captured Planning Output

## Agentic Routing

- Selected route: main-thread bugfix after `/hunt` root-cause proof and explicit user scope approval.
- Routing reason: one cross-package mailbox invariant; parallel writers would create contract conflicts.
- Due diligence:
  - P1 map: `@byok-sdk/cloud` creates offer envelopes, `@byok-sdk/core` owns the opaque mailbox port/reference, and `@byok-sdk/cloud-postgres` owns `device_stream`/`outbox` plus dead-letter replay.
  - P2 trace: `enqueueOffer` allocates N through `cloud.sequence`, encodes N, then Postgres mailbox allocates N+1 from the same row and the equality guard throws after the outbox side effect.
  - P3 decision rationale: make mailbox append the single per-device serialized authority and pass its reserved seq into an opaque body factory; this keeps core protocol-free and makes allocation/materialization/insert atomic. Remove the redundant sequence port. At 10x, one device's `device_stream` row is the intended hot lock; cross-device traffic remains independent.

## Approach

### Strategy

1. Preserve a real Postgres composition regression test and its observed red result.
2. Replace `MailboxAppendInput` bytes with an opaque `materialize(seq)` callback.
3. Serialize in-memory appends per device and transact Postgres allocate/materialize/insert under the `device_stream` row lock.
4. Remove `DeviceSequenceStore` from cloud compositions and conformance so allocation has one authority.
5. Rebind dead-letter envelope seq and recompute body hash/size in its existing transaction.
6. Run targeted suites, typecheck, then the repository-required checks.

### Trade-offs

| Option | Pros | Cons | Decision |
|---|---|---|---|
| Pass a preallocated seq to mailbox | Small API change | Concurrent commits can arrive out of order and an ack can skip a late lower seq | Reject |
| Mailbox-owned opaque body factory | One atomic authority; core stays protocol-free; both compositions share semantics | Shared contract change; per-device append holds a DB lock while hashing | Choose |
| Parse seq from opaque JSON in Postgres mailbox | Local patch | Violates the protocol-free mailbox boundary and duplicates semantic authority | Reject |

## Detailed Design

### File Changes

| Surface | Action | Description |
|---|---|---|
| `packages/core/src/mailbox.ts`, in-memory adapter, conformance | Modify | Add `MailboxBody` + `materialize(seq)` and prove serialized monotonic append/idempotency. |
| `packages/cloud/src/**` | Modify/delete | Build the offer inside mailbox allocation; remove sequence port/export/facade/reference. |
| `packages/cloud-postgres/src/**` | Modify/delete | Make mailbox transaction own allocation; remove sequence adapter; rebind replay envelope. |
| package metadata/constraints | Modify | Declare the direct protocol dependency used by protocol-aware cleanup only. |
| research/todo artifacts | Update | Record final authority decision and close the obsolete `cloud.sequence` cursor note. |

### Data Flow

`enqueueOffer -> mailbox.append(messageId, materialize) -> per-device lock -> allocate seq -> materialize frozen envelope bytes with seq -> insert outbox -> commit -> open task`.

Dead-letter replay follows the same lock order inside its existing quota transaction: allocate new seq, decode/re-encode the expired server-to-daemon envelope with that seq, recompute hash/size, check quota, insert, account, commit.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Public port break | Certain | Medium | Remove the obsolete port completely; no compatibility dual path. |
| Concurrent out-of-order commit | Medium without locking | Critical | Per-device serializer in memory and `device_stream` row transaction in Postgres; add concurrency conformance. |
| Materializer throws while locked | Low | Medium | Roll back Postgres and keep in-memory serializer usable without consuming seq. |
| Replay byte size changes at digit boundary | Certain eventually | Medium | Recompute encoded byte size before quota check and account the new size. |

## Promotion Gate

- Merge/PR unit: mailbox sequence authority P0 hotfix.
- Rollback surface: the cross-package diff; no schema migration.
- Verification boundary: core/cloud/cloud-postgres targeted suites with real Postgres/MinIO, then monorepo typecheck/test/build and strict task workflow.
- Review/acceptance boundary: offer row seq equals decoded envelope seq; concurrent appends cannot commit out of order; replay row/hash/size bind the new envelope.
- High-risk surface: durable delivery ordering and dead-letter accounting.
- Why not checklist row: shared public port change across three packages.

## Evidence Contract

- State/progress path: active plan plus the P0 research report.
- Verification evidence: red test output for `mailbox_seq_mismatch`, then green targeted/full commands.
- Evaluator rubric: one sequence allocator, atomic row/body binding, no compatibility fallback, no replay mismatch.
- Stop condition: targeted Postgres composition/replay and all required checks pass, or three fix loops fail.
- Rollback surface: revert this work-package diff; database schema remains unchanged.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Keep the real Postgres offer-delivery regression red on the unfixed composition.
- [x] Land the atomic mailbox body-factory contract and remove the sequence port.
- [x] Rebind dead-letter replay bytes/hash/size to its new sequence.
- [x] Run targeted real-dataplane and package tests.
- [x] Run required repository verification and update durable findings.
