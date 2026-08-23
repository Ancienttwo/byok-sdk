# Plan: Agent egress fresh session authority

> **Status**: Executing
> **Created**: 20260823-2300
> **Slug**: agent-egress-fresh-session-authority
> **Planning Source**: user-approved-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260823-2300-agent-egress-fresh-session-authority.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20260823-2300-agent-egress-fresh-session-authority.md`; after execution revert branch `codex/agent-egress-fresh-session-authority` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260823-2300-agent-egress-fresh-session-authority.contract.md`
> **Task Review**: `tasks/reviews/20260823-2300-agent-egress-fresh-session-authority.review.md`
> **Implementation Notes**: `tasks/notes/20260823-2300-agent-egress-fresh-session-authority.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from user-approved-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260823-2300-agent-egress-fresh-session-authority.md`
- Sprint contract: `tasks/contracts/20260823-2300-agent-egress-fresh-session-authority.contract.md`
- Sprint review: `tasks/reviews/20260823-2300-agent-egress-fresh-session-authority.review.md`
- Implementation notes: `tasks/notes/20260823-2300-agent-egress-fresh-session-authority.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260823-2300-agent-egress-fresh-session-authority.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260823-2300-agent-egress-fresh-session-authority.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260823-2300-agent-egress-fresh-session-authority.md`.

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
- Contract file: `tasks/contracts/20260823-2300-agent-egress-fresh-session-authority.contract.md`
- Review file: `tasks/reviews/20260823-2300-agent-egress-fresh-session-authority.review.md`
- Implementation notes file: `tasks/notes/20260823-2300-agent-egress-fresh-session-authority.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260823-2300-agent-egress-fresh-session-authority.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260823-2300-agent-egress-fresh-session-authority.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260823-2300-agent-egress-fresh-session-authority.md`; after execution revert branch `codex/agent-egress-fresh-session-authority` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260823-2300-agent-egress-fresh-session-authority.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260823-2300-agent-egress-fresh-session-authority.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260823-2300-agent-egress-fresh-session-authority.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260823-2300-agent-egress-fresh-session-authority.contract.md`, `tasks/reviews/20260823-2300-agent-egress-fresh-session-authority.review.md`, and `tasks/notes/20260823-2300-agent-egress-fresh-session-authority.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260823-2300-agent-egress-fresh-session-authority.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260823-2300-agent-egress-fresh-session-authority.md`; after execution revert branch `codex/agent-egress-fresh-session-authority` or the explicitly reviewed diff.

## Captured Planning Output

## Goal

Close the published 0.7.0 fresh-Agent deadlock without weakening protocol v1: a host can dispatch a new Agent execution with the exact egress policy before a runtime session exists, while exact resume continues to require SDK-owned durable handoff evidence.

## Success Criteria

- Protocol adds one additive fresh-only Agent egress offer and one durable capability. The existing `task.offer_for_agent_with_egress` remains exact-resume-only and byte compatible.
- Fresh offers carry no sessionRef. The selected runtime mints the authoritative sessionRef; the client fsyncs AgentRef/runtime/cwd/session handoff before `task.started` and uses that exact value for later reliable egress, ack and content-read identity.
- Resume offers retain pre-start exact `requireMatch`; missing/stale/cross-Agent/profile/runtime/cwd evidence fails closed with no fresh fallback.
- Cloud/server enqueue fresh offers only to devices durably declaring the new capability. Older 0.7 daemons never receive the new message.
- Public reliable egress cannot publish an invented session: it proves the supplied runtime/session against the canonical Agent-home handoff before durable append/send.
- A real client/server test proves fresh offer -> runtime-minted session -> durable handoff -> reliable spool/ack; negative tests cover legacy capability, fake preseed, resume mismatch, restart/exact ack and no content bytes.
- Build, typecheck, full tests, disposable dataplane where affected, pack/readback and independent frozen-subject gate pass. The complete prerelease train may publish only as `0.8.0-beta.0` plus keys `0.3.1-beta.0` under npm dist-tag `beta`; stable/latest, merge, push, deploy, production migration, secret change and Agent-home deletion remain excluded.

## Scope

- Architecture/spec/protocol documentation for fresh versus resume session authority.
- `packages/protocol`, `packages/client`, `packages/cloud`, `packages/server`, aligned package exports/manifests and directly affected tests.
- `packages/cloud-dataplane` only if durable capability/task schema or conformance changes require it; prefer no data migration when existing device capability persistence already carries opaque flags.
- Prerelease version alignment, release-tool support for exact SemVer prereleases and non-latest dist-tags, tarball/declaration/fresh-install readback, and one complete beta publication/readback.
- Salesko consumes only the exact beta artifacts in its isolated source-acceptance worktree; production/stable consumption remains blocked.

## Non-Scope

- Changing/removing the frozen v1 resume message, optionalizing its required sessionRef, or introducing protocol v2.
- Server-generated fake runtime sessions, pre-dispatch handoff reservations, token/JWT parsing, downstream shadow stores or compatibility fallback.
- Contentful trajectory or transfer enablement.
- Stable npm publication or moving `latest`; Salesko production dependency promotion; branch merge/push, deployment, production DDL, secrets or deletion of any Agent home.

## Constraints and Invariants

- Runtime session identity is runtime-issued and becomes durable only after SDK handoff fsync; task/job ids are not runtime session ids.
- Fresh and resume are distinct wire facts. No heuristic converts a missing or mismatched resume into fresh execution.
- Device capability admission uses durable authenticated device records, not presence.
- AgentRef, runtime, canonical cwd and session must exact-match before reliable egress is accepted locally.
- Existing legacy task and strict resume behavior remains unchanged.

## P1: Architecture Map

- `packages/protocol`: additive message/capability and frozen wire authority.
- `packages/client`: fresh admission, runtime start, handoff fsync, exact reliable publisher and daemon capability declaration.
- `packages/cloud` and `packages/server`: durable capability admission and distinct enqueue/dispatch APIs.
- Existing device capability stores: opaque durable capability persistence; no new session authority.
- Registry/manifests: aligned artifact authority; source acceptance is not registry availability.

## P2: Concrete Trace

1. Cloud verifies exact device plus `agent-home-contract`, egress policy/ack, and new fresh-session capability.
2. Cloud enqueues the distinct fresh Agent egress message with AgentRef/runtime/policy and no sessionRef.
3. Client acquires the canonical Agent home, starts a fresh runtime without resume arguments, receives the runtime-issued sessionRef, then fsyncs exact AgentRef/runtime/cwd/session handoff.
4. Only after durable handoff does the client report started and expose that session for reliable egress.
5. Reliable publish re-reads the exact handoff, sanitizes, spools with stable event/cursor and sends; cloud durably records and exact-acks; client retires only the exact record.
6. A later resume uses the unchanged resume message carrying that sessionRef and must pass `requireMatch` before runtime start.

## P3: Design Decision

Use an additive fresh-only message plus capability rather than changing the frozen v1 resume message or adding reservation state. This preserves old daemon safety and makes absence-versus-presence unambiguous. Tighten the host reliable-publish seam to consume durable handoff authority. Because the public client surface and aligned protocol train change, freeze one exact prerelease train and publish it under `beta` only after local pack/install closure; downstream Salesko acceptance must run on those immutable beta bytes before any stable publication is considered.

At 10x scale the first pressure point remains per-Agent/tenant reliable backlog, not session reservation. Reuse the existing bounded spool/ack/quota path rather than creating another cloud session table.

## Task Breakdown

- [x] Update architecture/spec/protocol docs with the observed 0.7.0 deadlock, datum authority and additive fresh/resume decision.
- [x] Add failing fresh-execution and exact-reliable-handoff regression guards.
- [x] Implement protocol capability/message plus client/cloud/server composition with no compatibility fallback.
- [x] Run focused protocol/client/cloud/server tests and affected typechecks/builds.
- [x] Align the new RC package train, pack/read back declarations and run fresh-install closure without publishing.
- [x] Run full repo verification, disposable dataplane if affected, repo-harness acceptance preparation and independent source gate.
- [x] Add fail-closed prerelease/dist-tag release support and align the immutable `0.8.0-beta.0` plus keys `0.3.1-beta.0` train.
- [ ] Publish the complete train under npm dist-tag `beta`, prove exact registry integrity/dependency closure, and keep `latest` unchanged.
- [ ] Complete Salesko downstream fresh/resume acceptance against the exact beta artifacts, then independently gate the combined artifact subject.

## Failure Handling and Rollback

Before beta publication, rollback is deletion/revert of this isolated source branch. After beta publication, immutable prerelease versions remain historical registry artifacts; rollback means do not promote them, leave `latest` unchanged, and publish a new beta only from a newly frozen subject. A fresh offer rejected by missing capability never creates a legacy/resume offer. Runtime start or handoff fsync failure reports fail closed and emits no resumable/start fact. Reliable sanitizer/handoff/spool failure sends no original bytes. No persistent cloud schema change is expected; if one becomes necessary, stop and revise the contract before implementation.

## Verification

- Focused protocol schema/golden and capability tests.
- Client real daemon fresh Agent egress integration plus exact resume/reliable negative tests.
- Cloud/server capability and enqueue tests over WebSocket and long-poll where existing fixtures support them.
- `bun run build`, `bun run typecheck`, `bun run test`, strict task workflow, `git diff --check`.
- Aligned tarball/declaration/transitive/fresh-install readback and independent gatekeeper on one frozen subject.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Update architecture/spec/protocol docs with the observed 0.7.0 deadlock, datum authority and additive fresh/resume decision.
- [x] Add failing fresh-execution and exact-reliable-handoff regression guards.
- [x] Implement protocol capability/message plus client/cloud/server composition with no compatibility fallback.
- [x] Run focused protocol/client/cloud/server tests and affected typechecks/builds.
- [x] Align the new RC package train, pack/read back declarations and run fresh-install closure without publishing.
- [x] Run full repo verification, disposable dataplane if affected, repo-harness acceptance preparation and independent source gate.
- [x] Add fail-closed prerelease/dist-tag release support and align the immutable `0.8.0-beta.0` plus keys `0.3.1-beta.0` train.
- [ ] Publish the complete train under npm dist-tag `beta`, prove exact registry integrity/dependency closure, and keep `latest` unchanged.
- [ ] Complete Salesko downstream fresh/resume acceptance against the exact beta artifacts, then independently gate the combined artifact subject.
