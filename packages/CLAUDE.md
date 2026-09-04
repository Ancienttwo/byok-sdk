# Functional Block Agent Context

Keep this file focused on the local contract for this primary functional block.

<!-- BEGIN CAPABILITY CONTEXT -->
## Capability Context

- Capability ID: `root`
- Domain: `sdk`
- Name: `sdk-root`
- Primary prefix: `packages`
- Architecture module: `docs/architecture/sdk-architecture.md`
- Workstream: `tasks/workstreams/root`

## Positioning

Owns the root capability boundary declared in .ai/context/capabilities.json.

## Source Map

- Primary prefix: `packages` (entrypoint)
- Architecture module: `docs/architecture/sdk-architecture.md` (design-source)
- Workstream: `tasks/workstreams/root` (durable-progress)

## Refresh Hints

- `bun run build`
- `bun run typecheck`
<!-- END CAPABILITY CONTEXT -->

<!-- BEGIN ARCHITECTURE CONTRACT -->
## Architecture Contract

- Functional block: `packages`
- Capability ID: `root`
- Matched prefix: `packages`
- Architecture domain: `sdk`
- Architecture capability: `sdk-root`
- Architecture module: `docs/architecture/sdk-architecture.md`
- Last architecture event: 2026-09-04T13:24:10+0800
- Last changed path: `tasks/workstreams/root/20260904-sdk-root.md`
- Severity: medium
- Change type: workstream-sync
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

- `tasks/workstreams/root/20260904-sdk-root.md`
  - status: active
  - current_slice: todo-01
  - source_plan: (none)

## Current Session Projection

- Durable progress lives under `tasks/workstreams/root`.
- `tasks/current.md` is the tracked derived status snapshot; it is not a live lock or task source.
- `tasks/todos.md` is the deferred-goal ledger; current execution slices stay in the active plan's `## Task Breakdown`.
<!-- END ARCHITECTURE CONTRACT -->
