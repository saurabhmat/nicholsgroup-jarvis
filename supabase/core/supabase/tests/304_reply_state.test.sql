-- T-234 part 3 review fixes: duplicate-send guard (core.act_reply_state, act.approve check_sent_first, act.insert_proposal rules).
-- Covered: grants (authenticated + service_role, not anon), act_reply_state pending / blocked / already_sent per THREAD, CROSS-LANE
-- denial, AAL1 and anon denial, approve refused with check_sent_first, the job rule after a failed-unknown action, the owner's
-- second pending proposal for a message refused, a supersede (edit) still allowed, is_unknown_failure codes.
begin;
select plan(28);
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
update core.lane_policies set store_outbound_drafts = true, write_actions_allowed = array['email_send', 'email_draft'] where lane_id in ('PKG', 'APK');
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{approvals}', coalesce(config -> 'approvals', '{}'::jsonb) || '{"approvals_live": true}'::jsonb)
from core.lane_config where lane_id = 'PKG' order by version desc limit 1;
insert into core.connections (id, lane_id, provider, external_account_id, status, features) values
  ('00000000-0000-4000-8000-000000003041', 'PKG', 'google', 'rs-pkg@example.test', 'active', '{"gmail_compose": true}'),
  ('00000000-0000-4000-8000-000000003042', 'APK', 'google', 'rs-apk@example.test', 'active', '{"gmail_compose": true}');

-- A reply proposal for message p_msg in thread p_thread, as the service does it.
create function pg_temp.mk(p_k text, p_lane text, p_conn uuid, p_thread text, p_msg text, p_kind text) returns void language plpgsql as $$
declare v_id uuid;
begin
  v_id := act.propose(p_lane, 'email.send', p_conn, jsonb_build_object('mailbox', 'rs@example.test', 'thread_id', p_thread),
    jsonb_build_object('fromMailbox', 'rs@example.test', 'to', jsonb_build_array('dana@sender.example.test'), 'cc', '[]'::jsonb, 'bcc', '[]'::jsonb,
                       'subject', 'Re: S', 'bodyText', 'CANARY body', 'inReplyTo', jsonb_build_object('threadId', p_thread, 'messageId', p_msg)),
    1, encode(sha256(convert_to('rs-' || p_k, 'utf8')), 'hex'), null, '[]', p_kind,
    case when p_kind = 'user' then pg_temp.uid('owner@example.test') else null end, false);
  insert into ids values (p_k, v_id);
end;
$$;
create function pg_temp.state(p_thread text, p_msg text) returns text language sql as $$
  select coalesce((select format('%s|%s|%s', s.pending_id is not null, s.blocked, s.already_sent_at is not null) from core.act_reply_state('PKG', '00000000-0000-4000-8000-000000003041', p_thread, p_msg) s), 'none');
$$;

-- Thread T1 / message M1: a pending owner proposal.  Thread T2: an approved action.  T3: failed outcome_unknown.  T4: failed
-- execution_error (not unknown).  T5: verified.  T6: failed unknown but 25 hours ago.  T7 / message M7: nothing.
select pg_temp.mk('p1', 'PKG', '00000000-0000-4000-8000-000000003041', 'T1', 'M1', 'user');
select pg_temp.mk('ap', 'PKG', '00000000-0000-4000-8000-000000003041', 'T2', 'M2', 'user');
select pg_temp.mk('fu', 'PKG', '00000000-0000-4000-8000-000000003041', 'T3', 'M3', 'user');
select pg_temp.mk('fe', 'PKG', '00000000-0000-4000-8000-000000003041', 'T4', 'M4', 'user');
select pg_temp.mk('ve', 'PKG', '00000000-0000-4000-8000-000000003041', 'T5', 'M5', 'user');
select pg_temp.mk('fo', 'PKG', '00000000-0000-4000-8000-000000003041', 'T6', 'M6', 'user');
select pg_temp.mk('apk', 'APK', '00000000-0000-4000-8000-000000003042', 'T1', 'M1', 'user');
-- Walk the rows into their states through the real functions (as the owner of the test transaction).
create function pg_temp.advance(p_k text, p_final text, p_code text default null) returns void language plpgsql as $$
declare v_id uuid := (select id from ids where k = p_k);
begin
  perform set_config('act.reason', 'test', true);
  update act.proposed_actions set status = 'approved', approved_by = pg_temp.uid('owner@example.test'), approved_at = now(), approved_hash = payload_sha256 where id = v_id;
  if p_final = 'approved' then return; end if;
  update act.proposed_actions set status = 'executing', executing_at = now() where id = v_id;
  if p_final = 'executing' then return; end if;
  if p_final = 'verified' then
    update act.proposed_actions set status = 'verified', verified_at = now(), executed_at = now() where id = v_id;
  else
    update act.proposed_actions set status = 'failed', failure_code = p_code where id = v_id;
  end if;
