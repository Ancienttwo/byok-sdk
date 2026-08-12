> **Archived**: 2026-08-13 04:04
> **Related Plan**: plans/archive/plan-20260813-0339-skill-pack-postgres-phase2.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260813-0404

# Implementation Notes: skill-pack-postgres-phase2

> **Status**: Active
> **Plan**: plans/plan-20260813-0339-skill-pack-postgres-phase2.md
> **Contract**: tasks/contracts/20260813-0339-skill-pack-postgres-phase2.contract.md
> **Review**: tasks/reviews/20260813-0339-skill-pack-postgres-phase2.review.md
> **Last Updated**: 2026-08-13 03:39
> **Lifecycle**: notes

## Design Decisions

- **`skillPacks` graduated to a mandatory `CoreStores` member.** Added to the
  `CoreStores` interface and `CORE_STORE_NAMES` (`packages/core/src/stores.ts`).
  Storage is mandatory (every composition creates the tables); the wire
  route/capability stays optional in `@byok-sdk/cloud` (`includeSkillPacks`).
  Storage presence is not capability advertisement.

- **`CORE_NON_COMPOSITION_PORT_NAMES` emptied, `CORE_PORT_NAMES` / `CorePortName`
  collapsed.** Phase 1 held `['skillPacks']` in
  `CORE_NON_COMPOSITION_PORT_NAMES` and derived `CORE_PORT_NAMES = [...stores,
  ...nonComposition]` + a `CorePortName` union solely to carry that one
  exception. With the list empty, `CORE_PORT_NAMES` equalled `CORE_STORE_NAMES`
  and `CorePortName` equalled `CoreStoreName` — a steady-state duplicate. Both
  the const and the type are removed; `CORE_PORT_METHODS` / `CORE_PORT_INTERFACES`
  are now typed `Record<CoreStoreName, …>`, and `packages/core/src/index.ts`
  drops the `CORE_PORT_NAMES` value export and `CorePortName` type export. The
  frozen public-export list in `constraints.test.ts` drops `CORE_PORT_NAMES`.
  `CORE_NON_COMPOSITION_PORT_NAMES` is kept as an exported `[] as const`: it is
  the testable statement "every core port is a composition member", which
  `CORE_STORE_NAMES` alone cannot express, and matches the Phase 1 comment's
  promise ("this list goes back to empty").

- **`PostgresSkillPackStore` mirrors `InMemorySkillPackStore` method-for-method.**
  Same validators reused from core (`checkSkillPackManifest`,
  `checkSkillPackEntry`, the delivered-vs-declared path/byteSize cross-checks,
  `SKILL_PACK_ENTRY_PATH`); zero re-implemented validation. Validation runs
  fully BEFORE the write transaction, so a rejected publish leaves nothing
  behind (asserted by conformance). Takes only `pool`, no clock: a manifest
  carries no timestamp, so the store reads the database clock nowhere (same
  shape as `PostgresDeviceDirectory`).

- **Migration `deploy/sql/0005_skill_packs.sql` — two tables:**
  - `skill_pack (tenant_id, name, version, description, content_hash)`,
    PK `(tenant_id, name)`. Pack-level manifest fields. The `schema` id is a
    constant the store supplies from `SKILL_PACK_MANIFEST_SCHEMA_ID`, not a
    stored column (cannot drift per row).
  - `skill_pack_file (tenant_id, pack_name, path, content_hash, byte_size,
    content)`, PK `(tenant_id, pack_name, path)`. One row per declared file;
    `content` is the UTF-8 text itself.
  - Both PKs are tenant-first, honoring the 0002 rule "every unique
    index/constraint starts with tenant_id". No FK (matches the codebase
    convention — 0002's `object_reference`/`object_manifest` use app-level
    integrity via transaction, not FKs). Forward-only; only creates new tables.

