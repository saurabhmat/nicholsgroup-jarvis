-- T-232: the Approval Center for email (schema act, wrappers core.act_*).
-- Covered: shape and grants (no DML for API roles, service-only writers), RLS (owner sees the lane, a proposer sees their own,
-- viewer / admin_technical / outsider / AAL1 nothing, CROSS-LANE denial for reads and approve), propose gates (D-19
-- store_outbound_drafts, deny-listed types, other lane's connection), approve gates (AAL1, stale TOTP, non-owner roles,
-- cross-lane owner, hash mismatch, approvals_live, lane policy type, connection without compose, already approved),
-- the state machine and immutability, the single claim, the D-19 body purge in every terminal state, edit = supersede,
-- history insert-only, pending count.
begin;
select plan(106);
\ir helpers/lane_rls.psql

-- A token whose amr carries a TOTP verification at p_at (epoch seconds), or none when p_at is null.
create function pg_temp.claims_amr(p_email text, p_aal text, p_at bigint) returns text language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', (select id from auth.users where email = p_email), 'role', 'authenticated', 'aal', p_aal,
                      'amr', case when p_at is null then '[]'::json else json_build_array(json_build_object('method', 'totp', 'timestamp', p_at)) end)::text, true);
$$;
create temp table ids (k text primary key, id uuid);
grant all on ids to public;

update core.lanes set enabled = true where code = 'APK';
-- The owner is a member of APK in the seed; drop that so APK is a lane the owner may NOT see (cross-lane denial).
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');
update core.lane_policies set store_outbound_drafts = true, write_actions_allowed = array['email_send', 'email_draft'] where lane_id in ('PKG', 'APK');
-- approvals_live true for PKG (a new insert-only config version).
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{approvals}', coalesce(config -> 'approvals', '{}'::jsonb) || '{"approvals_live": true}'::jsonb)
from core.lane_config where lane_id = 'PKG' order by version desc limit 1;

insert into core.connections (id, lane_id, provider, external_account_id, status, features) values
  ('00000000-0000-4000-8000-000000002901', 'PKG', 'google', 'act-pkg@example.test', 'active', '{"gmail_compose": true}'),
  ('00000000-0000-4000-8000-000000002902', 'PKG', 'google', 'act-pkg-ro@example.test', 'active', '{}'),
  ('00000000-0000-4000-8000-000000002903', 'APK', 'google', 'act-apk@example.test', 'active', '{"gmail_compose": true}');

create function pg_temp.payload(p_from text) returns jsonb language sql as $$
  select jsonb_build_object('fromMailbox', p_from, 'to', jsonb_build_array('dana@sender.example.test'), 'cc', '[]'::jsonb, 'bcc', '[]'::jsonb,
                            'subject', 'Subject line', 'bodyText', 'CANARY body text');
$$;
create function pg_temp.hash(p_n text) returns text language sql as $$ select encode(sha256(convert_to('hash-' || p_n, 'utf8')), 'hex'); $$;

