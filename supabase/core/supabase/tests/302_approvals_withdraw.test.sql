-- T-234 part 0 re-review: act.withdraw_proposed / core.act_withdraw_proposed.
-- Covered: grants (service_role only), a pending JOB proposal is withdrawn (invalidated, body purged, history reason
-- "withdrawn: ..." by the service), a second call is false (idempotent), an approved action, a person's own proposal and an
-- unknown id are never touched, CROSS-LANE denial (another lane's id through this lane), reason validation.
begin;
select plan(13);
\ir helpers/lane_rls.psql

create temp table ids (k text primary key, id uuid);
grant all on ids to public;
update core.lanes set enabled = true where code = 'APK';
update core.lane_policies set store_outbound_drafts = true, write_actions_allowed = array['email_send', 'email_draft'] where lane_id in ('PKG', 'APK');
insert into core.connections (id, lane_id, provider, external_account_id, status, features) values
  ('00000000-0000-4000-8000-000000001931', 'PKG', 'google', 'wd-pkg@example.test', 'active', '{"gmail_compose": true}'),
  ('00000000-0000-4000-8000-000000001932', 'APK', 'google', 'wd-apk@example.test', 'active', '{"gmail_compose": true}');
create function pg_temp.mk(p_k text, p_lane text, p_conn uuid, p_kind text) returns void language plpgsql as $$
declare v_id uuid;
begin
  v_id := act.propose(p_lane, 'email.send', p_conn, jsonb_build_object('mailbox', 'x@example.test'),
    jsonb_build_object('fromMailbox', 'x@example.test', 'to', jsonb_build_array('dana@sender.example.test'), 'cc', '[]'::jsonb, 'bcc', '[]'::jsonb, 'subject', 'S', 'bodyText', 'CANARY body text'),
    1, encode(sha256(convert_to('wd-' || p_k, 'utf8')), 'hex'), null, '[]', p_kind, case when p_kind = 'user' then pg_temp.uid('owner@example.test') else null end, false);
  insert into ids values (p_k, v_id);
end;
$$;
select pg_temp.mk('job', 'PKG', '00000000-0000-4000-8000-000000001931', 'job');
select pg_temp.mk('job2', 'PKG', '00000000-0000-4000-8000-000000001931', 'job');
select pg_temp.mk('user', 'PKG', '00000000-0000-4000-8000-000000001931', 'user');
select pg_temp.mk('apkjob', 'APK', '00000000-0000-4000-8000-000000001932', 'job');
select pg_temp.mk('approved', 'PKG', '00000000-0000-4000-8000-000000001931', 'job');
update act.proposed_actions set status = 'approved', approved_by = pg_temp.uid('owner@example.test'), approved_at = now(), approved_hash = payload_sha256 where id = (select id from ids where k = 'approved');

select ok(has_function_privilege('service_role', 'core.act_withdraw_proposed(text, uuid, text)', 'execute'), 'service_role may withdraw');
select ok(not has_function_privilege('authenticated', 'core.act_withdraw_proposed(text, uuid, text)', 'execute')
          and not has_function_privilege('authenticated', 'act.withdraw_proposed(text, uuid, text)', 'execute')
          and not has_function_privilege('anon', 'core.act_withdraw_proposed(text, uuid, text)', 'execute'), 'authenticated and anon may not');

set local role service_role;
select is(core.act_withdraw_proposed('PKG', (select id from ids where k = 'job'), 'briefing run timed out'), true, 'a pending job proposal is withdrawn');
select is(core.act_withdraw_proposed('PKG', (select id from ids where k = 'job'), 'briefing run timed out'), false, 'a second call is false (idempotent)');
select is(core.act_withdraw_proposed('PKG', (select id from ids where k = 'approved'), 'briefing run timed out'), false, 'an approved action is never touched');
select is(core.act_withdraw_proposed('PKG', (select id from ids where k = 'user'), 'briefing run timed out'), false, 'a person''s own proposal is never touched');
select is(core.act_withdraw_proposed('PKG', gen_random_uuid(), 'briefing run timed out'), false, 'unknown id: false');
select is(core.act_withdraw_proposed('PKG', (select id from ids where k = 'apkjob'), 'briefing run timed out'), false, 'cross-lane: another lane''s proposal through this lane is false');
select throws_ok($$select core.act_withdraw_proposed('PKG', (select id from ids where k = 'job2'), '   ')$$, '22023', null, 'a reason is required');
reset role;

select is((select status || ':' || (payload_purged_at is not null)::text from act.proposed_actions where id = (select id from ids where k = 'job')), 'invalidated:true', 'withdrawn: invalidated and the body purged');
select is((select count(*)::int from act.status_history where action_id = (select id from ids where k = 'job') and reason = 'withdrawn: briefing run timed out' and actor_kind = 'service'), 1, 'the history says who and why');
select is((select status from act.proposed_actions where id = (select id from ids where k = 'apkjob')), 'proposed', 'the APK proposal is still pending');
select is((select status from act.proposed_actions where id = (select id from ids where k = 'approved')), 'approved', 'the approved action is still approved');

select * from finish();
rollback;
