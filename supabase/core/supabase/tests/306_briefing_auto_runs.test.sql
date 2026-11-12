-- T-235 part 1: brief.briefing_runs and core.briefing_claim_auto / briefing_claim_regenerate / briefing_claim_schedule /
-- briefing_run_state, plus the claim close in core.briefing_save_own and core.briefing_save.
-- Covered: lane_id + RLS + grants; auto gates (stale, running, cooldown, daily cap of 6 per lane and New York day); Regenerate once per
-- 30 minutes inside the same cap; the schedule claim counts toward the cap but is never refused; a lost claim (> 10 min) is closed as
-- failed in a COMMITTED step even when the claim is then refused; the save closes the claim and skips the 2-minute cooldown only
-- while a claim is open; run state; read denial: other lane, AAL1, same-lane non-owner, outsider, anon.
begin;
select plan(68);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');

-- ---------------------------------------------------------------- shape and grants
select has_column('brief', 'briefing_runs', 'lane_id', 'briefing_runs has lane_id');
select col_not_null('brief', 'briefing_runs', 'lane_id', 'lane_id is not null');
select ok((select relrowsecurity from pg_class where oid = 'brief.briefing_runs'::regclass), 'RLS is on');
select is((select count(*)::int from pg_policy where polrelid = 'brief.briefing_runs'::regclass), 1, 'one policy');
select ok((select polcmd = 'r' and polroles = array[(select oid from pg_roles where rolname = 'authenticated')]::oid[]
                  and pg_get_expr(polqual, polrelid) like '%aal2%' and pg_get_expr(polqual, polrelid) like '%owner_user_id%' and pg_get_expr(polqual, polrelid) like '%briefing%'
           from pg_policy where polrelid = 'brief.briefing_runs'::regclass), 'the policy: SELECT, authenticated, aal2 + briefing view + own rows');
select ok(not has_table_privilege('authenticated', 'brief.briefing_runs', 'insert, update, delete') and not has_table_privilege('anon', 'brief.briefing_runs', 'select')
          and not has_table_privilege('service_role', 'brief.briefing_runs', 'insert, update, delete'), 'no writes for API roles, nothing for anon');
select ok(has_function_privilege('authenticated', 'core.briefing_claim_auto(text)', 'execute') and has_function_privilege('authenticated', 'core.briefing_claim_regenerate(text)', 'execute')
          and has_function_privilege('authenticated', 'core.briefing_run_state(text)', 'execute'), 'authenticated: claim_auto, claim_regenerate, run_state');
select ok(not has_function_privilege('anon', 'core.briefing_claim_auto(text)', 'execute') and not has_function_privilege('anon', 'core.briefing_claim_regenerate(text)', 'execute')
          and not has_function_privilege('anon', 'core.briefing_run_state(text)', 'execute') and not has_function_privilege('anon', 'core.briefing_claim_schedule(text, uuid)', 'execute'), 'anon: none');
select ok(has_function_privilege('service_role', 'core.briefing_claim_schedule(text, uuid)', 'execute') and not has_function_privilege('authenticated', 'core.briefing_claim_schedule(text, uuid)', 'execute'), 'claim_schedule: service_role only');
select ok(not has_function_privilege('authenticated', 'brief.briefing_claim(text, uuid, text)', 'execute') and not has_function_privilege('service_role', 'brief.briefing_claim(text, uuid, text)', 'execute'), 'the internal claim is callable by no API role');
select ok(not has_function_privilege('authenticated', 'brief.briefing_runs_close(text, uuid, text[], text)', 'execute') and has_function_privilege('service_role', 'brief.briefing_runs_close(text, uuid, text[], text)', 'execute'), 'close: service_role only');
select ok(coalesce((select bool_and(prosecdef and proconfig = array['search_path=""']) from pg_proc where oid in (
  'core.briefing_claim_auto(text)'::regprocedure, 'core.briefing_claim_regenerate(text)'::regprocedure, 'core.briefing_claim_schedule(text, uuid)'::regprocedure,
  'core.briefing_run_state(text)'::regprocedure, 'brief.briefing_claim(text, uuid, text)'::regprocedure, 'brief.briefing_runs_close(text, uuid, text[], text)'::regprocedure)), false),
  'every new function is definer with an empty search_path');

-- ---------------------------------------------------------------- auto: stale, running, cooldown
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select core.briefing_claim_auto('PKG') ->> 'gate'), null, 'no briefing yet: stale, claimed');
select ok((select running from core.briefing_run_state('PKG')), 'run state: running');
select is((select core.briefing_claim_auto('PKG') ->> 'gate'), 'running', 'a second claim while one is open: running');
reset role;
select is((select count(*)::int from brief.briefing_runs where lane_id = 'PKG' and kind = 'auto' and status = 'running'), 1, 'one open auto claim');

