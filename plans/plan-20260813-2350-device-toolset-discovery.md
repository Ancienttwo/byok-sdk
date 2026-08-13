# Plan: Device toolset inventory discovery

> **Status**: Executing
> **Created**: 20260813-2350
> **Slug**: device-toolset-discovery
> **Planning Source**: codex-plan-or-waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260813-2350-device-toolset-discovery.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20260813-2350-device-toolset-discovery.md`; after execution revert branch `codex/device-toolset-discovery` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260813-2350-device-toolset-discovery.contract.md`
> **Task Review**: `tasks/reviews/20260813-2350-device-toolset-discovery.review.md`
> **Implementation Notes**: `tasks/notes/20260813-2350-device-toolset-discovery.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan-or-waza-think planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260813-2350-device-toolset-discovery.md`
- Sprint contract: `tasks/contracts/20260813-2350-device-toolset-discovery.contract.md`
- Sprint review: `tasks/reviews/20260813-2350-device-toolset-discovery.review.md`
- Implementation notes: `tasks/notes/20260813-2350-device-toolset-discovery.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260813-2350-device-toolset-discovery.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260813-2350-device-toolset-discovery.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260813-2350-device-toolset-discovery.md`.

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
- Contract file: `tasks/contracts/20260813-2350-device-toolset-discovery.contract.md`
- Review file: `tasks/reviews/20260813-2350-device-toolset-discovery.review.md`
- Implementation notes file: `tasks/notes/20260813-2350-device-toolset-discovery.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260813-2350-device-toolset-discovery.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260813-2350-device-toolset-discovery.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260813-2350-device-toolset-discovery.md`; after execution revert branch `codex/device-toolset-discovery` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260813-2350-device-toolset-discovery.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260813-2350-device-toolset-discovery.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260813-2350-device-toolset-discovery.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260813-2350-device-toolset-discovery.contract.md`, `tasks/reviews/20260813-2350-device-toolset-discovery.review.md`, and `tasks/notes/20260813-2350-device-toolset-discovery.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260813-2350-device-toolset-discovery.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260813-2350-device-toolset-discovery.md`; after execution revert branch `codex/device-toolset-discovery` or the explicitly reviewed diff.

## Captured Planning Output

# Device toolset inventory discovery

## Goal

Expose the validated logical IDs configured in DaemonConfig.mcpToolsets through both conn.hello and hosted presence discovery, without exposing command, args, environment, headers, or credentials.

## Architecture

- Protocol owns ToolsetId validation, inventory bounds, and the optional conn.hello field.
- Client derives one deterministic sorted snapshot from the already validated local registry.
- Embedded server projects the hello snapshot through MachineInfo.
- Hosted cloud accepts the same IDs on the authenticated presence heartbeat and returns them through listPresence.
- Core presence stores persist the optional inventory; Postgres receives one forward-only migration.
- Local task resolution remains the final fail-closed authority because discovery is TTL-bounded and may be stale.

## Task Breakdown

1. Add bounded ConfiguredToolsets schema and conn.hello projection.
2. Project the local registry snapshot through client WS hello and presence heartbeat.
3. Persist and return configuredToolsets in in-memory and Postgres presence stores.
4. Surface the hello inventory in embedded MachineInfo.
5. Add protocol, conformance, client, cloud, server, migration, and hosted Salesko E2E coverage.
6. Run targeted package checks, then repository required checks.

## Non-goals

- No remote executable connector definitions.
- No connector lifecycle, health, reload, approval, policy, or audit work.
- No cloud-side authorization decision based on presence.
- No compatibility fallback or inferred inventory.

## Acceptance

- A daemon configured with salesko.connectors publishes only that logical ID through hello and hosted listPresence.
- A configured empty registry is observable as an empty array; omission remains legacy or unknown.
- Invalid, duplicate, or oversized inventories fail schema validation.
- No command path, argument, environment value, header, or secret appears in discovery payloads.
- Existing local task resolution still declines a missing required toolset.
- pnpm recursive typecheck, test, build, and strict task workflow checks pass.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Execute captured plan: Device toolset inventory discovery
