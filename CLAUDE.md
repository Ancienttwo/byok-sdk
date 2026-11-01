# Repo Agent Context

This is the root routing contract for Claude Code and Codex. Load this before task-local artifacts.

## Workflow Contract

- Use first principles, one source of truth, and no steady-state compatibility paths.
- Treat `docs/spec.md` as product truth; `tasks/current.md` is derived state and `tasks/todos.md` is the deferred-goal ledger.
- Put pre-implementation design in the issue body. Record a one-time decision as a decision comment on its issue or PR, a durable decision as an ADR in `docs/adr/` that links its issue or PR, and research and runtime evidence in `docs/researches/`.
- Read `.ai/context/capabilities.json` and `.ai/context/context-map.json` before adding scoped agent context.
- Keep `_ref/` ignored external reference material and `_ops/` ignored local operations state.

## Required Checks

PR and main push CI run targeted checks selected from changed paths. Nightly CI on main runs the complete matrix, including the full macOS client suite, without uploading release tarballs. Release validation runs the same complete matrix only for an explicitly approved commit on main or release/*; only that mode uploads accepted release artifacts.

- `bun run build`
- `bun run typecheck`
- `bun run test`
- `bun run check:api-surface`
- `bun run check:version-authority`

<!-- BEGIN ARCHITECTURE CONTRACT -->
## Architecture Contract

- Functional block: `packages`
- Capability ID: `root`
- Matched prefix: `packages`
- Architecture domain: `sdk`
- Architecture capability: `sdk-root`
- Architecture module: `docs/architecture/sdk-architecture.md`
- Module responsibility: Keep this block aligned with the local boundary described by surrounding human-owned context.
- Entrypoints: `packages`
- Allowed dependencies: Follow root `AGENTS.md` / `CLAUDE.md` and this local contract.
- Forbidden dependencies: Do not cross sibling app/service/package boundaries without an architecture snapshot or explicit plan.
- Runtime path: `packages`
- LSP/tooling profile: `typescript-lsp`
- Verification: Use root required checks plus local commands recorded in this capability contract.
- Semantic diagram source: `docs/architecture/sdk-architecture.md`

## Active Workstreams

- (none yet)

## Current Session Projection

- Durable progress lives under `tasks/workstreams/root`.
- `tasks/current.md` is the tracked derived status snapshot; it is not a live lock or task source.
- `tasks/todos.md` is the deferred-goal ledger; current execution slices stay in the active plan's `## Task Breakdown`.
<!-- END ARCHITECTURE CONTRACT -->