-- The run saves through save_own: the 2-minute cooldown is not applied while a claim is open (a briefing prepared a minute ago exists).
set local role service_role;
select isnt(core.briefing_save('PKG', pg_temp.uid('owner@example.test'), 'schedule', 'ready', now() - interval '1 day', now() - interval '1 hour', '{"lines": ["old"]}', '[]', '[]', 'mock'), null, 'an older briefing (1 minute ago after the update below)');
reset role;
update brief.briefings set prepared_at = now() - interval '1 minute' where lane_id = 'PKG';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select isnt(core.briefing_save_own('PKG', 'ready', now() - interval '1 day', now(), '{"lines": ["new"]}', '[]', '[]', 'mock'), null, 'save_own with an open claim: no cooldown refusal');
reset role;
select is((select status from brief.briefing_runs where lane_id = 'PKG' and kind = 'auto'), 'done', 'the save closed the claim (done)');
select ok((select finished_at is not null from brief.briefing_runs where lane_id = 'PKG' and kind = 'auto'), 'with a finish time');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.briefing_save_own('PKG', 'ready', now() - interval '1 day', now(), '{}', '[]', '[]', 'mock')$$, 'P0001', 'too_soon', 'without an open claim the 2-minute cooldown still applies');
select is((select core.briefing_claim_auto('PKG') ->> 'gate'), 'not_stale', 'a fresh briefing: not stale');
reset role;

-- Stale again (4 h) but an auto run started a moment ago: cooldown; after 11 minutes it claims again.
update brief.briefings set prepared_at = now() - interval '4 hours' where lane_id = 'PKG';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select core.briefing_claim_auto('PKG') ->> 'gate'), 'cooldown', 'stale, but an auto run started within 10 minutes: cooldown');
reset role;
update brief.briefing_runs set started_at = started_at - interval '11 minutes', finished_at = finished_at - interval '11 minutes';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select isnt((select core.briefing_claim_auto('PKG') ->> 'id'), null, 'stale and 11 minutes since the last run: claimed');
reset role;

-- A failed save closes the claim as failed.
update brief.briefings set prepared_at = now() - interval '5 minutes' where lane_id = 'PKG';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select isnt(core.briefing_save_own('PKG', 'failed', now() - interval '1 day', now(), '{"notes": ["fail:timeout"]}', '[]', '[]', 'mock'), null, 'a failed briefing is saved');
reset role;
select is((select status from brief.briefing_runs where lane_id = 'PKG' order by started_at desc limit 1), 'failed', 'the claim closes as failed');

-- ---------------------------------------------------------------- the daily cap (auto + regenerate + manual + schedule)
delete from brief.briefing_runs;
delete from brief.briefings;
insert into brief.briefing_runs (lane_id, owner_user_id, kind, started_at, finished_at, status)
select 'PKG', pg_temp.uid('owner@example.test'), k, now() - interval '3 hours', now() - interval '3 hours', 'done'
from unnest(array['auto', 'regenerate', 'manual', 'auto', 'schedule']) k;
select is((select count(*)::int from brief.briefing_runs where lane_id = 'PKG'), 5, 'five runs today');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select runs_today from core.briefing_run_state('PKG')), 5, 'run state counts them');
select isnt((select core.briefing_claim_auto('PKG') ->> 'id'), null, 'the sixth run is allowed');
reset role;
update brief.briefing_runs set started_at = now() - interval '2 hours', finished_at = now() - interval '2 hours', status = 'done' where status = 'running';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select core.briefing_claim_auto('PKG') ->> 'gate'), 'cap_reached', 'the seventh: cap_reached (auto)');
select is((select core.briefing_claim_regenerate('PKG') ->> 'gate'), 'cap_reached', 'the seventh: cap_reached (regenerate)');
select is((select runs_today from core.briefing_run_state('PKG')), 6, 'run state: 6 today');
reset role;
-- The scheduled run counts but is never blocked by the cap.
set local role service_role;
select isnt(core.briefing_claim_schedule('PKG', pg_temp.uid('owner@example.test')), null, 'the scheduled claim is made even at the cap');
reset role;
select is((select count(*)::int from brief.briefing_runs where lane_id = 'PKG' and kind = 'schedule'), 2, 'recorded (counts toward the cap)');
-- A run claimed yesterday (New York day) does not count today.
update brief.briefing_runs set day = day - 1;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select runs_today from core.briefing_run_state('PKG')), 0, 'yesterday''s runs do not count');
reset role;

-- ---------------------------------------------------------------- Regenerate: once per 30 minutes, inside the cap
delete from brief.briefing_runs;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select isnt((select core.briefing_claim_regenerate('PKG') ->> 'id'), null, 'regenerate: claimed even though the briefing is fresh or missing');
select is((select core.briefing_claim_regenerate('PKG') ->> 'gate'), 'running', 'a second one while it runs: running');
reset role;
update brief.briefing_runs set started_at = now() - interval '5 minutes', finished_at = now() - interval '4 minutes', status = 'done';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select core.briefing_claim_regenerate('PKG') ->> 'gate'), 'rate_limited', 'five minutes later: rate_limited');
select ok((select last_regenerate_at is not null from core.briefing_run_state('PKG')), 'run state tells when the last Regenerate started');
reset role;
update brief.briefing_runs set started_at = now() - interval '31 minutes', finished_at = now() - interval '30 minutes';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select isnt((select core.briefing_claim_regenerate('PKG') ->> 'id'), null, '31 minutes later: claimed');
reset role;

