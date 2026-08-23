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
--   deploy/sql/0009_task_cancellation.sql (durable host cancellation tombstone and delivery identity)
--   deploy/sql/0010_tenant_readiness.sql (optional frozen presence facts)
--   deploy/sql/0011_tenant_erasure.sql (package/operator erasure receipt, not product data)
--   deploy/sql/0012_agent_home_contract.sql (durable capability + exact AgentRef task identity)
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
-- wrong". 27 is 0001's seven plus 0002's eleven plus 0003's three plus
-- 0004's one plus 0005's two plus 0007's one plus 0008's one plus 0010's
-- package/operator erasure receipt; 0009 alters the existing task table and is
-- checked explicitly in section 0.1. A later migration may only raise this count.
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

  IF port_tables < 27 THEN
    RAISE EXCEPTION
      'control-plane invariants ran against an unmigrated schema: %.% has % port table(s), expected at least 27 (0001_cloud_local.sql + 0002_core_domain.sql + 0003_cloud_cleanup.sql + 0004_device_proof_truth.sql + 0005_skill_packs.sql + 0007_approval_timeline.sql + 0008_device_assertion_replay.sql + 0011_tenant_erasure.sql; 0009_task_cancellation.sql and 0010_tenant_readiness.sql are checked separately)',
      current_database(), current_schema(), port_tables;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 0.4 Agent-home durable admission and task identity columns are installed
-- ---------------------------------------------------------------------------
--
-- 0012 changes no tenant-first key shape and creates no table. These columns
-- are nullable for legacy devices/tasks; the application gate treats missing
-- device capabilities as unsupported and requires the AgentRef pair together.
DO $$
DECLARE
  missing_columns text;
BEGIN
  SELECT string_agg(required.table_name || '.' || required.column_name, ', ' ORDER BY required.table_name, required.column_name)
    INTO missing_columns
    FROM (
      VALUES
        ('device'::text, 'capabilities'::text, 'jsonb'::regtype),
        ('task'::text, 'agent_id'::text, 'text'::regtype),
        ('task'::text, 'agent_profile_revision'::text, 'text'::regtype),
        ('task'::text, 'terminal_cause'::text, 'text'::regtype)
    ) AS required(table_name, column_name, type_oid)
   WHERE NOT EXISTS (
      SELECT 1
        FROM pg_class t
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid
       WHERE n.nspname = current_schema()
         AND t.relname = required.table_name
         AND a.attname = required.column_name
         AND a.atttypid = required.type_oid
         AND a.attnum > 0
         AND NOT a.attisdropped
    );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'control-plane invariants ran without 0012_agent_home_contract.sql: missing column(s): %',
      missing_columns;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 0.2 Tenant readiness presence projection has the additive fact columns
-- ---------------------------------------------------------------------------
--
-- 0010 changes no key shape and creates no table, so the invariant is an
-- explicit catalog check rather than another table-count increment. These
-- fields are nullable by design: older daemons omit release/runtime/auth facts
-- and the SDK must not synthesize them.
DO $$
DECLARE
  missing_columns text;
BEGIN
  SELECT string_agg(required.name, ', ' ORDER BY required.name) INTO missing_columns
    FROM (
      VALUES
        ('client_version'::text, 'text'::regtype),
        ('protocol_versions'::text, 'jsonb'::regtype),
        ('runtimes'::text, 'jsonb'::regtype)
    ) AS required(name, type_oid)
   WHERE NOT EXISTS (
      SELECT 1
        FROM pg_class t
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid
       WHERE n.nspname = current_schema()
         AND t.relname = 'device_presence'
         AND a.attname = required.name
         AND a.atttypid = required.type_oid
         AND a.attnum > 0
         AND NOT a.attisdropped
    );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'control-plane invariants ran without 0010_tenant_readiness.sql: device_presence is missing column(s): %',
      missing_columns;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 0.3 Tenant-erasure receipt is installed, tenant-first, and distinct from
--     product data deletion. Completed rows remain operator evidence.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  missing_columns text;
BEGIN
  SELECT string_agg(required.name, ', ' ORDER BY required.name) INTO missing_columns
    FROM (
      VALUES
        ('operation_id'::text, 'text'::regtype),
        ('state'::text, 'text'::regtype),
        ('revision'::text, 'bigint'::regtype),
        ('r2_complete'::text, 'boolean'::regtype),
        ('sql_table_index'::text, 'integer'::regtype),
        ('completed_at'::text, 'timestamp with time zone'::regtype)
    ) AS required(name, type_oid)
   WHERE NOT EXISTS (
      SELECT 1
        FROM pg_class t
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid
       WHERE n.nspname = current_schema()
         AND t.relname = 'tenant_erasure_operation'
         AND a.attname = required.name
         AND a.atttypid = required.type_oid
         AND a.attnum > 0
         AND NOT a.attisdropped
    );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'control-plane invariants ran without 0011_tenant_erasure.sql: tenant_erasure_operation is missing column(s): %',
      missing_columns;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 0.1 Host cancellation migration is present with its exact durable columns
-- ---------------------------------------------------------------------------
--
-- 0009 is additive and does not create another table, so the table-count guard
-- above cannot distinguish a pre-0009 schema. All three columns are the one
-- cancellation authority: timestamp/reason is the accepted host tombstone and
-- message identity pins the one durable task.cancel delivery. They intentionally
-- remain nullable because existing and successfully completed tasks were never
-- cancelled.
DO $$
DECLARE
  missing_columns text;
BEGIN
  SELECT string_agg(required.name, ', ' ORDER BY required.name) INTO missing_columns
    FROM (
      VALUES
        ('cancel_requested_at'::text, 'timestamp with time zone'::regtype),
        ('cancel_reason'::text, 'text'::regtype),
        ('cancel_message_id'::text, 'text'::regtype)
    ) AS required(name, type_oid)
   WHERE NOT EXISTS (
      SELECT 1
        FROM pg_class t
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid
       WHERE n.nspname = current_schema()
         AND t.relname = 'task'
         AND a.attname = required.name
         AND a.atttypid = required.type_oid
         AND a.attnum > 0
         AND NOT a.attisdropped
    );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'control-plane invariants ran without 0009_task_cancellation.sql: task is missing cancellation column(s): %',
      missing_columns;
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
