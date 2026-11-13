-- T-238: core.briefing_claim_refresh, core.job_failures (+ record / clear), core.sync_now_requests (+ sync_now_claim).
-- Covered: shape, RLS and grants (cross-lane denial, AAL1, role, anon); the refresh claim goes through the existing gates (stale,
-- running, cap) and is closed by core.briefing_save; the failure streak (counts, alert once per streak, reset by a success, keys apart,
-- bad codes replaced, lanes apart); the Sync now limit (one per lane per 2 minutes, roles, AAL, lanes).
begin;
select plan(63);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');

-- ---------------------------------------------------------------- shape and grants
select has_column('core', 'job_failures', 'lane_id', 'job_failures has lane_id');
select col_not_null('core', 'job_failures', 'lane_id', 'job_failures.lane_id is not null');
select pg_temp.has_standard_lane_policy('core.job_failures', 'health');
select has_column('core', 'sync_now_requests', 'lane_id', 'sync_now_requests has lane_id');
select pg_temp.has_standard_lane_policy('core.sync_now_requests', 'health');
select ok(not has_table_privilege('service_role', 'core.job_failures', 'insert, update, delete') and not has_table_privilege('service_role', 'core.sync_now_requests', 'insert, update, delete'), 'service_role writes only through the functions');
select ok(has_function_privilege('service_role', 'core.job_failure_record(text, text, text, text)', 'execute') and has_function_privilege('service_role', 'core.job_failure_clear(text, text, text)', 'execute')
          and has_function_privilege('service_role', 'core.briefing_claim_refresh(text, uuid)', 'execute') and has_function_privilege('service_role', 'core.briefing_claim_refresh_close(text, uuid, text)', 'execute'), 'service_role: record, clear, refresh claim and close');
select ok(not has_function_privilege('authenticated', 'core.job_failure_record(text, text, text, text)', 'execute') and not has_function_privilege('authenticated', 'core.job_failure_clear(text, text, text)', 'execute')
          and not has_function_privilege('authenticated', 'core.briefing_claim_refresh(text, uuid)', 'execute') and not has_function_privilege('authenticated', 'core.briefing_claim_refresh_close(text, uuid, text)', 'execute')
          and not has_function_privilege('anon', 'core.job_failure_record(text, text, text, text)', 'execute') and not has_function_privilege('anon', 'core.briefing_claim_refresh(text, uuid)', 'execute'), 'no API user runs them');
select ok(has_function_privilege('authenticated', 'core.sync_now_claim(text)', 'execute') and not has_function_privilege('anon', 'core.sync_now_claim(text)', 'execute')
          and not has_function_privilege('service_role', 'core.sync_now_claim(text)', 'execute'), 'sync_now_claim: authenticated only');
select ok(coalesce((select bool_and(prosecdef and proconfig = array['search_path=""']) from pg_proc where oid in (
  'core.job_failure_record(text, text, text, text)'::regprocedure, 'core.job_failure_clear(text, text, text)'::regprocedure,
  'core.briefing_claim_refresh(text, uuid)'::regprocedure, 'core.briefing_claim_refresh_close(text, uuid, text)'::regprocedure, 'core.sync_now_claim(text)'::regprocedure)), false), 'definer functions have an empty search_path');

