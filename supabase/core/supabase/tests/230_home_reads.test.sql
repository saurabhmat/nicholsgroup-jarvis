-- Home v1 reads (T-200): core.home_meetings and core.home_mail_attention.
-- Covered: privileges (authenticated/service_role execute, anon not), security invoker with an empty search_path, window
-- and argument checks, meetings (overlap, cancelled excluded, cross-calendar de-duplication, all-day first, columns),
-- attention counts (important, priority address and @domain, read/deleted/non-inbox/old mail ignored, no priority list),
-- and denial: other lane (rows exist, caller not a member), member without the calendar/comms view, outsider, AAL1.
begin;
select plan(38);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
-- The owner is a member of APK in the seed; drop that so APK is a lane the owner may NOT see (cross-lane denial).
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');

-- Start PKG and APK from no mail and no events (a developer's own synced rows are removed inside this transaction only).
delete from comms.message_index where lane_id in ('PKG', 'APK');
delete from cal.event_index where lane_id in ('PKG', 'APK');

insert into core.connections (id, lane_id, provider, external_account_id, status) values
  ('00000000-0000-4000-8000-000000002301', 'PKG', 'google', 'home-pkg@example.test', 'active'),
  ('00000000-0000-4000-8000-000000002302', 'APK', 'google', 'home-apk@example.test', 'active');

-- Calendar: a window of 2026-11-06 05:00Z .. 2026-11-07 05:00Z (Nov 6 in New York).
insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, ical_uid, title, location, source_url, online_meeting_url,
                             start_at, end_at, all_day, start_date, end_date, status, attendees, source_updated_at) values
  ('PKG', '00000000-0000-4000-8000-000000002301', 'google', 'primary', 'm1', 'u-m1@x', 'Leadership sync', 'Room 1', 'https://calendar.example.test/m1', 'https://meet.example.test/m1',
   '2026-11-06 14:30:00Z', '2026-11-06 15:00:00Z', false, null, null, 'confirmed', '[]', now()),
  -- the same meeting on a second calendar: shown once
  ('PKG', '00000000-0000-4000-8000-000000002301', 'google', 'aaa-team@group', 'm1-copy', 'u-m1@x', 'Leadership sync', null, null, null,
   '2026-11-06 14:30:00Z', '2026-11-06 15:00:00Z', false, null, null, 'confirmed', '[]', now()),
  ('PKG', '00000000-0000-4000-8000-000000002301', 'google', 'primary', 'm2', 'u-m2@x', 'Cancelled call', null, null, null,
   '2026-11-06 16:00:00Z', '2026-11-06 16:30:00Z', false, null, null, 'cancelled', '[]', now()),
  ('PKG', '00000000-0000-4000-8000-000000002301', 'google', 'primary', 'm3', 'u-m3@x', 'Offsite', null, null, null,
   '2026-11-06 05:00:00Z', '2026-11-07 05:00:00Z', true, '2026-11-06', '2026-11-07', 'confirmed', '[]', now()),
  ('PKG', '00000000-0000-4000-8000-000000002301', 'google', 'primary', 'm4', 'u-m4@x', 'Tomorrow', null, null, null,
   '2026-11-07 14:00:00Z', '2026-11-07 15:00:00Z', false, null, null, 'confirmed', '[]', now()),
  -- all-day events from calendars in other zones (the sync stores their instants as midnight in that zone):
  -- a UTC calendar's Nov 7 starts before the New York window ends, but is tomorrow; a Los Angeles Nov 6 is today.
  ('PKG', '00000000-0000-4000-8000-000000002301', 'google', 'utc-cal', 'm5', 'u-m5@x', 'UTC tomorrow', null, null, null,
   '2026-11-07 00:00:00Z', '2026-11-08 00:00:00Z', true, '2026-11-07', '2026-11-08', 'confirmed', '[]', now()),
  ('PKG', '00000000-0000-4000-8000-000000002301', 'google', 'la-cal', 'm6', 'u-m6@x', 'LA today', null, null, null,
   '2026-11-06 08:00:00Z', '2026-11-07 08:00:00Z', true, '2026-11-06', '2026-11-07', 'confirmed', '[]', now()),
  ('APK', '00000000-0000-4000-8000-000000002302', 'google', 'primary', 'a1', 'u-a1@x', 'Other company meeting', null, null, null,
   '2026-11-06 15:00:00Z', '2026-11-06 16:00:00Z', false, null, null, 'confirmed', '[]', now());

