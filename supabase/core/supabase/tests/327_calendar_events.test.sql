-- T-274: core.calendar_events, the Calendar page's reader. Covered: Google and Microsoft events of the caller returned together; another user's
-- connection in the same lane returns nothing; another lane returns nothing (cross-lane denial, both ways); AAL1 returns nothing; a member without
-- own_mail returns nothing; cancelled left out; the same ical_uid on two of the caller's connections is one row with both connection ids; all-day events
-- at the window edges (end_date exclusive); window length and null rules; grants (anon and service_role cannot execute).
-- Synthetic data only: example UUIDs, example.test addresses. Window used: 2026-12-01 00:00 to 2026-12-08 00:00 New York (UTC-5).
begin;
select plan(28);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
delete from cal.event_index where lane_id in ('PKG', 'APK');
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id) values
  ('00000000-0000-4000-8000-000000032701', 'PKG', 'google', 'robert-g@example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032702', 'PKG', 'microsoft', 'robert-m@ms.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032703', 'PKG', 'google', 'robert-g2@example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032704', 'PKG', 'google', 'saurabh@example.test', 'active', '{}', pg_temp.uid('admin-technical@example.test')),
  ('00000000-0000-4000-8000-000000032705', 'APK', 'google', 'robert-apk@example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032706', 'PKG', 'google', 'finance@example.test', 'active', '{}', pg_temp.uid('finance-operator@example.test'));

insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, ical_uid, title, start_at, end_at, all_day, start_date, end_date, status, attendees, source_url, online_meeting_url, organizer_email, timezone, source_updated_at) values
  -- Robert, Google: a timed meeting with a link; a cancelled one; two all-day events at the window edges and two just outside.
  ('PKG', '00000000-0000-4000-8000-000000032701', 'google', 'primary', 'g-1', 'u-g1', 'Google meeting', '2026-12-02 15:00+00', '2026-12-02 16:00+00', false, null, null, 'confirmed', '[]', 'https://calendar.example.test/g-1', 'https://meet.example.test/g-1', 'boss@example.test', 'America/New_York', now()),
  ('PKG', '00000000-0000-4000-8000-000000032701', 'google', 'primary', 'g-cancelled', 'u-gc', 'Cancelled meeting', '2026-12-02 17:00+00', '2026-12-02 18:00+00', false, null, null, 'cancelled', '[]', null, null, null, null, now()),
  ('PKG', '00000000-0000-4000-8000-000000032701', 'google', 'primary', 'g-ad-first', 'u-adf', 'All day first day', '2026-12-01 05:00+00', '2026-12-02 05:00+00', true, '2026-12-01', '2026-12-02', 'confirmed', '[]', null, null, null, 'America/New_York', now()),
  ('PKG', '00000000-0000-4000-8000-000000032701', 'google', 'primary', 'g-ad-last', 'u-adl', 'All day last day', '2026-12-07 05:00+00', '2026-12-08 05:00+00', true, '2026-12-07', '2026-12-08', 'confirmed', '[]', null, null, null, 'America/New_York', now()),
  ('PKG', '00000000-0000-4000-8000-000000032701', 'google', 'primary', 'g-ad-before', 'u-adb', 'All day before', '2026-11-30 05:00+00', '2026-12-01 05:00+00', true, '2026-11-30', '2026-12-01', 'confirmed', '[]', null, null, null, 'America/New_York', now()),
  ('PKG', '00000000-0000-4000-8000-000000032701', 'google', 'primary', 'g-ad-after', 'u-ada', 'All day after', '2026-12-08 05:00+00', '2026-12-09 05:00+00', true, '2026-12-08', '2026-12-09', 'confirmed', '[]', null, null, null, 'America/New_York', now()),
  -- Robert, Microsoft: tentative.
  ('PKG', '00000000-0000-4000-8000-000000032702', 'microsoft', 'cal-1', 'm-1', 'u-m1', 'Outlook meeting', '2026-12-03 14:00+00', '2026-12-03 15:00+00', false, null, null, 'tentative', '[]', 'https://outlook.example.test/m-1', null, 'ms-boss@example.test', 'America/New_York', now()),
  -- The same meeting on two of Robert's Google calendars: the first copy has no link, the second has one (the better copy wins).
  ('PKG', '00000000-0000-4000-8000-000000032701', 'google', 'primary', 'dup-a', 'u-dup', 'Shared meeting', '2026-12-04 15:00+00', '2026-12-04 16:00+00', false, null, null, 'confirmed', '[]', null, null, null, null, now()),
  ('PKG', '00000000-0000-4000-8000-000000032703', 'google', 'primary', 'dup-b', 'u-dup', 'Shared meeting', '2026-12-04 15:00+00', '2026-12-04 16:00+00', false, null, null, 'confirmed', '[]', 'https://calendar.example.test/dup-b', 'https://meet.example.test/dup-b', null, null, now()),
  -- ANOTHER user's copy of the same meeting (same ical_uid and start), with a title, links and attendees that would win the tie-break: it must change nothing for Robert.
  ('PKG', '00000000-0000-4000-8000-000000032704', 'google', 'primary', 'dup-other', 'u-dup', 'Other user wins the tie-break', '2026-12-04 15:00+00', '2026-12-04 16:00+00', false, null, null, 'confirmed', '[{"email": "a@example.test"}]', 'https://calendar.example.test/other', 'https://meet.example.test/other', 'other@example.test', 'America/New_York', now()),
  -- Two instances of one series (same ical_uid, different start): two rows.
  ('PKG', '00000000-0000-4000-8000-000000032701', 'google', 'primary', 'rec-1', 'u-rec', 'Weekly sync', '2026-12-05 15:00+00', '2026-12-05 16:00+00', false, null, null, 'confirmed', '[]', null, null, null, null, now()),
  ('PKG', '00000000-0000-4000-8000-000000032701', 'google', 'primary', 'rec-2', 'u-rec', 'Weekly sync', '2026-12-06 15:00+00', '2026-12-06 16:00+00', false, null, null, 'confirmed', '[]', null, null, null, null, now()),
  -- Another user in the same lane, the finance operator (no own_mail), and Robert's other lane.
  ('PKG', '00000000-0000-4000-8000-000000032704', 'google', 'primary', 's-1', 'u-s1', 'Saurabh private meeting', '2026-12-02 15:00+00', '2026-12-02 16:00+00', false, null, null, 'confirmed', '[]', null, null, null, null, now()),
  ('PKG', '00000000-0000-4000-8000-000000032706', 'google', 'primary', 'f-1', 'u-f1', 'Finance private meeting', '2026-12-02 15:00+00', '2026-12-02 16:00+00', false, null, null, 'confirmed', '[]', null, null, null, null, now()),
  ('APK', '00000000-0000-4000-8000-000000032705', 'google', 'primary', 'a-1', 'u-a1', 'Robert APK meeting', '2026-12-02 15:00+00', '2026-12-02 16:00+00', false, null, null, 'confirmed', '[]', null, null, null, null, now());

