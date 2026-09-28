# Task Contract: 20260928-hermes-memory-helper

> **Status**: Active
> **Task Profile**: code-change
> **Plan**: plans/plan-20260928-0217-hermes-bot-adoption.md
> **Owner**: assigned worker

## Why

User approved the complete WP1-I implementation under docs/researches/2026-09-28-prepared-agent-memory-contract.md.

## Goal

Implement C3 descriptor-only helper role and single operation-classified schema authority. tools/list advertises complete schemas plus SDK metadata; descriptor no credentials/IPC/home, rejects all tools/call. Execution helper supports selected read/read-write grant and rejects save under read before deps call; root separately adds daemon ACL. Use new private context input for mode explicitly, no ordinary-mode fallback (coordinate root). Add shared prepared-capability.ts pure APIs: mode validation/policy/ceiling, typed SDK observation validation from raw tools/list, selected descriptors/fingerprints/digest. Do not own daemon preparer/runtime integration. Coordinate API with root before finalizing. Existing install/service must remain single authority; no MCP registry identity. Test descriptor/execution parity and direct forbidden calls, preserve existing entry import constraints.

## Scope

- In scope: Only exact paths below, in /Users/kito/Projects/byok-sdk-wt-hermes-bot-adoption.
- Out of scope: Other worker/root paths, Host repos, release/deployment, lockfile or dependency installation, commits/pushes.
- You are not alone in the codebase. Preserve all concurrent edits; communicate interface changes and never revert others.

## Stop Conditions

- No compatibility paths or invented attestation. Three fix/reverify rounds per issue maximum.
- Ask parent for newly necessary paths before writing. Root installs/builds dependencies; do not run a competing install/build.

## Falsifier

If an approved constraint cannot be represented with a truthful typed implementation, report the exact code/contract conflict without weakening authority.

## Allowed Paths

```yaml
allowed_paths:
  - packages/client/src/__tests__/agent-memory-embedded-entry.test.ts
  - packages/client/src/__tests__/reserved-mcp-wire-regression.test.ts
  - packages/client/src/bin/agent-memory-mcp-server.ts
  - packages/client/src/bin/sdk-reserved-helper-runners.ts
  - packages/client/src/bin/byok-agent-memory-describe.ts
  - packages/client/src/sdk-reserved-helper-host.ts
  - packages/client/src/daemon/resolve-agent-memory-mcp-bin.ts
  - packages/client/src/agent-memory/prepared-capability.ts
  - packages/client/src/mcp-server/index.ts
  - packages/client/tsup.config.ts
  - packages/client/src/__tests__/agent-memory-describe.test.ts
  - packages/client/src/__tests__/agent-memory-mcp.test.ts
  - packages/client/src/__tests__/sdk-reserved-helper-host.test.ts
  - packages/client/src/__tests__/fixtures/reserved-mcp-wire-baseline.json
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - packages/client/src/bin/agent-memory-mcp-server.ts
    - packages/client/src/bin/sdk-reserved-helper-runners.ts
    - packages/client/src/bin/byok-agent-memory-describe.ts
    - packages/client/src/sdk-reserved-helper-host.ts
    - packages/client/src/daemon/resolve-agent-memory-mcp-bin.ts
    - packages/client/src/agent-memory/prepared-capability.ts
    - packages/client/src/mcp-server/index.ts
    - packages/client/tsup.config.ts
    - packages/client/src/__tests__/agent-memory-describe.test.ts
    - packages/client/src/__tests__/agent-memory-mcp.test.ts
    - packages/client/src/__tests__/sdk-reserved-helper-host.test.ts
    - packages/client/src/__tests__/fixtures/reserved-mcp-wire-baseline.json
  artifacts_exist: []
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "focused",
      "kind": "command",
      "command": "bun run --cwd packages/client test -- src/__tests__/agent-memory-describe.test.ts src/__tests__/agent-memory-mcp.test.ts src/__tests__/sdk-reserved-helper-host.test.ts",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Validate owned implementation after dependency readiness.",
      "inputs": {
        "env": []
      }
    }
  ]
}
```

## Acceptance Notes

Return RESULT DONE/PARTIAL/BLOCKED with exact changed files, exported API, command results and unresolved limitations. Parent integrates and runs full project checks once frozen.
