-- RLS catalog test (T-013). Fails when any object in an app schema breaks the lane conventions. App schemas are every
-- schema except Supabase/Postgres platform ones, so a new schema is checked automatically. Exceptions are explicit,
-- reviewed lists with a reason per entry; a stale entry (object no longer exists) also fails.
-- Policies are compared as whole expressions against the canonical text, never by fragment (T-013 review H1, M1).
begin;
select plan(20);
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
  ('core.users', 'one profile per person across lanes; visibility via memberships'),
  ('core.mfa_verification_attempts', 'per-user security counter written by the auth hook; no API access'),
  ('core.mfa_enrolment_state', 'per-user MFA enrolment guard (T-020); no API access');

-- Private tables: RLS on with NO policy (deny all) and no grants to API roles; reached only by definer code.
create temp table private_table_ok (name text primary key, why text not null) on commit drop;
insert into private_table_ok values
  ('core.mfa_verification_attempts', 'MFA attempt guard (T-019), written by core.mfa_verification_attempt()'),
  ('core.mfa_enrolment_state', 'MFA enrolment guard (T-020); reset allowances are granted by an admin in SQL (runbook)'),
  ('core.connection_secrets', 'connection -> Vault secret id (T-032); only the core.connection_token_* functions'),
  ('core.oauth_states', 'OAuth connect state + PKCE verifier (T-035); only core.oauth_state_create / _consume'),
  ('raw.source_records', 'raw provider payloads (T-039); only core.source_records_upsert');

-- Tables whose SELECT policy is not the exact standard expression (reviewed by hand; each still requires aal2).
create temp table custom_policy_ok (name text primary key, why text not null) on commit drop;
insert into custom_policy_ok values
  ('core.memberships', 'own rows, plus lanes with the memberships view'),
  ('core.users', 'own row, plus members of lanes with the memberships view'),
  ('core.lanes', 'standard expression on code (the lane id) instead of lane_id');

-- Tables where authenticated may write directly (grants or write policies). Empty: writes go through service code or
-- reviewed security-definer functions.
create temp table user_dml_ok (name text primary key, why text not null) on commit drop;

-- Materialized views or foreign tables authenticated may read (they bypass RLS). Empty.
create temp table unprotected_read_ok (name text primary key, why text not null) on commit drop;

-- Security-definer functions (they bypass RLS and run as their owner). Each one is reviewed.
create temp table security_definer_ok (name text primary key, why text not null) on commit drop;
insert into security_definer_ok values
  ('core.allowed_lanes', 'reads memberships for RLS; own uid at aal2 only (T-012)'),
  ('core.has_lane_role', 'role check for actions; own uid at aal2 only (T-012)'),
  ('core.lane_config_public', 'non-sensitive config subset for lane members (T-011)'),
  ('audit.log', 'the only audit write path; service_role only (T-014)'),
  ('core.mfa_verification_attempt', 'Supabase Auth MFA hook; supabase_auth_admin only (T-019)'),
  ('core.connection_token_store', 'writes the Vault; service_role only, lane-checked (T-032)'),
  ('core.connection_token_read', 'reads the Vault; service_role only, lane-checked (T-032)'),
  ('core.connection_token_rotate', 'updates the Vault; service_role only, lane-checked (T-032)'),
  ('core.connection_token_revoke', 'deletes from the Vault and disconnects; service_role only, lane-checked (T-032)'),
  ('core.connections_no_orphan_secret', 'trigger only: reads the private Vault mapping on status changes (T-032)'),
  ('core.oauth_state_create', 'starts a connect; owner/admin_technical of the lane at aal2 only (T-035)'),
  ('core.oauth_state_consume', 'finishes a connect; own unexpired state, same lane, role re-checked (T-035)'),
  ('core.source_records_upsert', 'writes the private raw.source_records; service_role only, lane-checked against the connection (T-039)');