-- APK has priority senders too, so the cross-lane check below would see them if config RLS failed.
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{priority_senders}', '["boss@example.test"]'::jsonb)
from core.lane_config where lane_id = 'APK' order by version desc limit 1;
-- lane_config is insert-only: a new version with the priority senders.
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{priority_senders}', '["boss@example.test", "@partner.example.test"]'::jsonb)
from core.lane_config where lane_id = 'PKG' order by version desc limit 1;

insert into comms.message_index (lane_id, connection_id, provider, message_id, from_address, subject, received_at, is_read, is_important, folder, labels, deleted, source_updated_at) values
  ('PKG', '00000000-0000-4000-8000-000000002301', 'google', 'h1', 'boss@example.test', 's', now() - interval '1 hour', false, true, 'INBOX', '{}', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000002301', 'google', 'h2', 'Anna@Partner.Example.Test', 's', now() - interval '2 hours', false, false, 'INBOX', '{}', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000002301', 'google', 'h3', 'news@example.test', 's', now() - interval '3 hours', false, true, 'INBOX', '{}', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000002301', 'google', 'h4', 'boss@example.test', 's', now() - interval '1 hour', true, true, 'INBOX', '{}', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000002301', 'google', 'h5', 'boss@example.test', 's', now() - interval '1 hour', false, true, 'INBOX', '{}', true, now()),
  ('PKG', '00000000-0000-4000-8000-000000002301', 'google', 'h6', 'boss@example.test', 's', now() - interval '1 hour', false, true, null, '{}', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000002301', 'google', 'h7', 'boss@example.test', 's', now() - interval '3 days', false, true, 'INBOX', '{}', false, now()),
  ('APK', '00000000-0000-4000-8000-000000002302', 'google', 'a1', 'boss@example.test', 's', now() - interval '1 hour', false, true, 'INBOX', '{}', false, now());

-- ---------------------------------------------------------------- privileges
select ok(has_function_privilege('authenticated', 'core.home_meetings(text, timestamptz, timestamptz)', 'execute')
          and has_function_privilege('authenticated', 'core.home_mail_attention(text, timestamptz)', 'execute'), 'authenticated executes both');
select ok(not has_function_privilege('anon', 'core.home_meetings(text, timestamptz, timestamptz)', 'execute')
          and not has_function_privilege('anon', 'core.home_mail_attention(text, timestamptz)', 'execute'), 'anon executes neither');
select ok((select bool_and(not prosecdef and proconfig = array['search_path=""']) from pg_proc
           where oid in ('core.home_meetings(text, timestamptz, timestamptz)'::regprocedure, 'core.home_mail_attention(text, timestamptz)'::regprocedure)),
          'both are security invoker with an empty search_path');
select ok((select prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = 'core.home_calendar_status(text)'::regprocedure),
          'home_calendar_status is security definer with an empty search_path');

-- ---------------------------------------------------------------- owner, aal2, own lane
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;

select is((select count(*)::int from core.home_meetings('PKG', '2026-11-06 05:00Z', '2026-11-07 05:00Z')), 3, 'today: the meeting once and two all-day events; cancelled and tomorrow left out');
select ok((select bool_and(all_day) from (select all_day from core.home_meetings('PKG', '2026-11-06 05:00Z', '2026-11-07 05:00Z') limit 2) t), 'all-day events come first');
select is((select array_agg(title order by title) from core.home_meetings('PKG', '2026-11-06 05:00Z', '2026-11-07 05:00Z') where all_day), array['LA today', 'Offsite'],
          'all-day events match by New York date: a UTC calendar''s tomorrow is not today');
select is((select count(*)::int from core.home_meetings('PKG', '2026-11-07 05:00Z', '2026-11-08 05:00Z') where title = 'UTC tomorrow'), 1, '...and it shows on its own day');
select is((select title || '|' || location || '|' || online_meeting_url from core.home_meetings('PKG', '2026-11-06 05:00Z', '2026-11-07 05:00Z') where not all_day),
          'Leadership sync|Room 1|https://meet.example.test/m1', 'of two copies, the one with location and meeting link is kept (not the alphabetically first calendar)');
select is((select count(*)::int from core.home_meetings('PKG', '2026-11-06 05:00Z', '2026-11-08 05:00Z')), 5, 'a two-day window includes tomorrow''s timed and all-day events');
select throws_ok($$select * from core.home_meetings('PKG', '2026-11-06 05:00Z', '2026-11-14 05:00Z')$$, '22023', null, 'a window over 7 days is refused');
select throws_ok($$select * from core.home_meetings('PKG', '2026-11-07 05:00Z', '2026-11-06 05:00Z')$$, '22023', null, 'an empty window is refused');
select throws_ok($$select * from core.home_meetings(null, '2026-11-06 05:00Z', '2026-11-07 05:00Z')$$, '22004', null, 'a lane is required');

select is(core.home_calendar_status('PKG'), 'connected', 'calendar status: connected');
select is(core.home_calendar_status('APK'), 'no_access', 'calendar status: another lane is no_access, nothing about its connections');
select is((select unread_important from core.home_mail_attention('PKG', now() - interval '24 hours')), 2, 'unread important inbox mail in 24 h (read, deleted, non-inbox and old ignored)');
select is((select unread_priority from core.home_mail_attention('PKG', now() - interval '24 hours')), 2, 'unread from priority senders: an address and an @domain, case-insensitive');
select is((select priority_configured from core.home_mail_attention('PKG', now() - interval '24 hours')), true, 'priority senders are configured');
select is((select unread_important from core.home_mail_attention('PKG', now() - interval '4 days')), 3, 'a wider window counts older mail');
select throws_ok($$select * from core.home_mail_attention('PKG', now() - interval '8 days')$$, '22023', null, 'since more than 7 days back is refused');

-- ---------------------------------------------------------------- cross-lane: rows exist in APK, owner is not a member
select is((select count(*)::int from core.home_meetings('APK', '2026-11-06 05:00Z', '2026-11-07 05:00Z')), 0, 'another lane''s meetings are not returned');
select is((select unread_important + unread_priority from core.home_mail_attention('APK', now() - interval '24 hours')), 0, 'another lane''s mail is not counted');
select is((select priority_configured from core.home_mail_attention('APK', now() - interval '24 hours')), false, 'another lane''s config is not read');
reset role;
-- The APK fixture is real: without RLS (service_role) the same call sees the list and the message.
set local role service_role;
select is((select unread_priority::text || '/' || priority_configured::text from core.home_mail_attention('APK', now() - interval '24 hours')), '1/true', 'fixture check: APK has a priority sender and an unread message');
reset role;

-- ---------------------------------------------------------------- owner at aal1
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.home_meetings('PKG', '2026-11-06 05:00Z', '2026-11-07 05:00Z')), 0, 'AAL1 sees no meetings');
select is((select unread_important from core.home_mail_attention('PKG', now() - interval '24 hours')), 0, 'AAL1 counts no mail');
select is(core.home_calendar_status('PKG'), 'no_access', 'AAL1: calendar status no_access');
reset role;

