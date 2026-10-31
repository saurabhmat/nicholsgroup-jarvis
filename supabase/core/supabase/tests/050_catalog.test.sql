-- RLS catalog test (T-013). Fails when any table or view in an app schema breaks the lane conventions. App schemas
-- are every schema except Supabase/Postgres platform ones, so a new schema is checked automatically.
-- Exceptions are explicit, reviewed lists below; a stale entry (object no longer exists) also fails.
begin;
select plan(13);
\ir helpers/lane_rls.psql

create temp table platform_schemas (name text primary key) on commit drop;
insert into platform_schemas values
  ('_realtime'), ('auth'), ('extensions'), ('graphql'), ('graphql_public'), ('information_schema'), ('pg_catalog'),
  ('pg_toast'), ('pgbouncer'), ('realtime'), ('storage'), ('supabase_functions'), ('supabase_migrations'), ('vault'),
  ('net'), ('cron'), ('pgsodium'), ('pgsodium_masks');

-- Control-plane tables that are not lane-scoped by design (T-012 review L4).
create temp table no_lane_id_ok (name text primary key, why text not null) on commit drop;
insert into no_lane_id_ok values
  ('core.lanes', 'the lane registry itself; keyed by code'),
  ('core.users', 'one profile per person across lanes; visibility via memberships');

-- Tables whose SELECT policy is not the plain standard pattern (still aal2 + allowed_lanes, plus extra clauses).
create temp table custom_policy_ok (name text primary key, why text not null) on commit drop;
insert into custom_policy_ok values
  ('core.memberships', 'own rows, plus lanes with the memberships view'),
  ('core.users', 'own row, plus members of lanes with the memberships view'),
  ('core.lanes', 'filters code (the lane id) instead of lane_id');

-- Tables where authenticated may write directly (through RLS write policies). Empty: writes go through service code
-- or security-definer functions.
create temp table user_dml_ok (name text primary key, why text not null) on commit drop;

create temp view app_tables as
  select c.oid, format('%s.%s', n.nspname, c.relname) as name, c.relkind
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm', 'f')
    and n.nspname not in (select name from platform_schemas)
    and n.nspname !~ '^pg_(temp|toast_temp)_';

-- ---------------------------------------------------------------- tables
select is(
  array(select t.name from app_tables t
        where t.relkind in ('r', 'p')
          and not exists (select 1 from pg_attribute a where a.attrelid = t.oid and a.attname = 'lane_id' and not a.attisdropped)
          and t.name not in (select name from no_lane_id_ok)
        order by 1),
  '{}'::text[],
  'every app table has lane_id (or is on the reviewed control-plane list)'
);
select is(
  array(select t.name from app_tables t join pg_class c on c.oid = t.oid
        where t.relkind in ('r', 'p') and not c.relrowsecurity order by 1),
  '{}'::text[],
  'every app table has RLS enabled'
);
select is(
  array(select t.name from app_tables t
        where t.relkind in ('r', 'p') and not exists (select 1 from pg_policy p where p.polrelid = t.oid) order by 1),
  '{}'::text[],
  'every app table has at least one policy'
);
select is(
  array(select distinct t.name from app_tables t join pg_policy p on p.polrelid = t.oid
        where p.polcmd in ('r', '*')
          and not (pg_get_expr(p.polqual, p.polrelid) ~ '''aal2''' and pg_get_expr(p.polqual, p.polrelid) ~ 'core\.allowed_lanes\(')
        order by 1),
  '{}'::text[],
  'every SELECT policy requires aal2 and goes through core.allowed_lanes'
);
select is(
  array(select distinct t.name from app_tables t join pg_policy p on p.polrelid = t.oid
        where t.relkind in ('r', 'p')
          and p.polcmd in ('r', '*')
          and pg_get_expr(p.polqual, p.polrelid) !~ ('^\(\(\( SELECT \(auth\.jwt\(\) ->> ''role''::text\)\)|^\(\(\( SELECT \(auth\.jwt\(\) ->> ''aal''::text\)\) = ''aal2''::text\) AND \(lane_id = ANY')
          and t.name not in (select name from custom_policy_ok)
        order by 1),
  '{}'::text[],
  'lane tables use the standard policy shape (or are on the reviewed custom list)'
);
select is(
  array(select distinct t.name from app_tables t join pg_policy p on p.polrelid = t.oid
        where 0 = any (p.polroles) or (select oid from pg_roles where rolname = 'anon') = any (p.polroles)
        order by 1),
  '{}'::text[],
  'no policy applies to public or anon'
);
select is(
  array(select t.name from app_tables t
        where has_table_privilege('anon', t.oid, 'select, insert, update, delete, truncate, references, trigger')
        order by 1),
  '{}'::text[],
  'anon has no privilege on any app table or view'
);
select is(
  array(select t.name from app_tables t
        where t.relkind in ('r', 'p')
          and has_table_privilege('authenticated', t.oid, 'insert, update, delete, truncate')
          and t.name not in (select name from user_dml_ok)
        order by 1),
  '{}'::text[],
  'authenticated has no direct DML on app tables (or is on the reviewed list)'
);

-- ---------------------------------------------------------------- views and functions
select is(
  array(select t.name from app_tables t join pg_class c on c.oid = t.oid
        where t.relkind = 'v' and not coalesce('security_invoker=true' = any (c.reloptions), false) order by 1),
  '{}'::text[],
  'every app view is security_invoker'
);
select is(
  array(select format('%s.%s', n.nspname, p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname not in (select name from platform_schemas) and n.nspname !~ '^pg_(temp|toast_temp)_'
          and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c = 'search_path=""')
        order by 1),
  '{}'::text[],
  'every app function pins an empty search_path'
);
select is(
  array(select format('%s.%s', n.nspname, p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname not in (select name from platform_schemas) and n.nspname !~ '^pg_(temp|toast_temp)_'
          and has_function_privilege('anon', p.oid, 'execute')
        order by 1),
  '{}'::text[],
  'anon cannot execute any app function'
);

-- ---------------------------------------------------------------- exception lists stay current
select is(
  array(select e.name from (select name from no_lane_id_ok union select name from custom_policy_ok union select name from user_dml_ok) e
        where to_regclass(e.name) is null order by 1),
  '{}'::text[],
  'no stale entries in the exception lists'
);

-- The standard helper agrees on a known lane table.
select pg_temp.has_standard_lane_policy('core.lane_policies', 'lane_policies');

select * from finish();
rollback;
