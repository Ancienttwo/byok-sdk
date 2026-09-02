# Plan: Grant projected MCP toolset tools under readonly policy (Claude + Codex)

> **Status**: Executing
> **Created**: 20260830-0302
> **Slug**: readonly-toolset-mcp-grant
> **Artifact Level**: work-package
> **Promotion Reason**: A downstream consumer (salesko Private Agent Chat, plan `plan-20260830-0134-private-agent-salesko-read-tools`) proved with a Gate 0 falsifier that a projected `requiredToolsets` MCP server is visible (`tools/list`) but never callable (`tools/call`) under `policy.mode = readonly` on both Claude and Codex. Toolset projection is core SDK capability; the fix belongs here, not in a host workaround.
> **Verification Boundary**: `packages/client` unit tests with fake CLIs + live adapter tests against real `claude` 2.1.251 / `codex-cli` 0.149.0; then the downstream falsifier `SALESKO_GATE0_LIVE=1 bun test apps/local-agent/src/salesko-read-tools-gate0.falsifier.ts` in `/Users/kito/Projects/salesko-new-wt-private-agent-salesko-read-tools` against the locally built client (9/9, the two `F4 REFUTED` tests flipping to pass).
> **Rollback Surface**: revert the client change; no protocol or store shape changes.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260830-0302-readonly-toolset-mcp-grant.contract.md`
> **Task Review**: `tasks/reviews/20260830-0302-readonly-toolset-mcp-grant.review.md`
> **Implementation Notes**: `tasks/notes/20260830-0302-readonly-toolset-mcp-grant.notes.md`

## Agentic Routing
- Selected route:
- Routing reason:
- Due diligence:
  - P1 map:
  - P2 trace:
  - P3 decision rationale:

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260830-0302-readonly-toolset-mcp-grant.md`
- Sprint contract: `tasks/contracts/20260830-0302-readonly-toolset-mcp-grant.contract.md`
- Sprint review: `tasks/reviews/20260830-0302-readonly-toolset-mcp-grant.review.md`
- Implementation notes: `tasks/notes/20260830-0302-readonly-toolset-mcp-grant.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260830-0302-readonly-toolset-mcp-grant.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260830-0302-readonly-toolset-mcp-grant.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260830-0302-readonly-toolset-mcp-grant.md`.

## Goal

Under `policy.mode = 'readonly'` with `allowTools: []`, a task whose offer carries `requiredToolsets` must be able to call the tools of exactly the projected toolset MCP servers on Claude and Codex, while built-in shell/file/write tools stay disabled and the reserved SDK servers keep their existing grants.

## Observed defect (downstream Gate 0, `@byok-sdk/client` 0.10.1)

- Claude: `mapPermissionPolicyToClaudeArgs` readonly branch emits `--permission-mode default --tools <READONLY ∩ allowTools>` = `--tools ""`. `--tools` governs built-ins only; MCP servers arrive via `--mcp-config` but are never pre-granted, and `-p` mode auto-denies (`system:permission_denied`). Verified fix: append `--allowedTools mcp__<server>__<tool>` per projected toolset tool, keep `--tools ""`.
- Codex: `mapPermissionPolicyToCodexArgs` pins `approval_policy=never`; every MCP call fails "requires approval". The unmerged commit `9110878` (branch `codex/packed-host-sdk-helper`) already solves this for the reserved message server with `mcp_servers.<name>.enabled_tools=[…]` + `mcp_servers.<name>.tools.<tool>.approval_mode="approve"` (Codex ≥ 0.149), plus a version/approval preflight probe. Generalize that mechanism to projected toolset servers.

