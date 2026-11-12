-- GovCon news (T-234 part 4): the `web` category, brief.news_digests, core.news_begin_* / news_finish* / news_latest / news_spend, retention.
-- Covered: the category constraint keeps every earlier category and accepts web; web is not an assistant tool category (gate refuses it,
-- chat does not count it); grants; lane gates (web category + news.enabled); the once-a-day schedule; the in-flight guard; the 1-per-hour
-- owner refresh; the monthly cap read from lane_config and last month not counted; lost attempts closed as timed_out; item shape (https,
-- size, count); finished rows are final; reads (members with the briefing view) and denial: other lane, AAL1, outsider, admin_technical
-- (spend only), anon; the owner-only refresh; retention floor and the current month kept.
begin;
select plan(125);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
-- A same-lane viewer who holds the briefing view (grantable by name).
update core.memberships set views = array['briefing'] where lane_id = 'PKG' and user_id = pg_temp.uid('viewer@example.test') and 'briefing' = any (core.viewer_view_names());
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');
update core.lane_policies set llm_allowed_categories = array['email', 'calendar', 'docs', 'finance', 'tasks', 'brain_import', 'web'] where lane_id in ('PKG', 'APK');
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{news}', '{"enabled": true, "monthly_cap_usd": 5}'::jsonb)
from core.lane_config where lane_id = 'PKG' order by version desc limit 1;
insert into core.lane_config (lane_id, version, config)
values ('APK', coalesce((select max(version) from core.lane_config where lane_id = 'APK'), 0) + 1, '{"news": {"enabled": true}}'::jsonb);

create function pg_temp.items(n int, url text default 'https://www.acquisition.gov/far-overhaul') returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('headline', 'Headline ' || i, 'why', 'Matters for the lane', 'source_name', 'acquisition.gov',
                                               'source_url', url, 'published_at', '2026-11-12T10:00:00Z', 'citations', jsonb_build_array(url))), '[]'::jsonb)
  from generate_series(1, n) i;
$$;
-- Ages every row of a lane (test only: the guard trigger is off for the update).
create function pg_temp.age(p_lane text, p_interval interval) returns void language plpgsql as $$
begin
  alter table brief.news_digests disable trigger news_digests_guard;
  update brief.news_digests set created_at = created_at - p_interval, fetched_at = fetched_at - p_interval, day = (created_at - p_interval)::date where lane_id = p_lane;
  alter table brief.news_digests enable trigger news_digests_guard;
end;
$$;

-- Ages the ATTEMPTS of a lane by a short interval without touching their New York day (test only).
create function pg_temp.age_attempts(p_lane text, p_interval interval) returns void language plpgsql as $$
begin
  alter table brief.news_digests disable trigger news_digests_guard;
  update brief.news_digests set created_at = created_at - p_interval, fetched_at = fetched_at - p_interval where lane_id = p_lane;
  alter table brief.news_digests enable trigger news_digests_guard;
end;
$$;
-- One item with overrides.
create function pg_temp.item1(p_over jsonb) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('headline', 'Headline', 'why', 'Matters', 'source_name', 'acquisition.gov',
    'source_url', 'https://www.acquisition.gov/x', 'published_at', '2026-11-12T10:00:00Z', 'citations', '[]'::jsonb) || p_over);
$$;

-- ---------------------------------------------------------------- the category
select has_column('brief', 'news_digests', 'lane_id', 'news_digests has lane_id');
select ok((select relrowsecurity from pg_class where oid = 'brief.news_digests'::regclass), 'RLS is on');
select lives_ok($$update core.lane_policies set llm_allowed_categories = array['email', 'calendar', 'docs', 'finance', 'finance_summary', 'tasks', 'brain_import', 'web'] where lane_id = 'APK'$$,
  'the constraint accepts web and keeps every earlier category');