-- ---------------------------------------------------------------- a lost claim is closed in a committed step, even when the claim is then refused
delete from brief.briefing_runs;
insert into brief.briefing_runs (lane_id, owner_user_id, kind, started_at) values ('PKG', pg_temp.uid('owner@example.test'), 'auto', now() - interval '11 minutes');
insert into brief.briefing_runs (lane_id, owner_user_id, kind, started_at, finished_at, status)
select 'PKG', pg_temp.uid('owner@example.test'), 'auto', now() - interval '1 hour', now() - interval '1 hour', 'done' from generate_series(1, 5);
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select core.briefing_claim_auto('PKG') ->> 'gate'), 'cap_reached', 'refused at the cap (6 today including the lost one)');
reset role;
select is((select status from brief.briefing_runs where kind = 'auto' and started_at < now() - interval '10 minutes' and finished_at is not null and status = 'failed' limit 1), 'failed', 'the lost claim was closed as failed by the same call');
select is((select count(*)::int from brief.briefing_runs where status = 'running'), 0, 'nothing is left running');

-- ---------------------------------------------------------------- the job's save closes a scheduled claim
delete from brief.briefing_runs;
set local role service_role;
select isnt(core.briefing_claim_schedule('PKG', pg_temp.uid('owner@example.test')), null, 'schedule claim');
select isnt(core.briefing_save('PKG', pg_temp.uid('owner@example.test'), 'schedule', 'ready', now() - interval '1 day', now(), '{"lines": ["x"]}', '[]', '[]', 'mock'), null, 'the job saves');
reset role;
select is((select status from brief.briefing_runs where kind = 'schedule'), 'done', 'the scheduled claim is closed by the save');

-- ---------------------------------------------------------------- reads and denial
delete from brief.briefing_runs;
delete from brief.briefings;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select isnt((select core.briefing_claim_auto('PKG') ->> 'id'), null, 'owner claims');
select is((select count(*)::int from brief.briefing_runs), 1, 'the owner reads their own run');
reset role;

select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select throws_ok($$select core.briefing_claim_auto('PKG')$$, '42501', 'not allowed', 'AAL1: claim_auto refused');
select throws_ok($$select core.briefing_claim_regenerate('PKG')$$, '42501', 'not allowed', 'AAL1: claim_regenerate refused');
select is((select count(*)::int from core.briefing_run_state('PKG')), 0, 'AAL1: no run state');
select is((select count(*)::int from brief.briefing_runs), 0, 'AAL1: reads nothing');
reset role;

select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.briefing_claim_auto('PKG')$$, '42501', 'not allowed', 'same-lane non-owner: claim_auto refused');
select throws_ok($$select core.briefing_claim_regenerate('PKG')$$, '42501', 'not allowed', 'same-lane non-owner: claim_regenerate refused');
select is((select count(*)::int from core.briefing_run_state('PKG')), 0, 'same-lane non-owner: no run state');
select is((select count(*)::int from brief.briefing_runs), 0, 'same-lane non-owner: reads nothing');
reset role;

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.briefing_claim_auto('APK')$$, '42501', 'not allowed', 'other lane (no membership there): claim_auto refused');
select throws_ok($$select core.briefing_claim_regenerate('APK')$$, '42501', 'not allowed', 'other lane: claim_regenerate refused');
select is((select count(*)::int from core.briefing_run_state('APK')), 0, 'other lane: no run state');
select is((select count(*)::int from brief.briefing_runs where lane_id = 'APK'), 0, 'other lane: reads nothing');
reset role;

select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.briefing_claim_auto('PKG')$$, '42501', 'not allowed', 'outsider: refused');
select is((select count(*)::int from brief.briefing_runs), 0, 'outsider: reads nothing');
reset role;

set local role anon;
select throws_ok($$select core.briefing_claim_auto('PKG')$$, '42501', null, 'anon: claim_auto refused');
select throws_ok($$select core.briefing_run_state('PKG')$$, '42501', null, 'anon: run state refused');
select throws_ok($$select count(*) from brief.briefing_runs$$, '42501', null, 'anon: table refused');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.briefing_claim_schedule('PKG', gen_random_uuid())$$, '42501', null, 'authenticated cannot call the schedule claim');
select throws_ok($$insert into brief.briefing_runs (lane_id, owner_user_id, kind) values ('PKG', gen_random_uuid(), 'auto')$$, '42501', null, 'no direct insert');
reset role;
set local role service_role;
select throws_ok($$select core.briefing_claim_schedule('PKG', gen_random_uuid())$$, '42501', 'not allowed', 'the schedule claim re-checks the owner');
reset role;

select * from finish();
rollback;
