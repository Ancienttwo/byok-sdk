# Plan: Agent-first home contract

> **Status**: Review
> **Created**: 20260823-1214
> **Slug**: agent-first-home-contract
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: risk_boundary
> **Verification Boundary**: Protocol freeze tests, server and cloud persistence/admission tests, client Agent-home containment/session/concurrency/adapter-cwd tests, full build/typecheck/test, and strict workflow verification.
> **Rollback Surface**: Revert the single Agent-first work-package diff before any downstream Salesko cutover; no legacy task authority or local Agent home is migrated by this slice.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260823-1214-agent-first-home-contract.contract.md`
> **Task Review**: `tasks/reviews/20260823-1214-agent-first-home-contract.review.md`
> **Implementation Notes**: `tasks/notes/20260823-1214-agent-first-home-contract.notes.md`

## Agentic Routing
- Selected route: parent-agent:p1-p2-p3
- Routing reason: Captured from codex-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260823-1214-agent-first-home-contract.md`
- Sprint contract: `tasks/contracts/20260823-1214-agent-first-home-contract.contract.md`
- Sprint review: `tasks/reviews/20260823-1214-agent-first-home-contract.review.md`
- Implementation notes: `tasks/notes/20260823-1214-agent-first-home-contract.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260823-1214-agent-first-home-contract.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260823-1214-agent-first-home-contract.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260823-1214-agent-first-home-contract.md`.

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
- Contract file: `tasks/contracts/20260823-1214-agent-first-home-contract.contract.md`
- Review file: `tasks/reviews/20260823-1214-agent-first-home-contract.review.md`
- Implementation notes file: `tasks/notes/20260823-1214-agent-first-home-contract.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260823-1214-agent-first-home-contract.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260823-1214-agent-first-home-contract.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert the single Agent-first work-package diff before any downstream Salesko cutover; no legacy task authority or local Agent home is migrated by this slice.
- **Verification boundary**: Protocol freeze tests, server and cloud persistence/admission tests, client Agent-home containment/session/concurrency/adapter-cwd tests, full build/typecheck/test, and strict workflow verification.
- **Review/acceptance boundary**: `tasks/reviews/20260823-1214-agent-first-home-contract.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: risk_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260823-1214-agent-first-home-contract.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260823-1214-agent-first-home-contract.contract.md`, `tasks/reviews/20260823-1214-agent-first-home-contract.review.md`, and `tasks/notes/20260823-1214-agent-first-home-contract.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260823-1214-agent-first-home-contract.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert the single Agent-first work-package diff before any downstream Salesko cutover; no legacy task authority or local Agent home is migrated by this slice.

## Captured Planning Output

## Goal

Implement a generic Agent-first local persistence contract across byok-sdk. A task is one execution of a durable Agent and never owns long-term workspace authority. An Agent-bound offer carries an exact AgentRef with agentId and profileRevision; SDK code composes its home from one absolute hostStorageRoot, seals that home as runtime cwd, binds resume and terminal evidence to the same identity, and admits execution only when the target daemon declared the additive agent-home-contract capability.

## P1: Architecture Map

- Protocol authority: packages/protocol/src/messages.ts, envelope/codec/version exports, protocol freeze tests, and docs/protocol.md.
- Reference server authority: packages/server/src/types.ts, hub.ts, TaskStore/SQLite persistence, dispatch admission, claim/terminal validation, and readback tests.
- Hosted cloud authority: packages/cloud/src/cloud.ts, inbound/terminal projection, durable device capability and task-attempt stores; packages/cloud-dataplane only where the existing ports require a durable implementation.
- Local daemon authority: packages/client/src/daemon/create-daemon.ts, task-runner.ts, a fail-closed Agent session store, canonical containment/lease helpers, frozen operation manifest in packages/client/src/types.ts, and Pi/Codex/Claude cwd receipts.
- SDK Agent-home authority: accepts one absolute hostStorageRoot, composes the
  only canonical path as <hostStorageRoot>/agents/<agentId>, initializes
  create-if-missing MEMORY.md and notes/ without overwriting existing content,
  validates containment, and binds runtime/session state to that home.
- Host/downstream authority: selects the branded hostStorageRoot, provides a
  stable AgentRef and redacted profile projection content, owns opaque Agent
  artifacts, and keeps credentials in the OS credential store. It never joins
  agents/<agentId> itself.
- RAFT is a recovered precedent only. Its Agent home behavior evidence is in /Users/kito/Projects/RAFT-study/docs/2026-08-23_reverse-raft-agent-home-contract-report.md; its product-private directories, lexical-only guards, and direct join(agentId) are not copied.

## P2: Concrete Trace

AgentDispatchInput with explicit device placement and AgentRef
→ server/cloud reads durable target capability and fails before task creation/enqueue when agent-home-contract is absent
→ strict Agent offer persists exact AgentRef/profileRevision
→ daemon decodes without workspaceHint
→ daemon combines its absolute hostStorageRoot with the validated typed
  AgentRef using the single SDK-owned agents/<agentId> rule
→ SDK validates segment shape, canonical/realpath containment,
  existing-ancestor symlinks, and cross-Agent identity
→ SDK creates missing Agent home, MEMORY.md, and notes/ while preserving every
  existing byte; downstream projection content is applied through the bounded
  canonical-home input rather than a downstream path join
→ same-Agent exclusive mutable lease is acquired before claim
→ session receipt exact-match is required for resume; unknown, cross-Agent, or revision mismatch declines
→ frozen operation manifest seals AgentRef, canonical Agent home cwd, runtime/session selection, and lease identity
→ Pi/Codex/Claude receive exactly that cwd
→ runtime handoff is durably written before task.started
→ claim and terminal messages echo exact AgentRef and terminal cause
→ server/cloud persist and read back the same identity/evidence
→ lease releases on every terminal/abort path.

