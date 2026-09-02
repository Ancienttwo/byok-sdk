# Plan: Codex follow-up turns keep MCP server config

> **Status**: Approved
> **Created**: 20260830-1110
> **Slug**: codex-followup-mcp-config
> **Artifact Level**: work-package
> **Promotion Reason**: `CodexSession.followUp` passes only `mapping.args`, never `codexMcpConfigArgs`, so a resumed Codex turn loses `--ignore-user-config` and every `mcp_servers.*` key — the reserved message server and any projected toolset vanish after turn one. Downstream Private Agent Chat's second turn is a resume.
> **Verification Boundary**: client unit test asserting resume argv carries the same MCP config + grants as the first turn; `smoke:codex-toolset-permission` extended with one follow-up turn; `bun run build && bun run typecheck && bun run test`.
> **Rollback Surface**: revert one client commit.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260830-1110-codex-followup-mcp-config.contract.md`
> **Task Review**: `tasks/reviews/20260830-1110-codex-followup-mcp-config.review.md`
> **Implementation Notes**: `tasks/notes/20260830-1110-codex-followup-mcp-config.notes.md`

## Agentic Routing
- Selected route:
- Routing reason:
- Due diligence:
  - P1 map:
  - P2 trace:
  - P3 decision rationale:

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260830-1110-codex-followup-mcp-config.md`
- Sprint contract: `tasks/contracts/20260830-1110-codex-followup-mcp-config.contract.md`
- Sprint review: `tasks/reviews/20260830-1110-codex-followup-mcp-config.review.md`
- Implementation notes: `tasks/notes/20260830-1110-codex-followup-mcp-config.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260830-1110-codex-followup-mcp-config.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260830-1110-codex-followup-mcp-config.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260830-1110-codex-followup-mcp-config.md`.

## Goal

A Codex follow-up (`codex exec resume`) turn receives exactly the MCP server config, `--ignore-user-config`, `enabled_tools` and per-tool `approval_mode` grants that the first turn received, derived from the same frozen start input — no re-probe, no widening.

## Approach
### Strategy
Reuse the first turn's computed `codexMcpConfigArgs(servers, grants)` (store it on the session at start) and append it in `followUp`; add a fake-codex assertion and one live follow-up smoke step.
### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|

### Code Snippets
### Data Flow

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|

## Task Contracts
- Contract file: `tasks/contracts/20260830-1110-codex-followup-mcp-config.contract.md`
- Review file: `tasks/reviews/20260830-1110-codex-followup-mcp-config.review.md`
- Implementation notes file: `tasks/notes/20260830-1110-codex-followup-mcp-config.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260830-1110-codex-followup-mcp-config.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**:
- **Rollback surface**:
- **Verification boundary**:
- **Review/acceptance boundary**:
- **High-risk surface**:
- **Why not checklist row**:

## Evidence Contract

- **State/progress path**:
- **Verification evidence**:
- **Evaluator rubric**:
- **Stop condition**:
- **Rollback surface**:

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] **T1** fix `followUp` + unit test + smoke follow-up step + CHANGELOG line. Verify: `bun run build && bun run typecheck && bun run test`, `bun run --filter '@byok-sdk/client' smoke:codex-toolset-permission`.
