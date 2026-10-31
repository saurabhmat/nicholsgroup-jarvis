-- Users, memberships, roles and core.allowed_lanes() (T-012). Seeded personas: owner in every lane, admin_technical,
-- finance_operator and viewer (named view 'finance') in PKG, outsider in none. Only PKG is enabled.
begin;
select plan(52);

-- Sets the JWT claims for a persona (run as postgres, before switching role).
create function pg_temp.claims(p_email text, p_aal text) returns text language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', (select id from auth.users where email = p_email), 'role', 'authenticated', 'aal', p_aal)::text, true);
$$;
-- The persona's user id. Security definer (test-only, owned by postgres) so it also works after `set role
-- authenticated`, which cannot read auth.users.
create function pg_temp.uid(p_email text) returns uuid language sql security definer as $$
  select id from auth.users where email = p_email;
$$;
-- allowed_lanes(uid, view) for a persona asking about itself at the given AAL, called as authenticated.
create function pg_temp.lanes_for(p_email text, p_view text, p_aal text default 'aal2') returns text[] language plpgsql as $$
declare
  v_uid uuid := pg_temp.uid(p_email);
  v_result text[];
begin
  perform pg_temp.claims(p_email, p_aal);
  set local role authenticated;
  v_result := core.allowed_lanes(v_uid, p_view);
  reset role;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------- schema and function properties
select has_table('core', 'users', 'core.users exists');
select has_table('core', 'memberships', 'core.memberships exists');
select is((select relrowsecurity from pg_class where oid = 'core.users'::regclass), true, 'RLS is enabled on core.users');
select is((select relrowsecurity from pg_class where oid = 'core.memberships'::regclass), true, 'RLS is enabled on core.memberships');
select is((select prosecdef from pg_proc where oid = 'core.allowed_lanes(uuid, text)'::regprocedure), true, 'allowed_lanes is security definer');
select is((select provolatile from pg_proc where oid = 'core.allowed_lanes(uuid, text)'::regprocedure), 's', 'allowed_lanes is stable');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'core'
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c = 'search_path=""')),
  0,
  'every core function pins an empty search_path'
);
select is(has_function_privilege('anon', 'core.allowed_lanes(uuid, text)', 'execute'), false, 'anon cannot execute allowed_lanes');
select is(has_table_privilege('authenticated', 'core.memberships', 'insert, update, delete'), false, 'authenticated has no DML on memberships');
select is(has_table_privilege('authenticated', 'core.users', 'insert, update, delete'), false, 'authenticated has no DML on users');

-- ---------------------------------------------------------------- constraints
select throws_ok(
  $$insert into core.memberships (user_id, lane_id, role) values (pg_temp.uid('outsider@example.test'), 'PKG', 'superuser')$$,
  '23514', null, 'unknown role rejected'
);
select throws_ok(
  $$insert into core.memberships (user_id, lane_id, role, views) values (pg_temp.uid('outsider@example.test'), 'PKG', 'finance_operator', array['assistant'])$$,
  '23514', null, 'named views only on viewer memberships'
);
select throws_ok(
  $$insert into core.memberships (user_id, lane_id, role, views) values (pg_temp.uid('outsider@example.test'), 'PKG', 'viewer', array['everything'])$$,
  '23514', null, 'unknown view name rejected'
);
select throws_ok(
  $$insert into core.memberships (user_id, lane_id, role, views) values (pg_temp.uid('outsider@example.test'), 'PKG', 'viewer', array['memberships', 'config'])$$,
  '23514', null, 'a viewer cannot be given administration views'
);
select throws_ok(
  $$insert into core.memberships (user_id, lane_id, role, views) values (pg_temp.uid('outsider@example.test'), 'PKG', 'viewer', array['approvals'])$$,
  '23514', null, 'a viewer cannot be given the approvals view'
);
select throws_ok(
  $$insert into core.memberships (user_id, lane_id, role) values (pg_temp.uid('outsider@example.test'), 'XX', 'viewer')$$,
  '23503', null, 'membership in an unknown lane rejected'
);

-- ---------------------------------------------------------------- seeded memberships
select is((select count(*)::int from core.memberships where user_id = pg_temp.uid('owner@example.test')), 6, 'owner belongs to all six lanes');
select is((select count(*)::int from core.memberships where user_id = pg_temp.uid('outsider@example.test')), 0, 'outsider has no membership');

-- ---------------------------------------------------------------- allowed_lanes: role x view (AAL2, own uid)
select is(pg_temp.lanes_for('owner@example.test', 'finance'), array['PKG'], 'owner: finance in enabled lanes only');
select is(pg_temp.lanes_for('owner@example.test', 'assistant'), array['PKG'], 'owner: assistant');
select is(pg_temp.lanes_for('finance-operator@example.test', 'finance'), array['PKG'], 'finance_operator: finance (generates and signs off reports)');
select is(pg_temp.lanes_for('finance-operator@example.test', 'approvals'), '{}'::text[], 'finance_operator: no lane-wide approvals view (own proposals come from the act.* policy)');
select is(pg_temp.lanes_for('viewer@example.test', 'action_index'), array['PKG'], 'every member: action_index (status counts)');
select is(pg_temp.lanes_for('finance-operator@example.test', 'assistant'), array['PKG'], 'finance_operator: assistant (decided Oct 31, 2026)');
select is(pg_temp.lanes_for('admin-technical@example.test', 'connections'), array['PKG'], 'admin_technical: connections');
select is(pg_temp.lanes_for('admin-technical@example.test', 'finance'), '{}'::text[], 'admin_technical: no finance content');
select is(pg_temp.lanes_for('admin-technical@example.test', 'comms'), '{}'::text[], 'admin_technical: no comms content');
select is(pg_temp.lanes_for('admin-technical@example.test', 'assistant'), '{}'::text[], 'admin_technical: no assistant');
select is(pg_temp.lanes_for('viewer@example.test', 'finance'), array['PKG'], 'viewer: its named view (finance)');
select is(pg_temp.lanes_for('viewer@example.test', 'approvals'), '{}'::text[], 'viewer: no view it was not given');
select is(pg_temp.lanes_for('viewer@example.test', 'memberships'), '{}'::text[], 'viewer: no memberships view');
select is(pg_temp.lanes_for('outsider@example.test', 'lanes'), '{}'::text[], 'outsider: nothing');
select is(pg_temp.lanes_for('owner@example.test', 'finance', 'aal1'), '{}'::text[], 'AAL1: nothing, even for the owner');
select is(pg_temp.lanes_for('owner@example.test', null), '{}'::text[], 'null view: nothing');

-- Another user's lanes cannot be listed (T-010 review M2).
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is(core.allowed_lanes(pg_temp.uid('owner@example.test'), 'finance'), '{}'::text[], 'a user cannot list another user''s lanes');
reset role;

-- A forged role claim does not make an authenticated session service_role (T-012 review M1).
select set_config('request.jwt.claims',
  json_build_object('sub', pg_temp.uid('outsider@example.test'), 'role', 'service_role', 'aal', 'aal2')::text, true);
set local role authenticated;
select is(core.allowed_lanes(pg_temp.uid('owner@example.test'), 'finance'), '{}'::text[], 'a service_role claim on an authenticated session is not trusted');
reset role;

-- service_role may ask about any user (jobs).
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
set local role service_role;
select is(core.allowed_lanes(pg_temp.uid('finance-operator@example.test'), 'finance'), array['PKG'], 'service_role can resolve any user''s lanes');
reset role;

-- Disabled lanes are excluded until enabled (T-010 review L2).
update core.lanes set enabled = true where code = 'APK';
select is(pg_temp.lanes_for('owner@example.test', 'finance'), array['APK', 'PKG'], 'enabling APK adds it for its members');
select is(pg_temp.lanes_for('finance-operator@example.test', 'finance'), array['PKG'], 'a PKG-only member does not gain APK');
update core.lanes set enabled = false where code = 'APK';

-- ---------------------------------------------------------------- has_lane_role (actions a view does not imply)
create function pg_temp.role_check(p_email text, p_roles text[], p_aal text default 'aal2') returns boolean language plpgsql as $$
declare
  v_uid uuid := pg_temp.uid(p_email);
  v_result boolean;
begin
  perform pg_temp.claims(p_email, p_aal);
  set local role authenticated;
  v_result := core.has_lane_role(v_uid, 'PKG', p_roles);
  reset role;
  return v_result;
end;
$$;
select is(pg_temp.role_check('finance-operator@example.test', array['owner', 'finance_operator']), true, 'finance_operator may sign off finance reports');
select is(pg_temp.role_check('owner@example.test', array['owner', 'finance_operator']), true, 'owner may sign off finance reports');
select is(pg_temp.role_check('viewer@example.test', array['owner', 'finance_operator']), false, 'a viewer with the finance view may not sign off');
select is(pg_temp.role_check('admin-technical@example.test', array['owner', 'finance_operator']), false, 'admin_technical may not sign off');
select is(pg_temp.role_check('finance-operator@example.test', array['owner', 'finance_operator'], 'aal1'), false, 'has_lane_role requires aal2');
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is(core.has_lane_role(pg_temp.uid('finance-operator@example.test'), 'PKG', array['finance_operator']), false, 'has_lane_role answers only for the caller');
reset role;

-- ---------------------------------------------------------------- RLS on memberships and users
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.memberships), 1, 'finance_operator reads only its own membership');
select is((select count(*)::int from core.users), 1, 'finance_operator reads only its own profile');
reset role;

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select set_eq(
  $$select m.lane_id || ':' || m.role from core.memberships m$$,
  array['PKG:owner', 'PKG:admin_technical', 'PKG:finance_operator', 'PKG:viewer',
        'APK:owner', 'PKI:owner', 'NC:owner', 'NL:owner', 'P:owner'],
  'owner reads the PKG memberships and only its own rows elsewhere'
);
select is((select count(*)::int from core.users), 4, 'owner reads the four PKG members'' profiles, not the outsider''s');
reset role;

select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.memberships), 4, 'admin_technical reads the PKG memberships (memberships view)');
reset role;

select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.memberships) + (select count(*)::int from core.users), 0, 'AAL1 reads no memberships or users');
reset role;

set local role anon;
select throws_ok($$select count(*) from core.memberships$$, '42501', null, 'anon cannot read memberships');
reset role;

select * from finish();
rollback;
