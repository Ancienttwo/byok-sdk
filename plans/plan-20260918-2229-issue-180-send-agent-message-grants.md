# Plan: Issue 180: grant reserved byokagentmessage tool in claude and pi adapters

> **Status**: Executing
> **Created**: 20260918-2229
> **Slug**: issue-180-send-agent-message-grants
> **Planning Source**: codex-plan-or-waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260918-2229-issue-180-send-agent-message-grants.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20260918-2229-issue-180-send-agent-message-grants.md`; after execution revert branch `codex/issue-180-send-agent-message-grants` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260918-2229-issue-180-send-agent-message-grants.contract.md`
> **Task Review**: `tasks/reviews/20260918-2229-issue-180-send-agent-message-grants.review.md`
> **Implementation Notes**: `tasks/notes/20260918-2229-issue-180-send-agent-message-grants.notes.md`

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

- Active plan: `plans/plan-20260918-2229-issue-180-send-agent-message-grants.md`
- Sprint contract: `tasks/contracts/20260918-2229-issue-180-send-agent-message-grants.contract.md`
- Sprint review: `tasks/reviews/20260918-2229-issue-180-send-agent-message-grants.review.md`
- Implementation notes: `tasks/notes/20260918-2229-issue-180-send-agent-message-grants.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260918-2229-issue-180-send-agent-message-grants.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260918-2229-issue-180-send-agent-message-grants.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260918-2229-issue-180-send-agent-message-grants.md`.

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
- Contract file: `tasks/contracts/20260918-2229-issue-180-send-agent-message-grants.contract.md`
- Review file: `tasks/reviews/20260918-2229-issue-180-send-agent-message-grants.review.md`
- Implementation notes file: `tasks/notes/20260918-2229-issue-180-send-agent-message-grants.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260918-2229-issue-180-send-agent-message-grants.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260918-2229-issue-180-send-agent-message-grants.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260918-2229-issue-180-send-agent-message-grants.md`; after execution revert branch `codex/issue-180-send-agent-message-grants` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260918-2229-issue-180-send-agent-message-grants.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260918-2229-issue-180-send-agent-message-grants.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260918-2229-issue-180-send-agent-message-grants.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260918-2229-issue-180-send-agent-message-grants.contract.md`, `tasks/reviews/20260918-2229-issue-180-send-agent-message-grants.review.md`, and `tasks/notes/20260918-2229-issue-180-send-agent-message-grants.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260918-2229-issue-180-send-agent-message-grants.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260918-2229-issue-180-send-agent-message-grants.md`; after execution revert branch `codex/issue-180-send-agent-message-grants` or the explicitly reviewed diff.

## Captured Planning Output

# Issue #180: grant reserved byokagentmessage tool in claude and pi adapters

## Goal
The SDK-reserved `byokagentmessage` MCP server's single `send_agent_message` tool must be pre-granted by the claude and pi adapters exactly as codex already does, so a task whose offer carries `messageEgress` can satisfy a required Agent message on every runtime, not just codex.

## Verified premises (re-checked at HEAD a6c5a297)
- Shared pre-grant table `packages/client/src/adapters/mcp-tool-grants.ts:31-37` (`PREGRANTED_RESERVED_MCP_TOOLS`) already maps `AGENT_MESSAGE_MCP_SERVER_NAME` -> `[AGENT_MESSAGE_TOOL_NAME]`. The grant authority exists; claude and pi fail to consume it.
- Codex reference: `packages/client/src/adapters/codex/codex-adapter.ts:190-191` consumes ALL reserved grants plus toolset grants, preflighting per-tool approval.
- Claude bug: `packages/client/src/adapters/claude/claude-adapter.ts:218-219` resolves reserved grants then filters to `AGENT_MEMORY_MCP_SERVER_NAME` only, dropping the agent-message grant. The filter landed in b60148ce when the table was memory-only; `byokagentmessage` entered the table later and claude kept the stale slice. The filtered grants flow into `mapPermissionPolicyToClaudeArgs` as `--allowedTools mcp__<server>__<tool>`.
- Pi bug: `packages/client/src/adapters/pi/pi-adapter.ts` `prepare()` has no reserved-grant path at all. Pi's authority surface is the `--tools` CLI allowlist: the pi fork's `_refreshToolRegistry` (`@earendil-works/pi-coding-agent` dist/core/agent-session.js) drops every tool — builtin AND extension-registered — whose name the allowlist does not contain. The SDK extension (`./mcp-extension.ts`) registers reserved-server tools under their bare protocol names (`send_agent_message`), so under `readonly` (allowlist `read,grep,find,ls,subagent,todo`) or `auto` with an explicit `allowTools` list the tool is silently unregistered.
- The approval-channel server is intentionally absent from the pre-grant table (interactive-only) — stays that way.

## Approach
1. Claude adapter: consume the whole reserved table like codex — drop the memory-only `.filter()`, pass all reserved grants into the permission mapping. Memory grants unchanged; mode-by-mode grant rules (readonly/auto granted, plan/confirm withheld) already live in `mapPermissionPolicyToClaudeArgs` and are inherited unchanged.
2. Pi adapter + permission mapping: resolve `resolveReservedMcpToolGrants(input.mcpServers)` in `prepare()` and thread it into `mapPermissionPolicyToPiArgs`, which appends the granted bare tool names to any `--tools` allowlist it emits (readonly base list, auto+allowTools list). When no allowlist would be emitted (`auto` without `allowTools`), none is added: pi's undefined allowlist already admits every extension tool, and naming only the reserved lane would cage pi's native default set. Absence of the reserved servers changes nothing.
3. No codex behavior change. No PermissionPolicy semantics change, no readonly native widening, no compatibility shims.

## File surface
- `packages/client/src/adapters/claude/claude-adapter.ts` (filter removal)
- `packages/client/src/adapters/pi/permission-mapping.ts` (reserved-grant allowlist merge)
- `packages/client/src/adapters/pi/pi-adapter.ts` (reserved grant resolution)
- `packages/client/src/__tests__/toolset-mcp-grant.test.ts` (update the claude readonly reserved-grant expectation that pinned the old filtered output)
- new `packages/client/src/__tests__/agent-message-reserved-grants.test.ts` (claude + pi grant tests: direct tool authorized + server mounted/delivered; absence changes nothing; readonly/allowTools variants)

## Verification
- `bun run build`
- `bun run typecheck`
- `bun test` on the touched/added suites plus `mcp-tool-grants`-related suites: `agent-message-reserved-grants`, `toolset-mcp-grant`, `claude-adapter`, `pi-adapter`, `codex-agent-message-permission`, `agent-message-completion-gate` (pins the final-text->agent-message path and the single-message-body invariant at the daemon level, runtime-agnostic).
- `bun run test` full suite if it completes in reasonable time.

## Constraints
- Commit(s) on branch `claude/issue-180-send-agent-message-grants`, conventional style `fix(adapters): ...`, no AI attribution.
- Scope: adapters + mcp-tool-grants surface + tests only.
- Daemon-level behaviors (b) final-text->agent-message and (c) one message body per turn are already pinned runtime-agnostically by `agent-message-completion-gate.test.ts`; adapters do not participate in those paths, so the new tests cover the adapter-owned grant path (a) per adapter.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] Execute captured plan: Issue 180: grant reserved byokagentmessage tool in claude and pi adapters
