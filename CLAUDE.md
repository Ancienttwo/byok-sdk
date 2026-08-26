# Repo Agent Context

This is the root routing contract for Claude Code and Codex. Load this before task-local artifacts.

## Workflow Contract

- Use first principles, one source of truth, and no steady-state compatibility paths.
- Treat `docs/spec.md` as product truth; `tasks/current.md` is derived state and `tasks/todos.md` is the deferred-goal ledger.
- Keep current execution in the active plan's `## Task Breakdown`; use contracts, reviews, notes, workstreams, and handoff artifacts for durable progress.
- Read `.ai/context/capabilities.json` and `.ai/context/context-map.json` before adding scoped agent context.
- Keep `_ref/` ignored external reference material and `_ops/` ignored local operations state.

## Required Checks

- `bun run build`
- `bun run typecheck`
- `bun run test`
- `repo-harness run check-task-workflow --strict`

<!-- BEGIN ARCHITECTURE CONTRACT -->
## Architecture Contract

- Functional block: `packages`
- Capability ID: `root`
- Matched prefix: `packages`
- Architecture domain: `sdk`
- Architecture capability: `sdk-root`
- Architecture module: `docs/architecture/sdk-architecture.md`
- Last architecture event: 2026-08-26T15:29:46+0800
- Last changed path: `packages/client/src/__tests__/fixtures/fake-codex.mjs`
- Severity: low
- Change type: source-change
- Module responsibility: Keep this block aligned with the local boundary described by surrounding human-owned context.
- Entrypoints: `packages`
- Allowed dependencies: Follow root `AGENTS.md` / `CLAUDE.md` and this local contract.
- Forbidden dependencies: Do not cross sibling app/service/package boundaries without an architecture snapshot or explicit plan.
- Runtime path: `packages`
- LSP/tooling profile: `typescript-lsp`
- Verification: Use root required checks plus local commands recorded in this capability contract.
- Latest snapshot: `(none yet)`
- Semantic diagram source: `docs/architecture/sdk-architecture.md`
- Pending architecture request: `docs/architecture/requests/root.md`

## Active Workstreams

- (none yet)

## Current Session Projection

- Durable progress lives under `tasks/workstreams/root`.
- `tasks/current.md` is the tracked derived status snapshot; it is not a live lock or task source.
- `tasks/todos.md` is the deferred-goal ledger; current execution slices stay in the active plan's `## Task Breakdown`.
<!-- END ARCHITECTURE CONTRACT -->