select throws_ok($$update core.lane_policies set llm_allowed_categories = array['email', 'web_fetch'] where lane_id = 'APK'$$, '23514', null, 'an unknown category is still refused');
update core.lane_policies set llm_allowed_categories = array['email', 'calendar', 'docs', 'finance', 'tasks', 'brain_import', 'web'] where lane_id = 'APK';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.ai_tool_gate('PKG', 'finance', 'web')$$, '22023', 'invalid category', 'web is not an assistant tool category: the gate refuses it');
reset role;
update core.lane_policies set llm_allowed_categories = array['web'] where lane_id = 'PKG';
set local role authenticated;
select is((core.ai_chat_turn('PKG') ->> 'allowed')::boolean, false, 'a lane with only web does not open the chat');
reset role;
update core.lane_policies set llm_allowed_categories = array['email', 'calendar', 'docs', 'finance', 'tasks', 'brain_import'] where lane_id = 'PKG';

-- ---------------------------------------------------------------- grants
select ok(not has_table_privilege('authenticated', 'brief.news_digests', 'insert') and not has_table_privilege('authenticated', 'brief.news_digests', 'update')
          and not has_table_privilege('authenticated', 'brief.news_digests', 'delete'), 'authenticated has no write on the table');
select ok(not has_table_privilege('anon', 'brief.news_digests', 'select'), 'anon has no select');
select ok(has_function_privilege('service_role', 'core.news_begin_scheduled(text, numeric)', 'execute')
          and not has_function_privilege('authenticated', 'core.news_begin_scheduled(text, numeric)', 'execute')
          and not has_function_privilege('anon', 'core.news_begin_scheduled(text, numeric)', 'execute'), 'begin_scheduled: service_role only');
select ok(has_function_privilege('service_role', 'core.news_finish(text, uuid, text, text, jsonb, integer, numeric)', 'execute')
          and not has_function_privilege('authenticated', 'core.news_finish(text, uuid, text, text, jsonb, integer, numeric)', 'execute'), 'finish: service_role only');
select ok(has_function_privilege('authenticated', 'core.news_begin_refresh(text, numeric)', 'execute')
          and not has_function_privilege('service_role', 'core.news_begin_refresh(text, numeric)', 'execute')
          and not has_function_privilege('anon', 'core.news_begin_refresh(text, numeric)', 'execute'), 'begin_refresh: authenticated only');
select ok(has_function_privilege('authenticated', 'core.news_finish_own(text, uuid, text, text, jsonb, integer, numeric)', 'execute')
          and not has_function_privilege('anon', 'core.news_finish_own(text, uuid, text, text, jsonb, integer, numeric)', 'execute'), 'finish_own: authenticated, not anon');
select ok(not has_function_privilege('authenticated', 'brief.news_reserve(text, text, uuid, numeric)', 'execute')
          and not has_function_privilege('authenticated', 'brief.news_purge(text, interval)', 'execute')
          and not has_function_privilege('authenticated', 'core.news_purge(text, integer)', 'execute')
          and not has_function_privilege('authenticated', 'brief.news_cap(text)', 'execute') and not has_function_privilege('service_role', 'brief.news_cap(text)', 'execute'), 'the reserve, the cap helper and the purge are not callable by authenticated');

-- ---------------------------------------------------------------- lane gates (service_role, the job)
set local role service_role;
select is(core.news_begin_scheduled('PKG', 3) ->> 'gate', 'not_configured', 'no web category: refused before any model call');
reset role;
update core.lane_policies set llm_allowed_categories = llm_allowed_categories || array['web'] where lane_id = 'PKG';
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{news,enabled}', 'false'::jsonb) from core.lane_config where lane_id = 'PKG' order by version desc limit 1;
set local role service_role;
select is(core.news_begin_scheduled('PKG', 3) ->> 'gate', 'not_configured', 'web category but news.enabled false: refused');
reset role;
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{news,enabled}', 'true'::jsonb) from core.lane_config where lane_id = 'PKG' order by version desc limit 1;
set local role service_role;
select throws_ok($$select core.news_begin_scheduled('PKG', 0)$$, '22023', null, 'a zero reserve is refused');
select throws_ok($$select core.news_begin_scheduled('NOPE', 1)$$, '22023', null, 'a malformed lane is refused');

