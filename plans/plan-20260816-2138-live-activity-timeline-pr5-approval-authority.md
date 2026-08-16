# Plan: Live Activity Timeline PR5 — Approval Persistence Authority

> **Status**: Executing
> **Created**: 20260816-2138
> **Slug**: live-activity-timeline-pr5-approval-authority
> **Planning Source**: waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: docs/researches/2026-08-16_live-activity-timeline-v1-proposal.md#后续独立-sliceapproval-timeline
> **Artifact Level**: work-package
> **Promotion Reason**: User authorized the plan and requested staged execution of the approved proposal
> **Verification Boundary**: Protocol validation, real inbound persistence, in-memory/Postgres conformance, full workspace checks, strict contract verification, Codex acceptance
> **Rollback Surface**: Revert application/API changes; additive SQL table remains unused unless separately operator-approved for removal
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260816-2138-live-activity-timeline-pr5-approval-authority.contract.md`
> **Task Review**: `tasks/reviews/20260816-2138-live-activity-timeline-pr5-approval-authority.review.md`
> **Implementation Notes**: `tasks/notes/20260816-2138-live-activity-timeline-pr5-approval-authority.notes.md`

## Agentic Routing
- Selected route: main-thread
- Routing reason: Captured from waza-think planning output.
- Source ref: docs/researches/2026-08-16_live-activity-timeline-v1-proposal.md#后续独立-sliceapproval-timeline
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260816-2138-live-activity-timeline-pr5-approval-authority.md`
- Sprint contract: `tasks/contracts/20260816-2138-live-activity-timeline-pr5-approval-authority.contract.md`
- Sprint review: `tasks/reviews/20260816-2138-live-activity-timeline-pr5-approval-authority.review.md`
- Implementation notes: `tasks/notes/20260816-2138-live-activity-timeline-pr5-approval-authority.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260816-2138-live-activity-timeline-pr5-approval-authority.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260816-2138-live-activity-timeline-pr5-approval-authority.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260816-2138-live-activity-timeline-pr5-approval-authority.md`.

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
- Contract file: `tasks/contracts/20260816-2138-live-activity-timeline-pr5-approval-authority.contract.md`
- Review file: `tasks/reviews/20260816-2138-live-activity-timeline-pr5-approval-authority.review.md`
- Implementation notes file: `tasks/notes/20260816-2138-live-activity-timeline-pr5-approval-authority.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260816-2138-live-activity-timeline-pr5-approval-authority.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260816-2138-live-activity-timeline-pr5-approval-authority.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert application/API changes; additive SQL table remains unused unless separately operator-approved for removal
- **Verification boundary**: Protocol validation, real inbound persistence, in-memory/Postgres conformance, full workspace checks, strict contract verification, Codex acceptance
- **Review/acceptance boundary**: `tasks/reviews/20260816-2138-live-activity-timeline-pr5-approval-authority.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: User authorized the plan and requested staged execution of the approved proposal

## Evidence Contract