-- App functions authenticated may execute (callable through the API). Each one is reviewed.
create temp table authenticated_exec_ok (name text primary key, why text not null) on commit drop;
insert into authenticated_exec_ok values
  ('core.allowed_lanes', 'used by every RLS policy'),
  ('core.has_lane_role', 'role checks (requireRole)'),
  ('core.lane_config_public', 'public config subset'),
  ('core.view_names', 'pure list'),
  ('core.viewer_view_names', 'pure list'),
  ('core.role_views', 'pure mapping'),
  ('core.oauth_state_create', 'connect start; checks role and aal2 itself (T-035)'),
  ('core.oauth_state_consume', 'connect callback; own state only (T-035)');

create temp view app_objects as
  select c.oid, format('%s.%s', n.nspname, c.relname) as name, c.relkind
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    and n.nspname not in (select name from platform_schemas)
    and n.nspname !~ '^pg_(temp|toast_temp)_';
create temp view app_tables as select * from app_objects where relkind in ('r', 'p');
create temp view app_functions as
  select p.oid, format('%s.%s', n.nspname, p.proname) as name, p.prosecdef, p.proconfig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not in (select name from platform_schemas) and n.nspname !~ '^pg_(temp|toast_temp)_';

-- ---------------------------------------------------------------- tables
select is(
  array(select t.name from app_tables t
        where not exists (select 1 from pg_attribute a where a.attrelid = t.oid and a.attname = 'lane_id' and not a.attisdropped)
          and t.name not in (select name from no_lane_id_ok)
        order by 1),
  '{}'::text[],
  'every app table has lane_id (or is on the reviewed control-plane list)'
);
select is(
  array(select t.name from app_tables t join pg_class c on c.oid = t.oid where not c.relrowsecurity order by 1),
  '{}'::text[],
  'every app table has RLS enabled'
);
select is(
  array(select t.name from app_tables t
        where not exists (select 1 from pg_policy p where p.polrelid = t.oid)
          and not (t.name in (select name from private_table_ok)
                   and not has_table_privilege('authenticated', t.oid, 'select, insert, update, delete')
                   and not has_table_privilege('service_role', t.oid, 'select, insert, update, delete'))
        order by 1),
  '{}'::text[],
  'every app table has at least one policy (or is a reviewed private table without API grants)'
);
select is(
  array(select t.name from app_tables t
        where t.name not in (select name from custom_policy_ok)
          and t.name not in (select name from private_table_ok)
          and not (
            (select count(*) from pg_policy p where p.polrelid = t.oid and p.polpermissive) = 1
            and exists (
              select 1 from pg_policy p
              where p.polrelid = t.oid and p.polpermissive and p.polcmd = 'r'
                and p.polroles = array[(select oid from pg_roles where rolname = 'authenticated')]::oid[]
                and pg_get_expr(p.polqual, p.polrelid) in (select pg_temp.standard_lane_qual(v) from unnest(core.view_names()) v)))
        order by 1),
  '{}'::text[],
  'lane tables have exactly one permissive policy: SELECT for authenticated with the exact standard expression'
);
select is(
  array(select distinct t.name from app_tables t join pg_policy p on p.polrelid = t.oid
        where p.polcmd in ('r', '*') and pg_get_expr(p.polqual, p.polrelid) !~ '^\(\(\( SELECT \(auth\.jwt\(\) ->> ''aal''::text\)\) = ''aal2''::text\) AND '
        order by 1),
  '{}'::text[],
  'every SELECT policy (custom ones too) starts with the aal2 requirement as a conjunct'
);
select is(
  array(select distinct t.name from app_tables t join pg_policy p on p.polrelid = t.oid
        where p.polcmd in ('a', 'w', 'd', '*') and t.name not in (select name from user_dml_ok) order by 1),
  '{}'::text[],
  'no write (or ALL) policy outside the reviewed list'
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
        where (has_table_privilege('authenticated', t.oid, 'insert, update, delete, truncate')
               or has_any_column_privilege('authenticated', t.oid, 'insert, update'))
          and t.name not in (select name from user_dml_ok)
        order by 1),
  '{}'::text[],
  'authenticated has no table- or column-level DML on app tables (or is on the reviewed list)'
);