## Approach
### Strategy
Base the worktree on `codex/packed-host-sdk-helper` (contains `9110878`), so the toolset grant reuses the reserved-message approval mechanism instead of duplicating it. Grant is per projected server and per discovered tool, never a wildcard; the tool list comes from the toolset registry's own `tools/list` observation (it already performs it for readiness). Unknown/unlisted tools remain ungranted. Both adapters fail closed if the grant cannot be expressed (same shape as existing `ok:false` mappings).

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Per-tool grant from registry `tools/list` (`--allowedTools mcp__s__t`, `tools.t.approval_mode=approve`) | Exact, no widening, mirrors `9110878` | Needs the tool list before spawn; a server that adds tools mid-run needs a restart | **Selected** |
| Server-wide grant (`--allowedTools mcp__s`, Codex server-level approval if it exists) | No tool list needed | Claude form unverified; Codex server-level key unverified; grants future tools silently | Only if per-tool is impossible, and only after verifying the CLI accepts it |
| Widen `allowTools` / `approval_policy` | Trivial | Opens shell/file tools — violates readonly | Rejected |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/adapters/claude/permission-mapping.ts` / `claude-adapter.ts` | modify | Mapping takes the projected toolset servers' tool identifiers; readonly emits `--allowedTools mcp__<server>__<tool>,…` alongside `--tools <effective>`; doc comment records the `--tools` vs `--allowedTools` split with the live probe evidence. |
| `packages/client/src/adapters/codex/codex-adapter.ts` / `permission-mapping.ts` | modify | `codexMcpConfigArgs` emits `enabled_tools` + `tools.<tool>.approval_mode="approve"` for projected toolset servers (same keys as the reserved message server); reuse/extend the version preflight so Codex < 0.149 rejects before spawn. |
| `packages/client/src/daemon/task-runner.ts` / `toolset-registry.ts` | modify | Pass the resolved toolset servers' tool names into `RuntimeOperationStartInput` (or equivalent) so adapters grant exactly those. |
| `packages/client/src/__tests__/*` | modify/add | Fake-CLI arg assertions for both adapters; live tests behind the repo's existing live-test gate against a tiny stdio echo MCP server: readonly + toolset → call succeeds; no toolset → no grant; built-ins still absent. |
| `packages/client/README.md`, `CHANGELOG.md` | modify | Document the readonly + toolset grant contract and Codex minimum version. |

### Code Snippets
(see `9110878` for the Codex keys; Claude: `['--permission-mode','default','--tools',effective.join(','),'--allowedTools',grants.join(',')]`)

### Data Flow
registry `tools/list` → `RuntimeOperationStartInput.mcpServers[name].tools` → adapter mapping → CLI argv.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Claude `--allowedTools` with `--tools ""` still denies in some builds | low | fix fails | Live test against installed 2.1.251 (already verified manually by the downstream falsifier) |
| Codex per-tool `approval_mode` ignored for non-reserved servers | low | fix fails | Live test; preflight probe as in `9110878` |
| Granting tools the registry did not observe | — | widening | Grant only names returned by the registry's `tools/list`; assert in unit tests |
| Base branch `codex/packed-host-sdk-helper` is ahead of `main` by 4 unmerged commits | certain | merge ordering | Report; the PR for this plan targets that branch or lands after it merges — user decides |

## Task Contracts
- Contract file: `tasks/contracts/20260830-0302-readonly-toolset-mcp-grant.contract.md`
- Review file: `tasks/reviews/20260830-0302-readonly-toolset-mcp-grant.review.md`
- Implementation notes file: `tasks/notes/20260830-0302-readonly-toolset-mcp-grant.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260830-0302-readonly-toolset-mcp-grant.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: one client PR on top of `codex/packed-host-sdk-helper`.
- **Rollback surface**: revert.
- **Verification boundary**: as header.
- **Review/acceptance boundary**: gatekeeper after T1; downstream falsifier 9/9 is the acceptance oracle.
- **High-risk surface**: permission mapping — any widening beyond projected toolset tools is a security regression.
- **Why not checklist row**: two adapters, task-runner plumbing, live tests, downstream re-verification.

## Evidence Contract

- **State/progress path**: this plan's Task Breakdown; notes file.
- **Verification evidence**: `bun run build && bun run typecheck && bun run test` output; live adapter test output; downstream falsifier output (9 pass).
- **Evaluator rubric**: readonly + toolset → tool call succeeds on both runtimes; no toolset → nothing granted; built-ins unchanged; unknown tool not granted; Codex < 0.149 rejected before spawn.
- **Stop condition**: if per-tool grant cannot be expressed on a runtime and the server-wide form is unverifiable, stop and report — do not widen.
- **Rollback surface**: revert.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] **T1 client fix** — Claude `--allowedTools` grant, Codex `enabled_tools`/`approval_mode` grant generalized from `9110878`, task-runner passes registry-observed tool names, unit + live tests, README/CHANGELOG. Verify: `bun run build && bun run typecheck && bun run test` in this worktree.
- [x] **T2 downstream re-verification** — build client, overlay it into `/Users/kito/Projects/salesko-new-wt-private-agent-salesko-read-tools/node_modules/@byok-sdk/client` (bun link or copied dist, not committed), run `SALESKO_GATE0_LIVE=1 bun test apps/local-agent/src/salesko-read-tools-gate0.falsifier.ts` → the two `F4 REFUTED` tests fail as designed (they pin the defect); flip them to positive assertions in the salesko worktree so the suite is 9/9. Record outputs in both notes files.
- [ ] **T3 gate** — gatekeeper on the client diff; then user decides release train (0.10.2 vs next) and the packed-host branch merge order.
