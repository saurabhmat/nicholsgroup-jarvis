-- Lanes and lane policies (T-010). Registry contents, restrictive defaults, constraints, grants and RLS against the
-- seeded memberships (T-012): owner in every lane, the other personas in PKG only, the outsider in none.
begin;
select plan(36);
\ir helpers/lane_rls.psql

-- ---------------------------------------------------------------- schema
select has_table('core', 'lanes', 'core.lanes exists');
select has_table('core', 'lane_policies', 'core.lane_policies exists');
select is((select relrowsecurity from pg_class where oid = 'core.lanes'::regclass), true, 'RLS is enabled on core.lanes');
select is((select relrowsecurity from pg_class where oid = 'core.lane_policies'::regclass), true, 'RLS is enabled on core.lane_policies');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'core' and p.proname in ('allowed_lanes', 'set_updated_at')
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')),
  0,
  'core functions pin search_path'
);

-- ---------------------------------------------------------------- seeded registry
select set_eq($$select code from core.lanes$$, array['PKG', 'APK', 'PKI', 'NC', 'NL', 'P'], 'the six lanes are registered');
select set_eq($$select code from core.lanes where enabled$$, array['PKG'], 'only PKG is enabled');
select is((select data_plane from core.lanes where code = 'NL'), 'nl', 'NL is on the nl data plane');
select is(
  (select count(*)::int from core.lanes l where not exists (select 1 from core.lane_policies p where p.lane_id = l.code)),
  0,
  'every lane has a policy'
);
select set_eq(
  $$select l.code from core.lane_policies p join core.lanes l on l.code = p.lane_id where p.store_outbound_drafts$$,
  array['PKG'],
  'only PKG stores outbound drafts (D-19)'
);
select col_default_is('core', 'lane_policies', 'store_outbound_drafts', 'false', 'store_outbound_drafts defaults to false');

-- ---------------------------------------------------------------- restrictive defaults and constraints
-- Old timestamps so the updated_at check below can see a change (now() is fixed for the whole transaction).
insert into core.lanes (code, name, data_plane, created_at, updated_at)
  values ('TST', 'Synthetic Test Lane', 'core', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00');
insert into core.lane_policies (lane_id) values ('TST');
select is((select enabled from core.lanes where code = 'TST'), false, 'a new lane is disabled by default');
select row_eq(
  $$select llm_allowed_categories, store_content_bodies, store_outbound_drafts, indexing_enabled, retention_days,
           cross_lane_summary_allowed, write_actions_allowed
      from core.lane_policies p join core.lanes l on l.code = p.lane_id where l.code = 'TST'$$,
  row('{}'::text[], false, false, false, 30, 'none'::text, '{}'::text[]),
  'a new policy has the most restrictive defaults'
);
select throws_ok($$insert into core.lanes (code, name, data_plane) values ('BAD', 'Bad', 'other')$$, '23514', null, 'unknown data plane rejected');
select throws_ok($$insert into core.lanes (code, name, data_plane) values ('bad', 'Bad', 'core')$$, '23514', null, 'lowercase lane code rejected');
select throws_ok($$update core.lanes set data_plane = 'core' where code = 'NL'$$, '23514', null, 'NL cannot move to the core data plane');
select throws_ok(
  $$update core.lane_policies set llm_allowed_categories = array['everything'] where lane_id = 'TST'$$,
  '23514', null, 'unknown LLM category rejected'
);
select throws_ok(
  $$update core.lane_policies set write_actions_allowed = array['qbo_posting'] where lane_id = 'TST'$$,
  '23514', null, 'excluded write action class rejected'
);
select throws_ok(
  $$delete from core.lanes where code = 'TST'$$, '23503', null, 'a lane with a policy cannot be deleted'
);
update core.lanes set name = 'Synthetic Test Lane Renamed' where code = 'TST';
select ok((select updated_at > created_at from core.lanes where code = 'TST'), 'updated_at moves on update');

-- ---------------------------------------------------------------- grants
select is(has_function_privilege('anon', 'core.allowed_lanes(uuid, text)', 'execute'), false, 'anon cannot execute allowed_lanes');
select is(has_table_privilege('authenticated', 'core.lane_policies', 'insert, update, delete'), false, 'authenticated has no DML on lane_policies');
select is(has_table_privilege('authenticated', 'core.lanes', 'insert, update, delete'), false, 'authenticated has no DML on lanes');

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select set_eq($$select code from core.lanes$$, array['PKG'], 'owner at AAL2 reads only enabled lanes (PKG)');
select set_eq($$select lane_id from core.lane_policies$$, array['PKG'], 'owner reads the PKG policy only');
select throws_ok($$insert into core.lanes (code, name, data_plane) values ('ZZ', 'Synthetic Z', 'core')$$, '42501', null, 'authenticated cannot insert lanes');
reset role;

select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select set_eq($$select lane_id from core.lane_policies$$, array['PKG'], 'admin_technical reads the PKG policy (lane_policies view)');
reset role;

select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select set_eq($$select code from core.lanes$$, array['PKG'], 'finance_operator reads the PKG lane');
select is((select count(*)::int from core.lane_policies), 0, 'finance_operator has no lane_policies view');
reset role;

select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.lanes), 0, 'a non-member at AAL2 reads no lane');
select is((select count(*)::int from core.lane_policies), 0, 'a non-member at AAL2 reads no policy');
reset role;

select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.lanes) + (select count(*)::int from core.lane_policies), 0, 'an AAL1 session is denied');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users where email = 'owner@example.test'), 'role', 'authenticated')::text, true);
set local role authenticated;
select is((select count(*)::int from core.lanes) + (select count(*)::int from core.lane_policies), 0, 'a session without an aal claim is denied');
reset role;

set local role anon;
select throws_ok($$select count(*) from core.lane_policies$$, '42501', null, 'anon cannot read lane_policies');
reset role;

-- A member of another lane (APK enabled for this test) cannot read the PKG policy, and PKG members cannot read APK's.
update core.lanes set enabled = true where code = 'APK';
insert into auth.users (instance_id, id, aud, role, email)
  values ('00000000-0000-0000-0000-000000000000', '22222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'apk-admin@example.test');
insert into core.users (id, display_name) values ('22222222-2222-4222-8222-222222222222', 'Synthetic Admin Technical');
insert into core.memberships (user_id, lane_id, role) values ('22222222-2222-4222-8222-222222222222', 'APK', 'admin_technical');
select pg_temp.claims('apk-admin@example.test', 'aal2');
set local role authenticated;
select set_eq($$select lane_id from core.lane_policies$$, array['APK'], 'an APK member reads the APK policy and not PKG''s');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select set_eq($$select lane_id from core.lane_policies$$, array['PKG'], 'a PKG member cannot read the APK policy');
reset role;

select * from finish();
rollback;
