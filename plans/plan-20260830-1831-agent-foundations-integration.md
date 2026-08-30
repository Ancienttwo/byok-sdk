# Plan: Agent foundations integration and local team workspace

> **Status**: Executing
> **Created**: 20260830-1831
> **Slug**: agent-foundations-integration
> **Planning Source**: codex-plan-or-waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: 用户已批准把 Pi 基础依赖与跨 harness tmux communication pane 作为下一 minor train 的本地集成单元
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260830-1831-agent-foundations-integration.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20260830-1831-agent-foundations-integration.md`; after execution revert branch `codex/agent-foundations-integration` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260830-1831-agent-foundations-integration.contract.md`
> **Task Review**: `tasks/reviews/20260830-1831-agent-foundations-integration.review.md`
> **Implementation Notes**: `tasks/notes/20260830-1831-agent-foundations-integration.notes.md`

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

- Active plan: `plans/plan-20260830-1831-agent-foundations-integration.md`
- Sprint contract: `tasks/contracts/20260830-1831-agent-foundations-integration.contract.md`
- Sprint review: `tasks/reviews/20260830-1831-agent-foundations-integration.review.md`
- Implementation notes: `tasks/notes/20260830-1831-agent-foundations-integration.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260830-1831-agent-foundations-integration.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260830-1831-agent-foundations-integration.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260830-1831-agent-foundations-integration.md`.

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
- Contract file: `tasks/contracts/20260830-1831-agent-foundations-integration.contract.md`
- Review file: `tasks/reviews/20260830-1831-agent-foundations-integration.review.md`
- Implementation notes file: `tasks/notes/20260830-1831-agent-foundations-integration.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260830-1831-agent-foundations-integration.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260830-1831-agent-foundations-integration.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260830-1831-agent-foundations-integration.md`; after execution revert branch `codex/agent-foundations-integration` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260830-1831-agent-foundations-integration.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260830-1831-agent-foundations-integration.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: 用户已批准把 Pi 基础依赖与跨 harness tmux communication pane 作为下一 minor train 的本地集成单元

## Evidence Contract

- **State/progress path**: `plans/plan-20260830-1831-agent-foundations-integration.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260830-1831-agent-foundations-integration.contract.md`, `tasks/reviews/20260830-1831-agent-foundations-integration.review.md`, and `tasks/notes/20260830-1831-agent-foundations-integration.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260830-1831-agent-foundations-integration.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260830-1831-agent-foundations-integration.md`; after execution revert branch `codex/agent-foundations-integration` or the explicitly reviewed diff.

## Captured Planning Output

# Agent foundations integration and local team workspace

> **Artifact Level**: work-package
> **Status**: Approved
> **Promotion Reason**: The user approved one local integration unit for the foundational Pi packages and cross-harness communication pane; it changes package/runtime contracts and must be independently gated before a future minor release.

## Why

Pi has no equivalent built-in foundation for web access, MCP loading, subagents, todos, or cross-harness collaboration. The first four are already implemented on isolated branches. This slice integrates only gated branches and adds one local-only team communication authority whose tmux view is presentation, never IPC.

## Goal

Produce a local next-minor candidate that combines the approved Pi foundation stack with a durable local TeamWorkspace usable from Pi, Claude, and Codex through one SDK-owned MCP contract, plus an explicit tmux communication pane. tmux must never inject prompts with send-keys or infer protocol state with capture-pane.

## P1 Architecture Map

- Authority: a local TeamWorkspace store/service owns workspace definitions, ordered messages, member receipts, limits, and leases.
- Transport: the existing authenticated local control socket carries workspace operations; an SDK-reserved stdio MCP helper projects exact tools to harnesses.
- View: tmux launches a read-only watcher pane and receives only a body-free doorbell; no runtime process is moved into tmux.
- Frozen: TaskRunner task authority, cloud protocol/server/store, runtime adapter turn transport, and existing agent-message egress semantics.
- Dependency: tmux is an explicit native executable prerequisite for the tmux view, not an npm package and not a global daemon prerequisite. Windows returns a typed unsupported-platform error for this view.

## P2 Concrete Trace