-- Proposals created as the postgres owner through the same definer function the service role calls.
insert into ids select 'a1', act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test"}', pg_temp.payload('act-pkg@example.test'), 1, pg_temp.hash('a1'), 'note', '[]', 'job', pg_temp.uid('owner@example.test'), true);
insert into ids select 'a2', act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test"}', pg_temp.payload('act-pkg@example.test'), 1, pg_temp.hash('a2'), null, '[]', 'user', pg_temp.uid('finance-operator@example.test'), false);
insert into ids select 'a3', act.propose('PKG', 'email.save_draft', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test"}', pg_temp.payload('act-pkg@example.test'), 1, pg_temp.hash('a3'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false);
insert into ids select 'a4', act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test"}', pg_temp.payload('act-pkg@example.test'), 1, pg_temp.hash('a4'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false);
insert into ids select 'a5', act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002902', '{"mailbox":"act-pkg-ro@example.test"}', pg_temp.payload('act-pkg-ro@example.test'), 1, pg_temp.hash('a5'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false);
insert into ids select 'a6', act.propose('APK', 'email.send', '00000000-0000-4000-8000-000000002903', '{"mailbox":"act-apk@example.test"}', pg_temp.payload('act-apk@example.test'), 1, pg_temp.hash('a6'), null, '[]', 'user', null, false);

-- ---------------------------------------------------------------- shape and grants
select ok((select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('act.proposed_actions'::regclass, 'act.status_history'::regclass, 'act.execution_claims'::regclass)), 'RLS is enabled on all three act tables');
select ok(not has_table_privilege('authenticated', 'act.proposed_actions', 'insert, update, delete, truncate')
          and not has_table_privilege('authenticated', 'act.status_history', 'insert, update, delete, truncate')
          and not has_table_privilege('authenticated', 'act.execution_claims', 'insert, update, delete, truncate'), 'authenticated has no DML on act tables');
select ok(not has_table_privilege('service_role', 'act.proposed_actions', 'select, insert, update, delete')
          and not has_table_privilege('service_role', 'act.execution_claims', 'select, insert, update, delete'), 'service_role has no direct table access either');
select ok(not has_table_privilege('anon', 'act.proposed_actions', 'select'), 'anon has no access');
select ok(not has_function_privilege('authenticated', 'act.propose(text, text, uuid, jsonb, jsonb, integer, text, text, jsonb, text, uuid, boolean)', 'execute')
          and not has_function_privilege('authenticated', 'core.act_propose(text, text, uuid, jsonb, jsonb, integer, text, text, jsonb, text, uuid, boolean)', 'execute')
          and not has_function_privilege('authenticated', 'core.act_claim_execution(text, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'core.act_mark_verified(text, uuid, text, text)', 'execute'), 'authenticated cannot propose, claim or mark');
select ok(has_function_privilege('service_role', 'core.act_propose(text, text, uuid, jsonb, jsonb, integer, text, text, jsonb, text, uuid, boolean)', 'execute')
          and not has_function_privilege('service_role', 'core.act_approve(text, uuid, text)', 'execute')
          and not has_function_privilege('service_role', 'act.approve(text, uuid, text)', 'execute'), 'service_role proposes but cannot approve');
select ok((select bool_and(prosecdef and proconfig = array['search_path=""']) from pg_proc where oid in (
            'act.approve(text, uuid, text)'::regprocedure, 'act.reject(text, uuid, text)'::regprocedure, 'act.claim_execution(text, uuid)'::regprocedure)),
          'the writers are security definer with an empty search_path');

-- ---------------------------------------------------------------- propose gates
select is((select count(*)::int from ids), 6, 'six proposals were created');
select is((select status from act.proposed_actions where id = (select id from ids where k = 'a1')), 'proposed', 'a new action is proposed');
select is((select count(*)::int from act.status_history where action_id = (select id from ids where k = 'a1') and from_status is null and to_status = 'proposed'), 1, 'the proposal is in the history');
select ok((select expires_at between now() + interval '71 hours' and now() + interval '73 hours' from act.proposed_actions where id = (select id from ids where k = 'a1')), 'email proposals expire after 72 hours by default');

set local role service_role;
select lives_ok($$select core.act_propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test"}'::jsonb, '{"fromMailbox":"x@example.test"}'::jsonb, 1, repeat('c', 64), null, '[]'::jsonb, 'assistant', null, true)$$,
                'service_role can propose through the wrapper');
select throws_ok($$select core.act_propose('PKG', 'payment.send', '00000000-0000-4000-8000-000000002901', '{}'::jsonb, '{}'::jsonb, 1, repeat('c', 64), null, '[]'::jsonb, 'user', null, false)$$, '42501', null, 'a payment type is refused');
select throws_ok($$select core.act_propose('PKG', 'email.delete', '00000000-0000-4000-8000-000000002901', '{}'::jsonb, '{}'::jsonb, 1, repeat('c', 64), null, '[]'::jsonb, 'user', null, false)$$, '42501', null, 'a delete type is refused');
select throws_ok($$select core.act_propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002903', '{}'::jsonb, '{}'::jsonb, 1, repeat('c', 64), null, '[]'::jsonb, 'user', null, false)$$, '23503', null, 'another lane''s connection is refused');
select throws_ok($$select core.act_propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{}'::jsonb, '{}'::jsonb, 1, 'not-a-hash', null, '[]'::jsonb, 'user', null, false)$$, '23514', null, 'a malformed hash is refused');
reset role;
update core.lane_policies set store_outbound_drafts = false where lane_id = 'PKG';
set local role service_role;
select throws_ok($$select core.act_propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{}'::jsonb, '{}'::jsonb, 1, repeat('c', 64), null, '[]'::jsonb, 'user', null, false)$$, '42501', null,
                 'D-19: propose is refused while the lane does not allow storing outbound drafts');
reset role;
update core.lane_policies set store_outbound_drafts = true where lane_id = 'PKG';
select throws_ok($$insert into act.proposed_actions (lane_id, action_type, connection_id, provider, target, payload, payload_schema_version, payload_sha256, proposer_kind, expires_at)
                   values ('PKG', 'payment.send', '00000000-0000-4000-8000-000000002901', 'google', '{}', '{}', 1, repeat('c', 64), 'user', now())$$, '23514', null,
                 'a deny-listed type is also refused by the table check (second layer)');

-- ---------------------------------------------------------------- RLS reads (owner, proposer, others, cross-lane)
select pg_temp.claims_amr('owner@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select is((select count(*)::int from act.proposed_actions where lane_id = 'PKG'), 6, 'the owner sees every PKG action');
select is((select count(*)::int from act.proposed_actions where lane_id = 'APK'), 0, 'CROSS-LANE: the owner (not a member of APK) sees no APK action');
select is((select count(*)::int from core.act_list('APK')), 0, 'CROSS-LANE: act_list of another lane is empty');
select is((select count(*)::int from core.act_get('APK', (select id from ids where k = 'a6'))), 0, 'CROSS-LANE: act_get of another lane''s action is empty');
select is((select count(*)::int from act.status_history), (select count(*)::int from act.status_history where lane_id = 'PKG'), 'the owner sees no APK history');
select is(core.act_pending_count('PKG'), 6, 'pending count (proposed, unexpired) for PKG');
select is(core.act_pending_count('APK'), 0, 'CROSS-LANE: pending count of another lane is 0');
reset role;

select pg_temp.claims_amr('finance-operator@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select is((select array_agg(id) from act.proposed_actions), array[(select id from ids where k = 'a2')], 'a proposer sees only their own action');
reset role;
select pg_temp.claims_amr('viewer@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select is((select count(*)::int from act.proposed_actions), 0, 'a viewer sees nothing');
reset role;
select pg_temp.claims_amr('admin-technical@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select is((select count(*)::int from act.proposed_actions), 0, 'admin_technical sees no action content');
reset role;
select pg_temp.claims_amr('outsider@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select is((select count(*)::int from act.proposed_actions), 0, 'an outsider sees nothing');
reset role;
select pg_temp.claims_amr('owner@example.test', 'aal1', extract(epoch from now())::bigint);
set local role authenticated;
select is((select count(*)::int from act.proposed_actions), 0, 'AAL1 sees nothing');
reset role;
set local role anon;
select throws_ok($$select count(*) from act.proposed_actions$$, '42501', null, 'anon cannot read');
reset role;

-- ---------------------------------------------------------------- approve gates
select pg_temp.claims_amr('owner@example.test', 'aal1', extract(epoch from now())::bigint);
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'a1'), pg_temp.hash('a1')), '42501', null, 'AAL1 cannot approve');
reset role;

select pg_temp.claims_amr('owner@example.test', 'aal2', extract(epoch from now() - interval '20 minutes')::bigint);
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'a1'), pg_temp.hash('a1')), '42501', 'act: step_up_required', 'a TOTP older than step_up_max_age_s cannot approve');
reset role;
select pg_temp.claims_amr('owner@example.test', 'aal2', null);
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'a1'), pg_temp.hash('a1')), '42501', 'act: step_up_required', 'no TOTP in amr cannot approve');
reset role;

select pg_temp.claims_amr('finance-operator@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'a2'), pg_temp.hash('a2')), '42501', null, 'finance_operator cannot approve even their own proposal');
reset role;
select pg_temp.claims_amr('viewer@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'a1'), pg_temp.hash('a1')), '42501', null, 'a viewer cannot approve');
reset role;
select pg_temp.claims_amr('admin-technical@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'a1'), pg_temp.hash('a1')), '42501', null, 'admin_technical cannot approve');
reset role;
select pg_temp.claims_amr('outsider@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'a1'), pg_temp.hash('a1')), '42501', null, 'an outsider cannot approve');
reset role;

select pg_temp.claims_amr('owner@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select throws_ok(format($$select core.act_approve('APK', %L, %L)$$, (select id from ids where k = 'a6'), pg_temp.hash('a6')), '42501', null, 'CROSS-LANE: the owner cannot approve another lane''s action');
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'a6'), pg_temp.hash('a6')), 'P0002', null, 'CROSS-LANE: naming the other lane''s action under PKG finds nothing');
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'a1'), pg_temp.hash('other')), 'P0001', 'act: hash_mismatch', 'approving with a hash other than the stored one is refused');
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'a5'), pg_temp.hash('a5')), 'P0001', 'act: connection_not_enabled', 'a connection without the compose grant cannot be approved');
reset role;

