# Plan: Sprint S4A-b: Core Seven-Port Postgres Implementation and the I4 SQL Side

> **Status**: Executing
> **Created**: 20260808-0232
> **Slug**: s4a-b-core-postgres
> **Artifact Level**: work-package
> **Promotion Reason**: Second of three S4A slices (sprint D-7): the domain cut — `deploy/sql/0002_core_domain.sql` (eleven tables including the D-6 quota trio), Postgres implementations of all seven `@byok/core` ports, the 56-case core conformance suite running on the Postgres composition with zero assertion changes (the I4 SQL side D-2 promised), and `tests/sql/control_plane_invariants.sql` turning the tenant-first key discipline into an executable catalog assertion. `0002` freezes at merge under forward-only migrations; the port semantics it encodes (board five-state CAS, truth first-hash-wins, mailbox read-not-ack, quota no-oversell) are the program's cross-tenant correctness core. Needs contract-level scope authority, its own worktree, and dedicated review depth.
> **Verification Boundary**: `pnpm -r run typecheck`, `pnpm -r run test`, `pnpm -r run build`, `pnpm run check:deploy-sql`, `repo-harness run check-task-workflow --strict`, `docker compose -f docker-compose.test.yml up -d --wait` then `runCoreConformance` green on the Postgres composition plus `control_plane_invariants.sql` executing clean, `git diff --exit-code main -- packages/protocol/ packages/server/ packages/keys/ packages/client/ packages/core/ packages/cloud/ examples/ deploy/sql/0001_cloud_local.sql` (frozen surfaces incl. both untouched packages and the frozen first migration).
> **Rollback Surface**: Everything is additive: `0002`, the seven store implementations, the invariants file, and the runbook revert with the PR; no existing package's runtime behavior changes (core/cloud are zero-diff this slice). Migrations are forward-only per sprint S4A.6; no durable environment has executed the runner. The two P2 ride-alongs (ROLLBACK shadowing fix, todos trigger narrowing) are one-line-scale and revert with the PR.
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/s4a-dataplane-design.md` (§5 port→table mapping, §8 I4 = behavior suite + catalog assertions, §9 invariants file as the sole assertion home, §10 retention runbook + noteSkippedSeq ruling, §11 S4A-b cut), `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` §S4A + D-6/D-7, `docs/architecture/sdk-architecture.md` §12.6.2 (five-layer tenant discipline), §12.7.5 (retention), archived gate review `tasks/archive/review-20260808-0227-s4a-a-dataplane-foundations.md` (the two P2 findings)
> **Task Contract**: `tasks/contracts/20260808-0232-s4a-b-core-postgres.contract.md`
> **Task Review**: `tasks/reviews/20260808-0232-s4a-b-core-postgres.review.md`
> **Implementation Notes**: `tasks/notes/20260808-0232-s4a-b-core-postgres.notes.md`

## Agentic Routing
- Selected route: parent-agent
- Routing reason: The domain cut carries the heaviest port semantics of the program (five-state CAS, first-hash-wins, read-not-ack, no-oversell) against a conformance suite whose assertions are contractually frozen; parent pins the zero-assertion-change red line, the canonical-timestamp storage decision, and the 0002 key discipline; a deep-worker lands the implementation; gatekeeper re-runs the 56-case suite plus the catalog assertions against real Postgres as the acceptance artifact. Codex quota recovers 11:35 — if available when S4A-c opens, the CloudBlobStore split gets the dual track; this slice's decisions were all made in the S4A design round (HIGH).
- Due diligence:
  - P1 map: the seven core ports and their InMemory references live in `packages/core/src/` (board/truth/mailbox/quota/blob/presence + stores.ts facade data); the 56-case suite lives in `packages/conformance/src/core/` (moved byte-identical in S4A-a) with `runCoreConformance(name, factory)` as the single entry; the Postgres substrate (pool, migrate runner, env gate `support/dataplane.ts`, compose file) landed in S4A-a under `packages/cloud-postgres/`. `0001` created `device_stream` with `acked_seq` specifically so this slice never alters a frozen file. `check-deploy-sql-order` upgrades to double-constraint mode the moment `tests/sql/control_plane_invariants.sql` exists (every migration must be referenced in it).
  - P2 trace (mailbox, the ack-coupled path): cloud handler appends via `MailboxStore.append(tenant, deviceId, envelope)` → `INSERT INTO outbox (tenant_id, device_id, seq, ...)` with seq from `device_stream.next_seq` single-statement upsert → daemon polls `readAfter(tenant, deviceId, afterSeq, limit)` → `SELECT ... WHERE tenant_id=$1 AND device_id=$2 AND seq>$3 ORDER BY seq LIMIT $4` (read does not ack) → daemon's next poll carries the cursor → `advanceCursor` compare-and-set on `device_stream.acked_seq` (monotonic guard in the WHERE clause) → `collectRetired(tenant, {ackedBefore, expireUnackedBefore})` deletes acked rows and marks unacked rows `expired` without deleting (S4B dead-letters them). Every statement's WHERE leads with `tenant_id`; the catalog assertion proves no unique path exists that doesn't.
  - P3 decision rationale: canonical-instant columns are stored as `TEXT` — the port contract (S2's gatekeeper P1 fix) is canonical ISO-8601 UTC strings compared lexicographically, and TEXT preserves byte equality and ordering with zero round-trip proof obligation, whereas `timestamptz` would re-serialize and demand a canonicalization-stability proof at every boundary; `numeric`/`bigint` quota columns flow through the int8 parser injected in S4A-a's pool. The invariants file owns the catalog assertions (design §9): executable `DO $$ ... RAISE EXCEPTION` blocks, TS runs the file and asserts it does not throw — one assertion home, and operators can run the same file against production with `psql -f`. The suite's clock is caller-injected per the factory contract, and every TTL-bearing port method takes explicit instants, so no SQL `now()` dependence leaks into conformance runs.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260808-0232-s4a-b-core-postgres.md`
