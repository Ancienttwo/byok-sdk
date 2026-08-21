-- Disposable Worker/Hyperdrive authority for docker-compose.test.yml only.
-- The role owns the schema and PostgreSQL installs this setting on every new
-- session for this database; neither Node nor Worker supplies a schema option.
CREATE ROLE byok_worker_e2e
  LOGIN
  PASSWORD 'byok_worker_e2e'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT;

CREATE SCHEMA byok_worker_e2e AUTHORIZATION byok_worker_e2e;

ALTER ROLE byok_worker_e2e IN DATABASE byok_test
  SET search_path TO byok_worker_e2e, public;