end;
$$;
select pg_temp.advance('ap', 'approved');
select pg_temp.advance('fu', 'failed', 'verification_mismatch');
select pg_temp.advance('fe', 'failed', 'execution_error');
select pg_temp.advance('ve', 'verified');
select pg_temp.advance('fo', 'failed', 'outcome_unknown');
alter table act.proposed_actions disable trigger proposed_actions_guard;
update act.proposed_actions set updated_at = now() - interval '25 hours' where id = (select id from ids where k = 'fo');
alter table act.proposed_actions enable trigger proposed_actions_guard;

-- ---------------------------------------------------------------- grants and the helper
select ok(has_function_privilege('authenticated', 'core.act_reply_state(text, uuid, text, text)', 'execute')
          and has_function_privilege('service_role', 'core.act_reply_state(text, uuid, text, text)', 'execute')
          and not has_function_privilege('anon', 'core.act_reply_state(text, uuid, text, text)', 'execute'), 'act_reply_state: authenticated and service_role, not anon');
select ok((select not p.prosecdef and p.proconfig = array['search_path=""'] from pg_proc p where p.oid = 'core.act_reply_state(text, uuid, text, text)'::regprocedure), 'act_reply_state is invoker with an empty search_path');
select ok(has_function_privilege('authenticated', 'act.approve(text, uuid, text)', 'execute') and not has_function_privilege('anon', 'act.approve(text, uuid, text)', 'execute')
          and not has_function_privilege('service_role', 'act.approve(text, uuid, text)', 'execute')
          and not has_function_privilege('authenticated', 'act.insert_proposal(text, text, uuid, jsonb, jsonb, integer, text, text, jsonb, text, uuid, boolean, uuid)', 'execute'), 'the approve and insert_proposal grants are unchanged');
select ok(act.is_unknown_failure('outcome_unknown') and act.is_unknown_failure('verification_mismatch') and act.is_unknown_failure('verification_unavailable')
          and act.is_unknown_failure('marker_not_found') and act.is_unknown_failure('ambiguous_match') and act.is_unknown_failure('reconcile_gave_up')
          and not act.is_unknown_failure('execution_error') and not act.is_unknown_failure('payload_changed') and not act.is_unknown_failure(null)
          and not act.is_unknown_failure('verificationx'), 'is_unknown_failure: the unknown codes only');

-- ---------------------------------------------------------------- the state, as the owner
select pg_temp.claims_amr('owner@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select is(pg_temp.state('T1', 'M1'), 't|f|f', 'pending: the owner proposal for M1, nothing blocking');
select is(pg_temp.state('T1', 'OTHER'), 'f|f|f', 'a different message in the same thread has no pending proposal');
select is(pg_temp.state('T2', 'M2'), 'f|t|f', 'blocked: an approved action in the thread');
select is(pg_temp.state('T2', 'OTHER'), 'f|t|f', 'blocked is per THREAD: another message in T2 is blocked too');
select is(pg_temp.state('T3', 'M3'), 'f|t|f', 'blocked: failed with verification_mismatch (unknown) within 24 h');
select is(pg_temp.state('T4', 'M4'), 'f|f|f', 'not blocked: failed with execution_error (it did not go out)');
select is(pg_temp.state('T5', 'M5'), 'f|f|t', 'already_sent_at: a verified send in the thread');
select is(pg_temp.state('T5', 'OTHER'), 'f|f|t', 'already_sent is per thread');
select is(pg_temp.state('T6', 'M6'), 'f|f|f', 'not blocked: an unknown failure older than 24 h');
select is(pg_temp.state('T7', 'M7'), 'f|f|f', 'nothing anywhere: all false');
select is((select count(*)::int from core.act_reply_state('PKG', '00000000-0000-4000-8000-000000003042', 'T1', 'M1')), 1, 'always exactly one row');
-- CROSS-LANE: APK's proposal (same thread and message ids) is never visible through PKG, and APK itself is not visible to this owner.
select is((select s.pending_id from core.act_reply_state('APK', '00000000-0000-4000-8000-000000003042', 'T1', 'M1') s), null, 'CROSS-LANE: the owner sees nothing of APK');
select is((select s.pending_id from core.act_reply_state('PKG', '00000000-0000-4000-8000-000000003042', 'T1', 'M1') s), null, 'CROSS-LANE: APK connection under PKG finds nothing');
reset role;

select pg_temp.claims_amr('owner@example.test', 'aal1', extract(epoch from now())::bigint);
set local role authenticated;
select is(pg_temp.state('T1', 'M1'), 'f|f|f', 'AAL1 sees nothing (RLS)');
reset role;
set local role anon;
select throws_ok($$select * from core.act_reply_state('PKG', '00000000-0000-4000-8000-000000003041', 'T1', 'M1')$$, '42501', null, 'anon cannot call act_reply_state');
reset role;

-- ---------------------------------------------------------------- approve: check_sent_first
-- Another proposal in T2 (approved sibling) and in T3 (failed-unknown sibling), and one in the free thread T4.
select pg_temp.mk('n2', 'PKG', '00000000-0000-4000-8000-000000003041', 'T2', 'M2b', 'user');
select pg_temp.mk('n3', 'PKG', '00000000-0000-4000-8000-000000003041', 'T3', 'M3b', 'user');
select pg_temp.mk('n6', 'PKG', '00000000-0000-4000-8000-000000003041', 'T6', 'M6b', 'user');
select pg_temp.claims_amr('owner@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'n2'), encode(sha256(convert_to('rs-n2', 'utf8')), 'hex')), 'P0001', 'act: check_sent_first', 'approve refused: an approved sibling in the thread');
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'n3'), encode(sha256(convert_to('rs-n3', 'utf8')), 'hex')), 'P0001', 'act: check_sent_first', 'approve refused: a failed-unknown sibling within 24 h');
select lives_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'n6'), encode(sha256(convert_to('rs-n6', 'utf8')), 'hex')), 'approve allowed: the only unknown failure is older than 24 h');
reset role;
select is((select status from act.proposed_actions where id = (select id from ids where k = 'n2')), 'proposed', 'the refused approval left the proposal pending');