-- ---------------------------------------------------------------- the failure streak
set local role service_role;
select is((select consecutive_failures from core.job_failure_record('PKG', 'mail-ingest-delta', '', 'transient')), 1, 'first failure counts 1');
select is((select alert from core.job_failure_record('PKG', 'mail-ingest-delta', '', 'transient')), false, 'second failure: no alert yet');
select is((select alert from core.job_failure_record('PKG', 'mail-ingest-delta', '', 'timeout')), true, 'third failure alerts');
select is((select alert from core.job_failure_record('PKG', 'mail-ingest-delta', '', 'timeout')), false, 'the fourth does not alert again (once per streak)');
reset role;
select is((select consecutive_failures from core.job_failures where lane_id = 'PKG' and function_id = 'mail-ingest-delta' and connection_id = ''), 4, 'the count is 4');
select ok((select alerted_at is not null and streak_started_at is not null and last_error_code = 'timeout' and last_success_at is null from core.job_failures where lane_id = 'PKG' and function_id = 'mail-ingest-delta'), 'alerted, streak start and code recorded');
set local role service_role;
select is((select consecutive_failures from core.job_failure_record('PKG', 'cal-ingest-delta', '', 'transient')), 1, 'another function has its own streak');
select is((select consecutive_failures from core.job_failure_record('PKG', 'conn-sync', '00000000-0000-4000-8000-0000000b0001', 'reconnect_required')), 1, 'a connection has its own streak');
select is((select consecutive_failures from core.job_failure_record('PKG', 'conn-sync', '00000000-0000-4000-8000-0000000b0002', 'reconnect_required')), 1, 'another connection too');
select is((select consecutive_failures from core.job_failure_record('PKG', 'x-job', null, 'Bad Code <script>')), 1, 'a null connection is the whole lane');
reset role;
select is((select last_error_code from core.job_failures where function_id = 'x-job'), 'failed', 'a code that is not a short code is replaced by "failed"');
set local role service_role;
select lives_ok($$select core.job_failure_clear('PKG', 'mail-ingest-delta', '')$$, 'a success clears the streak');
reset role;
select ok((select consecutive_failures = 0 and alerted_at is null and streak_started_at is null and last_success_at is not null from core.job_failures where function_id = 'mail-ingest-delta'), 'reset: count 0, alert cleared, success time set');
set local role service_role;
select is((select alert from core.job_failure_record('PKG', 'mail-ingest-delta', '', 'transient')), false, 'after a reset the streak starts again at 1');
select is((select consecutive_failures from core.job_failure_record('PKG', 'mail-ingest-delta', '', 'transient')), 2, 'and counts 2');
select is((select alert from core.job_failure_record('PKG', 'mail-ingest-delta', '', 'transient')), true, 'and alerts again at 3 (a new streak)');
select lives_ok($$select core.job_failure_clear('PKG', 'never-failed', '')$$, 'clearing a key that never failed is fine');
select throws_ok($$select core.job_failure_record('ZZ', 'mail-ingest-delta', '', 'x')$$, '22023', null, 'an unknown lane is refused');
select throws_ok($$select core.job_failure_record('PKG', 'f', 'not-a-uuid', 'x')$$, '23514', null, 'a connection id that is not a uuid is refused');
select throws_ok($$select core.job_failure_record('PKG', 'Bad Name!', '', 'x')$$, '23514', null, 'a function id that is not a plain id is refused');
reset role;
select is((select count(*)::int from core.job_failures where lane_id = 'PKG' and function_id = 'never-failed'), 0, 'a key that never failed gets no row');
select lives_ok($$select * from core.job_failure_record('APK', 'mail-ingest-delta', '', 'transient')$$, 'APK has its own row (lane isolation)');

-- ---------------------------------------------------------------- reads
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select ok((select count(*) > 0 and bool_and(lane_id = 'PKG') from core.job_failures), 'admin_technical reads PKG rows and no APK row');
select throws_ok($$insert into core.job_failures (lane_id, function_id) values ('PKG', 'x')$$, '42501', null, 'authenticated cannot insert');
select throws_ok($$update core.job_failures set consecutive_failures = 0$$, '42501', null, 'authenticated cannot update');
select throws_ok($$select core.job_failure_clear('PKG', 'mail-ingest-delta', '')$$, '42501', null, 'authenticated cannot call clear');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.job_failures), 0, 'finance_operator reads none');
reset role;
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.job_failures), 0, 'cross-lane denial: a non-member reads none');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.job_failures), 0, 'AAL1 reads none');
reset role;
set local role anon;
select throws_ok($$select function_id from core.job_failures$$, '42501', null, 'anon is denied');
reset role;

