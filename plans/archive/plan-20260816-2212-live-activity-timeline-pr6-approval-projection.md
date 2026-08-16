# Plan: Live Activity Timeline PR6 — Approval UI Projection

> **Status**: Archived
> **Created**: 20260816-2212
> **Slug**: live-activity-timeline-pr6-approval-projection
> **Planning Source**: waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: docs/researches/2026-08-16_live-activity-timeline-v1-proposal.md#后续独立-sliceapproval-timeline
> **Artifact Level**: work-package
> **Promotion Reason**: User authorized the plan and requested completion of the staged Live Activity Timeline V1 proposal
> **Verification Boundary**: UI-runtime approval fold, host auth/redaction/presentation integration, full workspace checks, strict contract verification, Codex acceptance
> **Rollback Surface**: Revert UI-runtime and example-host projection changes; persisted approval authority remains independently usable
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260816-2212-live-activity-timeline-pr6-approval-projection.contract.md`
> **Task Review**: `tasks/reviews/20260816-2212-live-activity-timeline-pr6-approval-projection.review.md`
> **Implementation Notes**: `tasks/notes/20260816-2212-live-activity-timeline-pr6-approval-projection.notes.md`

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

- Active plan: `plans/plan-20260816-2212-live-activity-timeline-pr6-approval-projection.md`
- Sprint contract: `tasks/contracts/20260816-2212-live-activity-timeline-pr6-approval-projection.contract.md`
- Sprint review: `tasks/reviews/20260816-2212-live-activity-timeline-pr6-approval-projection.review.md`
- Implementation notes: `tasks/notes/20260816-2212-live-activity-timeline-pr6-approval-projection.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260816-2212-live-activity-timeline-pr6-approval-projection.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260816-2212-live-activity-timeline-pr6-approval-projection.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260816-2212-live-activity-timeline-pr6-approval-projection.md`.

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
- Contract file: `tasks/contracts/20260816-2212-live-activity-timeline-pr6-approval-projection.contract.md`
- Review file: `tasks/reviews/20260816-2212-live-activity-timeline-pr6-approval-projection.review.md`
- Implementation notes file: `tasks/notes/20260816-2212-live-activity-timeline-pr6-approval-projection.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260816-2212-live-activity-timeline-pr6-approval-projection.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260816-2212-live-activity-timeline-pr6-approval-projection.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert UI-runtime and example-host projection changes; persisted approval authority remains independently usable
- **Verification boundary**: UI-runtime approval fold, host auth/redaction/presentation integration, full workspace checks, strict contract verification, Codex acceptance
- **Review/acceptance boundary**: `tasks/reviews/20260816-2212-live-activity-timeline-pr6-approval-projection.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: User authorized the plan and requested completion of the staged Live Activity Timeline V1 proposal

## Evidence Contract

- **State/progress path**: `plans/plan-20260816-2212-live-activity-timeline-pr6-approval-projection.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260816-2212-live-activity-timeline-pr6-approval-projection.contract.md`, `tasks/reviews/20260816-2212-live-activity-timeline-pr6-approval-projection.review.md`, and `tasks/notes/20260816-2212-live-activity-timeline-pr6-approval-projection.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260816-2212-live-activity-timeline-pr6-approval-projection.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert UI-runtime and example-host projection changes; persisted approval authority remains independently usable

## Captured Planning Output

## Thesis

PR6 projects the persisted approval observation stream into a pure, deterministic UI snapshot and extends the host reference to present that snapshot beside activity. Approval remains a separate authority: correlation uses only native `approvalId`, missing request IDs remain explicitly unpaired, and no ordering or tool-call relationship is synthesized.

## P1 — Architecture Map

- Persistence authority: `packages/cloud/src/approval-timeline.ts` owns validated `ApprovalTimelineTail` observations and per-task revision order.
- UI runtime: `packages/ui-runtime/src/timeline.ts` is the existing pure activity fold; PR6 adds a sibling approval fold and exported types without changing activity semantics.
- Host boundary: `examples/live-activity-host/src/index.ts` owns authentication, tenant/task binding, redaction, ETag, and presentation. It must read/redact/fold both streams only after authorization.
- Product truth: `docs/spec.md` must declare the projection vocabulary, explicit unpaired behavior, conflict failures, and absence of cross-stream total order or approval mutation.
- Out of scope: protocol changes, persistence changes, action endpoints/buttons, `needs_approval` reinterpretation, `toolCallId` association, React/runtime dependencies, or durable audit claims.

## P2 — Concrete Trace

1. A host GET authenticates a user and resolves the authorized tenant/task binding.
2. The host reads `ActivityTail` and `ApprovalTimelineTail` for that exact binding; a returned tail outside the binding fails closed.
3. Host redaction may change approval summary presentation only. It must preserve task/source identity, revision, event type, `approvalId`, resolution decision/resolver/time, and metadata.
4. The UI runtime replays approval observations in native revision order into a task snapshot. Native IDs correlate request/resolution even when resolution arrives first; an omitted request ID becomes an explicit unpaired request.
5. States use the borrowed zero-dependency vocabulary: lifecycle `approval-requested|approval-responded`, decision status `pending|approved|rejected`, and correlation `paired|unpaired-request|unpaired-resolution`.
6. The host passes separate `activity` and `approvals` snapshots to presentation. ETag includes both independent cursors/retention metadata and never claims a shared order.

## P3 — Design Decision