-- already_replied (re-check M1): T5 has a verified send. A proposal made BEFORE it (a stale briefing draft on another message,
-- a second tab) is refused; one made after it (the owner's explicit new reply) is allowed. Inside one transaction now() is
-- constant, so "after" = created_at equal to verified_at (not before it).
select pg_temp.mk('n5old', 'PKG', '00000000-0000-4000-8000-000000003041', 'T5', 'M5b', 'user');
alter table act.proposed_actions disable trigger proposed_actions_guard;
update act.proposed_actions set created_at = now() - interval '1 hour' where id = (select id from ids where k = 'n5old');
alter table act.proposed_actions enable trigger proposed_actions_guard;
select pg_temp.mk('n5new', 'PKG', '00000000-0000-4000-8000-000000003041', 'T5', 'M5c', 'user');
select pg_temp.claims_amr('owner@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'n5old'), encode(sha256(convert_to('rs-n5old', 'utf8')), 'hex')), 'P0001', 'act: already_replied', 'approve refused: the draft was made before the latest verified reply in the thread');
select lives_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'n5new'), encode(sha256(convert_to('rs-n5new', 'utf8')), 'hex')), 'approve allowed: a draft made after that reply');
reset role;

-- ---------------------------------------------------------------- insert_proposal rules
select throws_ok($$select pg_temp.mk('j3', 'PKG', '00000000-0000-4000-8000-000000003041', 'T3', 'M3', 'job')$$, '23505', 'act: a reply to this message is already waiting for approval', 'a job does not propose again after a failed-unknown action for that message');
select pg_temp.mk('j4', 'PKG', '00000000-0000-4000-8000-000000003041', 'T4', 'M4', 'job');
select throws_ok($$select pg_temp.mk('u1', 'PKG', '00000000-0000-4000-8000-000000003041', 'T1', 'M1', 'user')$$, '23505', 'act: reply_already_pending', 'a second owner proposal for the same message is refused');
select lives_ok(format($$select act.supersede('PKG', %L, '{"mailbox":"rs@example.test","thread_id":"T1"}'::jsonb, %L::jsonb, 1, %L, null, '[]', %L, false)$$,
  (select id from ids where k = 'p1'),
  jsonb_build_object('fromMailbox', 'rs@example.test', 'to', jsonb_build_array('dana@sender.example.test'), 'cc', '[]'::jsonb, 'bcc', '[]'::jsonb, 'subject', 'Re: S', 'bodyText', 'edited', 'inReplyTo', jsonb_build_object('threadId', 'T1', 'messageId', 'M1'))::text,
  encode(sha256(convert_to('rs-edit', 'utf8')), 'hex'), pg_temp.uid('owner@example.test')), 'an edit (supersede) of the pending proposal is still allowed');

select * from finish();
rollback;
