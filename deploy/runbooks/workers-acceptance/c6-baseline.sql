-- C6 baseline, NEW dev branch byok-p9 only. Names, hashes and connection counts; no data rows.
\set ON_ERROR_STOP on
select version();
select current_setting('server_version_num')::integer / 10000 as major_version;
show ssl;
show max_connections;
select count(*) as current_connections,
  current_setting('max_connections')::integer - count(*) as available_connections
  from pg_stat_activity;
select nspname from pg_namespace
  where nspname not like 'pg\_%' and nspname <> 'information_schema' and nspname not like 'byok\_p9\_%' order by nspname;
select rolname from pg_roles where rolname not like 'byok\_p9\_%' order by rolname;
select count(*) as schemas, md5(string_agg(nspname, ',' order by nspname)) as schema_list_md5
  from pg_namespace where nspname not like 'pg\_%' and nspname <> 'information_schema' and nspname not like 'byok\_p9\_%';
select count(*) as roles, md5(string_agg(rolname, ',' order by rolname)) as role_list_md5
  from pg_roles where rolname not like 'byok\_p9\_%';