- **`byte_size` is `integer`, not `bigint` (deviation from the task's
  parenthetical "byteSize (bigint)").** `SkillPackFile.byteSize` is a core
  `number` bounded by `SKILL_PACK_FILE_MAX_BYTES` (256 KiB), unlike the quota /
  truth byte fields the contract declares as `bigint`. The pool's int8 parser
  decodes `bigint` columns as JS `BigInt`; a `bigint` column would force a
  `Number()` cast on every read (or fail the `number`-typed `SkillPackFile`).
  `integer` round-trips a `number` with no boundary cast — the same call 0002
  makes for small integer row counts (`rev`, `ref_count`). This matches "the
  store's read shape" and "the SkillPackStore interface", which the design red
  lines bind over the parenthetical. `content` is `text` (not `bytea`): a pack
  carries only UTF-8 Markdown/YAML/text, and `SkillPackFileContent.content` is
  typed `string`.

- **File ordering.** `get`/`list` return files ordered `path COLLATE "C"` (byte
  order); packs ordered `name COLLATE "C"`; default list limit 50 (matches the
  reference). Conformance fixtures publish files already in path-sorted order so
  the in-memory reference (preserves publication order) and Postgres (sorts by
  path) return the same array — a `toEqual(manifest)` comparison holds for both.

- **`packages/cloud` unchanged.** The wire `includeSkillPacks` gate takes an
  independent `options.skillPacks?` (not `core.skillPacks`), so a now-mandatory
  core store does not touch the optional route. The existing
  `cloud/src/__tests__/skill-packs.test.ts` already proves "store supplied but
  capability withheld → no route mounted" and "neither present → default
  deployment mounts nothing"; no new cloud test needed. All 10 cloud test files
  pass with the core flip in place.

## Deviations From Plan Or Spec

- `byte_size` stored as `integer` rather than `bigint` (see Design Decisions):
  faithful to the core `number` contract and the store's read shape, which the
  design red lines bind over the task's parenthetical.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Keep `CORE_NON_COMPOSITION_PORT_NAMES` as empty export vs delete it | Keep, empty | It is a named, testable invariant ("no core port sits outside the composition contract") that `CORE_STORE_NAMES` cannot express; matches the Phase 1 promise. |
| `byte_size` bigint vs integer | integer | Core `SkillPackFile.byteSize` is a bounded `number`; integer round-trips without a cast; bigint would need `Number()` on every read. |
| Reuse core validators vs re-implement in Postgres store | Reuse | Single validation authority; a pack rejected against one composition is rejected against the other. |
| Add FK skill_pack_file→skill_pack vs app-level integrity | App-level (transaction) | Matches the existing 0002 convention; publish replaces the file set in one transaction. |

## Local vs CI Verification Split

- **Verified locally (this worktree):** `pnpm -r run typecheck` (12 projects,
  clean), `pnpm -r run build` (all packages; cloud-postgres projected 5
  migrations into `dist/sql`), `pnpm -r run test`. All suites green: core (9
  files), protocol (11, freeze-guard passes untouched), cloud (10), conformance
  (3 files / 137 tests — in-memory composition runs the new skill-pack vectors),
  cloud-postgres (6 passed | 9 skipped). Build MUST precede test: the
  `migrations-dir` test reads `dist/sql` and hard-fails if the build has not
  refreshed it.
- **Defers to CI (dataplane job, real Postgres):** the 9 skipped cloud-postgres
  suites — including the Postgres core-conformance run — are `skipIf`-skipped
  without `BYOK_TEST_POSTGRES_URL`. `PostgresSkillPackStore` correctness against
  real Postgres (DDL apply + the new skill-pack conformance vectors on the
  Postgres composition) is verified by the CI dataplane job (Node 22.19.0 + 24).
- **Protocol zero-diff:** `git diff -- packages/protocol` is empty; freeze-guard
  suite passes.
- **SQL projection:** `deploy/sql/*.sql` is byte-identical to
  `packages/cloud-postgres/dist/sql/*.sql` for all 5 files (`cmp` clean).

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