-- ---------------------------------------------------------------- the scheduled run: once a day, one in flight
select isnt(core.news_begin_scheduled('PKG', 1.5) ->> 'id', null, 'the schedule reserves an attempt');
select is(core.news_begin_scheduled('PKG', 1.5) ->> 'gate', 'already_fetched', 'a second scheduled attempt today is refused (the first is pending)');
reset role;
select is((select est_cost from brief.news_digests where lane_id = 'PKG' and status = 'pending'), 1.50::numeric, 'the reserve is stored as the cost while pending');
set local role service_role;
select throws_ok(format($$select core.news_finish('PKG', %L, 'ok', null, %L::jsonb, 1, 0.5)$$, (select id from brief.news_digests where lane_id = 'PKG' and status = 'pending'), pg_temp.items(1, 'http://insecure.example.test/x')::text),
  '23514', null, 'an http link is refused');
select throws_ok(format($$select core.news_finish('PKG', %L, 'ok', null, %L::jsonb, 1, 0.5)$$, (select id from brief.news_digests where lane_id = 'PKG' and status = 'pending'), pg_temp.items(7)::text),
  '23514', null, 'more than 6 items are refused');
select throws_ok(format($$select core.news_finish('PKG', %L, 'ok', null, '[]'::jsonb, 1, 0.5)$$, (select id from brief.news_digests where lane_id = 'PKG' and status = 'pending')),
  '23514', null, 'an ok digest needs items');
select throws_ok(format($$select core.news_finish('PKG', %L, 'ok', null, '[{"headline": "x"}]'::jsonb, 1, 0.5)$$, (select id from brief.news_digests where lane_id = 'PKG' and status = 'pending')),
  '23514', null, 'an item without why / source / link is refused');
select lives_ok(format($$select core.news_finish('PKG', %L, 'ok', null, %L::jsonb, 2, 1.25)$$, (select id from brief.news_digests where lane_id = 'PKG' and status = 'pending'), pg_temp.items(5)::text),
  'finish stores the items and the actual estimate');
select throws_ok(format($$select core.news_finish('PKG', %L, 'failed', 'x', '[]'::jsonb, 0, 0)$$, (select id from brief.news_digests where lane_id = 'PKG' and status = 'ok')),
  'P0001', 'not_pending', 'a finished digest cannot be finished again');
select is(core.news_begin_scheduled('PKG', 1) ->> 'gate', 'already_fetched', 'today already has a digest: no second scheduled fetch');
reset role;
select throws_ok($$update brief.news_digests set items = '[]' where lane_id = 'PKG'$$, '23514', null, 'a finished digest is final even for the table owner');

-- ---------------------------------------------------------------- the owner refresh: aal2 owner only, one per hour
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select throws_ok($$select core.news_begin_refresh('PKG', 1)$$, '42501', null, 'AAL1: refresh refused');
reset role;
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.news_begin_refresh('PKG', 1)$$, '42501', null, 'a viewer cannot refresh');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.news_begin_refresh('PKG', 1)$$, '42501', null, 'a finance operator cannot refresh');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.news_begin_refresh('APK', 1)$$, '42501', null, 'cross-lane: the PKG owner cannot refresh APK');
select isnt(core.news_begin_refresh('PKG', 0.75) ->> 'id', null, 'the owner refreshes');
select is(core.news_begin_refresh('PKG', 1) ->> 'gate', 'busy', 'one in flight at a time');
select lives_ok(format($$select core.news_finish_own('PKG', %L, 'ok', null, %L::jsonb, 1, 0.75)$$, (select id from brief.news_digests where lane_id = 'PKG' and status = 'pending'), pg_temp.items(4)::text),
  'the owner finishes their own refresh');
