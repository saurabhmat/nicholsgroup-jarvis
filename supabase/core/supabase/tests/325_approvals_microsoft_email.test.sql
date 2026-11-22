-- T-263: approvals for email on a MICROSOFT connection. act.connection_ok is provider-aware: a Microsoft connection needs features.graph_mail_write (not gmail_compose),
-- a Google one still needs gmail_compose, the action's provider must be the connection's, and the owner-only rules of T-247 hold for a Microsoft mailbox.
-- Covered: approve with and without the grant (both providers, crossed grants refused), claim re-check, the owner cannot see / approve another member's Microsoft action,
-- CROSS-LANE denial (approve, read), the service-role job path, and the body purge on a terminal state of a Microsoft action.
begin;
select plan(20);
\ir helpers/lane_rls.psql

create function pg_temp.claims_amr(p_email text, p_aal text, p_at bigint) returns text language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', (select id from auth.users where email = p_email), 'role', 'authenticated', 'aal', p_aal,
                      'amr', case when p_at is null then '[]'::json else json_build_array(json_build_object('method', 'totp', 'timestamp', p_at)) end)::text, true);
$$;
create temp table ids (k text primary key, id uuid);
grant all on ids to public;

update core.lanes set enabled = true where code = 'APK';
update core.lane_policies set store_outbound_drafts = true, write_actions_allowed = array['email_send', 'email_draft'] where lane_id in ('PKG', 'APK');
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{approvals}', coalesce(config -> 'approvals', '{}'::jsonb) || '{"approvals_live": true}'::jsonb)
from core.lane_config where lane_id = 'PKG' order by version desc limit 1;

insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id) values
  ('00000000-0000-4000-8000-000000032501', 'PKG', 'microsoft', 'ms-owner@example.test', 'active', '{"graph_mail_write": true}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032502', 'PKG', 'microsoft', 'ms-ro@example.test', 'active', '{"graph_mail_write": false}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032503', 'PKG', 'microsoft', 'ms-gmailfeature@example.test', 'active', '{"gmail_compose": true}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032504', 'PKG', 'google', 'g-owner@example.test', 'active', '{"gmail_compose": true}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032505', 'PKG', 'google', 'g-graphfeature@example.test', 'active', '{"graph_mail_write": true}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032506', 'PKG', 'microsoft', 'ms-admin@example.test', 'active', '{"graph_mail_write": true}', pg_temp.uid('admin-technical@example.test')),
  ('00000000-0000-4000-8000-000000032507', 'APK', 'microsoft', 'ms-apk@example.test', 'active', '{"graph_mail_write": true}', pg_temp.uid('owner@example.test'));

create function pg_temp.payload(p_from text) returns jsonb language sql as $$
  select jsonb_build_object('fromMailbox', p_from, 'to', jsonb_build_array('dana@sender.example.test'), 'cc', '[]'::jsonb, 'bcc', '[]'::jsonb, 'subject', 'Subject line', 'bodyText', 'CANARY body text');
$$;
create function pg_temp.hash(p_n text) returns text language sql as $$ select encode(sha256(convert_to('hash-' || p_n, 'utf8')), 'hex'); $$;

