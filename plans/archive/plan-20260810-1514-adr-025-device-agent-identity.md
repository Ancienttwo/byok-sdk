# Plan: ADR-025 device and agent identity placement

> **Status**: Archived
> **Created**: 20260810-1514
> **Slug**: adr-025-device-agent-identity
> **Artifact Level**: work-package
> **Promotion Reason**: RAFT Computer 1.0.15 static evidence proves a persistent Agent layer that BYOK currently does not model; the authority split must be frozen before any fleet schema or daemon work.
> **Verification Boundary**: docs-only semantic consistency, exact three-document projection, strict workflow gate, and zero production/protocol changes.
> **Rollback Surface**: revert the ADR, canonical architecture subsection/ledger row, and research index entry.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260810-1514-adr-025-device-agent-identity.contract.md`
> **Task Review**: `tasks/reviews/20260810-1514-adr-025-device-agent-identity.review.md`
> **Implementation Notes**: `tasks/notes/20260810-1514-adr-025-device-agent-identity.notes.md`

## Agentic Routing
- Selected route: bounded main-thread projection from the completed reverse-skill case and current `origin/main` source/docs.
- Routing reason: deep artifact research is already complete; this slice only integrates the accepted authority decision into canonical repository docs.
- Due diligence:
  - P1 map: BYOK has tenant/product-scoped Device identity, device presence/runtime capabilities, task routing, and runtime sessions; it has no persistent Agent or AgentPlacement store/API/supervisor.
  - P2 trace: host dispatch chooses explicit/first-connected `deviceId`, persists `taskId + deviceId + runtime`, sends `task.offer`, then the device starts an ephemeral runtime/session/workspace. RAFT instead routes server lifecycle commands by stable `agentId` through a per-Computer runner into a process supervisor.
  - P3 decision rationale: keep Device, Agent, placement, observation, task, and runtime session as separate authorities; preserve protocol v1 and current Local Agent CLI behavior; trigger implementation only from an explicit fleet product slice.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260810-1514-adr-025-device-agent-identity.md`
- Sprint contract: `tasks/contracts/20260810-1514-adr-025-device-agent-identity.contract.md`
- Sprint review: `tasks/reviews/20260810-1514-adr-025-device-agent-identity.review.md`
- Implementation notes: `tasks/notes/20260810-1514-adr-025-device-agent-identity.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260810-1514-adr-025-device-agent-identity.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260810-1514-adr-025-device-agent-identity.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260810-1514-adr-025-device-agent-identity.md`.

## Approach
### Strategy

Project ADR-025 into the existing ADR family, add a compact four-authority terminology section under the canonical identity architecture, and index the decision. State both present capability and non-capability: current BYOK is multi-device + multi-runtime + task session, not a first-class multi-Agent fleet.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Treat runtime/task as Agent | No new concept | Conflates capability/attempt with durable identity | Rejected |
| Copy RAFT multi-server Computer attachments | Proven shipped topology | Adds unrequested credential/control-plane fan-out | Rejected |
| Separate Agent + generation-fenced placement | Stable identity and explicit split-brain boundary | Requires future stores/APIs/supervisor | Accepted as architecture only |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `docs/researches/agent-identity-placement-decision.md` | Add | ADR-025 context, decision, invariants, alternatives, consequences, and implementation trigger |
| `docs/architecture/sdk-architecture.md` | Modify | Add Device/Agent/AgentPlacement/RuntimeSession terminology and ADR-025 ledger row |
| `docs/researches/README.md` | Modify | Index ADR-025 |

### Code Snippets
None; docs-only.

### Data Flow

Current: `dispatch → device selection → TaskStore(taskId, deviceId, runtime) → task.offer → runtime session`.

Future trigger only: `Agent authority → AgentPlacement(agentId, deviceId, generation, lease) → Device supervisor → AgentObservation + RuntimeSession`.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Docs imply feature exists | Medium | High | Mark Agent/placement as unimplemented and keep current Local Agent CLI path explicit |
| Protocol v1 drift | Low | High | State byte-for-byte freeze and authorize no schema/source changes |
| Hidden scheduler fallback | Medium | High | Require single placement authority, generation/lease fencing, and fail-closed stale commands |
| Over-copy RAFT product semantics | Medium | Medium | Keep multi-control-plane attachment out of scope without a proven product requirement |

## Task Contracts
- Contract file: `tasks/contracts/20260810-1514-adr-025-device-agent-identity.contract.md`
- Review file: `tasks/reviews/20260810-1514-adr-025-device-agent-identity.review.md`
- Implementation notes file: `tasks/notes/20260810-1514-adr-025-device-agent-identity.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260810-1514-adr-025-device-agent-identity.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: one docs-only ADR projection commit.
- **Rollback surface**: three documentation files plus workflow artifacts.
- **Verification boundary**: exact terminology/ledger/index grep, `git diff --check`, Mermaid extraction/rendering, strict workflow and contract verification.
- **Review/acceptance boundary**: reviewer must confirm the ADR does not claim first-class Agent fleet implementation or authorize production work.
- **High-risk surface**: canonical identity and placement authority semantics.
- **Why not checklist row**: this freezes a cross-module invariant and future schema boundary, so it requires a durable ADR and acceptance evidence.

## Evidence Contract

- **State/progress path**: this plan and its generated contract/review/notes.
- **Verification evidence**: reverse case report plus current source/docs trace; strict repo workflow outputs.
- **Evaluator rubric**: present-vs-target truthfulness, distinct identities, one placement authority, protocol freeze, no production diff.
- **Stop condition**: any required production/schema/protocol edit, or evidence that current BYOK already owns persistent Agent lifecycle.
- **Rollback surface**: documentation projection only.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Activate the docs-only contract with exactly scoped allowed paths.
- [x] Add ADR-025 and canonical architecture/index projections.
- [x] Verify semantic markers, Markdown (no Mermaid fence changed), strict workflow, and contract.
- [ ] Record review evidence and close the docs-only workflow without publishing or merging.
