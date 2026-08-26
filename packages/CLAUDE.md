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
