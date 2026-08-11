# Implementation Notes: cloud-postgres-sql-projection

> **Status**: Active
> **Plan**: plans/plan-20260812-0201-cloud-postgres-sql-projection.md
> **Contract**: tasks/contracts/20260812-0201-cloud-postgres-sql-projection.contract.md
> **Review**: tasks/reviews/20260812-0201-cloud-postgres-sql-projection.review.md
> **Last Updated**: 2026-08-12 02:41
> **Lifecycle**: notes

## Design Decisions

- Falsifier ran first, as the contract required. The tier-1 tarball assertion was written and run against the
  unmodified package; it failed red with all four migrations reported missing from
  `byok-sdk-cloud-postgres-0.2.0.tgz` under `dist/sql/`, which is the gap this slice exists to close. Only then
  were the copy step and the export added, and the same command went green
  (`[release-pack] byok-sdk-cloud-postgres-0.2.0.tgz carries 4 migration(s) matching deploy/sql`). The stop
  condition (`files: ["dist"]` unable to carry non-JS assets) did not trigger: npm packs `dist/sql/*.sql` without
  any manifest change.
- Projection lives in `packages/cloud-postgres/scripts/copy-migrations.mjs`, invoked as the last step of the
  package `build`. It runs after `tsup` on purpose — `tsup.config.ts` sets `clean: true`, so a copy placed before
  it would be deleted. It is clean-then-copy (`rmSync` the target, then recreate), which is what keeps a deleted
  migration from surviving inside a published package.
- `.sql` is the copy filter. `deploy/sql/` also holds a `.gitkeep`, and the runner already ignores every non-`.sql`
  entry, so the projection copies what the runner reads rather than the directory listing. The first test run
  caught this by failing on `.gitkeep`; the fix was to filter, not to copy the file.
- `migrationsDir()` is its own module (`src/migrations-dir.ts`) re-exported from `index.ts`. It resolves
  `fileURLToPath(new URL('./sql', import.meta.url))`, and because tsup bundles the package into a single
  `dist/index.js`, that URL is the built entry's own directory in an installed copy. No `process.cwd()`, no
  `require.resolve` of the package name, no second lookup location if the first misses — a fallback would be a
  second authority for where migrations live.
- The unit test imports the BUILT entry (`dist/index.js`), not the source module. Calling `migrationsDir()` from
  `src/` answers about `src/`, which is true and proves nothing. Missing `dist/` is a hard throw rather than a
  skip, matching the workspace's existing build-before-test ordering.
- Tier-1 reads the tarball with `node:zlib` + a small ustar walk instead of shelling out to `tar`. This script is a
  release hard gate that also runs on Windows runners; a builtin-only reader has no platform surface. The
  comparison is bidirectional over the filename set plus per-file sha256, and the expected set is read from
  `deploy/sql` at run time, so adding a migration never edits the assertion.
- Tier-2 is a separate script (`scripts/release/pg-migrate-smoke.mjs`) driven by a new CI job
  `release-pack-migrate`, not an addition to the release gate: keeping Postgres out of `pack-and-smoke.mjs` is the
  reason that script can be a hard gate anywhere. It installs the exact tarballs listed in the release manifest,
  migrates an empty database through `migrate(pool, migrationsDir())`, and asserts the second run applies nothing,
  recognises everything, and leaves a ledger row per migration. It never passes `deploy/sql` to the runner —
  a consumer installing from npm has no checkout.
- CI uses a `services:` container here rather than `docker-compose.test.yml`. The compose file exists because the
  `dataplane` job needs MinIO with an overridden CMD; migrating needs Postgres and nothing else.

## Deviations From Plan Or Spec

- The plan's file table lists `scripts/release/pack-and-smoke.mjs` for the smoke work; tier-2 landed as a second
  file in the same allowed directory (`scripts/release/pg-migrate-smoke.mjs`) rather than as a workflow heredoc, so
  the migrate smoke is runnable and reviewable outside GitHub Actions. Same for
  `packages/cloud-postgres/scripts/copy-migrations.mjs` versus an inline shell copy in the `build` script: an
  inline `cp` cannot clean-then-copy portably, and Windows has no `cp`.
- No version bump and no publish, per the contract.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Extract the tarball with `tar -xzf` via `spawnSync` | Rejected | Adds an external-tool dependency to a hard gate that must also pass on Windows runners; a ~25-line builtin ustar walk has none |
| Assert only the installed copy under `node_modules`, skip the tarball | Rejected | The installed tree is npm's output, not the artifact; asserting the tarball is asserting the thing that gets published |
| Inline `cp -R deploy/sql dist/sql` in the build script | Rejected | Not portable to Windows, and appending rather than clean-then-copy would let a deleted migration linger |
| Put the PG migrate smoke inside `pack-and-smoke.mjs` | Rejected | The release gate's value is that it needs no external service; the database layer belongs in CI |
| Have the unit test assert against `src/` | Rejected | `migrationsDir()` resolves relative to its own module, so a src-level assertion is tautological |

## Open Questions

- （已关闭，gatekeeper 验收实证 2026-08-12）"extra" 与 "modified" 两向此前未被端到端驱动过红。gatekeeper 将
  `assertTarballCarriesMigrations` 及其依赖逐字提取到 scratch 模块，对真实 tarball 加三份篡改副本驱动：
  control 绿、extra（`9999_rogue.sql`）红、modified（`0001_cloud_local.sql`）红、missing（`0002_core_domain.sql`）红。
  三向 fail-closed 均已实证，比对基准确认在运行时读自 `deploy/sql`（无硬编码数量）。

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Red: `node scripts/release/pack-and-smoke.mjs` → `does not carry deploy/sql byte-for-byte under dist/sql/: missing: 0001_cloud_local.sql, 0002_core_domain.sql, 0003_cloud_cleanup.sql, 0004_device_proof_truth.sql`
- Green: same command after the copy step + export, exit 0, release manifest emitted.
- Tier-2 verified locally against a real `postgres:17-alpine` container (the same image the new CI job uses):
  `[pg-migrate-smoke] migrated 4 file(s) from …/node_modules/@byok-sdk/cloud-postgres/dist/sql, re-run was a no-op`.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Candidate for `tasks/lessons.md` after a second occurrence: a published package that exports a runner taking a
  path can ship without the data that path points at, and an import-only release smoke can never see it. The
  general form is "assert the artifact's contents, not just that it installs and imports".