## P3: Design Decision

- Add a distinct strict Agent offer/message and additive agent-home-contract capability. Do not reuse or enable reserved workspaceHint; do not make AgentRef optional on the legacy offer.
- Keep the existing task-only contract as a separate non-Agent API, not a fallback for Agent offers. No steady-state translation, dual authority, or silent downgrade is permitted.
- Canonical runtime cwd is the SDK-composed Agent home root at
  <hostStorageRoot>/agents/<agentId>. This keeps MEMORY.md, notes/, and opaque
  Agent artifacts visible through one working directory. BYOK never derives
  .salesko or parses Salesko profile or artifact content.
- Agent identity is opaque and bounded, while agentId must also be a valid single path segment: reject empty, dot segments, separators, absolute forms, control/NUL bytes, malformed and oversized values.
- Session resume requires exact agentId, profileRevision, sessionRef, canonicalHome, and runtime identity. Mismatch or an unreadable/corrupt Agent session store fails closed.
- One canonical Agent home has one mutable writer lease. A second same-Agent task declines busy even with a different session; different Agent homes remain independent.
- Cloud capability admission uses a durable authenticated device contract record, never TTL presence. Old daemons lacking the capability are rejected before enqueue.
- Profile schema/content, credential bytes, branded hostStorageRoot selection,
  and Agent CRUD/placement policy remain downstream. Canonical Agent-home path
  composition is exclusively SDK-owned.

## Scope

In scope:
- Typed AgentRef, strict Agent offer, claim/terminal echo, additive capability, codec/golden/freeze changes.
- Public server/cloud dispatch inputs, authenticated durable capability admission, mailbox/task persistence, terminal exact-match/readback.
- Absolute hostStorageRoot/projection interface, SDK-owned canonical path
  composition and initialization, Agent lease, fail-closed Agent session
  handoff store, sealed manifest, adapter cwd and terminal-cause evidence.
- Negative and restart tests for capability omission, malformed/oversize identity, relative root, traversal/absolute/symlink escape, cross-Agent access, profile revision/session mismatch, same-Agent overlap, different-Agent isolation, idempotent initialization/preservation, exact cwd, terminal cause, and durable readback.
- Upstream/downstream responsibility and Salesko integration documentation.

Out of scope:
- Modifying the fulfilled connector-readonly contract or adding compatibility code to it.
- Salesko Profile schema/content, branded root selection beyond supplying one
  absolute hostStorageRoot, credential storage, Agent CRUD,
  placement/scheduling policy, UI, deployment, or migration execution.
- Copying RAFT private token/app-storage/inbox/machine/reminder/service layouts.
- Treating Agent-home artifacts as SDK configuration or parsing/indexing their
  PDF, image, project, or other business content; only home ownership,
  containment, isolation, and lifecycle are in scope.
- Claiming RAFT marker inventory or recovered-source probes as BYOK acceptance.

## Allowed Paths Requested

- packages/protocol/src/
- packages/server/src/
- packages/cloud/src/
- packages/cloud-dataplane/src/ only if required by an existing durable store port
- packages/client/src/
- tests/sql/control_plane_invariants.sql
- docs/spec.md
- docs/protocol.md
- docs/host-local-storage-layout.md
- docs/researches/
- README.md
- packages/client/README.md
- generated plan/contract/review/notes/check/run artifacts for this work-package

## Acceptance

- An Agent offer cannot be created/enqueued for a target without durable agent-home-contract support.
- workspaceHint remains reserved and ignored for legacy tasks and absent from the strict Agent offer.
- Every protocol/server/cloud/client persistence boundary round-trips exact AgentRef/profileRevision.
- The SDK-composed home cannot escape hostStorageRoot through traversal,
  symlinked existing ancestors, non-existent tails, or cross-Agent canonical
  collisions; no downstream path resolver exists.
- Agent home preparation is create-if-missing and preserves existing MEMORY.md/notes content through repeated runs.
- Same Agent is single-writer; different Agents execute independently.
- Resume and terminal paths reject identity/revision/session/runtime/cwd mismatch.
- Adapter/process receipt proves runtime cwd equals the sealed manifest Agent home.
- Runtime terminal cause is persisted and survives daemon/server/cloud restart readback where the owning store is durable.
- bun run build, bun run typecheck, bun run test, and repo-harness run check-task-workflow --strict pass.

## Task Breakdown

- [x] Freeze Agent-first protocol, capability, public inputs, codec and golden tests.
- [x] Add reference-server admission, exact-match persistence and terminal readback.
- [x] Add hosted-cloud durable capability admission, mailbox/task persistence and readback.
- [x] Add client hostStorageRoot/path-composition/projection contract,
  initialization, containment, lease, handoff store and frozen manifest.
- [x] Bind Pi/Codex/Claude cwd and terminal evidence to the sealed Agent manifest.
- [x] Add the required positive/negative/restart behavior tests.
- [x] Update upstream contract and downstream Salesko responsibility/migration guidance.
- [x] Run targeted suites, full required checks, semantic review and acceptance preparation.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Freeze Agent-first protocol, capability, public inputs, codec and golden tests.
- [x] Add reference-server admission, exact-match persistence and terminal readback.
- [x] Add hosted-cloud durable capability admission, mailbox/task persistence and readback.
- [x] Add client hostStorageRoot/path-composition/projection contract,
  initialization, containment, lease, handoff store and frozen manifest.
- [x] Bind Pi/Codex/Claude cwd and terminal evidence to the sealed Agent manifest.
- [x] Add the required positive/negative/restart behavior tests.
- [x] Update upstream contract and downstream Salesko responsibility/migration guidance.
- [x] Run targeted suites, full required checks, semantic review and acceptance preparation.