set local role service_role;
insert into ids select 'm1', act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000032501', '{"mailbox":"ms-owner@example.test"}', pg_temp.payload('ms-owner@example.test'), 1, pg_temp.hash('m1'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false);
insert into ids select 'm1d', act.propose('PKG', 'email.save_draft', '00000000-0000-4000-8000-000000032501', '{"mailbox":"ms-owner@example.test"}', pg_temp.payload('ms-owner@example.test'), 1, pg_temp.hash('m1d'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false);
insert into ids select 'm2', act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000032502', '{"mailbox":"ms-ro@example.test"}', pg_temp.payload('ms-ro@example.test'), 1, pg_temp.hash('m2'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false);
insert into ids select 'm3', act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000032503', '{"mailbox":"ms-gmailfeature@example.test"}', pg_temp.payload('ms-gmailfeature@example.test'), 1, pg_temp.hash('m3'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false);
insert into ids select 'g1', act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000032504', '{"mailbox":"g-owner@example.test"}', pg_temp.payload('g-owner@example.test'), 1, pg_temp.hash('g1'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false);
insert into ids select 'g2', act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000032505', '{"mailbox":"g-graphfeature@example.test"}', pg_temp.payload('g-graphfeature@example.test'), 1, pg_temp.hash('g2'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false);
insert into ids select 'ma', act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000032506', '{"mailbox":"ms-admin@example.test"}', pg_temp.payload('ms-admin@example.test'), 1, pg_temp.hash('ma'), null, '[]', 'user', pg_temp.uid('admin-technical@example.test'), false);
insert into ids select 'x1', act.propose('APK', 'email.send', '00000000-0000-4000-8000-000000032507', '{"mailbox":"ms-apk@example.test"}', pg_temp.payload('ms-apk@example.test'), 1, pg_temp.hash('x1'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false);
reset role;
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test'); -- APK is a lane the owner may NOT see

select is((select provider from act.proposed_actions where id = (select id from ids where k = 'm1')), 'microsoft', 'a proposal on a Microsoft connection is stored with provider microsoft');

-- ---------------------------------------------------------------- approve: the provider's own grant
select pg_temp.claims_amr('owner@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select is(core.act_approve('PKG', (select id from ids where k = 'm1'), pg_temp.hash('m1')), pg_temp.hash('m1'), 'the owner approves email.send on their Microsoft mailbox that holds graph_mail_write');
select is(core.act_approve('PKG', (select id from ids where k = 'm1d'), pg_temp.hash('m1d')), pg_temp.hash('m1d'), '...and email.save_draft');
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'm2'), pg_temp.hash('m2')), 'P0001', 'act: connection_not_enabled', 'a Microsoft connection with graph_mail_write false cannot be approved');
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'm3'), pg_temp.hash('m3')), 'P0001', 'act: connection_not_enabled', 'a Microsoft connection holding only gmail_compose cannot be approved (the grants are not interchangeable)');
select is(core.act_approve('PKG', (select id from ids where k = 'g1'), pg_temp.hash('g1')), pg_temp.hash('g1'), 'a Google connection with gmail_compose is approved exactly as before');
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'g2'), pg_temp.hash('g2')), 'P0001', 'act: connection_not_enabled', 'a Google connection holding only graph_mail_write cannot be approved');
reset role;

-- ---------------------------------------------------------------- T-247 owner-only rules for a Microsoft mailbox
select pg_temp.claims_amr('owner@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select is((select count(*)::int from act.proposed_actions where connection_id = '00000000-0000-4000-8000-000000032506'), 0, 'T-247: the lane owner cannot see another member''s Microsoft email action');
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'ma'), pg_temp.hash('ma')), 'P0002', null, 'T-247: ...nor approve it (the same not_found as an unknown id)');
reset role;
select pg_temp.claims_amr('admin-technical@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select is((select count(*)::int from act.proposed_actions), 1, 'T-247: admin_technical sees exactly their own Microsoft action');
select is(core.act_approve('PKG', (select id from ids where k = 'ma'), pg_temp.hash('ma')), pg_temp.hash('ma'), 'T-247: and approves it as the mailbox owner');
reset role;

-- ---------------------------------------------------------------- CROSS-LANE denial
select pg_temp.claims_amr('owner@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select is((select count(*)::int from act.proposed_actions where lane_id = 'APK'), 0, 'CROSS-LANE: the owner sees no APK action');
select throws_ok(format($$select core.act_approve('APK', %L, %L)$$, (select id from ids where k = 'x1'), pg_temp.hash('x1')), '42501', null, 'CROSS-LANE: the owner cannot approve another lane''s Microsoft action');
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'x1'), pg_temp.hash('x1')), 'P0002', null, 'CROSS-LANE: naming it under PKG finds nothing');
reset role;

-- ---------------------------------------------------------------- claim re-check and the body purge
set local role service_role;
select is((select (core.act_claim_execution('PKG', (select id from ids where k = 'm1'))).status), 'executing', 'the service claims the approved Microsoft action');
select throws_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'm1')), 'P0001', 'act: not_approved', 'a second claim is refused');
reset role;
update core.connections set features = '{}' where id = '00000000-0000-4000-8000-000000032501';
set local role service_role;
select throws_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'm1d')), 'P0001', 'act: connection_not_enabled', 'the grant is re-checked at claim: a Microsoft connection that lost graph_mail_write cannot be claimed');
select lives_ok(format($$select core.act_mark_failed('PKG', %L, 'execution_refused', 'error')$$, (select id from ids where k = 'm1')), 'the claimed Microsoft action ends failed');
reset role;
select is((select payload ? 'bodyText' from act.proposed_actions where id = (select id from ids where k = 'm1')), false, 'D-19: the body of the Microsoft action is purged at the terminal state');
select is((select count(*)::int from act.proposed_actions where payload ? 'bodyText' and status in ('failed', 'verified', 'rejected', 'expired', 'invalidated')), 0, 'no terminal action keeps its body');

select * from finish();
rollback;
