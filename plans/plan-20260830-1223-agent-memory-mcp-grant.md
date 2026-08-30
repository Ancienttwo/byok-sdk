# Plan: Grant the reserved agent-memory MCP tools under readonly policy

> **Status**: Completed
> **Created**: 20260830-1223
> **Slug**: agent-memory-mcp-grant
> **Artifact Level**: work-package
> **Promotion Reason**: The reserved `byokagentmemory` MCP server is injected after strict Agent admission but receives no runtime grant: Claude auto-denies its tools under `readonly` and Codex refuses them under `approval_policy=never`, so Agent memory is unusable in exactly the mode Private Agent Chat runs in. Same defect class as the projected-toolset and reserved-message grants just shipped.
> **Verification Boundary**: client unit tests (fake-claude/fake-codex) asserting the memory server's tools are granted on both runtimes alongside the message server, no other widening; live smoke on the real CLIs if the existing memory smoke exists, otherwise a unit-only slice; `bun run build && bun run typecheck && bun run test`.
> **Rollback Surface**: revert one client commit.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260830-1223-agent-memory-mcp-grant.contract.md`
> **Task Review**: `tasks/reviews/20260830-1223-agent-memory-mcp-grant.review.md`
> **Implementation Notes**: `tasks/notes/20260830-1223-agent-memory-mcp-grant.notes.md`

## Agentic Routing
- Selected route: bounded main-thread bugfix
- Routing reason: one cross-adapter grant invariant and one explicit breaking MCP rename; no broad research or parallel write ownership is needed.
- Due diligence:
  - P1 map: `TaskRunner` injects SDK-reserved `byokagentmemory`; `agent-memory-mcp-server.ts` owns its tool names; Claude and Codex adapters own runtime-specific grants; `mcp-tool-grants.ts` is the shared grant composition seam.
  - P2 trace: strict Agent task -> reserved memory server in `mcpServers` -> adapter `prepare()` -> Claude `--allowedTools` or Codex `enabled_tools` + per-tool `approval_mode` -> helper `tools/list` / `tools/call`. Dot-named tools cannot survive Codex's flat TOML-key boundary.
  - P3 decision rationale: one-shot rename to `memory_recall` / `memory_save`, no aliases; bind message and memory helper constants through one reserved-server grant table consumed by both adapters. At 10x scale the first pressure remains per-task helper/process admission, not this static two-entry map.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260830-1223-agent-memory-mcp-grant.md`
- Sprint contract: `tasks/contracts/20260830-1223-agent-memory-mcp-grant.contract.md`
- Sprint review: `tasks/reviews/20260830-1223-agent-memory-mcp-grant.review.md`
- Implementation notes: `tasks/notes/20260830-1223-agent-memory-mcp-grant.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260830-1223-agent-memory-mcp-grant.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260830-1223-agent-memory-mcp-grant.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260830-1223-agent-memory-mcp-grant.md`.

## Goal

Under `readonly`, the reserved agent-memory server's tools are pre-granted on Claude (`--allowedTools mcp__byokagentmemory__<tool>`) and Codex (`enabled_tools` + per-tool `approval_mode="approve"`) exactly the way the reserved message server is, using the server's static SDK-owned tool list (no probe: the binary is SDK-owned, like the message server). Nothing else widens.

## Approach
### Strategy
Extend the reserved-server grant path (the same helper the message server uses) with the memory server's tool names sourced from the memory MCP binary's own exported constants, so the names cannot drift.
### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Rename to flat underscore names | Expressible by both runtime permission surfaces; preserves strict allowlisting | Breaking MCP name change | Chosen; SDK-reserved/model-only surface, no downstream caller contract found |
| Allow dots in grant-name validation | Avoids rename | Codex TOML authority lands in a nested table and silently fails | Rejected |
| Generate a separate Codex config file | Could quote arbitrary keys | Much larger config-authority and lifecycle surface | Rejected |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/bin/agent-memory-mcp-server.ts` | modify | Rename the two helper-owned tool constants, without aliases. |
| `packages/client/src/adapters/mcp-tool-grants.ts` | modify | Add the single reserved server -> tool names table. |
| Claude/Codex adapter + client tests | modify | Consume the shared reserved grants and prove exact runtime argv. |
| `CHANGELOG.md` / architecture / task evidence | modify | Record the breaking one-shot rename and verification. |

### Code Snippets
### Data Flow

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Old tool name remains accepted or documented as current | Medium | Medium | No alias; source/smoke literals and current architecture updated; repo search check. |
| Reserved approval server is accidentally pre-granted | Low | High | Grant table contains message + memory only and documents why `byokapproval` is excluded. |
| Global Codex/Claude authority widens | Low | High | Assert global `never`, readonly built-ins empty, and exact two-tool grants. |

## Task Contracts
- Contract file: `tasks/contracts/20260830-1223-agent-memory-mcp-grant.contract.md`
- Review file: `tasks/reviews/20260830-1223-agent-memory-mcp-grant.review.md`
- Implementation notes file: `tasks/notes/20260830-1223-agent-memory-mcp-grant.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260830-1223-agent-memory-mcp-grant.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: one isolated client bugfix commit; no publish/push/merge authority.
- **Rollback surface**: revert the isolated commit; no persisted data migration.
- **Verification boundary**: focused adapter/memory tests, client build checks, then root required checks if dependencies are available.
- **Review/acceptance boundary**: source acceptance only; registry and downstream runtime remain separate.
- **High-risk surface**: runtime permission composition and breaking MCP tool identifier.
- **Why not checklist row**: the tool rename is an external MCP contract decision shared by two adapters.

## Evidence Contract

- **State/progress path**: this plan plus matching notes/review.
- **Verification evidence**: regression guard and repo commands named in the contract.
- **Evaluator rubric**: exact grants only, no dotted runtime keys, no alias, no global widening.
- **Stop condition**: any runtime requires a compatibility alias or cannot read back the exact flat-name grant.
- **Rollback surface**: isolated source diff only.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] **T1** grant memory server tools on both adapters via the reserved-server path, tests, CHANGELOG. Verify: `bun run build && bun run typecheck && bun run test`.
