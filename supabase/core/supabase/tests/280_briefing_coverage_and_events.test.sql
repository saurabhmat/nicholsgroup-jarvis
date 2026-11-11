-- Home briefing reads part 1 (T-231a): core.briefing_coverage and core.briefing_events.
-- Covered: privileges, definer/invoker + empty search_path, coverage rows (configured mailbox without a connection is
-- not_connected; connected account with stream sync times and error kind only), per-stream views, events (attendees,
-- zone, cancelled excluded, de-duplicated, window checks), and denial: other lane, AAL1, member without the views,
-- outsider.
begin;
select plan(27);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');
delete from cal.event_index where lane_id in ('PKG', 'APK');

insert into core.connections (id, lane_id, provider, external_account_id, status, last_error) values
  ('00000000-0000-4000-8000-000000002801', 'PKG', 'google', 'brief-pkg@example.test', 'degraded',
   '{"kind": "rate_limited", "message": "provider text that must not leak", "disposition": "retry", "endpoint": null, "http_status": 429, "provider_error_code": null, "provider_tid": null, "retry_after_seconds": null}'::jsonb),
  ('00000000-0000-4000-8000-000000002802', 'APK', 'google', 'brief-apk@example.test', 'active', null);

-- PKG configures two mailboxes: one connected above, one not connected at all.
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{mailboxes}', '["brief-pkg@example.test", "Missing@Example.Test"]'::jsonb)
from core.lane_config where lane_id = 'PKG' order by version desc limit 1;

insert into core.sync_runs (lane_id, connection_id, kind, trigger, status, started_at, finished_at) values
  ('PKG', '00000000-0000-4000-8000-000000002801', 'incremental', 'schedule', 'succeeded', '2026-11-11 10:00Z', '2026-11-11 10:01Z');
insert into core.sync_cursors (lane_id, connection_id, stream, cursor_value, updated_at) values
  ('PKG', '00000000-0000-4000-8000-000000002801', 'calendar', 'cursor-x', '2026-11-11 11:00Z');

insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, ical_uid, title, start_at, end_at, all_day, start_date, end_date,
                             timezone, status, attendees, organizer_email, source_updated_at) values
  ('PKG', '00000000-0000-4000-8000-000000002801', 'google', 'primary', 'e1', 'u-e1', 'Board prep', '2026-11-12 14:00Z', '2026-11-12 15:00Z', false, null, null,
   'America/Los_Angeles', 'confirmed', '[{"email":"brief-pkg@example.test","response":"needs_action"},{"email":"guest@outside.example","name":"Guest","response":"accepted"}]', 'guest@outside.example', now()),
  ('PKG', '00000000-0000-4000-8000-000000002801', 'google', 'team@group', 'e1-copy', 'u-e1', 'Board prep', '2026-11-12 14:00Z', '2026-11-12 15:00Z', false, null, null,
   null, 'confirmed', '[]', null, now()),
  ('PKG', '00000000-0000-4000-8000-000000002801', 'google', 'primary', 'e2', 'u-e2', 'Cancelled', '2026-11-12 16:00Z', '2026-11-12 17:00Z', false, null, null,
   null, 'cancelled', '[]', null, now()),
  ('PKG', '00000000-0000-4000-8000-000000002801', 'google', 'primary', 'e3', 'u-e3', 'Next week', '2026-11-18 14:00Z', '2026-11-18 15:00Z', false, null, null,
   null, 'confirmed', '[]', null, now()),
  ('APK', '00000000-0000-4000-8000-000000002802', 'google', 'primary', 'a1', 'u-a1', 'Other company', '2026-11-12 14:00Z', '2026-11-12 15:00Z', false, null, null,
   null, 'confirmed', '[]', null, now());

-- ---------------------------------------------------------------- privileges
select ok(has_function_privilege('authenticated', 'core.briefing_coverage(text)', 'execute')
          and has_function_privilege('authenticated', 'core.briefing_events(text, timestamptz, timestamptz)', 'execute'), 'authenticated executes both');
select ok(not has_function_privilege('anon', 'core.briefing_coverage(text)', 'execute')
          and not has_function_privilege('anon', 'core.briefing_events(text, timestamptz, timestamptz)', 'execute'), 'anon executes neither');