reset role;
select is((select est_cost from brief.news_digests where trigger = 'refresh' and status = 'ok'), 0.75::numeric, 'the refresh keeps its reserve as the cost floor (0.75 reserved, 0.75 reported)');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(core.news_begin_refresh('PKG', 1) ->> 'gate', 'rate_limited', 'a second refresh within the hour is refused (SQL-enforced)');
reset role;
select pg_temp.age('PKG', interval '2 hours');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(core.news_begin_refresh('PKG', 4) ->> 'gate', 'cap_reached', 'month-to-date 2.00 + reserve 4 > cap 5 (from lane_config): refused before any model call');
select isnt(core.news_begin_refresh('PKG', 3) ->> 'id', null, 'month-to-date 2.00 + 3 = 5 is within the cap');
reset role;
select is((select est_cost from brief.news_digests where status = 'pending'), 3.00::numeric, 'the reserve counts against the cap while pending');
set local role authenticated;
select lives_ok(format($$select core.news_finish_own('PKG', %L, 'failed', 'model_failed', '[]'::jsonb, 0, 0.10)$$, (select id from brief.news_digests where status = 'pending')),
  'a failed attempt is stored with its code (the reported 0.10 is below the reserve)');
select is((select month_spend from core.news_spend('PKG')), 5.00::numeric, 'news_spend: month-to-date = 1.25 + 0.75 + 3.00 (the failed refresh reported 0.10 but keeps its 3.00 reserve as the floor)');
select is((select cap_usd from core.news_spend('PKG')), 5::numeric, 'news_spend: the cap comes from lane_config');
select ok((select web_allowed and news_enabled from core.news_spend('PKG')), 'news_spend: configured (web category + news.enabled)');
reset role;

-- last month does not count; a lost attempt is closed as timed_out and keeps its reserve
select pg_temp.age('PKG', interval '40 days');
set local role service_role;
select isnt(core.news_begin_scheduled('PKG', 4.5) ->> 'id', null, 'rows from last month are not in the month-to-date ledger');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
select is((select count(*)::int from brief.news_digests where lane_id = 'PKG' and status = 'pending'), 1, 'one pending (reserved 4.50)');
alter table brief.news_digests disable trigger news_digests_guard;
update brief.news_digests set created_at = created_at - interval '20 minutes' where status = 'pending';
alter table brief.news_digests enable trigger news_digests_guard;
set local role service_role;
select is(core.news_begin_scheduled('PKG', 1) ->> 'gate', 'retry_later', 'the lost scheduled attempt started 20 minutes ago: the next one waits for the 30-minute spacing');
reset role;
select is((select failure_code from brief.news_digests where lane_id = 'PKG' and est_cost = 4.50), 'timed_out', 'the lost attempt was closed (timed_out) even though that reserve was refused: the close commits');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select isnt(core.news_begin_refresh('PKG', 0.5) ->> 'id', null, 'the next successful reserve closes the lost attempt first (4.50 + 0.50 = the cap)');
reset role;
select is((select status from brief.news_digests where lane_id = 'PKG' and est_cost = 4.50), 'failed', 'a lost attempt stays closed as failed with its reserved cost kept');
set local role authenticated;
select lives_ok(format($$select core.news_finish_own('PKG', %L, 'failed', 'model_failed', '[]'::jsonb, 0, 0)$$, (select id from brief.news_digests where status = 'pending')), 'the refresh is closed');
reset role;