create function pg_temp.titles(p_lane text, p_from timestamptz default '2026-12-01 05:00+00', p_to timestamptz default '2026-12-08 05:00+00') returns text language sql as $$
  select coalesce(string_agg(title, ' | ' order by all_day desc, start_at, title), '') from core.calendar_events(p_lane, p_from, p_to);
$$;
grant execute on function pg_temp.titles(text, timestamptz, timestamptz) to public;

-- ---------------------------------------------------------------- the owner of two Google calendars and a Microsoft one
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.titles('PKG'),
  'All day first day | All day last day | Google meeting | Outlook meeting | Shared meeting | Weekly sync | Weekly sync',
  'both providers together: all-day first, then by start; cancelled, other people, other lane and out-of-window all-day events are left out');
select is((select count(*)::int from core.calendar_events('PKG', '2026-12-01 05:00+00', '2026-12-08 05:00+00') where title = 'Shared meeting'), 1, 'the same ical_uid on two connections is one row');
select is((select connection_ids from core.calendar_events('PKG', '2026-12-01 05:00+00', '2026-12-08 05:00+00') where title = 'Shared meeting'),
  array['00000000-0000-4000-8000-000000032701', '00000000-0000-4000-8000-000000032703']::uuid[] , 'the deduplicated row lists both connections');
select is((select connection_id from core.calendar_events('PKG', '2026-12-01 05:00+00', '2026-12-08 05:00+00') where title = 'Shared meeting'),
  '00000000-0000-4000-8000-000000032703'::uuid, 'the copy with the links wins (its connection is the row''s connection)');