select ok((select prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = 'core.briefing_coverage(text)'::regprocedure),
          'coverage is security definer with an empty search_path');
select ok((select not prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = 'core.briefing_events(text, timestamptz, timestamptz)'::regprocedure),
          'events is security invoker with an empty search_path');

-- ---------------------------------------------------------------- owner, aal2, own lane
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;

select is((select count(*)::int from core.briefing_coverage('PKG')), 4, 'coverage: two accounts x two streams');
select is((select status from core.briefing_coverage('PKG') where account = 'missing@example.test' and stream = 'mail'), 'not_connected',
          'a configured mailbox without a connection is not_connected (never silently absent)');
select is((select configured from core.briefing_coverage('PKG') where account = 'missing@example.test' and stream = 'mail'), true, '...and marked configured');
select is((select status || '|' || error_kind from core.briefing_coverage('PKG') where account = 'brief-pkg@example.test' and stream = 'mail'), 'degraded|rate_limited',
          'connected account: status and the error kind only');
select is((select last_sync_at from core.briefing_coverage('PKG') where account = 'brief-pkg@example.test' and stream = 'mail'), '2026-11-11 10:01Z'::timestamptz,
          'mail last sync = last succeeded run');
select ok((select last_sync_at > '2026-11-11 10:01Z' from core.briefing_coverage('PKG') where account = 'brief-pkg@example.test' and stream = 'calendar'),
          'calendar last sync = its newer cursor time');
select ok(not exists (select 1 from core.briefing_coverage('PKG') c where c::text like '%provider text%'), 'no provider error text in coverage');

select is((select count(*)::int from core.briefing_events('PKG', '2026-11-12 05:00Z', '2026-11-13 05:00Z')), 1, 'events: de-duplicated, cancelled excluded');
select is((select timezone || '|' || organizer_email || '|' || jsonb_array_length(attendees)::text from core.briefing_events('PKG', '2026-11-12 05:00Z', '2026-11-13 05:00Z')),
          'America/Los_Angeles|guest@outside.example|2', 'the copy with attendees is kept, with zone and organizer');
select is((select count(*)::int from core.briefing_events('PKG', '2026-11-12 05:00Z', '2026-11-20 05:00Z')), 2, 'an 8-day window includes the look-ahead');
select throws_ok($$select * from core.briefing_events('PKG', '2026-11-12 05:00Z', '2026-11-21 05:00Z')$$, '22023', null, 'a window over 8 days is refused');
select throws_ok($$select * from core.briefing_coverage(null)$$, '22004', null, 'a lane is required');

-- cross-lane: APK has a connection and events; the owner is not an APK member
select is((select count(*)::int from core.briefing_coverage('APK')), 0, 'another lane: no coverage rows');
select is((select count(*)::int from core.briefing_events('APK', '2026-11-12 05:00Z', '2026-11-13 05:00Z')), 0, 'another lane: no events');
reset role;
set local role service_role;
select is((select count(*)::int from core.briefing_events('APK', '2026-11-12 05:00Z', '2026-11-13 05:00Z')), 1, 'fixture check: APK has an event');
select ok((select count(*)::int from core.briefing_coverage('APK')) >= 2, 'fixture check: APK has coverage rows for service_role');
reset role;

-- ---------------------------------------------------------------- AAL1
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.briefing_coverage('PKG')), 0, 'AAL1: no coverage');
select is((select count(*)::int from core.briefing_events('PKG', '2026-11-12 05:00Z', '2026-11-13 05:00Z')), 0, 'AAL1: no events');
reset role;

-- ---------------------------------------------------------------- members without comms/calendar views, outsider
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.briefing_coverage('PKG')), 0, 'admin_technical (connections view only): no coverage');
select is((select count(*)::int from core.briefing_events('PKG', '2026-11-12 05:00Z', '2026-11-13 05:00Z')), 0, 'admin_technical: no events');
reset role;
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.briefing_coverage('PKG')), 0, 'viewer: no coverage');
reset role;
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.briefing_coverage('PKG')), 0, 'outsider: no coverage');
select is((select count(*)::int from core.briefing_events('PKG', '2026-11-12 05:00Z', '2026-11-13 05:00Z')), 0, 'outsider: no events');
reset role;

select * from finish();
rollback;