-- ---------------------------------------------------------------- reads
set local role service_role;
select isnt(core.news_begin_scheduled('APK', 1) ->> 'id', null, 'APK has its own attempt');
select lives_ok(format($$select core.news_finish('APK', %L, 'ok', null, %L::jsonb, 1, 0.5)$$, (select id from brief.news_digests where lane_id = 'APK' and status = 'pending'), pg_temp.items(4, 'https://apk.example.test/story')::text), 'APK digest stored');
reset role;
-- a fresh PKG digest for the read tests
alter table brief.news_digests disable trigger news_digests_guard;
insert into brief.news_digests (lane_id, trigger, status, items, searches, est_cost, fetched_at, day)
values ('PKG', 'schedule', 'ok', pg_temp.items(5, 'https://www.federalregister.gov/d/2026-1'), 2, 1.00, now(), (now() at time zone 'America/New_York')::date - 1);
alter table brief.news_digests enable trigger news_digests_guard;

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select jsonb_array_length(items) from core.news_latest('PKG')), 5, 'owner: the newest ok digest with its items');
select ok((select next_refresh_at is not null from core.news_latest('PKG')), 'and the time the owner may refresh again (a failed refresh: 5 minutes)');
select is((select count(*)::int from core.news_latest('APK')), 0, 'cross-lane: the PKG owner sees nothing of APK');
select is((select count(*)::int from brief.news_digests where lane_id = 'APK'), 0, 'cross-lane: not through the table either');
reset role;
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select jsonb_array_length(items) from core.news_latest('PKG')), 5, 'a viewer with the briefing view reads the news');
select throws_ok($$select core.news_spend('PKG')$$, '42501', null, 'but not the spend');
select is(core.news_enabled('PKG'), true, 'and sees that news is configured (a boolean only)');
select is(core.news_enabled('APK'), false, 'cross-lane: not configured as far as a PKG-only member can tell');
reset role;
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.news_latest('PKG')), 0, 'AAL1: nothing');
select is((select count(*)::int from brief.news_digests), 0, 'AAL1: nothing from the table');
select is(core.news_enabled('PKG'), false, 'AAL1: news_enabled is false');
select throws_ok($$select core.news_spend('PKG')$$, '42501', null, 'AAL1: no spend');
reset role;
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.news_latest('PKG')), 0, 'outsider: nothing');
select is(core.news_enabled('PKG'), false, 'outsider: news_enabled is false');
select throws_ok($$select core.news_spend('PKG')$$, '42501', null, 'outsider: no spend');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.news_latest('PKG')), 0, 'admin_technical: no items (no content view)');
select ok((select month_spend >= 0 from core.news_spend('PKG')), 'admin_technical reads spend and status only');
select is(core.news_enabled('PKG'), false, 'admin_technical: no briefing view, so news_enabled is false');
reset role;
set local role anon;
select throws_ok($$select core.news_latest('PKG')$$, '42501', null, 'anon cannot call news_latest');
reset role;

-- ---------------------------------------------------------------- retention
set local role service_role;
select throws_ok($$select brief.news_purge('PKG', interval '1 hour')$$, '22023', null, 'purge floor: at least 1 day');
reset role;
select pg_temp.age('PKG', interval '100 days');
insert into brief.news_digests (lane_id, trigger) values ('PKG', 'schedule');
set local role service_role;
select is(brief.news_purge('PKG', interval '30 days'), 6, 'old PKG rows are purged (cap by lane retention), this month''s pending row stays');
select is((select count(*)::int from brief.news_digests where lane_id = 'APK'), 1, 'the purge of PKG leaves APK alone');
reset role;
select is((select count(*)::int from brief.news_digests where lane_id = 'PKG'), 1, 'the current month''s row is kept (spend ledger)');