select is((select string_agg(provider, ',' order by start_at) from core.calendar_events('PKG', '2026-12-02 00:00+00', '2026-12-04 00:00+00') where not all_day), 'google,microsoft', 'each row carries its provider');
select is((select source_url from core.calendar_events('PKG', '2026-12-03 00:00+00', '2026-12-04 00:00+00')), 'https://outlook.example.test/m-1', 'the event link is returned');
select is((select status from core.calendar_events('PKG', '2026-12-03 00:00+00', '2026-12-04 00:00+00')), 'tentative', 'status is returned');
select is((select organizer_email from core.calendar_events('PKG', '2026-12-02 00:00+00', '2026-12-03 00:00+00') where not all_day), 'boss@example.test', 'the organizer is returned');
select is(pg_temp.titles('PKG', '2026-12-02 15:30+00', '2026-12-02 15:31+00'), 'Google meeting', 'a window inside a meeting returns it (overlap)');
select is(pg_temp.titles('PKG', '2026-12-02 16:00+00', '2026-12-02 16:30+00'), '', 'a meeting that ended exactly at the window start is not returned');
-- all-day edges: end_date is exclusive
select is(pg_temp.titles('PKG', '2026-12-02 05:00+00', '2026-12-02 14:00+00'), '', 'the day after a one-day all-day event does not return it');
select is(pg_temp.titles('PKG', '2026-12-01 05:00+00', '2026-12-02 05:00+00'), 'All day first day', 'the first day returns its all-day event, not the one that ended the day before');
-- another lane: the owner's own APK calendar is asked for by its lane only
select is(pg_temp.titles('APK'), 'Robert APK meeting', 'the owner reads their own APK calendar when asking for APK');
select is(pg_temp.titles('XXX'), '', 'an unknown lane returns nothing');
-- window rules
select throws_ok($$select * from core.calendar_events('PKG', '2026-12-01 05:00+00', '2027-01-14 05:00+00')$$, '22023', null, 'a window of over 43 days is refused');
select lives_ok($$select * from core.calendar_events('PKG', '2026-11-29 05:00+00', '2026-11-29 05:00+00'::timestamptz + interval '43 days')$$, 'a window of exactly 43 days is accepted');
select throws_ok($$select * from core.calendar_events('PKG', '2026-12-08 05:00+00', '2026-12-01 05:00+00')$$, '22023', null, 'a reversed window is refused');
select throws_ok($$select * from core.calendar_events('PKG', null, '2026-12-01 05:00+00')$$, '22004', null, 'a null window start is refused');
select throws_ok($$select * from core.calendar_events(null, '2026-12-01 05:00+00', '2026-12-02 05:00+00')$$, '22004', null, 'a null lane is refused');
reset role;

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select title || '|' || source_url || '|' || cardinality(connection_ids)::text from core.calendar_events('PKG', '2026-12-04 05:00+00', '2026-12-05 05:00+00')),
  'Shared meeting|https://calendar.example.test/dup-b|2', 'another user''s copy of the same meeting (same ical_uid and start) changes nothing: Robert''s own title, link and connection ids');
select is((select count(*)::int from core.calendar_events('PKG', '2026-12-01 05:00+00', '2026-12-08 05:00+00') where title = 'Weekly sync'), 2, 'two instances of a series (same ical_uid, different start) stay two rows');
reset role;
insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, ical_uid, title, start_at, end_at, status, attendees, source_updated_at)
select 'PKG', '00000000-0000-4000-8000-000000032701', 'google', 'primary', 'cap-' || g, 'u-cap-' || g, 'Cap ' || g, '2026-12-02 12:00+00'::timestamptz + (g || ' minutes')::interval, '2026-12-02 12:00+00'::timestamptz + (g || ' minutes')::interval + interval '5 minutes', 'confirmed', '[]', now()
from generate_series(1, 502) g;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.calendar_events('PKG', '2026-12-01 05:00+00', '2026-12-08 05:00+00')), 501, 'the result is capped at 501 rows (the page shows 500 and says there are more)');
reset role;

-- ---------------------------------------------------------------- other people, no MFA, no own_mail, other lane, anon
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.titles('PKG'), 'Saurabh private meeting | Other user wins the tie-break', 'another user in the same lane reads only their own calendar (never Robert''s)');
select is(pg_temp.titles('APK'), '', 'cross-lane denial: a user with no APK membership reads nothing from APK');
reset role;
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is(pg_temp.titles('PKG'), '', 'AAL1 reads nothing, even of one''s own calendars');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.titles('PKG'), '', 'a member without own_mail reads nothing, even with a connection of their own');
reset role;
select ok(not has_function_privilege('anon', 'core.calendar_events(text, timestamptz, timestamptz)', 'execute')
      and not has_function_privilege('service_role', 'core.calendar_events(text, timestamptz, timestamptz)', 'execute')
      and has_function_privilege('authenticated', 'core.calendar_events(text, timestamptz, timestamptz)', 'execute'), 'only authenticated may execute it');
set local role anon;
select throws_ok($$select * from core.calendar_events('PKG', '2026-12-01 05:00+00', '2026-12-02 05:00+00')$$, '42501', null, 'anon cannot call it');
reset role;

select * from finish();
rollback;