update core.lane_policies set write_actions_allowed = array['email_draft'] where lane_id = 'PKG';
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'a1'), pg_temp.hash('a1')), 'P0001', 'act: type_not_allowed', 'email.send is refused when the lane policy lacks email_send');
reset role;
update core.lane_policies set write_actions_allowed = array['email_send', 'email_draft'] where lane_id = 'PKG';

-- approvals_live false: a config version with the flag off.
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{approvals,approvals_live}', 'false'::jsonb) from core.lane_config where lane_id = 'PKG' order by version desc limit 1;
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'a1'), pg_temp.hash('a1')), 'P0001', 'act: not_live', 'approve is refused while approvals_live is false');
reset role;
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{approvals,approvals_live}', 'true'::jsonb) from core.lane_config where lane_id = 'PKG' order by version desc limit 1;

set local role authenticated;
select is(core.act_approve('PKG', (select id from ids where k = 'a1'), pg_temp.hash('a1')), pg_temp.hash('a1'), 'the owner with a fresh step-up approves the exact hash');
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'a1'), pg_temp.hash('a1')), 'P0001', 'act: already_approved', 'a second approve is refused');
reset role;
select is((select status || ':' || (approved_by = pg_temp.uid('owner@example.test'))::text || ':' || (approved_hash = payload_sha256)::text from act.proposed_actions where id = (select id from ids where k = 'a1')), 'approved:true:true', 'approval records approver and hash');

