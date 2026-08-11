# Plan: Sprint S4A-a: Dataplane Foundations - Conformance Package, Postgres Cloud Ports, Migrate Runner

> **Status**: Archived
> **Created**: 20260808-0046
> **Slug**: s4a-a-dataplane-foundations
> **Artifact Level**: work-package
> **Promotion Reason**: First of three S4A slices (sprint D-7): the mechanism cut — the docker-compose test substrate, the `@byok/conformance` private package (core dimensions moved, cloud dimensions new), the `@byok/cloud-postgres` package skeleton with the hand-written ordered migrate runner, `deploy/sql/0001` (first frozen migration), and the Postgres implementations of the cloud-local ports. Everything S4A-b and S4A-c build on lands here; the migration ledger and conformance shape become one-way doors at merge. Needs contract-level scope authority, its own worktree, and dedicated review depth.
> **Verification Boundary**: `pnpm -r run typecheck`, `pnpm -r run test`, `pnpm -r run build`, `pnpm run check:deploy-sql`, `repo-harness run check-task-workflow --strict`, `docker compose -f docker-compose.test.yml up -d --wait` then dataplane suites green on the Postgres composition, `git diff --exit-code main -- packages/protocol/ packages/server/ packages/keys/ packages/client/ examples/` (zero-diff machine check), cloud handler/route surface unchanged (`packages/cloud/src/cloud.ts`, `inbound.ts`, route registry — export additions only elsewhere).
> **Rollback Surface**: Everything is additive: `docker-compose.test.yml`, `packages/conformance/`, `packages/cloud-postgres/`, `deploy/sql/0001`, and the CI dataplane job can be reverted by deleting them; no existing package's runtime behavior changes. The conformance move is restorable by reverting the PR (core's dimension files move, they do not change assertions). Migrations are forward-only per sprint S4A.6: environments that never ran the runner need no action; no destructive down path exists or is required.
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/s4a-dataplane-design.md` (all eleven decision points; this slice implements §1, §2, §4, §5, §7 and the S4A-a cut of §11), `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` §S4A + D-6/D-7, `docs/architecture/sdk-architecture.md` §12.6.2 (tenant-first lookup discipline), §12.7 (Postgres + R2 composition, ADR-020)
> **Task Contract**: `tasks/contracts/20260808-0046-s4a-a-dataplane-foundations.contract.md`
> **Task Review**: `tasks/reviews/20260808-0046-s4a-a-dataplane-foundations.review.md`
> **Implementation Notes**: `tasks/notes/20260808-0046-s4a-a-dataplane-foundations.notes.md`

## Agentic Routing
- Selected route: parent-agent
- Routing reason: The mechanism cut fixes three one-way doors (migration ledger semantics, conformance package shape, port→table key design) that S4A-b/c inherit; parent pins those as hard constraints from `docs/researches/s4a-dataplane-design.md`, a deep-worker lands the cross-package restructure plus the new package, gatekeeper re-runs the suites against a real Postgres as the acceptance artifact. Codex dual-track unavailable this round (quota exhausted until 2026-08-08 11:35); design confidence HIGH from the deep-reasoner track, residual noted.
- Due diligence:
  - P1 map: conformance today lives in `packages/core/src/__tests__/conformance/` (harness.ts factory contract + nine dimension files, imported by the single vitest entry `in-memory.test.ts`; port inventory data `CORE_PORT_METHODS` lives with the tests). Cloud-local ports live in `packages/cloud/src/stores/ports.ts` (nine ports; in-memory impls under `stores/in-memory/`); their durable home was explicitly deferred to S4A (`ports.ts:6-9`). No pg/S3/docker dependency exists anywhere in the workspace; CI has no service containers. `check:deploy-sql` = repo-harness `check-deploy-sql-order` (four-digit ordered filenames under `deploy/sql/`, currently only `.gitkeep`).
  - P2 trace: CI dataplane job → `docker compose -f docker-compose.test.yml up -d --wait` (postgres + minio) → migrate runner (`pg_advisory_lock` → per-file transaction: apply `deploy/sql/NNNN_*.sql` + ledger insert, sha256 checksum verified against `byok_schema_migration` for already-applied files, mismatch = fail-closed stop) → `runCloudConformance(postgresFactory)`: each dimension exercises a cloud-local port (e.g. `pairingCodes.redeem` → `UPDATE pairing_code ... WHERE code = $1 AND redeemed_at IS NULL` single-statement CAS → row carries tenant_id → tenant-first lookups thereafter). The same suite instance runs the in-memory factory in the same job — assertion divergence between compositions is structurally impossible because there is exactly one assertion source.
  - P3 decision rationale: PGlite excluded because its serialized single-connection model makes CAS/atomicity assertions pass vacuously (no-silent-downgrade); hand-written runner because `check-deploy-sql-order` is already the repo's ordering authority and a second migration framework would compete with it; `pg` over postgres.js for multi-statement files and explicit PoolClient checkout under advisory lock; private `@byok/conformance` package (not a subpath export) because all consumers are in-repo and moving `CORE_PORT_*` into core's shipped source breaks the core⇄conformance devDependency cycle; `rateLimiter` gets no table because persisting an allow-all is a fiction and real rate limiting is an edge concern.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260808-0046-s4a-a-dataplane-foundations.md`
