-- control_plane_invariants.sql — the tenant-first key discipline, made executable.
--
-- Migrations covered by this file:
--
--   deploy/sql/0001_cloud_local.sql   (the seven cloud-local port tables)
--   deploy/sql/0002_core_domain.sql   (the eleven core-domain port tables)
--   deploy/sql/0003_cloud_cleanup.sql (the three maintenance authority tables)
--   deploy/sql/0004_device_proof_truth.sql (proof key columns + replay authority table)
--   deploy/sql/0005_skill_packs.sql   (the two skill-pack tables: manifest + files)
--   deploy/sql/0006_device_presence_toolsets.sql (nullable logical-toolset inventory column)
--   deploy/sql/0007_approval_timeline.sql (bounded approval lifecycle tail)
--   deploy/sql/0008_device_assertion_replay.sql (single-use assertion exchange ledger)
--
-- Every migration must be claimed here. `check-deploy-sql-order` enforces that
-- the moment this file exists, and the friction is the point: a new table has
-- to be looked at by the invariant that would otherwise have quietly accepted
-- it (docs/researches/s4a-dataplane-design.md §9).
--
-- ---------------------------------------------------------------------------
-- What this file is, and what it deliberately is not
-- ---------------------------------------------------------------------------
--
-- It is the machine-readable form of §12.6.2 layer 3: EVERY unique index or
-- constraint on a tenant-owned table starts with `tenant_id`. A naked unique
-- key is what turns "look up by id, then check the tenant" into a reachable
-- code path; when the first column is `tenant_id`, a cross-tenant read
-- addresses a different key space and finds nothing rather than finding a row
-- it then has to be trusted to reject.
--
-- It is NOT an `EXPLAIN` assertion. A plan check varies with statistics, data
-- volume and server version — a test that flakes by construction — and it
-- proves the wrong proposition anyway: "this query did not use that index" is
-- not "no such path exists". A catalog assertion is deterministic, is
-- independent of the planner, and answers the question that was actually asked
-- (design §8).
--
-- It is also not test-only. `psql -f tests/sql/control_plane_invariants.sql`
-- against a production database is the same health check, which is why the
-- assertions live here in SQL and the TypeScript side only runs the file and
-- asserts it did not raise. Restating any of this in TypeScript would create
-- the second source of truth this repository exists without.
--
-- Scope: every ordinary table in `current_schema()` except the migration
-- runner's own ledger, which is infrastructure rather than port state.

-- ---------------------------------------------------------------------------
-- 0. The schema is actually migrated
-- ---------------------------------------------------------------------------
--
-- Without this block the two below pass trivially against an empty schema, and
-- a green result would mean "nothing was checked" rather than "nothing is
-- wrong". 26 is 0001's seven plus 0002's eleven plus 0003's three plus
-- 0004's one plus 0005's two plus 0007's one plus 0008's one; migrations that
-- only alter an existing table do not add to the count. A later migration may only
-- raise it.
DO $$
DECLARE
  port_tables integer;
BEGIN
  SELECT count(*) INTO port_tables
    FROM pg_class t
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = current_schema()
     AND t.relkind = 'r'
     AND t.relname <> 'byok_schema_migration';

  IF port_tables < 26 THEN
    RAISE EXCEPTION
      'control-plane invariants ran against an unmigrated schema: %.% has % port table(s), expected at least 26 (0001_cloud_local.sql + 0002_core_domain.sql + 0003_cloud_cleanup.sql + 0004_device_proof_truth.sql + 0005_skill_packs.sql + 0007_approval_timeline.sql + 0008_device_assertion_replay.sql)',
      current_database(), current_schema(), port_tables;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Every tenant-owned table carries a NOT NULL tenant_id
-- ---------------------------------------------------------------------------
--
-- The column is what every other layer's guarantee is expressed in terms of. A
-- nullable one would let a row exist that belongs to no tenant and therefore
-- matches no tenant-scoped predicate — invisible to its owner and reachable
-- only by a query that forgot the tenant.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(t.relname, ', ' ORDER BY t.relname) INTO offenders
    FROM pg_class t
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = current_schema()
     AND t.relkind = 'r'
     AND t.relname <> 'byok_schema_migration'
     AND NOT EXISTS (
       SELECT 1
         FROM pg_attribute a
        WHERE a.attrelid = t.oid
          AND a.attname = 'tenant_id'
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND a.attnotnull);

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'control-plane invariant violated (§12.6.2 layer 3): table(s) without a NOT NULL tenant_id column: %',
      offenders;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Every unique index leads with tenant_id, with exactly two exceptions
-- ---------------------------------------------------------------------------
--
-- The whitelist is written into the assertion rather than derived from
-- anything, so adding a third exception means editing this file — and that is
-- its entire value. Both entries are single-step pre-tenant resolutions of a
-- CLOUD-MINTED credential, never a two-step "find by id, then compare tenant":
--
--   device.device_id   — `dev_<uuid>` minted by the cloud
--                        (packages/cloud/src/auth/plane.ts); global uniqueness
--                        is constructive, and the row it returns CARRIES its
--                        tenant, so every step after it is tenant-first. If a
--                        protocol ever let a device choose its own id, this
--                        becomes a cross-tenant denial of service and has to go.
--   pairing_code.code  — a single-use credential the host's control plane
--                        minted out of band. `PairRequest` has no tenant field
--                        at all, so a device can never name the tenant it lands
--                        in; the code IS the tenant lookup.
--
-- Primary keys are covered without naming them separately: every PRIMARY KEY
-- and UNIQUE constraint has a backing `pg_index` row with `indisunique`.
--
-- An expression index reports attnum 0 and so matches no `pg_attribute` row.
-- Those are reported as offenders rather than skipped: a unique expression
-- index over something other than a tenant-first prefix is exactly the shape
-- this assertion exists to catch, and silently ignoring it would be the one
-- way to slip past a file whose whole job is to have no blind spot.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(format('%s.%s (leads with %s)',
                           t.relname, i.relname, COALESCE(a.attname, '<expression>')),
                    ', ' ORDER BY t.relname, i.relname)
    INTO offenders
    FROM pg_index x
    JOIN pg_class i      ON i.oid = x.indexrelid
    JOIN pg_class t      ON t.oid = x.indrelid
    JOIN pg_namespace n  ON n.oid = t.relnamespace
    LEFT JOIN pg_attribute a
           ON a.attrelid = t.oid
          AND a.attnum = x.indkey[0]
   WHERE n.nspname = current_schema()
     AND t.relkind = 'r'
     AND t.relname <> 'byok_schema_migration'
     AND x.indisunique
     AND COALESCE(a.attname, '<expression>') <> 'tenant_id'
     AND NOT (t.relname = 'device'       AND a.attname = 'device_id')
     AND NOT (t.relname = 'pairing_code' AND a.attname = 'code');

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'control-plane invariant violated (§12.6.2 layer 3): unique index/constraint not leading with tenant_id: %. Two exceptions are whitelisted in tests/sql/control_plane_invariants.sql; a third needs an argument, not an edit.',
      offenders;
  END IF;
END $$;