-- ---------------------------------------------------------------- state machine and immutability (as the table owner)
select throws_ok(format($$update act.proposed_actions set payload = '{"to":["x@example.test"]}' where id = %L$$, (select id from ids where k = 'a1')), '42501', null, 'the payload is immutable');
select throws_ok(format($$update act.proposed_actions set payload_sha256 = repeat('d', 64) where id = %L$$, (select id from ids where k = 'a1')), '42501', null, 'the hash is immutable');
select throws_ok(format($$update act.proposed_actions set target = '{"mailbox":"evil@example.test"}' where id = %L$$, (select id from ids where k = 'a1')), '42501', null, 'the target is immutable');
select throws_ok(format($$update act.proposed_actions set status = 'verified' where id = %L$$, (select id from ids where k = 'a1')), '42501', null, 'approved -> verified (skipping executing) is illegal');
select throws_ok(format($$update act.proposed_actions set status = 'approved', approved_by = null where id = %L$$, (select id from ids where k = 'a4')), '42501', null, 'proposed -> approved without an approver or hash is illegal');
select throws_ok(format($$delete from act.proposed_actions where id = %L$$, (select id from ids where k = 'a1')), '42501', null, 'actions are never deleted');
select throws_ok(format($$update act.status_history set reason = 'x' where action_id = %L$$, (select id from ids where k = 'a1')), '42501', null, 'status_history is insert-only (update)');
select throws_ok(format($$delete from act.status_history where action_id = %L$$, (select id from ids where k = 'a1')), '42501', null, 'status_history is insert-only (delete)');

