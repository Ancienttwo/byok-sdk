-- C5: run on the NEW dev branch only (never main), as the default role:
--   pscale shell aiphabee-staging <new-branch> --role admin
-- From the repo root, then: \i deploy/runbooks/workers-acceptance/c5-roles.sql
-- No passwords in this file. Set them afterwards with \password (typed by the owner).
\set ON_ERROR_STOP on
CREATE ROLE byok_p9_h LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE byok_p9_canary LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE SCHEMA byok_p9_sdk_h AUTHORIZATION byok_p9_h;
CREATE SCHEMA byok_p9_h AUTHORIZATION byok_p9_h;
CREATE SCHEMA byok_p9_host AUTHORIZATION byok_p9_h;
CREATE SCHEMA byok_p9_sdk_canary AUTHORIZATION byok_p9_canary;
ALTER ROLE byok_p9_h IN DATABASE postgres SET search_path TO byok_p9_sdk_h, public;
ALTER ROLE byok_p9_canary IN DATABASE postgres SET search_path TO byok_p9_sdk_canary, public;
-- Needed only for steps 3.3-3.4 (store.migrate runs CREATE SCHEMA IF NOT EXISTS); revoked right after.
-- If this GRANT is refused: STOP, change nothing else, and tell t3.
GRANT CREATE ON DATABASE postgres TO byok_p9_h;
\dn byok_p9_*
\du byok_p9_*
