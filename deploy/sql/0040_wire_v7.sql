-- Wire v7 (#1757). v7 starts on a new database: nothing a v6 build wrote is
-- migrated (docs/releases/host-upgrade-next-minor.md#wire-v7).
--
-- Preflight: any row in any table of this schema except the migration ledger
-- and the erasure operation log means the database is not new, and the
-- migration stops before any change. Host configuration (storage entitlements,
-- retention policy) is written after the migrations, so it counts too. Each
-- migration file is its own transaction, so 0001-0039 stay applied.
--
-- The scope is the schema the migrations run in (`current_schema()`, where
-- every unqualified table above was created), not the database: a Host may
-- share the database with other applications. A table is read without ONLY, so
-- Postgres walks pg_inherits and the read covers every partition and inheriting
-- child, whatever schema it lives in; a partitioned parent (relkind 'p') holds
-- no rows of its own, so it is read the same way.

DO $$
DECLARE
  relation record;
  occupied boolean;
BEGIN
  FOR relation IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relkind IN ('r', 'p')
       AND c.relname NOT IN ('byok_schema_migration', 'tenant_erasure_operation')
     ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I)', current_schema(), relation.relname) INTO occupied;
    IF occupied THEN
      RAISE EXCEPTION '0040_wire_v7: table % holds rows; wire v7 starts on a new database and nothing was changed. Export the Host history you need, then run the migrations on a new database.', relation.relname;
    END IF;
  END LOOP;
END;
$$;

-- The store's wire epoch: the one fact a composition checks before it serves
-- (createPostgresCloudStores). It is written here, after the preflight, so a
-- database that held v6 data never carries epoch 7.
CREATE TABLE byok_wire_epoch (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  epoch     integer NOT NULL
);
INSERT INTO byok_wire_epoch (epoch) VALUES (7);

-- A device's first refusal of one steer (#2009). First write wins on the
-- primary key; `revision` is per task, gapless from 1, assigned under the
-- store's per-task lock. No foreign key to `task`: a refusal is an observation
-- keyed by ids, and archive, redaction and retention keep it.
CREATE TABLE task_steer_refusal (
  tenant_id        text        NOT NULL,
  task_id          text        NOT NULL,
  steer_message_id text        NOT NULL,
  reason           text        NOT NULL,
  device_id        text        NOT NULL,
  recorded_at      timestamptz NOT NULL,
  revision         integer     NOT NULL CHECK (revision > 0),
  PRIMARY KEY (tenant_id, task_id, steer_message_id),
  CONSTRAINT task_steer_refusal_revision_key UNIQUE (tenant_id, task_id, revision)
);

-- B1-g: a claimed attempt names exactly one executor, in one of the two
-- columns (0021 keeps them exclusive).
ALTER TABLE task ADD CONSTRAINT task_claimed_executor_present
  CHECK (owner_device_id IS NULL OR num_nonnulls(claimed_runtime, claimed_harness_id) = 1);