- **State/progress path**: `plans/plan-20260816-2138-live-activity-timeline-pr5-approval-authority.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260816-2138-live-activity-timeline-pr5-approval-authority.contract.md`, `tasks/reviews/20260816-2138-live-activity-timeline-pr5-approval-authority.review.md`, and `tasks/notes/20260816-2138-live-activity-timeline-pr5-approval-authority.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260816-2138-live-activity-timeline-pr5-approval-authority.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert application/API changes; additive SQL table remains unused unless separately operator-approved for removal

## Captured Planning Output

## Thesis

Cloud must persist approval lifecycle as its own bounded, tenant-scoped read authority before any UI can project approval state. Approval observations remain a separate stream from `ActivityTail`: the protocol carries no authoritative total-order cursor shared by `task.progress`, `task.await_approval`, and `task.approval_resolved`, so this slice must not synthesize one.

## P1 — Architecture Map

- Protocol authority: `packages/protocol/src/messages.ts` owns frozen-v1 approval payloads; `approvalId` identifies a daemon-generated approval request. Existing wire field constraints cannot be tightened without protocol v2, so PR5 validates persisted identity at the cloud authority boundary.
- Producer path: `packages/client/src/daemon/task-runner.ts` generates UUID approval IDs and emits await/resolved envelopes through the existing out-of-band MCP approval seam.
- Inbound boundary: `packages/cloud/src/inbound.ts` validates and deduplicates daemon envelopes, but currently drops both approval lifecycle messages from durable projection.
- Storage boundary: `packages/cloud/src/stores/ports.ts` and `packages/cloud/src/tenant-stores.ts` expose tenant-bound ports; in-memory and Postgres implementations must share one conformance contract.
- Read boundary: `packages/cloud/src/cloud.ts` exposes host-only control-plane reads. No browser-auth route or approval action endpoint belongs in this slice.
- Out of scope: `AgentEvent.needs_approval`, UI fold/presentation, approval mutation/control, and any guessed relation between approvalId and toolCallId.

## P2 — Concrete Trace

1. The daemon emits a schema-valid `task.await_approval` or `task.approval_resolved` envelope.
2. Cloud authenticates the device, validates tenant/task ownership, and deduplicates by envelope ID through the existing inbound gate.
3. After accepted lifecycle processing, cloud appends one typed approval observation to the tenant-bound approval store. The store assigns a monotonic per-task `revision` under the same atomic row update used for retention.
4. The bounded tail preserves `sourceEnvelopeId`, host `receivedAt`, native lifecycle fields, `dropped`, `capacity`, and `expiresAt`.
5. `ByokCloud.readApprovalTimeline(tenant, taskId)` returns the host-only typed tail. It does not fold pending/approved/rejected and does not merge ordering with `ActivityTail`.
6. Missing optional request `approvalId` remains explicit source data for a future unpaired projection; empty/blank persisted identities fail at the cloud authority boundary. Frozen wire v1 is unchanged.

## P3 — Design Decision

- Add a dedicated `ApprovalTimelineStore`, not fields on `ActivityStore`. Its authority is envelope arrival order, represented by a store-assigned monotonic revision; activity ordering remains `(taskId, batchSeq, eventIndex)`.
- Store typed requested/resolved observations in a bounded JSONB tail per tenant/task. Default retention is capacity 50 and TTL 10 minutes, matching the live-observation product boundary without claiming a durable audit log.
- Use one Postgres row transaction/lock to allocate revision, enforce capacity, and update dropped/expiry atomically. At 10x load the first pressure point is the per-task hot JSONB row; the port permits later storage replacement without changing the public DTO.
- Validate approval IDs as trim-aware nonblank strings at the cloud persistence boundary. Do not trim or rewrite values; frozen wire v1 remains unchanged because in-place constraint tightening requires protocol v2.
- Fail closed on malformed store input and conflicting task identity. Do not pair, infer, or translate semantic state in cloud.

This plan assumes approval messages continue to pass the existing authenticated/deduplicated inbound gate. If that ceases to hold, persistence must stop at the gate rather than introduce a second authentication or deduplication authority.

## Scope

- Cloud approval-ID validation and regression coverage; protocol v1 remains byte-for-byte frozen.
- Public typed approval timeline DTO/store port and exports.
- In-memory and Postgres bounded-tail implementations plus shared conformance tests.
- Cloud store composition, tenant facade, inbound lifecycle append, and host-only read method.
- SQL migration for the Postgres approval tail.
- Product/spec status update that records persistence authority while leaving UI projection for the next independent work-package.

## Non-scope

- No changes to `AgentEvent.needs_approval`.
- No approval buttons, mutation routes, browser/device-auth GET, React, or presentation state.
- No synthetic ordering between approval and activity streams.
- No toolCallId association, heuristic pairing, compatibility parser, or dual-write path.
- No durable compliance/audit-log claim.

## Public Contract

- `ApprovalObservation`: task ID, source envelope ID, store revision, received time, and an exact requested/resolved event union.
- `ApprovalTail`: tenant/task identity, ordered retained observations, cursor revision, dropped count, capacity, and expiry.
- `ApprovalTimelineStore.append/read` at the root store boundary and a tenant-bound facade.
- `ByokCloud.readApprovalTimeline(tenant, taskId)` as a host control-plane read.
- Protocol schemas remain unchanged. Cloud accepts an omitted request approval ID as explicit unpaired source data, but rejects empty/whitespace persisted IDs; resolved persisted IDs are nonblank.

## Task Breakdown

- [x] T1: Verify frozen-v1 constraints and keep protocol/golden unchanged; put nonblank approval-ID validation at the new cloud persistence boundary.
- [x] T2: Define approval timeline DTOs, bounds, validation, store port, exports, tenant facade, and in-memory implementation.
- [x] T3: Persist accepted await/resolved envelopes in `handleInboundEnvelope` and expose `readApprovalTimeline`; prove auth/tenant/dedup behavior through the real inbound path.
- [x] T4: Add `deploy/sql/0007_approval_timeline.sql`, Postgres implementation, composition, cleanup/expiry integration as required, and shared in-memory/Postgres conformance.
- [x] T5: Update `docs/spec.md`, targeted tests, implementation notes, and freeze the implementation subject.
- [x] T6: Run targeted protocol/cloud/dataplane tests, build, typecheck, full test suite, strict workflow check, contract verification, and one Codex acceptance review; fix only in-scope findings.
- [ ] T7: Merge the independently usable PR5, archive its workflow artifacts, then capture PR6 for approval UI projection.

## Acceptance Criteria

- Await and resolved envelopes accepted by the real inbound gate are readable from the correct tenant/task tail and never leak across tenants.
- Duplicate envelope delivery appends once; distinct observations receive strictly increasing revisions even under concurrent append.
- Capacity eviction increments `dropped`; TTL expiry resets the bounded observation window according to the declared contract.
- Request without approvalId remains faithfully represented and is never paired; empty/whitespace IDs are rejected before cloud persistence.
- Resolution preserves exact decision, resolver, and native resolved time; cloud does not infer pending/approved/rejected.
- Activity ordering and approval revision remain distinct; no API claims a cross-stream total order.
- In-memory and Postgres stores pass one conformance suite, including concurrency, tenant isolation, capacity, and TTL.
- Required repository checks and strict contract verification pass on the frozen subject.

## Falsifier

The design is invalid if current wire/runtime evidence provides an authoritative shared monotonic sequence across progress and approval envelopes, or if accepted approval envelopes bypass the existing deduplication authority. The cheapest proof is a focused codec/inbound trace plus a pinned daemon emission fixture; if either condition is observed, stop and revise the ordering or dedup boundary before implementation.

## Verification

- Frozen protocol freeze-guard plus focused cloud validation tests.
- Focused cloud inbound, store-conformance, tenant-isolation, and Postgres tests with the repository's existing Postgres fixture.
- `bun run build`
- `bun run typecheck`
- `bun run test`
- `repo-harness run check-task-workflow --strict`
- `repo-harness run verify-contract --contract <captured-contract> --strict`

## Workflow Inventory

- Active plan: captured under `plans/plan-*.md`; contract under `tasks/contracts/*.contract.md`.
- Review/notes: `tasks/reviews/` and `tasks/notes/`; deferred UI projection remains in `tasks/todos.md` until PR6 capture.
- Evidence: `.ai/harness/checks/latest.json` and `.ai/harness/runs/`.
- Ownership: implementation occurs only in a linked contract worktree with explicit allowed paths covering protocol, cloud, migration, docs, and workflow artifacts.
- Destructive boundary: no deletion of user data, no production migration execution, no force push/reset, no worktree removal unless separately verified clean. The SQL change is additive schema creation only.
- Rollback: revert application/read API changes before deploying the additive table migration; an unused table may remain safely. Dropping persisted approval rows/table requires separate operator authorization and is not part of this work-package.

## Rejected Alternative

Appending approvals into `ActivityTail` was rejected because it would invent a total order the protocol does not carry and would overload `AgentEvent` with an out-of-band authority. A separate bounded tail is the smallest coherent boundary and remains useful even if PR6 never ships.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] T1: Verify frozen-v1 constraints and keep protocol/golden unchanged; put nonblank approval-ID validation at the new cloud persistence boundary.
- [x] T2: Define approval timeline DTOs, bounds, validation, store port, exports, tenant facade, and in-memory implementation.
- [x] T3: Persist accepted await/resolved envelopes in `handleInboundEnvelope` and expose `readApprovalTimeline`; prove auth/tenant/dedup behavior through the real inbound path.
- [x] T4: Add `deploy/sql/0007_approval_timeline.sql`, Postgres implementation, composition, cleanup/expiry integration as required, and shared in-memory/Postgres conformance.
- [x] T5: Update `docs/spec.md`, targeted tests, implementation notes, and freeze the implementation subject.
- [x] T6: Run targeted protocol/cloud/dataplane tests, build, typecheck, full test suite, strict workflow check, contract verification, and one Codex acceptance review; fix only in-scope findings.
- [ ] T7: Merge the independently usable PR5, archive its workflow artifacts, then capture PR6 for approval UI projection.