-- ---------------------------------------------------------------- the refresh claim goes through the existing gates
set local role service_role;
select is((select core.briefing_claim_refresh('PKG', pg_temp.uid('owner@example.test')) ->> 'gate'), null, 'no briefing yet: the refresh claim is granted');
select is((select core.briefing_claim_refresh('PKG', pg_temp.uid('owner@example.test')) ->> 'gate'), 'running', 'a second one while the first is open: running');
select throws_ok($$select core.briefing_claim_refresh('PKG', pg_temp.uid('finance-operator@example.test'))$$, '42501', null, 'a non-owner is refused');
select throws_ok($$select core.briefing_claim_refresh('PKG', pg_temp.uid('outsider@example.test'))$$, '42501', null, 'a non-member is refused');
select throws_ok($$select core.briefing_claim_refresh('APK', pg_temp.uid('owner@example.test'))$$, '42501', null, 'cross-lane: an owner of another lane only is refused');
-- The job saves, then finishes its claim; the briefing is then fresh (3 h): the next refresh says not_stale.
select isnt(core.briefing_save('PKG', pg_temp.uid('owner@example.test'), 'schedule', 'ready', now() - interval '1 day', now(), '{"lines": ["x"]}', '[]', '[]', 'mock'), null, 'the job saves');
select is(core.briefing_claim_refresh_close('PKG', pg_temp.uid('owner@example.test'), 'done'), 1, 'the job finishes its claim');
select is(core.briefing_claim_refresh_close('PKG', pg_temp.uid('owner@example.test'), 'done'), 0, 'a second close finds nothing open');
select throws_ok($$select core.briefing_claim_refresh_close('PKG', pg_temp.uid('owner@example.test'), 'nonsense')$$, '22023', null, 'a status that is not done, failed or lost is refused');
select is((select core.briefing_claim_refresh('PKG', pg_temp.uid('owner@example.test')) ->> 'gate'), 'not_stale', 'a fresh briefing: not_stale, no run');
reset role;
select is((select status from brief.briefing_runs where lane_id = 'PKG' and kind = 'auto' order by started_at limit 1), 'done', 'the refresh claim is closed');
-- Cap: fill the day with claims; the refresh is refused with cap_reached once the latest briefing is old.
update brief.briefings set prepared_at = now() - interval '4 hours' where lane_id = 'PKG';
update brief.briefing_runs set status = 'done', finished_at = now() - interval '3 hours', started_at = now() - interval '3 hours' where lane_id = 'PKG';
insert into brief.briefing_runs (lane_id, owner_user_id, kind, status, started_at, finished_at)
  select 'PKG', pg_temp.uid('owner@example.test'), 'schedule', 'done', now() - interval '3 hours', now() - interval '3 hours' from generate_series(1, 6);
set local role service_role;
select is((select core.briefing_claim_refresh('PKG', pg_temp.uid('owner@example.test')) ->> 'gate'), 'cap_reached', 'the daily cap of 6 still applies');
reset role;

-- ---------------------------------------------------------------- Sync now limit
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select core.sync_now_claim('PKG') ->> 'ok'), 'true', 'admin_technical: the first Sync now is granted');
select is((select core.sync_now_claim('PKG') ->> 'ok'), 'false', 'a second within 2 minutes is refused');
select ok((select (core.sync_now_claim('PKG') ->> 'retry_after_seconds')::int between 1 and 120), 'with a retry time');
reset role;
update core.sync_now_requests set requested_at = now() - interval '3 minutes' where lane_id = 'PKG';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select core.sync_now_claim('PKG') ->> 'ok'), 'true', 'after 2 minutes the owner may');
select throws_ok($$select core.sync_now_claim('APK')$$, '42501', null, 'cross-lane: not a member of APK');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.sync_now_claim('PKG')$$, '42501', null, 'finance_operator is refused');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal1');
set local role authenticated;
select throws_ok($$select core.sync_now_claim('PKG')$$, '42501', null, 'AAL1 is refused');
reset role;
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.sync_now_claim('PKG')$$, '42501', null, 'a non-member is refused');
select is((select count(*)::int from core.sync_now_requests), 0, 'a non-member reads no request rows');
reset role;
set local role anon;
select throws_ok($$select core.sync_now_claim('PKG')$$, '42501', null, 'anon is refused');
reset role;
select is((select count(*)::int from core.sync_now_requests where lane_id = 'PKG'), 1, 'one row per lane, updated in place');

select * from finish();
rollback;
