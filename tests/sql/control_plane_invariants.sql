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
--   deploy/sql/0013_agent_egress_contract.sql (immutable reliable Agent egress receipt facts)
--   deploy/sql/0014_agent_memory_projection.sql (bounded redacted head + body-free metering receipts)
--   deploy/sql/0015_device_machine_identity.sql (nullable client-hashed machine identity + partial active-machine uniqueness)
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
-- Without this block the checks below pass trivially against an empty schema, and
-- a green result would mean "nothing was checked" rather than "nothing is
-- wrong". 30 is 0001's seven plus 0002's eleven plus 0003's three plus
-- 0004's one plus 0005's two plus 0007's one plus 0008's one plus 0010's
-- package/operator erasure receipt; 0013 adds one immutable reliable Agent
-- egress table; 0014 adds the projection head, metering receipt, and erase
-- epoch-fence tables;
-- 0009 alters the existing task table and is
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

  IF port_tables < 31 THEN
    RAISE EXCEPTION
      'control-plane invariants ran against an unmigrated schema: %.% has % port table(s), expected at least 31 (0001_cloud_local.sql + 0002_core_domain.sql + 0003_cloud_cleanup.sql + 0004_device_proof_truth.sql + 0005_skill_packs.sql + 0007_approval_timeline.sql + 0008_device_assertion_replay.sql + 0011_tenant_erasure.sql + 0013_agent_egress_contract.sql + 0014_agent_memory_projection.sql; 0009_task_cancellation.sql, 0010_tenant_readiness.sql, and 0012_agent_home_contract.sql are checked separately)',
      current_database(), current_schema(), port_tables;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 0.5 Reliable Agent egress facts preserve every acknowledgement discriminator
-- ---------------------------------------------------------------------------
--
-- A receipt row is never an opaque envelope blob: tenant/device/event identity,
-- AgentRef, session, policy revision, cursor, content hash, and receipt id are
-- all durable columns so the host can make an exact typed readback. The primary
-- key is also the first-write-wins idempotency authority.
DO $$
DECLARE
  missing_columns text;
  primary_key_columns text[];
BEGIN
  SELECT string_agg(required.column_name, ', ' ORDER BY required.column_name)
    INTO missing_columns
    FROM (
      VALUES
        ('tenant_id'::text, 'text'::regtype),
        ('device_id'::text, 'text'::regtype),
        ('event_id'::text, 'uuid'::regtype),
        ('agent_id'::text, 'text'::regtype),
        ('agent_profile_revision'::text, 'text'::regtype),
        ('session_ref'::text, 'text'::regtype),
        ('policy_revision'::text, 'text'::regtype),
        ('cursor'::text, 'bigint'::regtype),
        ('payload_json'::text, 'jsonb'::regtype),
        ('content_hash'::text, 'text'::regtype),
        ('byte_count'::text, 'integer'::regtype),
        ('receipt_id'::text, 'uuid'::regtype),
        ('recorded_at'::text, 'timestamp with time zone'::regtype)
    ) AS required(column_name, type_oid)
   WHERE NOT EXISTS (
      SELECT 1
        FROM pg_class t
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid
       WHERE n.nspname = current_schema()
         AND t.relname = 'agent_egress_event'
         AND a.attname = required.column_name
         AND a.atttypid = required.type_oid
         AND a.attnum > 0
         AND NOT a.attisdropped
    );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'control-plane invariants ran without complete 0013_agent_egress_contract.sql: agent_egress_event is missing column(s): %',
      missing_columns;
  END IF;

  SELECT array_agg(a.attname ORDER BY key_columns.ordinality)
    INTO primary_key_columns
    FROM pg_constraint constraint_row
    JOIN pg_class t ON t.oid = constraint_row.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS key_columns(attnum, ordinality)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key_columns.attnum
   WHERE n.nspname = current_schema()
     AND t.relname = 'agent_egress_event'
     AND constraint_row.contype = 'p';

  IF primary_key_columns IS DISTINCT FROM ARRAY['tenant_id', 'device_id', 'event_id']::text[] THEN
    RAISE EXCEPTION
      'agent_egress_event primary key must be (tenant_id, device_id, event_id), found %',
      primary_key_columns;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 0.6 Hosted Agent-memory projection has exact tenant-first replay authority
