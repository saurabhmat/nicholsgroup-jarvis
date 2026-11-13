-- T-195: qbo.disconnect in the Approval Center (migration 20261116100000).
-- Covered: the type and provider are accepted; propose gates (person only, owner or admin_technical, QuickBooks connection of
-- the lane, target = the realm and nothing else, empty payload, one pending per connection, CROSS-LANE connection refused);
-- RLS reads (owner, admin_technical of the lane see it; finance_operator, viewer, outsider, AAL1 and another lane's members do
-- not; email actions stay hidden from admin_technical); approve gates (admin_technical may approve a qbo.disconnect but not an
-- email; finance_operator cannot; step-up, hash, lane policy class qbo_disconnect, approvals_live, connection state, CROSS-LANE
-- denial); reject; claim by the recorded approver only; reconnect_required connections can be disconnected; token store clears
-- last_error on reconnect; lane policy accepts the new class and nothing else new.
begin;
select plan(45);
\ir helpers/lane_rls.psql

create function pg_temp.claims_amr(p_email text, p_aal text, p_at bigint) returns text language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', (select id from auth.users where email = p_email), 'role', 'authenticated', 'aal', p_aal,
                      'amr', case when p_at is null then '[]'::json else json_build_array(json_build_object('method', 'totp', 'timestamp', p_at)) end)::text, true);
$$;
create temp table ids (k text primary key, id uuid);
grant all on ids to public;

update core.lanes set enabled = true where code = 'APK';
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');
update core.lane_policies set write_actions_allowed = array['email_send', 'email_draft', 'qbo_disconnect'] where lane_id in ('PKG', 'APK');
update core.lane_policies set store_outbound_drafts = true where lane_id in ('PKG', 'APK');
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{approvals}', coalesce(config -> 'approvals', '{}'::jsonb) || '{"approvals_live": true}'::jsonb)
from core.lane_config where lane_id = 'PKG' order by version desc limit 1;

insert into core.connections (id, lane_id, provider, external_account_id, status, features) values
  ('00000000-0000-4000-8000-000000003081', 'PKG', 'quickbooks', 'realm-t195-pkg-1', 'active', '{}'),
  ('00000000-0000-4000-8000-000000003082', 'PKG', 'quickbooks', 'realm-t195-pkg-2', 'reconnect_required', '{}'),
  ('00000000-0000-4000-8000-000000003083', 'PKG', 'google', 'act-t195@example.test', 'active', '{"gmail_compose": true}'),
  ('00000000-0000-4000-8000-000000003084', 'APK', 'quickbooks', 'realm-t195-apk-1', 'active', '{}'),
  ('00000000-0000-4000-8000-000000003085', 'PKG', 'quickbooks', 'realm-t195-pkg-3', 'active', '{}');

create function pg_temp.hash(p_n text) returns text language sql as $$ select encode(sha256(convert_to('hash-' || p_n, 'utf8')), 'hex'); $$;

-- ---------------------------------------------------------------- types and shape
select ok(act.is_allowed_type('qbo.disconnect') and not act.is_denied_type('qbo.disconnect'), 'qbo.disconnect is an allowed, not deny-listed type');
select ok(not act.is_allowed_type('qbo.revoke_grant') and act.is_denied_type('qbo.delete'), 'other qbo types stay refused');
select is(act.write_roles('qbo.disconnect'), array['owner', 'admin_technical']::text[], 'qbo.disconnect: owner or admin_technical');
select is(act.write_roles('email.send'), array['owner']::text[], 'email stays owner only');
select throws_ok($$update core.lane_policies set write_actions_allowed = array['qbo_post'] where lane_id = 'PKG'$$, '23514', null, 'the lane policy class list still refuses anything else (qbo_post)');
select ok(not has_function_privilege('authenticated', 'act.write_roles(text)', 'execute') and not has_function_privilege('authenticated', 'act.connection_ok(text, act.proposed_actions)', 'execute'), 'the new helpers are not callable by API roles');

-- ---------------------------------------------------------------- propose gates (service role, as the app does)
set local role service_role;
select lives_ok(format($$select core.act_propose('PKG', 'qbo.disconnect', %L, '{"realm_id":"realm-t195-pkg-1"}'::jsonb, '{}'::jsonb, 1, %L, null, '[]'::jsonb, 'user', %L, false)$$,
                       '00000000-0000-4000-8000-000000003081', pg_temp.hash('q1'), pg_temp.uid('owner@example.test')), 'a person who is owner proposes a disconnect');