-- ---------------------------------------------------------------- member without the calendar/comms view
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.home_meetings('PKG', '2026-11-06 05:00Z', '2026-11-07 05:00Z')), 0, 'admin_technical sees no meetings');
select is((select unread_important + unread_priority from core.home_mail_attention('PKG', now() - interval '24 hours')), 0, 'admin_technical counts no mail');
select is(core.home_calendar_status('PKG'), 'no_access', 'admin_technical: calendar status no_access (connections view alone is not enough)');
reset role;

select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.home_meetings('PKG', '2026-11-06 05:00Z', '2026-11-07 05:00Z')), 0, 'a finance-only viewer sees no meetings');
select is((select priority_configured from core.home_mail_attention('PKG', now() - interval '24 hours')), false, 'a viewer without the config view does not read priority senders');
reset role;

-- ---------------------------------------------------------------- outsider
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.home_meetings('PKG', '2026-11-06 05:00Z', '2026-11-07 05:00Z')), 0, 'an outsider sees no meetings');
select is((select unread_important + unread_priority from core.home_mail_attention('PKG', now() - interval '24 hours')), 0, 'an outsider counts no mail');
select is(core.home_calendar_status('PKG'), 'no_access', 'an outsider: calendar status no_access');
reset role;

-- ---------------------------------------------------------------- not connected: a lane the owner may see, with no connections
update core.lanes set enabled = true where code = 'NC';
delete from core.connections where lane_id = 'NC';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(core.home_calendar_status('NC'), 'not_connected', 'calendar status: not_connected for a visible lane without a calendar connection');
reset role;

-- ---------------------------------------------------------------- anon
set local role anon;
select throws_ok($$select * from core.home_meetings('PKG', '2026-11-06 05:00Z', '2026-11-07 05:00Z')$$, '42501', null, 'anon cannot call home_meetings');
select throws_ok($$select core.home_calendar_status('PKG')$$, '42501', null, 'anon cannot call home_calendar_status');
reset role;

select * from finish();
rollback;
