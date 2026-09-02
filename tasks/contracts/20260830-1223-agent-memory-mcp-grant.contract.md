# Task Contract: agent-memory-mcp-grant

> **Status**: Fulfilled
> **Plan**: plans/plan-20260830-1223-agent-memory-mcp-grant.md
> **Task Profile**: bugfix
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-30 14:10
> **Review File**: `tasks/reviews/20260830-1223-agent-memory-mcp-grant.review.md`
> **Notes File**: `tasks/notes/20260830-1223-agent-memory-mcp-grant.notes.md`

## Why

The SDK injects its reserved Agent-memory MCP into strict tasks, but neither runtime can authorize the dot-named tools safely: Claude has no repo proof for the identifier and Codex parses the dotted per-tool TOML key as nested tables.

## Goal

Rename the two SDK-reserved MCP tools once to flat names, pre-grant exactly them under readonly on Claude and Codex, preserve every global permission boundary, and keep one helper-owned source of truth with no compatibility alias.

## Scope

- In scope: memory MCP tool identifiers, shared reserved grant composition, both adapters, focused tests/smokes, current architecture and changelog evidence.
- Out of scope: internal `agent_memory.*` control RPC names, generic grant regex widening, generated Codex config files, publish/push/merge/deploy, downstream rollout.
- Taste constraints: no aliases, dual reads, fallback names, or server wildcards.

## Stop Conditions

- Stop if either runtime cannot express/read back the underscore names exactly.
- Stop if implementation requires a compatibility alias or global approval widening.
- Stop before registry, downstream, deploy, or production actions.

## Falsifier

The direction is wrong if flat names still cannot be represented by either native permission surface, if the reserved approval server is pre-granted, or if a runtime gains any tool beyond message plus the exact two memory tools.

## Root Cause Evidence

- root_cause: `packages/client/src/bin/agent-memory-mcp-server.ts` registered `memory.recall` / `memory.save`, while `packages/client/src/adapters/codex/codex-adapter.ts` composes unquoted flat TOML paths for per-tool approval and both adapters excluded reserved memory from their grant list.
- repro: the regression guard observes no Claude `--allowedTools` and no Codex `enabled_tools` / per-tool approval for `byokagentmemory`; a dotted Codex key would target a nested TOML table.
- regression_guard: packages/client/src/__tests__/toolset-mcp-grant.test.ts
- pre_fix_failure_artifact: .ai/harness/runs/20260830-agent-memory-mcp-grant/pre-fix.txt

## Workflow Inventory

- Source plan: `plans/plan-20260830-1223-agent-memory-mcp-grant.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260830-1223-agent-memory-mcp-grant.review.md`
- Notes file: `tasks/notes/20260830-1223-agent-memory-mcp-grant.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Change Assessment

```json
{"protocol":1,"oracles":[]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - CHANGELOG.md
  - docs/architecture/sdk-architecture.md
  - packages/client/src/adapters/claude/claude-adapter.ts
  - packages/client/src/adapters/codex/codex-adapter.ts
  - packages/client/src/adapters/mcp-tool-grants.ts
  - packages/client/src/agent-memory/index.ts
  - packages/client/src/bin/agent-memory-mcp-server.ts
  - packages/client/src/__tests__/agent-memory-embedded-entry.test.ts
  - packages/client/src/__tests__/agent-memory-mcp.test.ts
  - packages/client/src/__tests__/toolset-mcp-grant.test.ts
  - packages/client/scripts/check-agent-memory-entry.mjs
  - packages/client/scripts/single-file-sdk-helper-smoke.mjs
  - plans/plan-20260830-1223-agent-memory-mcp-grant.md
  - tasks/contracts/20260830-1223-agent-memory-mcp-grant.contract.md
  - tasks/notes/20260830-1223-agent-memory-mcp-grant.notes.md
  - tasks/reviews/20260830-1223-agent-memory-mcp-grant.review.md
  - .ai/harness/runs/20260830-agent-memory-mcp-grant/
```

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - packages/client/src/__tests__/toolset-mcp-grant.test.ts
  artifacts_exist:
    - .ai/harness/runs/20260830-agent-memory-mcp-grant/pre-fix.txt
    - tasks/notes/20260830-1223-agent-memory-mcp-grant.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/toolset-mcp-grant.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: exact two memory tools are callable under readonly on both adapters.
- Edge cases: no memory server means no memory grant; `byokapproval` remains outside the pre-grant table; Codex global approval remains never.
- Regression risks: external tool-name break; explicitly documented and intentionally has no alias.

## Rollback Point

- Commit / checkpoint: isolated branch `codex/agent-memory-mcp-grant`.
- Revert strategy: revert the single slice; no data cleanup.