-- ---------------------------------------------------------------- claim, single claim, tamper, verify
select throws_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'a4')), 'P0001', 'act: not_approved', 'an unapproved action cannot be claimed');
-- A stored payload changed after approval is caught by the trigger; a forged approved_hash by the claim.
select throws_ok(format($$update act.proposed_actions set approved_hash = repeat('e', 64) where id = %L$$, (select id from ids where k = 'a1')), '42501', null, 'the approval record is immutable');
set local role service_role;
select is((select (core.act_claim_execution('PKG', (select id from ids where k = 'a1'))).status), 'executing', 'the service claims an approved action');
select throws_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'a1')), 'P0001', 'act: not_approved', 'a second claim is refused');
reset role;
select throws_ok(format($$insert into act.execution_claims (action_id, lane_id, idempotency_key) values (%L, 'PKG', %L)$$, (select id from ids where k = 'a1'), (select id from ids where k = 'a1')), '23505', null, 'a second claim row violates the primary key');
set local role service_role;
select lives_ok(format($$select core.act_claim_sent('PKG', %L, 'gmail-message-1')$$, (select id from ids where k = 'a1')), 'the provider id is recorded right after the send');
select lives_ok(format($$select core.act_mark_verified('PKG', %L, 'gmail-message-1', 'accepted')$$, (select id from ids where k = 'a1')), 'executing -> verified');
select throws_ok(format($$select core.act_mark_failed('PKG', %L, 'late', 'error')$$, (select id from ids where k = 'a1')), 'P0001', 'act: not_executing', 'a verified action cannot fail afterwards');
reset role;
select is((select (payload ? 'bodyText')::text || ':' || (payload_purged_at is not null)::text || ':' || (payload -> 'to')::text || ':' || (payload ->> 'subject') || ':' || (result ->> 'external_id') from act.proposed_actions where id = (select id from ids where k = 'a1')),
          'false:true:["dana@sender.example.test"]:Subject line:gmail-message-1', 'D-19 verified: bodyText purged; recipients, subject and ids stay');
select throws_ok(format($$update act.proposed_actions set status = 'proposed' where id = %L$$, (select id from ids where k = 'a1')), '42501', null, 'verified -> proposed is illegal (terminal)');
select throws_ok(format($$update act.proposed_actions set failure_code = 'x' where id = %L$$, (select id from ids where k = 'a1')), '42501', null, 'a terminal row is frozen');