An agent calls `post_team_message`; the helper reads an opaque member lease from environment, sends `{lease, body, contentType}` over the mutually authenticated control socket, the daemon validates the lease and quota, appends+fsyncs an ordered message, and returns an accepted receipt. Another member calls `read_team_messages`, receives only messages after its durable cursor, and advances the cursor only with `ack_team_messages`. `byok-agent team open --view tmux --tmux-bin <absolute>` validates the binary/version, starts a pane that watches the same service, and never transports the message body through tmux argv, pane title, or send-keys.

## P3 Design Decision

Use a daemon-co-resident, TaskRunner-independent local TeamWorkspace. Reusing `send_agent_message` would mislabel peer messages as terminal user replies; injecting pane text would make terminal rendering a second protocol authority. The smallest coherent V1 is local broadcast, three MCP tools, durable ordered storage and receipts, explicit quotas, and one tmux watcher. At 10x scale retention fills first, so quota exhaustion fails closed and no auto-truncation is allowed.

## Falsifier

The direction fails if a strict MCP client cannot complete initialize/initialized/tools/list, if a message can be posted without a valid lease, if ack can move backward or beyond delivered sequence, if restart loses an accepted message, or if any tmux command contains a message body or uses send-keys/capture-pane.

## Task Breakdown

- [x] Re-gate and integrate `readonly-toolset-mcp-grant`, then integrate `pi-subagents-dependency` in dependency order.
- [x] Implement TeamWorkspace durable registry/messages/receipts/lease authority with bounded limits and fail-closed validation.
- [x] Add authenticated control methods and SDK-reserved MCP helper with strict three-tool schema.
- [x] Add `byok-agent team` CLI operations and explicit tmux watcher pane with absolute executable preflight.
- [x] Add targeted durability, authorization, MCP handshake, tmux argv/no-send-keys, and unsupported-platform tests.
- [x] Run build, typecheck, full tests, strict workflow, packed-artifact smoke, and a disposable real-tmux smoke.
- [ ] Freeze independent review evidence; do not push, publish, tag, or deploy.

## Evidence Contract

- State/progress: this plan, its generated contract/notes/review, and the isolated `codex/agent-foundations-integration` worktree.
- Verification: targeted TeamWorkspace/MCP/tmux tests; `bun run build`; `bun run typecheck`; `bun run test`; `repo-harness run check-task-workflow --strict`; package pack/smoke; disposable tmux session proving pane creation and cleanup.
- Evaluator rubric: one durable authority, exact lease/member binding, monotonic receipts, bounded storage, no ambient/PATH tmux selection, no terminal-text IPC, no cloud/task authority change.
- Stop condition: merge gate failure, required change outside the frozen surfaces, or inability to prove accepted-message durability and tmux non-authority.
- Rollback surface: one integration commit set; remove TeamWorkspace control/MCP/CLI surfaces and revert the two feature merges without changing protocol or stored cloud state.

## Promotion Gate

- Merge/PR unit: one local next-minor integration branch; no publication in this slice.
- Rollback surface: source-only commits and local TeamWorkspace v1 directory.
- Independent verification: gatekeeper reviews frozen diff plus real tmux and packed artifact evidence.
- Acceptance boundary: typed receipt or explicit user waiver only after checks are subject-bound.
- High-risk surface: local IPC authentication, lease impersonation, message durability, and subprocess argv/env secrecy.
- Why not checklist-only: this creates a persistent local contract, a new reserved MCP capability, CLI surface, and native executable boundary consumed by three independent harnesses.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Re-gate and integrate `readonly-toolset-mcp-grant`, then integrate `pi-subagents-dependency` in dependency order.
- [x] Implement TeamWorkspace durable registry/messages/receipts/lease authority with bounded limits and fail-closed validation.
- [x] Add authenticated control methods and SDK-reserved MCP helper with strict three-tool schema.
- [x] Add `byok-agent team` CLI operations and explicit tmux watcher pane with absolute executable preflight.
- [x] Add targeted durability, authorization, MCP handshake, tmux argv/no-send-keys, and unsupported-platform tests.
- [x] Run build, typecheck, full tests, strict workflow, packed-artifact smoke, and a disposable real-tmux smoke.
- [ ] Freeze independent review evidence; do not push, publish, tag, or deploy.