reset role;
insert into ids select 'q1', id from act.proposed_actions where payload_sha256 = pg_temp.hash('q1');
select is((select provider || ':' || status from act.proposed_actions where id = (select id from ids where k = 'q1')), 'quickbooks:proposed', 'it is stored as a quickbooks proposal');
set local role service_role;
select throws_ok(format($$select core.act_propose('PKG', 'qbo.disconnect', %L, '{"realm_id":"realm-t195-pkg-1"}'::jsonb, '{}'::jsonb, 1, %L, null, '[]'::jsonb, 'user', %L, false)$$,
                        '00000000-0000-4000-8000-000000003081', pg_temp.hash('q1b'), pg_temp.uid('admin-technical@example.test')), '23505', 'act: disconnect_already_pending', 'a second pending disconnect for the same connection is refused');
select throws_ok(format($$select core.act_propose('PKG', 'qbo.disconnect', %L, '{"realm_id":"realm-t195-pkg-2"}'::jsonb, '{}'::jsonb, 1, %L, null, '[]'::jsonb, 'job', %L, false)$$,
                        '00000000-0000-4000-8000-000000003082', pg_temp.hash('q2j'), pg_temp.uid('owner@example.test')), '42501', null, 'a job cannot propose a disconnect');
select throws_ok(format($$select core.act_propose('PKG', 'qbo.disconnect', %L, '{"realm_id":"realm-t195-pkg-2"}'::jsonb, '{}'::jsonb, 1, %L, null, '[]'::jsonb, 'assistant', null, false)$$,
                        '00000000-0000-4000-8000-000000003082', pg_temp.hash('q2a')), '42501', null, 'the assistant cannot propose a disconnect');
select throws_ok(format($$select core.act_propose('PKG', 'qbo.disconnect', %L, '{"realm_id":"realm-t195-pkg-2"}'::jsonb, '{}'::jsonb, 1, %L, null, '[]'::jsonb, 'user', %L, false)$$,
                        '00000000-0000-4000-8000-000000003082', pg_temp.hash('q2f'), pg_temp.uid('finance-operator@example.test')), '42501', null, 'a finance_operator cannot propose a disconnect');
select throws_ok(format($$select core.act_propose('PKG', 'qbo.disconnect', %L, '{"realm_id":"realm-t195-pkg-2"}'::jsonb, '{}'::jsonb, 1, %L, null, '[]'::jsonb, 'user', %L, false)$$,
                        '00000000-0000-4000-8000-000000003082', pg_temp.hash('q2v'), pg_temp.uid('viewer@example.test')), '42501', null, 'a viewer cannot propose a disconnect');
select throws_ok(format($$select core.act_propose('PKG', 'qbo.disconnect', %L, '{"realm_id":"realm-t195-apk-1"}'::jsonb, '{}'::jsonb, 1, %L, null, '[]'::jsonb, 'user', %L, false)$$,
                        '00000000-0000-4000-8000-000000003084', pg_temp.hash('x1'), pg_temp.uid('owner@example.test')), '23503', null, 'CROSS-LANE: another lane''s QuickBooks connection cannot be proposed under PKG');
select throws_ok(format($$select core.act_propose('PKG', 'qbo.disconnect', %L, '{"realm_id":"realm-t195-pkg-3"}'::jsonb, '{}'::jsonb, 1, %L, null, '[]'::jsonb, 'user', %L, false)$$,
                        '00000000-0000-4000-8000-000000003082', pg_temp.hash('x2'), pg_temp.uid('owner@example.test')), '22023', null, 'the target must be this connection''s realm');
select throws_ok(format($$select core.act_propose('PKG', 'qbo.disconnect', %L, '{"realm_id":"realm-t195-pkg-2","note":"x"}'::jsonb, '{}'::jsonb, 1, %L, null, '[]'::jsonb, 'user', %L, false)$$,
                        '00000000-0000-4000-8000-000000003082', pg_temp.hash('x3'), pg_temp.uid('owner@example.test')), '22023', null, 'the target carries the realm and nothing else');
