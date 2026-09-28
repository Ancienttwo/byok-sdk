# Task Contract: 20260928-hermes-memory-identity

> **Status**: Active
> **Task Profile**: code-change
> **Plan**: plans/plan-20260928-0217-hermes-bot-adoption.md
> **Owner**: assigned worker

## Why

User approved the complete WP1-I implementation under docs/researches/2026-09-28-prepared-agent-memory-contract.md.

## Goal

Implement C3 truthful sdk-helper subject for helperId agent-memory and finite entries agent-memory-describe|agent-memory-mcp. Reuse install record, measurements and spawn reverify; no fake runtime/MCP subject. Late lifecycle env names BYOK_STORE_DIR/BYOK_PRODUCT_ID/BYOK_AGENT_MEMORY_CONTEXT only accepted for attested execution role; descriptor forbids all three, Host MCP still forbids memory context. Include closure/interpreter/argv drift and descriptor credential rejection tests. Publish exact resolver/reverify exports early for root/helper consumers. Preserve existing runtime/MCP semantics.

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
  - packages/implementation-identity/src/identity.ts
  - packages/implementation-identity/src/index.ts
  - packages/implementation-identity/src/spawn-binding.ts
  - packages/implementation-identity/src/__tests__/sdk-memory-identity.test.ts
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - packages/implementation-identity/src/identity.ts
    - packages/implementation-identity/src/index.ts
    - packages/implementation-identity/src/spawn-binding.ts
    - packages/implementation-identity/src/__tests__/sdk-memory-identity.test.ts
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
      "command": "bun run --cwd packages/implementation-identity test -- src/__tests__/sdk-memory-identity.test.ts",
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