- Sprint contract: `tasks/contracts/20260808-0232-s4a-b-core-postgres.contract.md`
- Sprint review: `tasks/reviews/20260808-0232-s4a-b-core-postgres.review.md`
- Implementation notes: `tasks/notes/20260808-0232-s4a-b-core-postgres.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260808-0232-s4a-b-core-postgres.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. The K-line plan stays Executing (cross-repo K4 waiting on user input); this plan takes the slot via `switch-plan`/worktree markers and hands it back at closure, per the S0-S4A-a pattern.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260808-0232-s4a-b-core-postgres.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260808-0232-s4a-b-core-postgres.md`.

## Approach
### Strategy
Land the domain in dependency order, each stage leaving the whole repo green:

1. **Ride-alongs (first commit, S4A-a gate P2s)**: wrap the runner's `ROLLBACK` in `.catch(() => {})` before rethrowing so a dead connection cannot shadow the original migration error (`packages/cloud-postgres/src/migrate.ts:218-221`); narrow the `noteSkippedSeq` revisit trigger in `tasks/todos.md:22` to the single condition "a protocol version bump adds new `task.*` types" (the S4A branch is consumed by this slice's runbook).
2. **`deploy/sql/0002_core_domain.sql`**: eleven tables per design §5 — `outbox` PK `(tenant_id, device_id, seq)`; `board_item` PK `(tenant_id, item_id)` + `tenant_stream` PK `(tenant_id)` holding `board_seq`; `attested_record` PK `(tenant_id, kind, subject_id)`; `device_presence` PK `(tenant_id, device_id)`; `activity_tail` PK `(tenant_id, task_id)`; `object_manifest` PK `(tenant_id, hash)` + `object_reference` PK `(tenant_id, hash, ref_kind, ref_id)`; `storage_entitlement`/`storage_usage`/`storage_reservation` all tenant-first (D-6). Canonical-instant columns TEXT; byte sizes BIGINT. This file adds zero UNIQUE constraints outside the tenant-first pattern. `0001` untouched (checksummed and machine-checked).
3. **Seven Postgres port implementations** in `packages/cloud-postgres/src/stores/core/`: mailbox (append/readAfter/advanceCursor/readCursor/collectRetired — advance is a monotonic single-statement CAS; collectRetired deletes acked, marks unacked `expired`, never deletes unacked), board (five-state transitions and claim/revision CAS as single-statement `UPDATE ... WHERE` guards returning current snapshot on zero rows), truth (first-hash-wins via `ON CONFLICT DO NOTHING` + equality re-read), presence/activity (bounded upserts), objects (manifest state machine `pending→committed`, reference add/remove, delete-pending marks — no byte I/O, that is S4A-c), quota (reserve as the no-oversell single statement: insert guarded by an aggregate-check CTE against entitlement, zero rows = typed `storage_*` rejection; finalize/abort/expire as guarded single-statement transitions).
4. **Postgres core composition entry** (`packages/cloud-postgres/src/__tests__/core-conformance.test.ts`, same env gate as S4A-a): `runCoreConformance('postgres', factory)` — 56 cases, zero assertion changes; per-composition branching is the stop condition.
5. **`tests/sql/control_plane_invariants.sql`**: executable `DO $$` blocks asserting (a) every UNIQUE index/constraint on tenant-owned tables leads with `tenant_id`, whitelist exactly `device.device_id` + `pairing_code.code`; (b) every tenant-owned table has `tenant_id NOT NULL`; file header lists `0001_cloud_local.sql` and `0002_core_domain.sql` (satisfying `check-deploy-sql-order`'s reference mode, which activates the moment this file exists); a TS test executes the file post-migration and asserts no exception.
6. **Mailbox retention runbook** (`deploy/runbooks/mailbox-retention.md`): default windows, host-driven invocation (the SDK ships no scheduler), the §12.7.5 mapping, the "capacity-bounded ring vs time-bounded SQL retention are not interchangeable" clause (§12.7.5 requires it in the runbook), `expired` rows are marked not flowed (dead-letter is S4B O-009), and the `noteSkippedSeq` evidence gap: a hosted daemon can advance its cursor through the skip path with no local journal record (design §10).

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Canonical instants as TEXT | Byte-equal storage; lexicographic ORDER BY/compare matches the port contract with zero proof obligation | No SQL date arithmetic (not needed — all TTL methods take explicit instants) | **Use** — the S2 timestamp contract is string-canonical; storage that cannot drift beats storage that must be proven not to |
| `timestamptz` columns | Native date ops, smaller | Round-trips through Postgres' serializer; canonical-form stability must be proven at every read; a formatting divergence is a silent cross-composition drift | Rejected |
| Catalog assertions in SQL (`DO $$`) run by a thin TS test | One assertion home; operators run the identical file against production via `psql -f` | SQL is less familiar to TS reviewers | **Use** — design §9; duplicating in TS is the two-truths shape the repo forbids |
| Catalog assertions via `EXPLAIN` plans | "Proves" runtime behavior | Planner-dependent, flaky by construction, and proves the wrong proposition (this plan didn't use the index ≠ no such path exists) | Rejected — design §8 |
| Quota no-oversell via single guarded INSERT (CTE aggregate check) | True row-level serialization; concurrent reservations cannot both pass | The statement is the most complex SQL in the slice | **Use** — read-then-insert is the oversell bug the suite's concurrency case exists to catch |
| Core composition entry in `packages/conformance` | Keeps entries together | Recreates the `conformance ⇄ cloud-postgres` cycle S4A-a explicitly avoided | Rejected — follow the S4A-a precedent (entry lives with the composition) |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/cloud-postgres/src/migrate.ts` | Edit (P2) | ROLLBACK shadowing fix only (`.catch(() => {})` before rethrow) |
| `tasks/todos.md` | Edit (P2) | `noteSkippedSeq` trigger narrowed to protocol-bump-only |
| `deploy/sql/0002_core_domain.sql` | Create | Eleven tables per §5; TEXT instants; BIGINT sizes; tenant-first keys |
| `packages/cloud-postgres/src/stores/core/*.ts` | Create | Seven port implementations (single-statement CAS discipline throughout) |
| `packages/cloud-postgres/src/index.ts` | Edit | Export `createPostgresCoreStores` (factory feeding `CoreStores`) |
| `packages/cloud-postgres/src/__tests__/core-conformance.test.ts` | Create | Postgres core composition entry, env-gated, 56 cases zero-diff assertions |
| `packages/cloud-postgres/src/__tests__/invariants.test.ts` | Create | Runs `tests/sql/control_plane_invariants.sql` post-migration, asserts clean execution |
| `tests/sql/control_plane_invariants.sql` | Create | Catalog `DO $$` assertions + migration reference header (activates check-deploy-sql reference mode) |
| `deploy/runbooks/mailbox-retention.md` | Create | Retention semantics, ring-vs-SQL clause, noteSkippedSeq evidence gap |
| `.github/workflows/ci.yml` | Prefer zero diff | The dataplane job's `--filter @byok/cloud-postgres` already covers the new entries; edit only if a filter is genuinely missing |
| `packages/conformance/**` | Prefer zero diff | `runCoreConformance` is already exported; minimal export addition only if an import is genuinely unavailable |
| `packages/core/**`, `packages/cloud/**`, `packages/protocol/**`, `packages/server/**`, `packages/keys/**`, `packages/client/**`, `examples/**`, `deploy/sql/0001_cloud_local.sql` | Do not touch | Machine-checked zero diff (frozen surfaces; 0001 is a frozen migration) |

### Code Snippets
The no-oversell reservation shape (single statement, aggregate-guarded):

```sql
WITH current AS (
  SELECT e.max_bytes,
         COALESCE(u.used_bytes, 0) AS used_bytes,
         COALESCE((SELECT SUM(r.reserved_bytes) FROM storage_reservation r
                   WHERE r.tenant_id = $1 AND r.state = 'active'), 0) AS reserved_bytes
    FROM storage_entitlement e
    LEFT JOIN storage_usage u ON u.tenant_id = e.tenant_id
   WHERE e.tenant_id = $1
)
INSERT INTO storage_reservation (tenant_id, reservation_id, reserved_bytes, state, expires_at)
SELECT $1, $2, $3, 'active', $4 FROM current
 WHERE used_bytes + reserved_bytes + $3 <= max_bytes
RETURNING reservation_id; -- zero rows = storage_quota_exceeded, typed rejection
```

Monotonic cursor advance (ack can only move forward):

```sql
UPDATE device_stream SET acked_seq = $3
 WHERE tenant_id = $1 AND device_id = $2 AND acked_seq < $3
RETURNING acked_seq; -- zero rows = stale ack, no-op by contract
```

### Data Flow
Same substrate as S4A-a: compose up → migrate runner applies `0001` (checksummed, untouched) then `0002` → `runCoreConformance(postgresFactory)` 56 cases + `runCloudConformance` 44 (regression) + invariants file executes clean → teardown. The suite's injected clock feeds every TTL parameter; no statement calls `now()` on a conformance path.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| 0002 key/type design wrong → frozen at merge | 中 | 高 | Keys copied from design §5 (reviewed twice); catalog assertions execute in the same PR; gatekeeper reviews DDL line-by-line |
| Quota reserve oversells under concurrency | 中 | 极高 | Single guarded INSERT (no read-then-write); the suite's quota dimension (36 expects incl. concurrency) runs on real Postgres where contention is real |
| Canonical-timestamp drift between compositions | 中 | 高 | TEXT storage makes drift unrepresentable; the timestamps dimension asserts canonical round-trips |
| Assertion "adjustment" to make Postgres green | 低 | 极高 | Zero-diff on `packages/conformance/` is the default expectation and any diff is a named review item; per-composition branch is a stop condition |
| Invariants file activates reference mode and breaks check:deploy-sql | 低 | 中 | Header references both migrations from day one; `pnpm run check:deploy-sql` in the verification boundary catches it locally and in CI |
| collectRetired deletes unacked rows | 低 | 极高 | Contract: acked-delete and unacked-mark are separate statements; the mailbox dimension asserts unacked survival; runbook documents the non-delete |
| Suite runtime grows past CI budget | 低 | 中 | S4A-a's batching precedent (dedup dimension); explicit budgets where a dimension is round-trip-heavy |

## Task Contracts
- Contract file: `tasks/contracts/20260808-0232-s4a-b-core-postgres.contract.md`
- Review file: `tasks/reviews/20260808-0232-s4a-b-core-postgres.review.md`
- Implementation notes file: `tasks/notes/20260808-0232-s4a-b-core-postgres.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260808-0232-s4a-b-core-postgres.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: One PR; commits: (1) P2 ride-alongs, (2) 0002, (3) seven store implementations, (4) core composition entry green, (5) invariants file + test, (6) runbook + closing marks.
- **Rollback surface**: Pure addition on top of S4A-a; no durable environment has run 0002; revert the PR restores the post-S4A-a state.
- **Verification boundary**: five standard gates + frozen-surface zero-diff (now including core/cloud packages and 0001) + 56-case core suite on Postgres + invariants execution + cloud suite regression.
- **Review/acceptance boundary**: Gatekeeper re-runs compose + migrate (0001→0002) + both suites + invariants as the acceptance artifact; DDL reviewed against §5 and §12.6.2; reviewer and implementer are different execution contexts.
- **High-risk surface**: quota no-oversell, mailbox never-delete-unacked, board/truth CAS semantics, 0002 freezing at merge.
- **Why not checklist row**: Second frozen migration + the program's heaviest port semantics + the I4 SQL-side commitment (D-2) close here.

## Evidence Contract

- **State/progress path**: `## Task Breakdown` below; sprint §S4A.5 boxes attributable to S4A-b (I4 SQL side; same suite on both compositions for the core domain; cross-tenant catalog assertion; retention documented).
- **Verification evidence**: `.ai/harness/checks/latest.json` via `repo-harness run verify-sprint --prepare-acceptance --contract tasks/contracts/20260808-0232-s4a-b-core-postgres.contract.md`.
- **Evaluator rubric**: core conformance 56/56 on Postgres with `packages/conformance/src/core/` zero-diff; invariants file executes clean and references both migrations; quota concurrency case green on real Postgres; `collectRetired` marks-not-deletes unacked; runbook contains the ring-vs-SQL clause and the noteSkippedSeq gap; both P2s closed; frozen surfaces zero-diff.
- **Stop condition**: Any diff in `packages/core|cloud|protocol|server|keys|client/**`, `examples/**`, or `deploy/sql/0001_cloud_local.sql`; any conformance assertion change or per-composition branch; any read-then-write on a CAS or quota path; any path that deletes unacked mailbox rows; any new UNIQUE constraint outside the whitelist pattern — stop, amend or escalate.
- **Rollback surface**: Revert the PR; additive-only.

## Annotations

## Task Breakdown
- [x] Ride-alongs (first commit): migrate.ts ROLLBACK shadowing fix + todos noteSkippedSeq trigger narrowed to protocol-bump-only
- [x] `deploy/sql/0002_core_domain.sql`: eleven tables per §5 (TEXT instants, BIGINT sizes, tenant-first keys); 0001 untouched; `check:deploy-sql` green
- [x] Seven core port Postgres implementations (single-statement CAS; quota aggregate-guarded reserve; mailbox monotonic ack + mark-not-delete retirement)
- [x] Postgres core composition entry green: `runCoreConformance('postgres', factory)` 56/56, conformance package zero-diff
- [x] `tests/sql/control_plane_invariants.sql` (catalog DO-blocks + migration reference header) + executing test; `check:deploy-sql` still green in reference mode
- [x] `deploy/runbooks/mailbox-retention.md`: windows, host-driven invocation, §12.7.5 mapping, ring-vs-SQL clause, noteSkippedSeq evidence gap
- [x] Full gates green incl. frozen-surface zero-diff machine check and cloud suite regression