- Add one pure approval fold beside the activity fold because the two streams have different authorities and ordering keys. Sharing a combined fold would invent a cross-stream order.
- Correlate exclusively by nonblank native `approvalId`. Resolution-before-request converges to the same paired snapshot; missing request IDs never match anything.
- Treat reuse of one approval ID with conflicting request summaries or conflicting resolutions as an authority collision and fail closed. Exact duplicate observations are idempotent.
- Support full replay and incremental folding with structural equality. The snapshot retains bounded-tail metadata so dropped/expiry state stays observable.
- Extend the reference host read model only. At 10x load the first pressure point remains two bounded reads plus serialization; parallel reads are sufficient for this example and no cache authority is added.

## Scope

- Approval projection types, error taxonomy, pure replay/incremental fold, and public exports in `@byok-sdk/ui-runtime`.
- Tests for paired/unpaired states, resolution-before-request, collision rejection, idempotency, replay/incremental equivalence, metadata, and task/revision validation.
- Host reference integration: approval read port, binding checks, authority-preserving redaction, separate snapshots in presentation, and ETag coverage.
- Host tests for auth-before-read, tenant isolation, redaction constraints, no-store behavior, and no mutation surface.
- `docs/spec.md` update recording the completed read-only projection boundary.

## Non-scope

- No protocol or cloud persistence changes.
- No approval action endpoint, button, callback, or browser-to-daemon mutation.
- No association between `approvalId` and `toolCallId`.
- No reinterpretation of `AgentEvent.needs_approval`; it remains an unsupported known activity placeholder.
- No combined activity/approval ordering, heuristic pairing, compatibility parser, or semantic fallback.
- No UI framework dependency.

## Public Contract

- `ApprovalProjectionState` and `TaskApprovalSnapshot` keyed by task ID and native approval identity.
- `foldApprovalObservation`, `foldApprovalTail`, and `replayApprovalTimeline` as deterministic pure functions.
- Approval items expose lifecycle, decision status, correlation status, exact native fields, and source revisions without synthesizing missing identity.
- `LiveActivityHostOptions` gains required `readApprovals` and `redactApproval`; `present` receives `{ activity, approvals }` as separate snapshots.
- Existing `/api/tasks/:taskId/activity` remains a read-only host endpoint; response representation is host-defined.

## Task Breakdown

- [x] T1: Freeze the PR6 public projection vocabulary and trace cloud approval authority through the existing UI-runtime and host boundaries.
- [x] T2: Implement approval projection types, validation, pure incremental fold/replay, exports, and focused tests.
- [x] T3: Extend the host reference with authorized approval reads, binding validation, authority-preserving redaction, dual-stream ETag/presentation, and tests.
- [x] T4: Update `docs/spec.md`, implementation notes, and contract evidence without changing protocol, persistence, or approval mutation surfaces.
- [x] T5: Run targeted UI-runtime/host tests, build, typecheck, full test suite, strict workflow/contract verification, and one Codex acceptance review; fix only in-scope findings.
- [x] T6: Merge PR6, archive the workflow, update durable project memory, and close the Live Activity Timeline V1 milestone.

## Acceptance Criteria

- A native request/resolution pair produces one paired item with `approval-responded` and exact `approved|rejected` status.
- Resolution-before-request converges to the same snapshot as request-before-resolution.
- Request without `approvalId` remains a distinct `unpaired-request`; resolution without a matching request remains `unpaired-resolution`; no heuristic or tool-call pairing exists.
- Conflicting summaries or decisions under one native approval ID fail closed; exact repeated observations are idempotent.
- Full replay and event-by-event incremental folding are deeply equal, including dropped/capacity/expiry/cursor metadata.
- The host authenticates/authorizes before either read, rejects tenant/task binding drift, redacts before folding, and preserves approval authority fields.
- Host presentation receives separate activity and approval snapshots; ETag changes when either stream changes and no API claims cross-stream total order.
- `needs_approval` activity handling remains unchanged and the host exposes no approval mutation method or route.
- Required repository checks and strict contract verification pass on the frozen subject.

## Falsifier

The design is invalid if the persisted approval tail lacks stable native identity/revision semantics, if product truth requires approval actions in this slice, or if the host must expose a single authoritative ordering across both streams. The cheapest falsifier is a focused trace of `ApprovalTimelineTail`, activity fold behavior, and host route contracts before editing.

## Verification

- `bun run --filter @byok-sdk/ui-runtime test`
- `bun run --filter @byok-sdk/live-activity-host test`
- `bun run build`
- `bun run typecheck`
- `bun run test`
- `repo-harness run check-task-workflow --strict`
- `repo-harness run verify-contract --contract <captured-contract> --strict`

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] T1: Freeze the PR6 public projection vocabulary and trace cloud approval authority through the existing UI-runtime and host boundaries.
- [x] T2: Implement approval projection types, validation, pure incremental fold/replay, exports, and focused tests.
- [x] T3: Extend the host reference with authorized approval reads, binding validation, authority-preserving redaction, dual-stream ETag/presentation, and tests.
- [x] T4: Update `docs/spec.md`, implementation notes, and contract evidence without changing protocol, persistence, or approval mutation surfaces.
- [x] T5: Run targeted UI-runtime/host tests, build, typecheck, full test suite, strict workflow/contract verification, and one Codex acceptance review; fix only in-scope findings.
- [x] T6: Merge PR6, archive the workflow, update durable project memory, and close the Live Activity Timeline V1 milestone.