-- ---------------------------------------------------------------- scheduled retries (H1): a failed morning does not block the day
delete from brief.news_digests where lane_id = 'APK';
set local role service_role;
select isnt(core.news_begin_scheduled('APK', 1) ->> 'id', null, 'retry: the first scheduled attempt of the day');
select lives_ok(format($$select core.news_finish('APK', %L, 'failed', 'model_failed', '[]'::jsonb, 0, 0.2)$$, (select id from brief.news_digests where lane_id = 'APK' and status = 'pending')), 'it fails');
select is(core.news_begin_scheduled('APK', 1) ->> 'gate', 'retry_later', 'retry: not within 30 minutes of the last attempt');
reset role;
select pg_temp.age_attempts('APK', interval '31 minutes');
set local role service_role;
select isnt(core.news_begin_scheduled('APK', 1) ->> 'id', null, 'retry: allowed 31 minutes after the failure');
select lives_ok(format($$select core.news_finish('APK', %L, 'failed', 'timed_out', '[]'::jsonb, 0, 0.2)$$, (select id from brief.news_digests where lane_id = 'APK' and status = 'pending')), 'the retry fails too');
reset role;
select pg_temp.age_attempts('APK', interval '31 minutes');
set local role service_role;
select isnt(core.news_begin_scheduled('APK', 1) ->> 'id', null, 'retry: the third attempt');
select lives_ok(format($$select core.news_finish('APK', %L, 'failed', 'model_failed', '[]'::jsonb, 0, 0.2)$$, (select id from brief.news_digests where lane_id = 'APK' and status = 'pending')), 'the third attempt fails');
reset role;
select pg_temp.age_attempts('APK', interval '31 minutes');
set local role service_role;
select is(core.news_begin_scheduled('APK', 1) ->> 'gate', 'attempts_exhausted', 'retry: 3 scheduled failures today end the day');
reset role;
delete from brief.news_digests where lane_id = 'APK';
set local role service_role;
select isnt(core.news_begin_scheduled('APK', 1) ->> 'id', null, 'no retry after success: first attempt');
select lives_ok(format($$select core.news_finish('APK', %L, 'ok', null, %L::jsonb, 1, 0.2)$$, (select id from brief.news_digests where lane_id = 'APK' and status = 'pending'), pg_temp.items(4)::text), 'it succeeds');
reset role;
select pg_temp.age_attempts('APK', interval '31 minutes');
set local role service_role;
select is(core.news_begin_scheduled('APK', 1) ->> 'gate', 'already_fetched', 'no retry once the day has an ok digest');
reset role;
delete from brief.news_digests where lane_id = 'APK';
set local role service_role;
select isnt(core.news_begin_scheduled('APK', 1) ->> 'id', null, 'no retry after partial: first attempt');
select lives_ok(format($$select core.news_finish('APK', %L, 'partial', null, %L::jsonb, 1, 0.2)$$, (select id from brief.news_digests where lane_id = 'APK' and status = 'pending'), pg_temp.items(2)::text), 'a partial digest');
reset role;
select pg_temp.age_attempts('APK', interval '31 minutes');
set local role service_role;
select is(core.news_begin_scheduled('APK', 1) ->> 'gate', 'already_fetched', 'no retry once the day has a partial digest');
reset role;

-- ---------------------------------------------------------------- the owner refresh limit (L1): ok/partial per hour, a retry 5 minutes after a failure
delete from brief.news_digests where lane_id = 'PKG';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select isnt(core.news_begin_refresh('PKG', 0.5) ->> 'id', null, 'refresh limit: first refresh');
select lives_ok(format($$select core.news_finish_own('PKG', %L, 'failed', 'model_failed', '[]'::jsonb, 0, 0)$$, (select id from brief.news_digests where lane_id = 'PKG' and status = 'pending')), 'it fails');
select is(core.news_begin_refresh('PKG', 0.5) ->> 'gate', 'rate_limited', 'a retry straight after a failure is refused (5 minutes)');
select ok((select next_refresh_at is not null and next_refresh_at < now() + interval '6 minutes' from core.news_latest('PKG')), 'news_latest shows the 5-minute wait');
reset role;
select pg_temp.age_attempts('PKG', interval '6 minutes');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select isnt(core.news_begin_refresh('PKG', 0.5) ->> 'id', null, 'one retry is allowed 6 minutes after a failed refresh');
select lives_ok(format($$select core.news_finish_own('PKG', %L, 'ok', null, %L::jsonb, 1, 0.1)$$, (select id from brief.news_digests where lane_id = 'PKG' and status = 'pending'), pg_temp.items(4)::text), 'the retry succeeds');
reset role;
select pg_temp.age_attempts('PKG', interval '6 minutes');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(core.news_begin_refresh('PKG', 0.5) ->> 'gate', 'rate_limited', 'after an ok refresh the hour applies');
select ok((select next_refresh_at > now() + interval '40 minutes' from core.news_latest('PKG')), 'news_latest shows the hour');
reset role;
select pg_temp.age_attempts('PKG', interval '61 minutes');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select isnt(core.news_begin_refresh('PKG', 0.5) ->> 'id', null, 'and a refresh is allowed again after the hour');
reset role;