-- ---------------------------------------------------------------- reject, supersede, expire, failure: bodies purged
select pg_temp.claims_amr('owner@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select throws_ok(format($$select core.act_reject('PKG', %L, '')$$, (select id from ids where k = 'a3')), '22023', null, 'a reason is required to reject');
select lives_ok(format($$select core.act_reject('PKG', %L, 'not needed')$$, (select id from ids where k = 'a3')), 'the owner rejects a pending proposal (AAL2 is enough)');
reset role;
select is((select status || ':' || (payload ? 'bodyText')::text || ':' || coalesce(rationale, 'null') from act.proposed_actions where id = (select id from ids where k = 'a3')), 'rejected:false:null', 'D-19 rejected: body purged');
select is((select reason from act.status_history where action_id = (select id from ids where k = 'a3') and to_status = 'rejected'), 'not needed', 'the rejection reason is in the history');

set local role service_role;
insert into ids select 'a4b', core.act_supersede('PKG', (select id from ids where k = 'a4'), '{"mailbox":"act-pkg@example.test"}', pg_temp.payload('act-pkg@example.test') || '{"subject":"Edited"}', 1, pg_temp.hash('a4b'), null, '[]', pg_temp.uid('owner@example.test'), false);
reset role;
select is((select status || ':' || (payload ? 'bodyText')::text || ':' || (superseded_by_id = (select id from ids where k = 'a4b'))::text from act.proposed_actions where id = (select id from ids where k = 'a4')), 'invalidated:false:true', 'edit: the old proposal is invalidated, its body purged, and it points at the new one');
select is((select status || ':' || (supersedes_id = (select id from ids where k = 'a4'))::text || ':' || (payload ->> 'subject') from act.proposed_actions where id = (select id from ids where k = 'a4b')), 'proposed:true:Edited', 'edit: the new proposal is pending with the edited payload');

-- expiry
select throws_ok(format($$update act.proposed_actions set expires_at = now() where id = %L$$, (select id from ids where k = 'a5')), '42501', null, 'expires_at is immutable');
-- Test-only: switch the guard off for one statement to age an action.
alter table act.proposed_actions disable trigger proposed_actions_guard;
update act.proposed_actions set expires_at = now() - interval '1 minute' where id = (select id from ids where k = 'a5');
alter table act.proposed_actions enable trigger proposed_actions_guard;
set local role service_role;
select is(core.act_expire_stale('PKG'), 1, 'stale proposals are expired');
reset role;
select is((select status || ':' || (payload ? 'bodyText')::text from act.proposed_actions where id = (select id from ids where k = 'a5')), 'expired:false', 'D-19 expired: body purged');
select pg_temp.claims_amr('owner@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select is(core.act_pending_count('PKG'), 3, 'pending count now: a2, the edited proposal and the service-proposed one');
reset role;

-- failed: a second approved action through the full path
update core.connections set features = '{"gmail_compose": true}' where id = '00000000-0000-4000-8000-000000002902';
insert into ids select 'a7', act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test"}', pg_temp.payload('act-pkg@example.test'), 1, pg_temp.hash('a7'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false);
select pg_temp.claims_amr('owner@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select lives_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'a7'), pg_temp.hash('a7')), 'a second action is approved');
reset role;
-- The approver loses the owner role between approval and execution: the claim refuses.
delete from core.memberships where lane_id = 'PKG' and user_id = pg_temp.uid('owner@example.test');
set local role service_role;
select throws_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'a7')), 'P0001', 'act: approver_revoked', 'the claim re-checks the approver''s role');
reset role;
insert into core.memberships (user_id, lane_id, role) values (pg_temp.uid('owner@example.test'), 'PKG', 'owner');
update core.lane_policies set write_actions_allowed = '{}' where lane_id = 'PKG';
set local role service_role;
select throws_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'a7')), 'P0001', 'act: type_not_allowed', 'the claim re-checks the lane policy');
reset role;
update core.lane_policies set write_actions_allowed = array['email_send', 'email_draft'] where lane_id = 'PKG';
set local role service_role;
select lives_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'a7')), 'with the gates open the claim succeeds');
select lives_ok(format($$select core.act_mark_failed('PKG', %L, 'verification_mismatch', 'mismatch')$$, (select id from ids where k = 'a7')), 'executing -> failed');
reset role;
select is((select status || ':' || failure_code || ':' || (payload ? 'bodyText')::text from act.proposed_actions where id = (select id from ids where k = 'a7')), 'failed:verification_mismatch:false', 'D-19 failed: body purged');
select is((select count(*)::int from act.status_history where action_id = (select id from ids where k = 'a7')), 4, 'history: proposed, approved, executing, failed');


