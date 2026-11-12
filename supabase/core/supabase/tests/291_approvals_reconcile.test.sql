-- T-192: action.reconcile_stuck (act.stuck_actions, act.reconcile_verified, act.reconcile_failed and the core.act_* wrappers).
-- Covered: grants (service_role only, no authenticated/anon), the threshold from lane_config (default 10 min, clamped), only
-- `executing` rows are listed, a claim is required, verified / failed transitions with history reason and claim outcome,
-- the body purge (D-19), never a second claim, idempotent rerun (second call returns false), not-due rows are untouched,
-- CROSS-LANE denial (another lane's action cannot be listed or transitioned through this lane), invalid outcomes.
begin;
select plan(40);
\ir helpers/lane_rls.psql

create temp table ids (k text primary key, id uuid);
grant all on ids to public;

update core.lanes set enabled = true where code = 'APK';
update core.lane_policies set store_outbound_drafts = true, write_actions_allowed = array['email_send', 'email_draft'] where lane_id in ('PKG', 'APK');
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{approvals}', coalesce(config -> 'approvals', '{}'::jsonb) || '{"approvals_live": true}'::jsonb)
from core.lane_config where lane_id in ('PKG', 'APK') and version = (select max(version) from core.lane_config l2 where l2.lane_id = core.lane_config.lane_id);
insert into core.connections (id, lane_id, provider, external_account_id, status, features) values
  ('00000000-0000-4000-8000-000000001921', 'PKG', 'google', 'rec-pkg@example.test', 'active', '{"gmail_compose": true}'),
  ('00000000-0000-4000-8000-000000001922', 'APK', 'google', 'rec-apk@example.test', 'active', '{"gmail_compose": true}');
create function pg_temp.hash(p_n text) returns text language sql as $$ select encode(sha256(convert_to('rec-' || p_n, 'utf8')), 'hex'); $$;
create function pg_temp.payload(p_from text) returns jsonb language sql as $$
  select jsonb_build_object('fromMailbox', p_from, 'to', jsonb_build_array('dana@sender.example.test'), 'cc', '[]'::jsonb, 'bcc', '[]'::jsonb,
                            'subject', 'Subject line', 'bodyText', 'CANARY body text');
$$;
-- An action in `executing` with its single claim, started p_min minutes ago.
create function pg_temp.executing(p_k text, p_lane text, p_conn uuid, p_mailbox text, p_min integer) returns void language plpgsql as $$
declare
  v_id uuid;
begin
  v_id := act.propose(p_lane, 'email.send', p_conn, jsonb_build_object('mailbox', p_mailbox), pg_temp.payload(p_mailbox), 1, pg_temp.hash(p_k), null, '[]', 'user', pg_temp.uid('owner@example.test'), false);
  insert into ids values (p_k, v_id);
  update act.proposed_actions set status = 'approved', approved_by = pg_temp.uid('owner@example.test'), approved_at = now(), approved_hash = payload_sha256 where id = v_id;
  if p_lane = 'PKG' then
    perform pg_catalog.set_config('role', 'service_role', true);
    perform core.act_claim_execution(p_lane, v_id);
    perform pg_catalog.set_config('role', 'postgres', true);
  else
    -- APK's owner is not seeded: write the claim as the table owner (the shape claim_execution leaves).
    insert into act.execution_claims (action_id, lane_id, idempotency_key) values (v_id, p_lane, v_id);
    update act.proposed_actions set status = 'executing', executing_at = now() where id = v_id;
  end if;
  update act.proposed_actions set executing_at = now() - make_interval(mins => p_min) where id = v_id;
end;
$$;

select pg_temp.executing('old', 'PKG', '00000000-0000-4000-8000-000000001921', 'rec-pkg@example.test', 30);
select pg_temp.executing('young', 'PKG', '00000000-0000-4000-8000-000000001921', 'rec-pkg@example.test', 3);
select pg_temp.executing('sent', 'PKG', '00000000-0000-4000-8000-000000001921', 'rec-pkg@example.test', 20);
select pg_temp.executing('veryold', 'PKG', '00000000-0000-4000-8000-000000001921', 'rec-pkg@example.test', 90);
select pg_temp.executing('apk', 'APK', '00000000-0000-4000-8000-000000001922', 'rec-apk@example.test', 45);
update act.execution_claims set outcome = 'sent', external_id = 'gmail-sent-1' where action_id = (select id from ids where k = 'sent');

-- ---------------------------------------------------------------- grants
select ok(has_function_privilege('service_role', 'core.act_stuck_actions(text, integer)', 'execute')
          and has_function_privilege('service_role', 'core.act_reconcile_verified(text, uuid, text, text)', 'execute')
          and has_function_privilege('service_role', 'core.act_reconcile_failed(text, uuid, text, text)', 'execute'), 'service_role may list and reconcile');
select ok(not has_function_privilege('authenticated', 'core.act_stuck_actions(text, integer)', 'execute')
          and not has_function_privilege('authenticated', 'core.act_reconcile_verified(text, uuid, text, text)', 'execute')
          and not has_function_privilege('authenticated', 'core.act_reconcile_failed(text, uuid, text, text)', 'execute')
          and not has_function_privilege('authenticated', 'act.reconcile_verified(text, uuid, text, text)', 'execute')
          and not has_function_privilege('authenticated', 'act.stuck_actions(text, integer)', 'execute'), 'authenticated may not');
select ok(not has_function_privilege('anon', 'core.act_stuck_actions(text, integer)', 'execute')
          and not has_function_privilege('anon', 'core.act_reconcile_failed(text, uuid, text, text)', 'execute'), 'anon may not');
select ok((select bool_and(prosecdef and proconfig = array['search_path=""']) from pg_proc where oid in (
            'act.stuck_actions(text, integer)'::regprocedure, 'act.reconcile_verified(text, uuid, text, text)'::regprocedure, 'act.reconcile_failed(text, uuid, text, text)'::regprocedure)),
          'the reconcile functions are security definer with an empty search_path');
select ok(not has_function_privilege('authenticated', 'act.reconcile_after_minutes(text)', 'execute'), 'the setting helpers are not callable by authenticated');

-- ---------------------------------------------------------------- threshold and listing
set local role service_role;
select is((select count(*)::int from core.act_stuck_actions('PKG')), 3, 'default threshold 10 min: the 30, 20 and 90 minute actions are listed, the 3 minute one is not');
select is((select array_agg(round(extract(epoch from now() - (action ->> 'executing_at')::timestamptz) / 60)::int order by (action ->> 'executing_at')::timestamptz)::text from core.act_stuck_actions('PKG')), '{90,30,20}', 'oldest first');
select is((select give_up::text from core.act_stuck_actions('PKG') where (action ->> 'executing_at')::timestamptz < now() - interval '80 minutes'), 'true', 'older than the give-up time (default 60 min): give_up');
select is((select count(*)::int from core.act_stuck_actions('PKG') where give_up), 1, 'only the 90 minute action is past the give-up time');
select is((select claim_outcome || ':' || claim_external_id from core.act_stuck_actions('PKG') where (action ->> 'id')::uuid = (select id from ids where k = 'sent')), 'sent:gmail-sent-1', 'the claim state is returned');
select is((select count(*)::int from core.act_stuck_actions('APK')), 1, 'APK lists its own action');
select is((select count(*)::int from core.act_stuck_actions('PKG') where action ->> 'lane_id' <> 'PKG'), 0, 'CROSS-LANE: the PKG list holds no other lane''s action');
reset role;

-- The lane's own threshold from lane_config (clamped to 5..1440).
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{approvals}', config -> 'approvals' || '{"reconcile_after_minutes": 25, "reconcile_give_up_minutes": 5}'::jsonb)
from core.lane_config where lane_id = 'PKG' order by version desc limit 1;
set local role service_role;
select is((select count(*)::int from core.act_stuck_actions('PKG')), 2, 'reconcile_after_minutes = 25 from lane_config: only the 30 and 90 minute actions');
reset role;
select is((select act.reconcile_give_up_minutes('PKG')), 30, 'give-up time is always at least the reconcile threshold + 5 minutes');
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{approvals}', config -> 'approvals' || '{"reconcile_after_minutes": 1}'::jsonb)
from core.lane_config where lane_id = 'PKG' order by version desc limit 1;
select is((select act.reconcile_after_minutes('PKG')), 5, 'a threshold below 5 minutes is clamped to 5');
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, (config #- '{approvals,reconcile_after_minutes}') #- '{approvals,reconcile_give_up_minutes}'
from core.lane_config where lane_id = 'PKG' order by version desc limit 1;
select is((select act.reconcile_after_minutes('PKG') || '/' || act.reconcile_give_up_minutes('PKG')), '10/60', 'defaults are 10 and 60 minutes');

-- ---------------------------------------------------------------- transitions
set local role service_role;
select is(core.act_reconcile_verified('PKG', (select id from ids where k = 'young'), 'gmail-x', 'already_applied'), false, 'an action that is not yet due is left alone');
select is(core.act_reconcile_verified('PKG', (select id from ids where k = 'sent'), 'gmail-sent-1', 'accepted'), true, 'executing -> verified (read back by the recorded id)');
select is(core.act_reconcile_verified('PKG', (select id from ids where k = 'sent'), 'gmail-sent-1', 'accepted'), false, 'a second run changes nothing (idempotent)');
select is(core.act_reconcile_failed('PKG', (select id from ids where k = 'sent'), 'outcome_unknown', 'outcome_unknown'), false, 'a verified action cannot be failed afterwards');
select is(core.act_reconcile_failed('PKG', (select id from ids where k = 'old'), 'marker_not_found', 'outcome_unknown'), true, 'executing -> failed / outcome_unknown');
select is(core.act_reconcile_failed('PKG', (select id from ids where k = 'old'), 'marker_not_found', 'outcome_unknown'), false, 'a second failed call changes nothing (idempotent)');
select is(core.act_reconcile_verified('PKG', (select id from ids where k = 'old'), 'gmail-late', 'already_applied'), false, 'a failed action is not verified afterwards (one transition only)');
select throws_ok(format($$select core.act_reconcile_failed('PKG', %L, 'x', 'error')$$, (select id from ids where k = 'veryold')), '22023', 'act: invalid outcome', 'only mismatch / outcome_unknown are accepted');
select throws_ok(format($$select core.act_reconcile_verified('PKG', %L, '', 'accepted')$$, (select id from ids where k = 'veryold')), '22023', 'act: invalid outcome', 'an external id is required to verify');
-- CROSS-LANE: the APK action cannot be touched through lane PKG, and PKG ids cannot be touched through APK.
select is(core.act_reconcile_failed('PKG', (select id from ids where k = 'apk'), 'marker_not_found', 'outcome_unknown'), false, 'CROSS-LANE: another lane''s action is not changed through this lane');
select is(core.act_reconcile_failed('APK', (select id from ids where k = 'veryold'), 'marker_not_found', 'outcome_unknown'), false, 'CROSS-LANE: a PKG action is not changed through APK');
reset role;

select is((select status || ':' || failure_code from act.proposed_actions where id = (select id from ids where k = 'old')), 'failed:marker_not_found', 'the failed action carries the code');
select is((select (payload ? 'bodyText')::text || ':' || (payload_purged_at is not null)::text from act.proposed_actions where id = (select id from ids where k = 'old')), 'false:true', 'D-19: the body is purged with the terminal transition');
select is((select status || ':' || (result ->> 'external_id') || ':' || (result ->> 'reconciled') from act.proposed_actions where id = (select id from ids where k = 'sent')), 'verified:gmail-sent-1:true', 'the verified action records the id and that it was reconciled');
select is((select count(*)::int from act.execution_claims where action_id in (select id from ids)), 5, 'still exactly one claim per action: the reconciler never creates a claim');
select is((select outcome from act.execution_claims where action_id = (select id from ids where k = 'old')), 'outcome_unknown', 'the claim records outcome_unknown');
select is((select count(*)::int from act.status_history where action_id in (select id from ids where k in ('old', 'sent')) and reason like 'reconciler:%' and actor_kind = 'service'), 2, 'each transition is in the history, by the service, reason "reconciler: ..."');

-- L3: never verify a different message than the one the claim recorded.
select pg_temp.executing('other', 'PKG', '00000000-0000-4000-8000-000000001921', 'rec-pkg@example.test', 40);
update act.execution_claims set outcome = 'sent', external_id = 'gmail-recorded' where action_id = (select id from ids where k = 'other');
set local role service_role;
select is(core.act_reconcile_verified('PKG', (select id from ids where k = 'other'), 'gmail-different', 'already_applied'), false, 'a claim that recorded another provider id is not verified with a different one');
select is((select status from core.act_action_state('PKG', (select id from ids where k = 'other'))), 'executing', 'it is still executing');
-- L2: sent but could not be read back: the claim keeps outcome sent.
select is(core.act_reconcile_failed('PKG', (select id from ids where k = 'other'), 'reconcile_sent_unverified', 'sent'), true, 'executing -> failed with the claim still "sent"');
select throws_ok(format($$select core.act_reconcile_failed('PKG', %L, 'reconcile_sent_unverified', 'sent')$$, (select id from ids where k = 'veryold')), '22023', 'act: invalid outcome', 'outcome sent needs a claim that recorded the send');
select is((select status || ':' || coalesce(failure_code, '') from core.act_action_state('PKG', (select id from ids where k = 'other'))), 'failed:reconcile_sent_unverified', 'action_state reports the settled status and code');
select is((select count(*)::int from core.act_action_state('APK', (select id from ids where k = 'other'))), 0, 'CROSS-LANE: action_state of another lane is empty');
reset role;
select is((select outcome || ':' || (finished_at is not null)::text from act.execution_claims where action_id = (select id from ids where k = 'other')), 'sent:true', 'the claim kept "sent" and is finished');

select * from finish();
rollback;