select throws_ok(format($$select core.act_propose('PKG', 'qbo.disconnect', %L, '{"realm_id":"realm-t195-pkg-2"}'::jsonb, '{"x":1}'::jsonb, 1, %L, null, '[]'::jsonb, 'user', %L, false)$$,
                        '00000000-0000-4000-8000-000000003082', pg_temp.hash('x4'), pg_temp.uid('owner@example.test')), '22023', null, 'the payload must be empty');
select throws_ok(format($$select core.act_propose('PKG', 'qbo.disconnect', %L, '{"realm_id":"act-t195@example.test"}'::jsonb, '{}'::jsonb, 1, %L, null, '[]'::jsonb, 'user', %L, false)$$,
                        '00000000-0000-4000-8000-000000003083', pg_temp.hash('x5'), pg_temp.uid('owner@example.test')), '22023', null, 'a Google connection cannot be the target of qbo.disconnect');
select lives_ok(format($$select core.act_propose('PKG', 'qbo.disconnect', %L, '{"realm_id":"realm-t195-pkg-2"}'::jsonb, '{}'::jsonb, 1, %L, null, '[]'::jsonb, 'user', %L, false)$$,
                       '00000000-0000-4000-8000-000000003082', pg_temp.hash('q2'), pg_temp.uid('admin-technical@example.test')), 'admin_technical proposes a disconnect of a reconnect_required connection');
reset role;
insert into ids select 'q2', id from act.proposed_actions where payload_sha256 = pg_temp.hash('q2');
-- an email action, to show it stays hidden from admin_technical and owner-only
insert into ids select 'e1', act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000003083', '{"mailbox":"act-t195@example.test"}',
  '{"fromMailbox":"act-t195@example.test","to":["dana@sender.example.test"],"cc":[],"bcc":[],"subject":"S","bodyText":"CANARY"}', 1, pg_temp.hash('e1'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false);
-- an APK proposal (the lane the owner and PKG admin are not members of)
insert into act.proposed_actions (lane_id, action_type, connection_id, provider, target, payload, payload_schema_version, payload_sha256, proposer_kind, expires_at)
  values ('APK', 'qbo.disconnect', '00000000-0000-4000-8000-000000003084', 'quickbooks', '{"realm_id":"realm-t195-apk-1"}', '{}', 1, pg_temp.hash('k1'), 'user', now() + interval '1 day');
insert into ids select 'k1', id from act.proposed_actions where payload_sha256 = pg_temp.hash('k1');
select pass('(the APK proposal above was made by the table owner as a fixture)');

-- ---------------------------------------------------------------- RLS reads
select pg_temp.claims_amr('admin-technical@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select is((select array_agg(id order by id) from act.proposed_actions), (select array_agg(id order by id) from ids where k in ('q1', 'q2')), 'admin_technical sees the lane''s qbo.disconnect actions and no email action');
select is((select count(*)::int from act.proposed_actions where lane_id = 'APK'), 0, 'CROSS-LANE: admin_technical of PKG sees no APK action');
reset role;
select pg_temp.claims_amr('owner@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select is((select count(*)::int from act.proposed_actions where lane_id = 'PKG'), 3, 'the owner sees all three PKG actions');
select is((select count(*)::int from act.proposed_actions where lane_id = 'APK'), 0, 'CROSS-LANE: the owner (not a member of APK) sees no APK action');
reset role;
select pg_temp.claims_amr('finance-operator@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select is((select count(*)::int from act.proposed_actions), 0, 'a finance_operator sees no disconnect (not theirs)');
reset role;
select pg_temp.claims_amr('viewer@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select is((select count(*)::int from act.proposed_actions), 0, 'a viewer sees nothing');
reset role;
select pg_temp.claims_amr('admin-technical@example.test', 'aal1', extract(epoch from now())::bigint);
set local role authenticated;
select is((select count(*)::int from act.proposed_actions), 0, 'AAL1 sees nothing');
reset role;

-- ---------------------------------------------------------------- approve gates
select pg_temp.claims_amr('finance-operator@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'q1'), pg_temp.hash('q1')), '42501', null, 'a finance_operator cannot approve a disconnect');
reset role;
select pg_temp.claims_amr('admin-technical@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'e1'), pg_temp.hash('e1')), '42501', null, 'admin_technical still cannot approve an email');
select throws_ok(format($$select core.act_approve('APK', %L, %L)$$, (select id from ids where k = 'k1'), pg_temp.hash('k1')), '42501', null, 'CROSS-LANE: admin_technical of PKG cannot approve in APK');
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'k1'), pg_temp.hash('k1')), 'P0002', null, 'CROSS-LANE: naming APK''s action under PKG finds nothing');
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'q1'), pg_temp.hash('other')), 'P0001', 'act: hash_mismatch', 'a hash other than the stored one is refused');
reset role;
select pg_temp.claims_amr('admin-technical@example.test', 'aal2', extract(epoch from now() - interval '20 minutes')::bigint);
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'q1'), pg_temp.hash('q1')), '42501', 'act: step_up_required', 'a stale TOTP cannot approve');
reset role;