-- ---------------------------------------------------------------- write-path gaps (security L4)
-- finish_own refusals. A pending refresh of the PKG owner, a pending scheduled row, a pending refresh of ANOTHER user (APK is closed to the PKG owner).
delete from brief.news_digests;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select isnt(core.news_begin_refresh('PKG', 0.5) ->> 'id', null, 'the owner has a pending refresh');
reset role;
alter table brief.news_digests disable trigger news_digests_guard;
insert into brief.news_digests (id, lane_id, trigger, requested_by) values ('00000000-0000-0000-0000-0000000000a1', 'APK', 'schedule', null);
insert into brief.news_digests (id, lane_id, trigger, requested_by) values ('00000000-0000-0000-0000-0000000000a2', 'PKG', 'refresh', pg_temp.uid('finance-operator@example.test'));
insert into brief.news_digests (id, lane_id, trigger, requested_by) values ('00000000-0000-0000-0000-0000000000a3', 'PKG', 'schedule', null);
alter table brief.news_digests enable trigger news_digests_guard;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.news_finish_own('APK', '00000000-0000-0000-0000-0000000000a1', 'failed', 'x', '[]'::jsonb, 0, 0)$$, '42501', null, 'finish_own: another lane (not a member there) is refused');
select throws_ok($$select core.news_finish_own('PKG', '00000000-0000-0000-0000-0000000000a1', 'failed', 'x', '[]'::jsonb, 0, 0)$$, 'P0001', 'not_pending', 'finish_own: another lane''s row id under my lane finds nothing');
select throws_ok($$select core.news_finish_own('PKG', '00000000-0000-0000-0000-0000000000a2', 'failed', 'x', '[]'::jsonb, 0, 0)$$, 'P0001', 'not_pending', 'finish_own: another user''s refresh is refused');
select throws_ok($$select core.news_finish_own('PKG', '00000000-0000-0000-0000-0000000000a3', 'failed', 'x', '[]'::jsonb, 0, 0)$$, 'P0001', 'not_pending', 'finish_own: a scheduled row is refused');
select throws_ok(format($$select core.news_finish_own('PKG', %L, 'failed', 'x', '[]'::jsonb, 0, -1)$$, (select id from brief.news_digests where lane_id = 'PKG' and requested_by = pg_temp.uid('owner@example.test') and status = 'pending')), '22023', null, 'finish_own: a negative cost is refused');
select throws_ok(format($$select core.news_finish_own('PKG', %L, 'failed', 'x', '[]'::jsonb, 0, 1000.01)$$, (select id from brief.news_digests where lane_id = 'PKG' and requested_by = pg_temp.uid('owner@example.test') and status = 'pending')), '22023', null, 'finish_own: a cost above 1000 is refused');
select throws_ok($$select core.news_begin_refresh('PKG', 100.01)$$, '22023', null, 'a reserve above 100 is refused (refresh)');
reset role;
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.news_finish_own('PKG', '00000000-0000-0000-0000-0000000000a2', 'failed', 'x', '[]'::jsonb, 0, 0)$$, '42501', null, 'finish_own: a non-owner is refused');
reset role;
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select throws_ok($$select core.news_finish_own('PKG', '00000000-0000-0000-0000-0000000000a2', 'failed', 'x', '[]'::jsonb, 0, 0)$$, '42501', null, 'finish_own: AAL1 is refused');
reset role;
set local role service_role;
select throws_ok($$select core.news_begin_scheduled('PKG', 100.01)$$, '22023', null, 'a reserve above 100 is refused (schedule)');
select throws_ok($$select core.news_finish('PKG', '00000000-0000-0000-0000-0000000000a3', 'failed', 'x', '[]'::jsonb, 0, -1)$$, '23514', null, 'finish: a negative cost is refused');
select throws_ok($$select core.news_finish('PKG', '00000000-0000-0000-0000-0000000000a3', 'failed', 'x', '[]'::jsonb, 0, 1000.01)$$, '23514', null, 'finish: a cost above 1000 is refused');
-- item shape limits (on the pending scheduled PKG row a3)
select throws_ok(format($$select core.news_finish('PKG', %L, 'ok', null, %L::jsonb, 1, 0.1)$$, '00000000-0000-0000-0000-0000000000a3', pg_temp.item1(jsonb_build_object('headline', repeat('h', 301)))::text), '23514', null, 'a headline over 300 characters is refused');
select throws_ok(format($$select core.news_finish('PKG', %L, 'ok', null, %L::jsonb, 1, 0.1)$$, '00000000-0000-0000-0000-0000000000a3', pg_temp.item1(jsonb_build_object('why', repeat('w', 401)))::text), '23514', null, 'a why over 400 characters is refused');
select throws_ok(format($$select core.news_finish('PKG', %L, 'ok', null, %L::jsonb, 1, 0.1)$$, '00000000-0000-0000-0000-0000000000a3', pg_temp.item1(jsonb_build_object('source_name', repeat('s', 121)))::text), '23514', null, 'a source name over 120 characters is refused');
select throws_ok(format($$select core.news_finish('PKG', %L, 'ok', null, %L::jsonb, 1, 0.1)$$, '00000000-0000-0000-0000-0000000000a3', pg_temp.item1(jsonb_build_object('source_url', 'https://www.acquisition.gov/' || repeat('p', 2040)))::text), '23514', null, 'a link over 2048 characters is refused');
select throws_ok(format($$select core.news_finish('PKG', %L, 'ok', null, %L::jsonb, 1, 0.1)$$, '00000000-0000-0000-0000-0000000000a3',
  (select jsonb_agg(i) from (select pg_temp.item1(jsonb_build_object('citations', (select jsonb_agg(repeat('c', 2000) || n) from generate_series(1, 6) n)))  -> 0 as i from generate_series(1, 4)) q)::text), '23514', null, 'items over 32 KB in total are refused');
