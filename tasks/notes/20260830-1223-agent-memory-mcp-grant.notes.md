# Implementation Notes: agent-memory-mcp-grant

> **Status**: Completed
> **Plan**: plans/plan-20260830-1223-agent-memory-mcp-grant.md
> **Contract**: tasks/contracts/20260830-1223-agent-memory-mcp-grant.contract.md
> **Review**: tasks/reviews/20260830-1223-agent-memory-mcp-grant.review.md
> **Last Updated**: 2026-08-30 14:10

## Design Decisions

- Human-approved one-shot rename: `memory.recall` / `memory.save` become `memory_recall` / `memory_save`; no alias or dual-name migration path.
- Keep helper constants as tool-name authority. `mcp-tool-grants.ts` owns only the reserved server-to-tools binding shared by Claude and Codex.
- The table intentionally excludes `byokapproval`: that server is Claude's interactive permission channel, not a non-interactive pre-grant.
- Codex keeps `approval_policy=never`, uses exact `enabled_tools` plus per-tool `approve`, and preflights/read-backs both memory tools before start.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Flat underscore rename | Use | Expressible by both runtime permission authorities. |
| Relax grant-name regex | Reject | Does not fix Codex TOML nesting. |
| Generated Codex config | Reject | Expands config lifecycle and authority beyond this defect. |
| Compatibility alias | Reject | Creates two steady-state public tool authorities. |

## Evidence Links

- Regression guard: `packages/client/src/__tests__/toolset-mcp-grant.test.ts`
- Pre-fix failure: `.ai/harness/runs/20260830-agent-memory-mcp-grant/pre-fix.txt`
- Checks: `.ai/harness/checks/latest.json`

## Verification Result

- Focused Vitest: 3 files passed, 26 tests passed, 5 platform skips.
- Root `build`, `typecheck`, and `test` passed after code freeze; the full test run passed 3,303 tests with 105 environment/platform skips.
- Strict task workflow passed. Registry, publish, downstream pin, and live runtime remain outside this source gate.