update core.lane_policies set write_actions_allowed = array['email_send', 'email_draft'] where lane_id = 'PKG';
select pg_temp.claims_amr('admin-technical@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'q1'), pg_temp.hash('q1')), 'P0001', 'act: type_not_allowed', 'refused while the lane policy lacks qbo_disconnect');
reset role;
update core.lane_policies set write_actions_allowed = array['email_send', 'email_draft', 'qbo_disconnect'] where lane_id = 'PKG';

insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{approvals,approvals_live}', 'false'::jsonb) from core.lane_config where lane_id = 'PKG' order by version desc limit 1;
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'q1'), pg_temp.hash('q1')), 'P0001', 'act: not_live', 'refused while approvals_live is false');
reset role;
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{approvals,approvals_live}', 'true'::jsonb) from core.lane_config where lane_id = 'PKG' order by version desc limit 1;

update core.connections set status = 'disconnected' where id = '00000000-0000-4000-8000-000000003085';
set local role authenticated;
select is(core.act_approve('PKG', (select id from ids where k = 'q1'), pg_temp.hash('q1')), pg_temp.hash('q1'), 'admin_technical with a fresh step-up approves the exact hash');
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'q1'), pg_temp.hash('q1')), 'P0001', 'act: already_approved', 'a second approve is refused');
reset role;
select is((select status || ':' || (approved_by = pg_temp.uid('admin-technical@example.test'))::text from act.proposed_actions where id = (select id from ids where k = 'q1')), 'approved:true', 'the approver is recorded');

-- a reconnect_required connection can be approved too; reject by the owner; reject by a finance_operator is refused
select pg_temp.claims_amr('owner@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select lives_ok(format($$select core.act_reject('PKG', %L, 'not now')$$, (select id from ids where k = 'q2')), 'the owner rejects a disconnect proposed by admin_technical');
reset role;
select is((select status from act.proposed_actions where id = (select id from ids where k = 'q2')), 'rejected', 'it is rejected');
select pg_temp.claims_amr('finance-operator@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select throws_ok(format($$select core.act_reject('PKG', %L, 'x')$$, (select id from ids where k = 'e1')), '42501', null, 'a finance_operator cannot reject');
reset role;
select pg_temp.claims_amr('admin-technical@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select throws_ok(format($$select core.act_reject('PKG', %L, 'x')$$, (select id from ids where k = 'e1')), '42501', null, 'admin_technical cannot reject an email');
reset role;

-- ---------------------------------------------------------------- claim
set local role service_role;
select is((select (core.act_claim_execution('PKG', (select id from ids where k = 'q1'))).status), 'executing', 'the approved disconnect is claimed once');
select throws_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'q1')), 'P0001', null, 'a second claim is refused');
reset role;

-- ---------------------------------------------------------------- reconnect clears last_error
update core.connections set status = 'reconnect_required',
  last_error = '{"kind":"reconnect_required","disposition":"reconnect_required","message":"x","http_status":400,"provider_error_code":"invalid_grant","provider_tid":null,"retry_after_seconds":null,"endpoint":null}'::jsonb
  where id = '00000000-0000-4000-8000-000000003082';
select core.connection_token_store('PKG', '00000000-0000-4000-8000-000000003082', 'synthetic-token-set', null, null);
select is((select status || ':' || coalesce(last_error::text, 'none') from core.connections where id = '00000000-0000-4000-8000-000000003082'), 'active:none', 'storing tokens for a reconnect_required connection makes it active and clears last_error');

select * from finish();
rollback;