select throws_ok(format($$select core.news_finish('PKG', %L, 'ok', null, %L::jsonb, 1, 0.1)$$, '00000000-0000-0000-0000-0000000000a3', pg_temp.item1(jsonb_build_object('citations', (select jsonb_agg('https://a.example/' || n) from generate_series(1, 7) n)))::text), '23514', null, 'more than 6 citations are refused');
select throws_ok(format($$select core.news_finish('PKG', %L, 'ok', null, %L::jsonb, 1, 0.1)$$, '00000000-0000-0000-0000-0000000000a3', pg_temp.item1(jsonb_build_object('citations', jsonb_build_array(repeat('c', 2049))))::text), '23514', null, 'a citation over 2048 characters is refused');
select throws_ok(format($$select core.news_finish('PKG', %L, 'ok', null, %L::jsonb, 1, 0.1)$$, '00000000-0000-0000-0000-0000000000a3', pg_temp.item1(jsonb_build_object('citations', jsonb_build_array(5)))::text), '23514', null, 'a non-string citation is refused');
select throws_ok(format($$select core.news_finish('PKG', %L, 'ok', null, %L::jsonb, 1, 0.1)$$, '00000000-0000-0000-0000-0000000000a3', pg_temp.item1(jsonb_build_object('source_url', 'https://user:pw@www.acquisition.gov/x'))::text), '23514', null, 'user-info (@) in the link authority is refused');
select throws_ok(format($$select core.news_finish('PKG', %L, 'ok', null, %L::jsonb, 1, 0.1)$$, '00000000-0000-0000-0000-0000000000a3', pg_temp.item1(jsonb_build_object('source_url', 'https://www.acquisition.gov@evil.example/x'))::text), '23514', null, 'a link that hides its real host behind @ is refused');
select throws_ok(format($$select core.news_finish('PKG', %L, 'ok', null, %L::jsonb, 1, 0.1)$$, '00000000-0000-0000-0000-0000000000a3', pg_temp.item1(jsonb_build_object('source_url', 'https://[::1]/x'))::text), '23514', null, 'an IPv6 literal host is refused');
select throws_ok(format($$select core.news_finish('PKG', %L, 'ok', null, %L::jsonb, 1, 0.1)$$, '00000000-0000-0000-0000-0000000000a3', pg_temp.item1(jsonb_build_object('source_url', 'https://10.0.0.5/x'))::text), '23514', null, 'an IPv4 literal host is refused');
select lives_ok(format($$select core.news_finish('PKG', %L, 'ok', null, %L::jsonb, 1, 0.1)$$, '00000000-0000-0000-0000-0000000000a3', pg_temp.item1(jsonb_build_object('preferred', true, 'citations', jsonb_build_array('https://www.acquisition.gov/x')))::text), 'a well-formed item (with the preferred flag and a citation) is stored');
reset role;

select * from finish();
rollback;