-- ---------------------------------------------------------------- review fixes (T-232 reviews) and T-231d
-- act_claim_open (security H1): true only for an executing action with an open claim, its approved hash and its approver.
insert into ids select 'a8', act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test"}', pg_temp.payload('act-pkg@example.test'), 1, pg_temp.hash('a8'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false);
select pg_temp.claims_amr('owner@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select lives_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'a8'), pg_temp.hash('a8')), 'a8 approved');
select throws_ok(format($$select core.act_claim_open('PKG', %L, %L, %L)$$, (select id from ids where k = 'a8'), pg_temp.hash('a8'), pg_temp.uid('owner@example.test')), '42501', null, 'act_claim_open is not callable by authenticated');
reset role;
set local role service_role;
select is(core.act_claim_open('PKG', (select id from ids where k = 'a8'), pg_temp.hash('a8'), pg_temp.uid('owner@example.test')), false, 'approved but not claimed: not open');
select lives_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'a8')), 'a8 claimed');
select is(core.act_claim_open('PKG', (select id from ids where k = 'a8'), pg_temp.hash('a8'), pg_temp.uid('owner@example.test')), true, 'claimed, right hash and approver: open');
select is(core.act_claim_open('PKG', (select id from ids where k = 'a8'), pg_temp.hash('other'), pg_temp.uid('owner@example.test')), false, 'another hash: not open');
select is(core.act_claim_open('PKG', (select id from ids where k = 'a8'), pg_temp.hash('a8'), pg_temp.uid('viewer@example.test')), false, 'another approver: not open');
select is(core.act_claim_open('APK', (select id from ids where k = 'a8'), pg_temp.hash('a8'), pg_temp.uid('owner@example.test')), false, 'another lane: not open');
select lives_ok(format($$select core.act_claim_sent('PKG', %L, 'gmail-message-8')$$, (select id from ids where k = 'a8')), 'a8 sent');
select is(core.act_claim_open('PKG', (select id from ids where k = 'a8'), pg_temp.hash('a8'), pg_temp.uid('owner@example.test')), false, 'after the send: no longer open (never twice)');
reset role;

-- supersede accepts only a pending proposal (security L2).
insert into ids select 'a9', act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test"}', pg_temp.payload('act-pkg@example.test'), 1, pg_temp.hash('a9'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false);
select pg_temp.claims_amr('owner@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select lives_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'a9'), pg_temp.hash('a9')), 'a9 approved');
reset role;
set local role service_role;
select throws_ok(format($$select core.act_supersede('PKG', %L, '{"mailbox":"act-pkg@example.test"}', %L, 1, %L, null, '[]', %L, false)$$, (select id from ids where k = 'a9'), pg_temp.payload('act-pkg@example.test'), pg_temp.hash('a9b'), pg_temp.uid('owner@example.test')),
                 'P0001', 'act: not_editable', 'an approved action cannot be edited (superseded)');
reset role;

-- The step-up window is bounded in SQL (security L1): a lane setting of a day still needs a TOTP within 900 s.
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{approvals}', coalesce(config -> 'approvals', '{}'::jsonb) || '{"step_up_max_age_s": 86400}'::jsonb)
from core.lane_config where lane_id = 'PKG' order by version desc limit 1;
insert into ids select 'a10', act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test"}', pg_temp.payload('act-pkg@example.test'), 1, pg_temp.hash('a10'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false);
select pg_temp.claims_amr('owner@example.test', 'aal2', extract(epoch from now())::bigint - 1000);
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'a10'), pg_temp.hash('a10')), '42501', 'act: step_up_required', 'a 1000 s old TOTP is refused even when the lane setting says a day');
reset role;

-- T-231d: a job proposes at most one pending reply per message replied to; a user's own proposal is not limited.
create function pg_temp.reply(p_msg text) returns jsonb language sql as $$
  select pg_temp.payload('act-pkg@example.test') || jsonb_build_object('inReplyTo', jsonb_build_object('threadId', 'thread-1', 'messageId', p_msg));
