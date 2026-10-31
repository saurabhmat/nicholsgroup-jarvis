-- Lanes and lane policies (T-010). Registry contents, restrictive defaults, constraints, grants and RLS.
-- Memberships arrive with T-012; until then core.allowed_lanes() returns no lanes. The cross-lane tests below swap in
-- a stand-in that grants PKG only (inside this transaction, rolled back) to prove the policies themselves.
begin;
select plan(34);

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
  (select count(*)::int from core.lanes l where not exists (select 1 from core.lane_policies p where p.lane_id = l.id)),
  0,
  'every lane has a policy'
);
select set_eq(
  $$select l.code from core.lane_policies p join core.lanes l on l.id = p.lane_id where p.store_outbound_drafts$$,
  array['PKG'],
  'only PKG stores outbound drafts (D-19)'
);
select col_default_is('core', 'lane_policies', 'store_outbound_drafts', 'false', 'store_outbound_drafts defaults to false');

-- ---------------------------------------------------------------- restrictive defaults and constraints
-- Old timestamps so the updated_at check below can see a change (now() is fixed for the whole transaction).
insert into core.lanes (code, name, data_plane, created_at, updated_at)
  values ('TST', 'Synthetic Test Lane', 'core', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00');
insert into core.lane_policies (lane_id) select id from core.lanes where code = 'TST';
select is((select enabled from core.lanes where code = 'TST'), false, 'a new lane is disabled by default');
select row_eq(
  $$select llm_allowed_categories, store_content_bodies, store_outbound_drafts, indexing_enabled, retention_days,
           cross_lane_summary_allowed, write_actions_allowed
      from core.lane_policies p join core.lanes l on l.id = p.lane_id where l.code = 'TST'$$,
  row('{}'::text[], false, false, false, 30, 'none'::text, '{}'::text[]),
  'a new policy has the most restrictive defaults'
);
select throws_ok($$insert into core.lanes (code, name, data_plane) values ('BAD', 'Bad', 'other')$$, '23514', null, 'unknown data plane rejected');
select throws_ok($$insert into core.lanes (code, name, data_plane) values ('bad', 'Bad', 'core')$$, '23514', null, 'lowercase lane code rejected');
select throws_ok($$update core.lanes set data_plane = 'core' where code = 'NL'$$, '23514', null, 'NL cannot move to the core data plane');
select throws_ok(
  $$update core.lane_policies set llm_allowed_categories = array['everything'] where lane_id = (select id from core.lanes where code = 'TST')$$,
  '23514', null, 'unknown LLM category rejected'
);
select throws_ok(
  $$update core.lane_policies set write_actions_allowed = array['qbo_posting'] where lane_id = (select id from core.lanes where code = 'TST')$$,
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

-- ---------------------------------------------------------------- RLS with the placeholder (no memberships yet)
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users where email = 'owner@example.test'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
set local role authenticated;
select is((select count(*)::int from core.lanes), 0, 'placeholder allowed_lanes: no lane is readable');
select is((select count(*)::int from core.lane_policies), 0, 'placeholder allowed_lanes: no policy is readable');
select throws_ok($$insert into core.lanes (code, name, data_plane) values ('ZZ', 'Synthetic Z', 'core')$$, '42501', null, 'authenticated cannot insert lanes');
reset role;

set local role anon;
select throws_ok($$select count(*) from core.lane_policies$$, '42501', null, 'anon cannot read lane_policies');
reset role;

-- ---------------------------------------------------------------- RLS with a stand-in membership: owner in PKG only
-- The stand-in answers only for the owner persona and the two view names these policies must pass, so a policy that
-- sent the wrong uid or view would see nothing and fail the member tests below.
do $stub$
begin
  execute format(
    'create or replace function core.allowed_lanes(p_uid uuid, p_view text) returns uuid[] language sql stable set search_path = '''' as $f$ select case when p_uid = %L::uuid and p_view in (%L, %L) then array[%L::uuid] else array[]::uuid[] end $f$',
    (select id from auth.users where email = 'owner@example.test'), 'lanes', 'lane_policies',
    (select id from core.lanes where code = 'PKG'));
end
$stub$;

set local role authenticated;
select set_eq($$select code from core.lanes$$, array['PKG'], 'a PKG member at AAL2 reads only the PKG lane');
select is(
  (select count(*)::int from core.lane_policies where lane_id <> (select id from core.lanes where code = 'PKG')),
  0,
  'a PKG member cannot read other lanes'' policies'
);
select is((select count(*)::int from core.lane_policies), 1, 'a PKG member reads the PKG policy');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users where email = 'outsider@example.test'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
set local role authenticated;
select is((select count(*)::int from core.lanes), 0, 'a non-member at AAL2 reads no lane');
select is((select count(*)::int from core.lane_policies), 0, 'a non-member at AAL2 reads no policy');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users where email = 'owner@example.test'), 'role', 'authenticated', 'aal', 'aal1')::text, true);
set local role authenticated;
select is((select count(*)::int from core.lanes) + (select count(*)::int from core.lane_policies), 0, 'an AAL1 session is denied');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users where email = 'owner@example.test'), 'role', 'authenticated')::text, true);
set local role authenticated;
select is((select count(*)::int from core.lanes) + (select count(*)::int from core.lane_policies), 0, 'a session without an aal claim is denied');
reset role;

select * from finish();
rollback;