- Sprint contract: `tasks/contracts/20260808-0046-s4a-a-dataplane-foundations.contract.md`
- Sprint review: `tasks/reviews/20260808-0046-s4a-a-dataplane-foundations.review.md`
- Implementation notes: `tasks/notes/20260808-0046-s4a-a-dataplane-foundations.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260808-0046-s4a-a-dataplane-foundations.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. The K-line plan stays Executing (cross-repo K4 waiting on user input); this plan takes the slot via `switch-plan`/worktree markers and hands it back at closure, per the S0-S3b pattern.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260808-0046-s4a-a-dataplane-foundations.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260808-0046-s4a-a-dataplane-foundations.md`.

## Approach
### Strategy
Land the mechanism in dependency order, each stage leaving the whole repo green:

1. **Test substrate**: root `docker-compose.test.yml` starting `postgres` and `minio` (minio unused until S4A-c but defined once — one file is the source of truth for the dataplane substrate). Availability gates: `BYOK_TEST_POSTGRES_URL` present → suites run, absent → `describe.skipIf` with a skip message that prints the compose command; `BYOK_REQUIRE_DATAPLANE=1` (CI dataplane job only) turns absence into hard failure.
2. **Conformance package**: new private `@byok/conformance` (`"private": true`, never published). Move the nine core dimension files + harness verbatim from `packages/core/src/__tests__/conformance/` (assertion-preserving move — dimension/assertion counts must not decrease); move the in-memory composition entry with them. Lift `CORE_PORT_METHODS`/`CORE_PORT_INTERFACES` into `@byok/core` shipped source (exported contract data, breaking the devDependency cycle); add the equivalent `CLOUD_PORT_METHODS`/`CLOUD_PORT_INTERFACES` exports to `@byok/cloud`. Add `runCloudConformance` with cloud-local dimensions: port inventory, tenant isolation (targeted assertions for the three pre-tenant exceptions `resolveByDeviceId`/`redeem`/nonce-challenge), pairing single-consumption, nonce TTL + single-use, dedup boundedness, attempt CAS (first claim wins), receipt first-fact-immutable, per-device seq monotonic. Dependency direction: `conformance → core`, `conformance → cloud`, zero cycles. File-header rule copied from `harness.ts`: any assertion that needs a per-composition branch is a port-contract bug — stop and escalate, never branch.
3. **`@byok/cloud-postgres` skeleton**: package with `README.md` + `LICENSE` from day one (todos.md precedent: no publishConfig-without-files). `pg` Pool factory with explicit int8 parser injection (`types.getTypeParser` passed to the Pool, never mutating `pg.types` globally — silent bigint→string decay is the named failure). `migrate.ts` ordered runner (~120 lines): read `deploy/sql/NNNN_*.sql` sorted by four-digit prefix, `pg_advisory_lock` singleton, self-bootstrap `byok_schema_migration(version, checksum, applied_at)` (the sole DDL outside `deploy/sql/`, commented as such), per-file transaction applying file + ledger insert atomically, sha256 checksum mismatch on applied files → typed fail-closed error, no down migrations.
4. **`deploy/sql/0001_cloud_local.sql`**: the seven cloud-local port tables per the design doc §5 mapping — `device` (PK `(tenant_id, device_id)`, `UNIQUE (device_id)` justified by cloud-minted IDs), `pairing_code` (PK `(code)`, row carries tenant), `auth_nonce` (PK `(tenant_id, device_id, nonce)`), `inbound_dedup` (PK `(tenant_id, device_id, envelope_id)` + bounded reclaim), `task` (PK `(tenant_id, task_id)`), `device_request_receipts` (PK `(tenant_id, key)`), `device_stream` (PK `(tenant_id, device_id)`, carrying both `next_seq` and `acked_seq` so S4A-b's mailbox needs no ALTER on a frozen file). All UNIQUE constraints tenant-first except the two whitelisted cloud-minted lookups.
5. **Postgres cloud-local port implementations**: seven ports (`devices`, `pairingCodes`, `nonces`, `dedup`, `tasks`, `receipts`, `sequence`) in `@byok/cloud-postgres`; `rateLimiter` stays the in-memory instance in the composition; `blobs` is S4A-c. CAS semantics as single-statement SQL (`UPDATE ... WHERE` guards), no read-modify-write.
6. **CI**: `dataplane` job (ubuntu-latest, Node [20, 22], compose up → `BYOK_REQUIRE_DATAPLANE=1` → conformance both compositions + runner tests), plus a constraints test pinning that `.github/workflows/ci.yml` contains a job setting `BYOK_REQUIRE_DATAPLANE` — the repo's established source-scan idiom guarding against the job being deleted or renamed.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| docker-compose test substrate (pg + minio), env-gated | One file, CI and local identical; MinIO covered (GH `services:` cannot override CMD) | Devs without docker see skips | **Use** — skip message prints the compose command; `BYOK_REQUIRE_DATAPLANE=1` makes CI the non-skippable authority |
| PGlite as embedded substitute | No docker needed | Single-connection multiplexer serializes concurrency: CAS/atomicity assertions pass vacuously — zero proof value | Rejected — the exact shape no-silent-downgrade forbids |
| `pg` + hand-written ordered runner | One ordering authority (`check-deploy-sql-order` filenames); multi-statement files native; advisory-lock model explicit | Runner bugs are schema incidents | **Use** — runner gets its own unit suite (out-of-order, checksum drift, concurrent runners, partial failure) + fresh migrate-up in CI every run |
| node-pg-migrate / drizzle / kysely migrator | Battle-tested | Own directory/format conventions compete with `check-deploy-sql-order` for ordering authority; builders add a TS-side schema truth | Rejected — two ordering authorities cannot coexist |
| Private `@byok/conformance` package | Breaks core⇄conformance devDep cycle once port tables move to shipped source; one assertion source for all compositions | `pnpm --filter @byok/core test` alone no longer self-certifies the reference impl (`-r` still does) | **Use** — subpath export deferred until an out-of-repo consumer actually exists |
| Conformance as `@byok/core` subpath export | No new package | Publishes test machinery in a shipped package for a consumer that does not exist yet | Rejected — revisit when the optional D1 adapter leaves the repo |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `docker-compose.test.yml` | Create | postgres + minio services, healthchecks for `--wait`, fixed test credentials (no real secrets) |
| `packages/conformance/package.json` + `tsconfig.json` | Create | `@byok/conformance`, `"private": true`, deps `@byok/core` + `@byok/cloud` + `@byok/cloud-postgres` (workspace) |
| `packages/conformance/src/core/` | Create (move) | harness + nine dimension files moved verbatim from `packages/core/src/__tests__/conformance/` |
| `packages/conformance/src/cloud/` | Create | `runCloudConformance` + cloud-local dimensions (inventory, tenant isolation incl. pre-tenant exceptions, pairing, nonce, dedup, attempt CAS, receipt immutability, seq monotonic) |
| `packages/conformance/src/compositions/*.test.ts` | Create (move+new) | in-memory core entry (moved), in-memory cloud entry, postgres cloud entry (env-gated) |
| `packages/core/src/ports-contract.ts` (or sibling) | Create (lift) | `CORE_PORT_METHODS`/`CORE_PORT_INTERFACES` as shipped contract data, exported from index |
| `packages/core/src/__tests__/conformance/` | Delete (moved) | contents relocated to `@byok/conformance`; core keeps its other tests (constraints etc.) |
| `packages/cloud/src/ports-contract.ts` (or sibling) | Create | `CLOUD_PORT_METHODS`/`CLOUD_PORT_INTERFACES` exported; no change to `ports.ts` semantics, handlers, or routes |
| `packages/cloud-postgres/package.json` + `README.md` + `LICENSE` + `tsconfig.json` | Create | new workspace package, deps `pg`, `@byok/core`, `@byok/cloud` (types); README + LICENSE from day one |
| `packages/cloud-postgres/src/pool.ts` | Create | Pool factory, int8 parser injection (no global `pg.types` mutation), connection config from env/explicit options |
| `packages/cloud-postgres/src/migrate.ts` | Create | ordered runner: sorted `NNNN_*.sql`, advisory lock, ledger bootstrap, per-file tx, checksum fail-closed, no down |
| `packages/cloud-postgres/src/stores/*.ts` | Create | seven cloud-local port implementations (single-statement CAS SQL) |
| `packages/cloud-postgres/src/__tests__/migrate.test.ts` | Create | runner unit suite: out-of-order files, checksum drift, concurrent runners, partial failure atomicity |
| `deploy/sql/0001_cloud_local.sql` | Create | seven tables per §5 mapping; tenant-first keys; `device_stream` carries `next_seq` + `acked_seq` |
| `.github/workflows/ci.yml` | Edit | new `dataplane` job: compose up --wait, `BYOK_REQUIRE_DATAPLANE=1`, Node [20, 22] |
| `packages/conformance/src/__tests__/constraints.test.ts` (or cloud-postgres sibling) | Create | pins the CI job setting `BYOK_REQUIRE_DATAPLANE`; pins assertion-source uniqueness invariants as needed |
| `pnpm-lock.yaml` | Edit | `pg` + dev additions |
| `docs/architecture/` | Edit (hook) | architecture-event hook regenerates request cards on package.json edits; adjudication prose goes to `docs/architecture/snapshots/` per operating notes |
| `docs/researches/s4a-dataplane-design.md` | Commit | design decision record rides with this slice (first S4A commit) |
| `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` | Edit | D-6/D-7 already recorded; S4A-a acceptance boxes marked at closure |
| `packages/protocol/**`, `packages/server/**`, `packages/keys/**`, `packages/client/**`, `examples/**` | Do not touch | Machine-checked zero diff |
| `packages/cloud/src/cloud.ts`, `inbound.ts`, route registry, `stores/ports.ts` semantics | Do not touch | Handler surface frozen this slice; export-only additions elsewhere in the package |

### Code Snippets
The runner's per-file atomicity and checksum discipline:

```ts
// migrate.ts — per already-applied file: sha256(file) must equal ledger row
if (applied.has(version) && applied.get(version) !== checksum(file)) {
  throw new MigrationChecksumMismatchError(version); // fail-closed: published files are immutable
}
// per pending file: one transaction = apply + ledger insert
await client.query('BEGIN');
await client.query(fileContents);
await client.query('INSERT INTO byok_schema_migration(version, checksum, applied_at) VALUES ($1,$2,now())', [version, sum]);
await client.query('COMMIT');
```

CAS as single-statement SQL (pairing redemption shape):

```sql
UPDATE pairing_code SET redeemed_at = now(), device_id = $2
 WHERE code = $1 AND redeemed_at IS NULL
RETURNING tenant_id, product_id; -- zero rows = already redeemed / unknown: typed rejection
```

### Data Flow
CI dataplane job → compose up (pg healthy) → migrate runner from empty DB (= S4A.5 "fresh install + migrate-up" every run) → `runCloudConformance(inMemoryFactory)` and `runCloudConformance(postgresFactory)` from the same assertion source → runner unit suite → teardown. Local: same compose file, env vars gate participation, skip message teaches the command.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Hand-written runner bug = production schema incident | 中 | 极高 | Dedicated unit suite (out-of-order, checksum drift, concurrent runners via two clients, partial-failure rollback); fresh migrate-up on every CI run; advisory lock; per-file tx |
| 0001 key design wrong → frozen at merge (forward-only) | 中 | 高 | Keys copied from design doc §5 mapping (reviewed); catalog-level tenant-first rule lands as executable assertion in S4A-b; gatekeeper reviews DDL against §12.6.2 before merge |
| Conformance move silently drops/weakens assertions | 中 | 高 | Assertion-preserving move is a named review item: dimension file diff must be pure relocation; dimension/assertion counts must not decrease; core in-memory suite green in new home |
| Cloud port Postgres impls subtly diverge from in-memory semantics | 中 | 高 | Same suite, same assertions, both compositions in one job; per-composition branching is a stop condition |
| CI dataplane job deleted/renamed later → silent coverage loss | 低 | 高 | Source-scan constraint test pins the job + env var (established repo idiom) |
| docker flake in CI | 低 | 中 | `--wait` healthchecks; compose file minimal; job isolated from build-test so a flake does not mask unit coverage |
| Node 20 leg behavior | 低 | 中 | No `node:sqlite` involvement in this slice; `pg` supports Node 20; dataplane job runs both Node majors |

## Task Contracts
- Contract file: `tasks/contracts/20260808-0046-s4a-a-dataplane-foundations.contract.md`
- Review file: `tasks/reviews/20260808-0046-s4a-a-dataplane-foundations.review.md`
- Implementation notes file: `tasks/notes/20260808-0046-s4a-a-dataplane-foundations.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260808-0046-s4a-a-dataplane-foundations.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: One PR; commits: (1) design doc + compose file, (2) conformance package move + port-table lift, (3) cloud dimensions, (4) cloud-postgres skeleton + runner + runner tests, (5) 0001 + port implementations, (6) CI job + constraint test.
- **Rollback surface**: Pure addition; revert the PR restores today exactly (conformance files move back with it). Forward-only migrations: no deployed environment exists yet, so no data-bearing rollback path is required.
- **Verification boundary**: five standard gates + zero-diff machine check (protocol/server/keys/client/examples) + cloud handler surface frozen + dataplane suites on both compositions + runner unit suite + `check:deploy-sql` with a real file present.
- **Review/acceptance boundary**: Gatekeeper re-runs compose + migrate + both compositions as the acceptance artifact; reviewer and implementer are different execution contexts; DDL reviewed line-by-line against the §5 mapping and §12.6.2 tenant-first rule.
- **High-risk surface**: migration ledger semantics (checksum, atomicity, advisory lock), 0001 key design (frozen at merge), assertion-preservation of the conformance move.
- **Why not checklist row**: Three one-way doors (ledger semantics, conformance shape, key design) plus a cross-package restructure; S4A-b/c inherit everything decided here.

## Evidence Contract

- **State/progress path**: `## Task Breakdown` below; sprint §S4A.5 boxes attributable to S4A-a (migrations order check; fresh install + migrate-up; suite runs on both compositions for cloud-local ports).
- **Verification evidence**: `.ai/harness/checks/latest.json` via `repo-harness run verify-sprint --prepare-acceptance --contract tasks/contracts/20260808-0046-s4a-a-dataplane-foundations.contract.md`.
- **Evaluator rubric**: cloud conformance green on in-memory AND Postgres compositions from one assertion source; runner unit suite covers out-of-order/checksum-drift/concurrent/partial-failure; fresh migrate-up green; `check:deploy-sql` green with `0001` present; constraint test pins the CI job; core suite green in its new home with undiminished dimension/assertion counts; zero-diff machine check green.
- **Stop condition**: Any conformance assertion needing a per-composition branch; any diff in `packages/protocol|server|keys|client/**` or `examples/**`; any change to cloud handlers/routes/`ports.ts` semantics; any down-migration or destructive path in the runner; any in-memory stand-in for a port the Postgres composition claims to implement — stop, amend or escalate.
- **Rollback surface**: Revert the PR; additive-only, no migration executed anywhere durable.

## Annotations

## Task Breakdown
- [x] Commit `docs/researches/s4a-dataplane-design.md` + `docker-compose.test.yml` (pg + minio, healthchecks, test-only credentials)
- [x] `@byok/conformance` package: move core harness + nine dimensions verbatim; lift `CORE_PORT_*` into `@byok/core` shipped source; move in-memory core composition entry; repo green
- [x] `CLOUD_PORT_*` exports in `@byok/cloud` (export-only); `runCloudConformance` + cloud-local dimensions; in-memory cloud composition entry green
- [x] `@byok/cloud-postgres` skeleton: package files (README/LICENSE day one), Pool + int8 parser, `migrate.ts` runner + unit suite (out-of-order, checksum drift, concurrent, partial failure)
- [x] `deploy/sql/0001_cloud_local.sql`: seven tables per §5 mapping, tenant-first keys, `device_stream` with `next_seq` + `acked_seq`; `check:deploy-sql` green
- [x] Seven Postgres cloud-local port implementations (single-statement CAS); postgres cloud composition entry green against compose substrate
- [x] CI `dataplane` job (compose up --wait, `BYOK_REQUIRE_DATAPLANE=1`, Node [20, 22]) + constraint test pinning the job
- [x] Full gates green incl. zero-diff machine check and cloud handler surface frozen