-- ---------------------------------------------------------------- other relations
select is(
  array(select o.name from app_objects o
        where o.relkind <> 'S'
          and (has_table_privilege('anon', o.oid, 'select, insert, update, delete, truncate, references, trigger')
               or has_any_column_privilege('anon', o.oid, 'select, insert, update, references'))
        order by 1),
  '{}'::text[],
  'anon has no privilege on any app table, view or other relation'
);
select is(
  array(select o.name from app_objects o
        where o.relkind in ('m', 'f')
          and (has_table_privilege('authenticated', o.oid, 'select') or has_any_column_privilege('authenticated', o.oid, 'select'))
          and o.name not in (select name from unprotected_read_ok)
        order by 1),
  '{}'::text[],
  'no materialized view or foreign table is readable by authenticated (they bypass RLS)'
);
select is(
  array(select o.name from app_objects o join pg_class c on c.oid = o.oid
        where o.relkind = 'v'
          and not exists (select 1 from unnest(coalesce(c.reloptions, '{}')) r
                          where lower(r) in ('security_invoker=true', 'security_invoker=on', 'security_invoker=1', 'security_invoker=yes'))
        order by 1),
  '{}'::text[],
  'every app view is security_invoker'
);
select is(
  array(select o.name from app_objects o
        where o.relkind = 'S' and (has_sequence_privilege('anon', o.oid, 'usage, select, update')
                                   or has_sequence_privilege('authenticated', o.oid, 'usage, select, update'))
        order by 1),
  '{}'::text[],
  'anon and authenticated have no privilege on app sequences'
);
select is(
  array(select format('%s.%s', n.nspname, c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'extensions' and c.relkind in ('r', 'p', 'v', 'm', 'f') and pg_get_userbyid(c.relowner) <> 'supabase_admin'
        order by 1),
  '{}'::text[],
  'no app relations hide in the extensions schema'
);

-- ---------------------------------------------------------------- functions
select is(
  array(select f.name from app_functions f
        where not exists (select 1 from unnest(coalesce(f.proconfig, '{}')) c where c = 'search_path=""')
        order by 1),
  '{}'::text[],
  'every app function pins an empty search_path'
);
select is(
  array(select f.name from app_functions f where has_function_privilege('anon', f.oid, 'execute') order by 1),
  '{}'::text[],
  'anon cannot execute any app function'
);
select is(
  array(select distinct f.name from app_functions f where f.prosecdef and f.name not in (select name from security_definer_ok) order by 1),
  '{}'::text[],
  'every security-definer function is on the reviewed list'
);
select is(
  array(select distinct f.name from app_functions f
        where has_function_privilege('authenticated', f.oid, 'execute') and f.name not in (select name from authenticated_exec_ok)
        order by 1),
  '{}'::text[],
  'authenticated can execute only reviewed app functions'
);

-- ---------------------------------------------------------------- exception lists stay current
select is(
  array(select e.name from (select name from no_lane_id_ok union select name from custom_policy_ok
                            union select name from user_dml_ok union select name from unprotected_read_ok
                            union select name from private_table_ok) e
        where to_regclass(e.name) is null order by 1),
  '{}'::text[],
  'no stale relation entries in the exception lists'
);
select is(
  array(select e.name from (select name from security_definer_ok union select name from authenticated_exec_ok) e
        where not exists (select 1 from app_functions f where f.name = e.name) order by 1),
  '{}'::text[],
  'no stale function entries in the exception lists'
);

-- The helper agrees on a known lane table.
select pg_temp.has_standard_lane_policy('core.lane_policies', 'lane_policies');

select * from finish();
rollback;