-- ---------------------------------------------------------------------------
--
-- The head is the only durable content authority: it contains one bounded
-- redacted bytea snapshot for the current (tenant, agent) state. The immutable
-- receipt retains exact non-body replay bindings and metering facts, but must
-- not grow a second snapshot/body store or an audit payload.
DO $$
DECLARE
  missing_columns text;
  head_primary_key_columns text[];
  fence_primary_key_columns text[];
  receipt_primary_key_columns text[];
  receipt_mutation_unique_columns text[];
  receipt_mutation_unique_count integer;
  body_columns_outside_head text;
BEGIN
  SELECT string_agg(required.table_name || '.' || required.column_name, ', ' ORDER BY required.table_name, required.column_name)
    INTO missing_columns
    FROM (
      VALUES
        ('agent_memory_projection_head'::text, 'tenant_id'::text, 'text'::regtype),
        ('agent_memory_projection_head'::text, 'agent_id'::text, 'text'::regtype),
        ('agent_memory_projection_head'::text, 'writer_epoch'::text, 'integer'::regtype),
        ('agent_memory_projection_head'::text, 'source_seq'::text, 'integer'::regtype),
        ('agent_memory_projection_head'::text, 'mutation_id'::text, 'uuid'::regtype),
        ('agent_memory_projection_head'::text, 'device_id'::text, 'text'::regtype),
        ('agent_memory_projection_head'::text, 'task_id'::text, 'text'::regtype),
        ('agent_memory_projection_head'::text, 'agent_profile_revision'::text, 'text'::regtype),
        ('agent_memory_projection_head'::text, 'session_ref'::text, 'text'::regtype),
        ('agent_memory_projection_head'::text, 'runtime_id'::text, 'text'::regtype),
        ('agent_memory_projection_head'::text, 'grant_ref'::text, 'text'::regtype),
        ('agent_memory_projection_head'::text, 'policy_revision'::text, 'text'::regtype),
        ('agent_memory_projection_head'::text, 'redacted_hash'::text, 'text'::regtype),
        ('agent_memory_projection_head'::text, 'redacted_snapshot'::text, 'bytea'::regtype),
        ('agent_memory_projection_head'::text, 'redacted_byte_count'::text, 'integer'::regtype),
        ('agent_memory_projection_head'::text, 'committed_at'::text, 'timestamp with time zone'::regtype),
        ('agent_memory_projection_erase_fence'::text, 'tenant_id'::text, 'text'::regtype),
        ('agent_memory_projection_erase_fence'::text, 'agent_id'::text, 'text'::regtype),
        ('agent_memory_projection_erase_fence'::text, 'next_writer_epoch'::text, 'integer'::regtype),
        ('agent_memory_projection_erase_fence'::text, 'erased_at'::text, 'timestamp with time zone'::regtype),
        ('agent_memory_projection_metering_receipt'::text, 'tenant_id'::text, 'text'::regtype),
        ('agent_memory_projection_metering_receipt'::text, 'agent_id'::text, 'text'::regtype),
        ('agent_memory_projection_metering_receipt'::text, 'writer_epoch'::text, 'integer'::regtype),
        ('agent_memory_projection_metering_receipt'::text, 'source_seq'::text, 'integer'::regtype),
        ('agent_memory_projection_metering_receipt'::text, 'mutation_id'::text, 'uuid'::regtype),
        ('agent_memory_projection_metering_receipt'::text, 'device_id'::text, 'text'::regtype),
        ('agent_memory_projection_metering_receipt'::text, 'task_id'::text, 'text'::regtype),
        ('agent_memory_projection_metering_receipt'::text, 'agent_profile_revision'::text, 'text'::regtype),
        ('agent_memory_projection_metering_receipt'::text, 'session_ref'::text, 'text'::regtype),
        ('agent_memory_projection_metering_receipt'::text, 'runtime_id'::text, 'text'::regtype),
        ('agent_memory_projection_metering_receipt'::text, 'grant_ref'::text, 'text'::regtype),
        ('agent_memory_projection_metering_receipt'::text, 'policy_revision'::text, 'text'::regtype),
        ('agent_memory_projection_metering_receipt'::text, 'redacted_hash'::text, 'text'::regtype),
        ('agent_memory_projection_metering_receipt'::text, 'redacted_byte_count'::text, 'integer'::regtype),
        ('agent_memory_projection_metering_receipt'::text, 'metering_receipt_id'::text, 'uuid'::regtype),
        ('agent_memory_projection_metering_receipt'::text, 'recorded_at'::text, 'timestamp with time zone'::regtype)
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
      'control-plane invariants ran without complete 0014_agent_memory_projection.sql: missing column(s): %',
      missing_columns;
  END IF;

  SELECT array_agg(a.attname ORDER BY key_columns.ordinality)
    INTO head_primary_key_columns
    FROM pg_constraint constraint_row
    JOIN pg_class t ON t.oid = constraint_row.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS key_columns(attnum, ordinality)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key_columns.attnum
   WHERE n.nspname = current_schema()
     AND t.relname = 'agent_memory_projection_head'
     AND constraint_row.contype = 'p';

  IF head_primary_key_columns IS DISTINCT FROM ARRAY['tenant_id', 'agent_id']::text[] THEN
    RAISE EXCEPTION
      'agent_memory_projection_head primary key must be (tenant_id, agent_id), found %',
      head_primary_key_columns;
  END IF;

  SELECT array_agg(a.attname ORDER BY key_columns.ordinality)
    INTO fence_primary_key_columns
    FROM pg_constraint constraint_row
    JOIN pg_class t ON t.oid = constraint_row.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS key_columns(attnum, ordinality)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key_columns.attnum
   WHERE n.nspname = current_schema()
     AND t.relname = 'agent_memory_projection_erase_fence'
     AND constraint_row.contype = 'p';

  IF fence_primary_key_columns IS DISTINCT FROM ARRAY['tenant_id', 'agent_id']::text[] THEN
    RAISE EXCEPTION
      'agent_memory_projection_erase_fence primary key must be (tenant_id, agent_id), found %',
      fence_primary_key_columns;
  END IF;

  SELECT array_agg(a.attname ORDER BY key_columns.ordinality)
    INTO receipt_primary_key_columns
    FROM pg_constraint constraint_row
    JOIN pg_class t ON t.oid = constraint_row.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS key_columns(attnum, ordinality)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key_columns.attnum
   WHERE n.nspname = current_schema()
     AND t.relname = 'agent_memory_projection_metering_receipt'
     AND constraint_row.contype = 'p';

  IF receipt_primary_key_columns IS DISTINCT FROM ARRAY['tenant_id', 'agent_id', 'writer_epoch', 'source_seq']::text[] THEN
    RAISE EXCEPTION
      'agent_memory_projection_metering_receipt primary key must be (tenant_id, agent_id, writer_epoch, source_seq), found %',
      receipt_primary_key_columns;
  END IF;

  SELECT count(*)
    INTO receipt_mutation_unique_count
    FROM (
      SELECT array_agg(a.attname ORDER BY key_columns.ordinality) AS columns
        FROM pg_constraint constraint_row
        JOIN pg_class t ON t.oid = constraint_row.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        CROSS JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS key_columns(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key_columns.attnum
       WHERE n.nspname = current_schema()
         AND t.relname = 'agent_memory_projection_metering_receipt'
         AND constraint_row.contype = 'u'
       GROUP BY constraint_row.oid
    ) AS unique_columns;

  SELECT unique_columns.columns
    INTO receipt_mutation_unique_columns
    FROM (
      SELECT array_agg(a.attname ORDER BY key_columns.ordinality) AS columns
        FROM pg_constraint constraint_row
        JOIN pg_class t ON t.oid = constraint_row.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        CROSS JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS key_columns(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key_columns.attnum
       WHERE n.nspname = current_schema()
         AND t.relname = 'agent_memory_projection_metering_receipt'
         AND constraint_row.contype = 'u'
       GROUP BY constraint_row.oid
       LIMIT 1
    ) AS unique_columns;

  IF receipt_mutation_unique_count <> 1
     OR receipt_mutation_unique_columns IS DISTINCT FROM ARRAY['tenant_id', 'agent_id', 'writer_epoch', 'mutation_id']::text[] THEN
    RAISE EXCEPTION
      'agent_memory_projection_metering_receipt must have exactly one tenant-first replay unique key (tenant_id, agent_id, writer_epoch, mutation_id), found % unique key(s) with columns %',
      receipt_mutation_unique_count, receipt_mutation_unique_columns;
  END IF;

  SELECT string_agg(t.relname || '.' || a.attname, ', ' ORDER BY t.relname, a.attname)
    INTO body_columns_outside_head
    FROM pg_class t
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid
   WHERE n.nspname = current_schema()
     AND t.relname IN ('agent_memory_projection_head', 'agent_memory_projection_metering_receipt', 'agent_memory_projection_erase_fence')
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND (
       a.atttypid = 'bytea'::regtype
       OR a.attname ILIKE '%snapshot%'
       OR a.attname ILIKE '%body%'
       OR a.attname ILIKE '%payload%'
     )
     AND NOT (t.relname = 'agent_memory_projection_head' AND a.attname = 'redacted_snapshot' AND a.atttypid = 'bytea'::regtype);

  IF body_columns_outside_head IS NOT NULL THEN
    RAISE EXCEPTION
      'agent-memory projection body may exist only as agent_memory_projection_head.redacted_snapshot; forbidden body column(s): %',
      body_columns_outside_head;
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
-- 0.5 Device machine identity is installed, nullable, and uniquely active
-- ---------------------------------------------------------------------------
--
-- 0015 creates no table and changes no tenant-first key shape, so the
-- invariant is an explicit catalog check. Two facts are asserted rather than
-- trusted: the column is NULLABLE (a device that cannot identify its machine
-- must still pair) and the uniqueness is PARTIAL (a plain unique key over a
-- mostly-NULL column would be uniqueness that never fires, and one that also
-- covered revoked rows would make superseding a machine impossible).
DO $$
DECLARE
  column_ok boolean;
  index_predicate text;
BEGIN
  SELECT NOT a.attnotnull INTO column_ok
    FROM pg_class t
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid
   WHERE n.nspname = current_schema()
     AND t.relname = 'device'
     AND a.attname = 'machine_id'
     AND a.atttypid = 'text'::regtype
     AND a.attnum > 0
     AND NOT a.attisdropped;

  IF column_ok IS NULL THEN
    RAISE EXCEPTION 'control-plane invariants ran without 0015_device_machine_identity.sql: device.machine_id is missing';
  END IF;
  IF NOT column_ok THEN
    RAISE EXCEPTION 'device.machine_id must stay nullable: a device that cannot identify its machine must still be able to pair';
  END IF;

  SELECT pg_get_expr(x.indpred, x.indrelid) INTO index_predicate
    FROM pg_index x
    JOIN pg_class i     ON i.oid = x.indexrelid
    JOIN pg_class t     ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = current_schema()
     AND t.relname = 'device'
     AND i.relname = 'device_active_machine_key'
     AND x.indisunique;

  IF index_predicate IS NULL THEN
    RAISE EXCEPTION
      'device_active_machine_key must exist as a PARTIAL unique index over the active rows only; found no such index (or a total one)';
  END IF;
  -- Mutation-proof: a predicate of only `machine_id IS NOT NULL` still passes
  -- the NULL check above while making supersession impossible (a revoked row
  -- would keep occupying the key), and a predicate of only `NOT revoked` turns
  -- every unidentified device into one shared machine. Both halves are named.
  IF index_predicate NOT LIKE '%machine_id IS NOT NULL%' THEN
    RAISE EXCEPTION
      'device_active_machine_key must be partial on machine_id IS NOT NULL so NULL machine ids never collide; predicate is: %',
      index_predicate;
  END IF;
  IF index_predicate NOT LIKE '%NOT revoked%' THEN
    RAISE EXCEPTION
      'device_active_machine_key must be partial on NOT revoked so a superseded machine can re-pair; predicate is: %',
      index_predicate;
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