$$;
select lives_ok($$select act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test","thread_id":"thread-1"}', pg_temp.reply('msg-1'), 1, pg_temp.hash('r1'), null, '[]', 'job', pg_temp.uid('owner@example.test'), true)$$, 'the briefing proposes a reply to msg-1');
select throws_ok($$select act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test","thread_id":"thread-1"}', pg_temp.reply('msg-1'), 1, pg_temp.hash('r2'), null, '[]', 'job', pg_temp.uid('owner@example.test'), true)$$,
                 '23505', 'act: a reply to this message is already waiting for approval', 'a second job reply to the same message is refused');
select lives_ok($$select act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test","thread_id":"thread-1"}', pg_temp.reply('msg-2'), 1, pg_temp.hash('r3'), null, '[]', 'job', pg_temp.uid('owner@example.test'), true)$$, 'a job reply to another message is fine');
select lives_ok($$select act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test","thread_id":"thread-1"}', pg_temp.reply('msg-1'), 1, pg_temp.hash('r4'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false)$$, 'a user''s own reply to msg-1 is not limited');

-- A rejected job reply is not proposed again for 7 days (T-231d security L1).
insert into ids select 'rj', act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test","thread_id":"thread-1"}', pg_temp.reply('msg-rj'), 1, pg_temp.hash('rj'), null, '[]', 'job', pg_temp.uid('owner@example.test'), true);
select pg_temp.claims_amr('owner@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select lives_ok(format($$select core.act_reject('PKG', %L, 'not this')$$, (select id from ids where k = 'rj')), 'the owner rejects the prepared reply');
reset role;
select throws_ok($$select act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test","thread_id":"thread-1"}', pg_temp.reply('msg-rj'), 1, pg_temp.hash('rj2'), null, '[]', 'job', pg_temp.uid('owner@example.test'), true)$$,
                 '23505', null, 'a reply the owner rejected is not prepared again (7 days)');
-- Jobs have their own cap of 6 pending, so the owner keeps room for their own proposals (T-231d security M4).
insert into ids select 'job' || g::text, act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test","thread_id":"thread-1"}', pg_temp.reply('msg-job-' || g::text), 1, pg_temp.hash('job' || g::text), null, '[]', 'job', pg_temp.uid('owner@example.test'), true)
from generate_series(1, 6 - (select count(*)::int from act.proposed_actions where lane_id = 'PKG' and status = 'proposed' and proposer_kind = 'job' and expires_at > now())) g;
select throws_ok($$select act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test","thread_id":"thread-1"}', pg_temp.reply('msg-job-over'), 1, pg_temp.hash('job-over'), null, '[]', 'job', pg_temp.uid('owner@example.test'), true)$$,
                 '54000', null, 'a 7th pending job proposal is refused');
select lives_ok($$select act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test"}', pg_temp.payload('act-pkg@example.test'), 1, pg_temp.hash('user-after-jobs'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false)$$,
                'the owner can still propose while the job cap is full');

-- The 20-pending cap counts only unexpired proposals (code M2).
insert into ids select 'cap' || g::text, act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test"}', pg_temp.payload('act-pkg@example.test'), 1, pg_temp.hash('cap' || g::text), null, '[]', 'user', pg_temp.uid('owner@example.test'), false)
from generate_series(1, 20 - (select count(*)::int from act.proposed_actions where lane_id = 'PKG' and status = 'proposed' and expires_at > now())) g;
select throws_ok($$select act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test"}', pg_temp.payload('act-pkg@example.test'), 1, pg_temp.hash('cap-over'), null, '[]', 'user', null, false)$$,
                 '54000', null, 'at 20 unexpired pending proposals the cap refuses');
alter table act.proposed_actions disable trigger proposed_actions_guard;
update act.proposed_actions set expires_at = now() - interval '1 minute' where lane_id = 'PKG' and status = 'proposed';
alter table act.proposed_actions enable trigger proposed_actions_guard;
select lives_ok($$select act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000002901', '{"mailbox":"act-pkg@example.test"}', pg_temp.payload('act-pkg@example.test'), 1, pg_temp.hash('cap-after'), null, '[]', 'user', null, false)$$,
                'expired (not yet swept) proposals no longer count against the cap');

select * from finish();
rollback;
