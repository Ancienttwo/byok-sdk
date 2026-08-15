# Implementation Notes: bun-package-manager-migration

> **Status**: Active
> **Plan**: plans/plan-20260815-1301-bun-package-manager-migration.md
> **Contract**: tasks/contracts/20260815-1301-bun-package-manager-migration.contract.md
> **Review**: tasks/reviews/20260815-1301-bun-package-manager-migration.review.md
> **Last Updated**: 2026-08-15 13:22
> **Lifecycle**: notes

## Design Decisions

- Root `packageManager: bun@1.3.14` is the only Bun version authority;
  `setup-bun@v2` reads it in every CI job.
- `.node-version` pins development and every CI job to Node 22.22.3; public
  dispatch manifests declare the distinct compatibility floor `>=22.22.0`.
- `bun.lock` plus root `workspaces` replace both pnpm files atomically.
- Build uses Bun's dependency-aware filtered execution. Test, typecheck, and
  clean stay sequential to preserve the existing timing-sensitive test invariant.
- Vitest and Node remain runtime/test semantics; Bun owns installation and
  workspace script orchestration.
- Release packing uses `bun pm pack` per explicit workspace directory, then
  retains npm isolated-install plus Node import checks as the consumer authority.
- SEA tools are direct devDependencies. `esbuild` and pinned
  `postject@1.0.0-alpha.6` fail closed when absent; no runtime download fallback.

## Deviations From Plan Or Spec

- Ship closeout found that the legacy root architecture card claimed six edits
  while the surviving append-only log could reconstruct only three unique
  events. The owner explicitly chose cleanup instead of recovery, so the stale
  pending card was removed and the generated index was rebuilt.
- `bun run --sequential --workspaces build` and the equivalent sequential
  wildcard filter do not preserve dependency order: a clean build starts client
  before protocol/core and fails. Build therefore uses Bun's dependency-aware
  parallel filter; only the pressure-sensitive test orchestration is sequential.
- Local default Node 26.3.1 is outside the fixed runtime and uses a different
  SEA fuse. The authoritative SEA smoke is rerun under exact Node 22.22.3.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Keep a pnpm pack fallback | Rejected | Would preserve dual package-manager authority. |
| Replace Vitest with `bun:test` | Rejected | Changes test semantics and weakens Node runtime validation. |
| Download postject with `npx` during SEA build | Rejected | Floating execution-time tool authority and fails under the target Node/npm combination. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- `bun ci`: 393-package graph, no lockfile changes.
- `bun run build`: clean dependency-ordered workspace build passed.
- `bun run typecheck`: all 13 workspaces passed.
- `bun run test`: 1,236 client tests plus every other workspace suite passed.
- `bun run check:release-pack`: eight Bun-packed tarballs installed by npm and
  imported under Node; dataplane carried all six SQL migrations byte-for-byte.
- `bun run --filter @byok-sdk/client smoke:adapters`: all three adapters and
  process-tree lifecycle scenarios passed.
- Bun compiled packaging smoke passed.
- Exact Node 22.22.3 full verification passed: frozen install, build,
  typecheck, all workspace tests, release pack/install, and Node SEA smoke.
- `repo-harness run check-task-workflow --strict`: passed after linked-worktree
  workflow scaffolding was materialized.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
