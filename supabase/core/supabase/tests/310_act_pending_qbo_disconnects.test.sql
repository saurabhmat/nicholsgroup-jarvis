-- T-197 review fix: core.act_pending_qbo_disconnects(p_lane). Read-only; RLS decides who sees what: owner and admin_technical of the
-- lane at AAL2 see the lane's unexpired pending qbo.disconnect ids; finance_operator, viewer, AAL1 and anon see none; CROSS-LANE: a
-- PKG member asking for another lane sees nothing; finished, expired and email proposals are not listed; API roles other than authenticated cannot call it.
begin;
select plan(11);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
update core.lane_policies set write_actions_allowed = array['email_send', 'email_draft', 'qbo_disconnect'] where lane_id in ('PKG', 'APK');
insert into core.connections (id, lane_id, provider, external_account_id, status, features) values
  ('00000000-0000-4000-8000-000000003101', 'PKG', 'quickbooks', 'realm-t197-pkg-1', 'active', '{}'),
  ('00000000-0000-4000-8000-000000003102', 'PKG', 'quickbooks', 'realm-t197-pkg-2', 'active', '{}'),
  ('00000000-0000-4000-8000-000000003104', 'APK', 'quickbooks', 'realm-t197-apk-1', 'active', '{}');

create function pg_temp.hash(p_n text) returns text language sql as $$ select encode(sha256(convert_to('hash-' || p_n, 'utf8')), 'hex'); $$;

set local role service_role;
select core.act_propose('PKG', 'qbo.disconnect', '00000000-0000-4000-8000-000000003101', '{"realm_id":"realm-t197-pkg-1"}'::jsonb, '{}'::jsonb, 1, pg_temp.hash('p1'), null, '[]'::jsonb, 'user', pg_temp.uid('owner@example.test'), false);
select core.act_propose('PKG', 'qbo.disconnect', '00000000-0000-4000-8000-000000003102', '{"realm_id":"realm-t197-pkg-2"}'::jsonb, '{}'::jsonb, 1, pg_temp.hash('p2'), null, '[]'::jsonb, 'user', pg_temp.uid('owner@example.test'), false);
select core.act_propose('APK', 'qbo.disconnect', '00000000-0000-4000-8000-000000003104', '{"realm_id":"realm-t197-apk-1"}'::jsonb, '{}'::jsonb, 1, pg_temp.hash('a1'), null, '[]'::jsonb, 'user', pg_temp.uid('owner@example.test'), false);
reset role;
-- one of the two PKG proposals is rejected (finished)
update act.proposed_actions set status = 'rejected' where payload_sha256 = pg_temp.hash('p2');
select pg_temp.claims('admin-technical@example.test', 'aal2');

set local role authenticated;
select is((select count(*)::integer from core.act_pending_qbo_disconnects('PKG')), 1, 'admin_technical sees the one pending disconnect of the lane (the rejected one is not listed)');
select is((select connection_id from core.act_pending_qbo_disconnects('PKG')), '00000000-0000-4000-8000-000000003101'::uuid, 'it is the right connection');
select is((select count(*)::integer from core.act_pending_qbo_disconnects('APK')), 0, 'CROSS-LANE: a PKG member asking for APK sees nothing');
reset role;

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::integer from core.act_pending_qbo_disconnects('PKG')), 1, 'the owner sees it too');
reset role;

select pg_temp.claims('admin-technical@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::integer from core.act_pending_qbo_disconnects('PKG')), 0, 'AAL1 sees nothing');
reset role;

select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::integer from core.act_pending_qbo_disconnects('PKG')), 0, 'a finance_operator sees nothing');
reset role;
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::integer from core.act_pending_qbo_disconnects('PKG')), 0, 'a viewer sees nothing');
reset role;

-- expired: not listed
set local session_replication_role = replica; -- test fixture only: the immutability trigger would refuse a back-dated expiry
update act.proposed_actions set expires_at = now() - interval '1 minute' where payload_sha256 = pg_temp.hash('p1');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::integer from core.act_pending_qbo_disconnects('PKG')), 0, 'an expired proposal is not listed');
reset role;

-- back to pending
update act.proposed_actions set expires_at = now() + interval '1 hour' where payload_sha256 = pg_temp.hash('p1');
set local session_replication_role = origin;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::integer from core.act_pending_qbo_disconnects('PKG')), 1, 'the pending disconnect is listed again once unexpired (the function has no row limit)');
reset role;

select ok(not has_function_privilege('anon', 'core.act_pending_qbo_disconnects(text)', 'execute') and not has_function_privilege('service_role', 'core.act_pending_qbo_disconnects(text)', 'execute')
  and has_function_privilege('authenticated', 'core.act_pending_qbo_disconnects(text)', 'execute'), 'only authenticated may call it');
select ok((select not prosecdef and provolatile = 's' from pg_proc where oid = 'core.act_pending_qbo_disconnects(text)'::regprocedure), 'it is an invoker, stable (read-only) function');

select * from finish();
rollback;
