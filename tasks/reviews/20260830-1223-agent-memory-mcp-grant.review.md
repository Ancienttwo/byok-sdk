# Task Review: agent-memory-mcp-grant

> **Status**: Passed
> **Plan**: plans/plan-20260830-1223-agent-memory-mcp-grant.md
> **Contract**: tasks/contracts/20260830-1223-agent-memory-mcp-grant.contract.md
> **Notes File**: tasks/notes/20260830-1223-agent-memory-mcp-grant.notes.md
> **Last Updated**: 2026-08-30 14:10
> **Recommendation**: pass for local source handoff; registry and downstream runtime remain separate gates

## Human Review Card

- Verdict: source behavior and repository gates passed.
- Intended files changed: memory MCP names, shared reserved grants, Claude/Codex composition, focused tests/smokes, changelog and current architecture.
- Residual risks: breaking public MCP name; no registry or downstream runtime proof is in scope.

## Verification Evidence

- Pre-fix regression: two failures in `toolset-mcp-grant.test.ts`, proving Claude emitted no memory allow and Codex emitted no memory approval.
- Post-fix focused guard: `vitest run` passed 3 files / 26 tests with 5 platform skips; the dedicated grant file passed 15/15.
- Root commands: `bun run build`, `bun run typecheck`, and `bun run test` passed after code freeze; full tests passed 3,303 with 105 skips.
- Workflow: `repo-harness run check-task-workflow --strict` passed.
- Contract: `repo-harness run verify-contract --contract tasks/contracts/20260830-1223-agent-memory-mcp-grant.contract.md --strict` fulfilled 18/18 criteria.
- Diff: `git diff --check` passed; current source/docs contain no dotted external MCP tool name except explicit negative assertions and the distinct internal `agent_memory.*` control RPC.

## Behavior Diff Notes

- `memory_recall` and `memory_save` replace the dotted names without aliases.
- Claude and Codex pre-grant only these helper-owned names when `byokagentmemory` is present.
- Codex's global approval and sandbox settings are unchanged.

## Residual Risks / Follow-ups

- Registry publication and downstream fresh-session runtime verification remain separate gates.

## Summary

- Exact flat memory tool names are now grantable on Claude and Codex without widening global policy or introducing a compatibility authority.
