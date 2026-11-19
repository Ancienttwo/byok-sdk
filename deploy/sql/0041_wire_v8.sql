-- Wire v8 starts on an empty store. Check the whole BYOK schema before
-- changing its shape or wire epoch. Reads include descendant partitions.
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
       AND c.relname NOT IN ('byok_schema_migration', 'byok_wire_epoch', 'tenant_erasure_operation')
     ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I)', current_schema(), relation.relname) INTO occupied;
    IF occupied THEN
      RAISE EXCEPTION '0041_wire_v8: table % holds rows; drain first and create a new database for wire v8.', relation.relname;
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE task
  DROP CONSTRAINT task_claimed_identity_exclusive,
  DROP CONSTRAINT task_claimed_executor_present,
  DROP COLUMN claimed_runtime,
  ADD CONSTRAINT task_claimed_executor_present CHECK ((owner_device_id IS NULL) = (claimed_harness_id IS NULL));

ALTER TABLE device_presence RENAME COLUMN runtimes TO harnesses;
ALTER TABLE device_presence RENAME CONSTRAINT device_presence_runtimes_shape TO device_presence_harnesses_shape;

UPDATE byok_wire_epoch SET epoch = 8 WHERE singleton;
