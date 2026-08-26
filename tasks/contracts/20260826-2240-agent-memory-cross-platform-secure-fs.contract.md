# Task Contract: agent-memory-cross-platform-secure-fs

> **Status**: Fulfilled
> **Plan**: plans/plan-20260826-2240-agent-memory-cross-platform-secure-fs.md
> **Task Profile**: code-change
> **Owner**: kito
> **Capability ID**: root
> **Review File**: `tasks/reviews/20260826-2240-agent-memory-cross-platform-secure-fs.review.md`
> **Notes File**: `tasks/notes/20260826-2240-agent-memory-cross-platform-secure-fs.notes.md`

## Goal

Provide a pure-JavaScript-compatible external secure-filesystem helper path for
Agent memory, enable it on macOS only after a real race proof, and keep Windows
fail-closed until an equivalent native proof exists.

## Scope

- In scope: external helper protocol/source, task-scoped lifecycle, exact root
  identity, macOS proof, Windows cross-build and dormant native test entry,
  Linux parity, packageability and architecture documentation.
- Out of scope: binary distribution/signing, npm native carrier packages,
  production enablement, publish/merge/deploy, and memory product semantics.

## Falsifier

The direction is wrong if the helper needs a `.node` dependency/install script,
uses PATH fallback, cannot bind the exact leased Agent-home object, or any race
test changes an outside sentinel. Windows support is not admitted from a
cross-build alone.

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260826-1725-agent-memory-phase2.md
  - plans/plan-20260826-2240-agent-memory-cross-platform-secure-fs.md
  - tasks/contracts/20260826-2240-agent-memory-cross-platform-secure-fs.contract.md
  - tasks/notes/20260826-2240-agent-memory-cross-platform-secure-fs.notes.md
  - tasks/reviews/20260826-2240-agent-memory-cross-platform-secure-fs.review.md
  - docs/architecture/sdk-architecture.md
  - packages/client/
  - scripts/release/check-package-graph.mjs
  - templates/packaging/
  - .github/workflows/ci.yml
  - .ai/harness/
```

## Exit Criteria

```yaml
exit_criteria:
  files_exist:
    - plans/plan-20260826-2240-agent-memory-cross-platform-secure-fs.md
    - packages/client/native/agent-memory-fs/go.mod
  artifacts_exist:
    - tasks/notes/20260826-2240-agent-memory-cross-platform-secure-fs.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/agent-memory-mcp.test.ts
    - path: packages/client/src/__tests__/agent-memory-guidance.test.ts
    - path: packages/client/src/__tests__/agent-memory-fs-helper.test.ts
  commands_succeed:
    - cd packages/client/native/agent-memory-fs && GOTOOLCHAIN=go1.26.5 go test ./...
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Rollback Point

- Checkpoint: Phase 2 source candidate before this work-package.
- Strategy: remove the external helper seam/source and restore Linux-only gate;
  do not leave a dormant compatibility fallback.

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```
