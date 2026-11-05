-- Audit log (T-014): write path, append-only for every role, constraints and RLS.
begin;
select plan(34);
\ir helpers/lane_rls.psql

select has_table('audit', 'events', 'audit.events exists');
select pg_temp.has_standard_lane_policy('audit.events', 'audit');

-- ---------------------------------------------------------------- write path
set local role service_role;
select ok(
  audit.log('PKG', 'user', pg_temp.uid('owner@example.test'), 'lane_config.version_created', 'lane_config:PKG:2', '{"version": 2}') > 0,
  'service_role writes through audit.log()'
);
select ok(audit.log('PKG', 'service', null, 'sync.run_finished') > 0, 'service actor without an actor id');
select ok(audit.log('APK', 'system', null, 'lane.disabled_event') > 0, 'an event in another lane');
select throws_ok($$insert into audit.events (lane_id, actor_kind, action) values ('PKG', 'system', 'x.y')$$, '42501', null, 'service_role cannot insert directly');
reset role;

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select audit.log('PKG', 'system', null, 'forged.event')$$, '42501', null, 'authenticated cannot call audit.log()');
select throws_ok($$insert into audit.events (lane_id, actor_kind, action) values ('PKG', 'system', 'forged.event')$$, '42501', null, 'authenticated cannot insert');
reset role;

-- ---------------------------------------------------------------- append-only for every role
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$update audit.events set action = 'x.y'$$, '42501', null, 'authenticated cannot update');
select throws_ok($$delete from audit.events$$, '42501', null, 'authenticated cannot delete');
reset role;

set local role service_role;
select throws_ok($$update audit.events set action = 'x.y'$$, '42501', null, 'service_role cannot update');
select throws_ok($$delete from audit.events$$, '42501', null, 'service_role cannot delete');
select throws_ok($$truncate audit.events$$, '42501', null, 'service_role cannot truncate');
reset role;

select throws_ok($$update audit.events set action = 'x.y'$$, '42501', 'audit.events is append-only', 'the table owner cannot update (trigger)');
select throws_ok($$delete from audit.events$$, '42501', 'audit.events is append-only', 'the table owner cannot delete (trigger)');
select throws_ok($$truncate audit.events$$, '42501', 'audit.events is append-only', 'the table owner cannot truncate (trigger)');

-- ---------------------------------------------------------------- constraints
select throws_ok($$select audit.log('PKG', 'system', null, 'NotDotted')$$, '23514', null, 'action must be a dotted lowercase name');
select throws_ok($$select audit.log('PKG', 'user', null, 'x.y')$$, '23514', null, 'a user actor needs an actor id');
select throws_ok($$select audit.log('PKG', 'service', pg_temp.uid('owner@example.test'), 'x.y')$$, '23514', null, 'a non-user actor has no actor id');
select throws_ok($$select audit.log('PKG', 'system', null, 'x.y', null, '{"access_token": "abc"}')$$, '23514', null, 'credential-named metadata rejected');
select throws_ok($$select audit.log('PKG', 'system', null, 'x.y', null, '{"note": "sk_live_abc"}')$$, '23514', null, 'secret-looking metadata rejected');
select throws_ok($$select audit.log('XX', 'system', null, 'x.y')$$, '23503', null, 'unknown lane rejected');
select throws_ok($$select audit.log('PKG', 'system', null, 'x.y', 'sk_live_target_secret')$$, '23514', null, 'secret-looking target rejected');
select throws_ok($$select audit.log('PKG', 'system', null, 'x.y', 'free text with spaces')$$, '23514', null, 'free-text target rejected');
select throws_ok($$select audit.log('PKG', 'system', null, 'x.y', null, '{"accessToken": "abc"}')$$, '23514', null, 'camelCase credential metadata rejected');

-- The append-only guarantees stay in place (T-014 review L1).
select set_eq(
  $$select tgname::text from pg_trigger where tgrelid = 'audit.events'::regclass and tgenabled = 'O' and not tgisinternal$$,
  array['events_no_update_delete', 'events_no_truncate'],
  'both immutability triggers exist and are enabled'
);
select is(pg_get_userbyid((select relowner from pg_class where oid = 'audit.events'::regclass)), 'postgres', 'audit.events is owned by postgres');
select is(
  (select count(*)::int from pg_roles r
    where r.rolname <> 'postgres' and not r.rolsuper and r.rolname !~ '^pg_'
      and has_table_privilege(r.oid, 'audit.events', 'insert, update, delete, truncate, trigger, references')),
  0,
  'no role other than the owner holds a write, trigger or references privilege'
);
select is(
  (select count(*)::int from pg_roles r
    where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
      and pg_has_role(r.oid, 'pg_write_all_data', 'member')),
  0,
  'no API role is a member of pg_write_all_data'
);

-- ---------------------------------------------------------------- RLS ('audit' view: owner)
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select set_eq($$select action from audit.events$$, array['lane_config.version_created', 'sync.run_finished'], 'owner reads PKG events only (APK is disabled)');
reset role;

select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from audit.events), 0, 'admin_technical has no audit view');
reset role;

select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from audit.events), 0, 'finance_operator has no audit view');
reset role;

select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from audit.events), 0, 'AAL1 reads no events');
reset role;

set local role anon;
select throws_ok($$select count(*) from audit.events$$, '42501', null, 'anon cannot read events');
reset role;

select * from finish();
rollback;
