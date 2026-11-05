-- Google Calendar sync persistence (T-064): core.cal_events_apply_page and the 'calendar' stream of core.sync_cursors.
-- Covered: privileges (service_role only), apply (insert, all-day dates, replay, stale version skipped, equal version
-- applied), cancelled-stub merge (stored fields kept, new stub row, versionless stub, restore), removals, last-wins
-- duplicates, atomicity (a bad row rolls back removals and cursor), cursor compare-and-swap on every chunk, independent
-- mail and calendar cursors, lane/provider/status checks, size limits, and cross-lane/anon/aal1 denial.
begin;
select plan(70);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
insert into core.connections (id, lane_id, provider, external_account_id, status) values
  ('00000000-0000-4000-8000-000000000641', 'PKG', 'google', 'exec-cal@example.test', 'active'),
  ('00000000-0000-4000-8000-000000000642', 'APK', 'google', 'apk-cal@example.test', 'active'),
  ('00000000-0000-4000-8000-000000000643', 'PKG', 'quickbooks', 'realm-cal-64', 'active'),
  ('00000000-0000-4000-8000-000000000644', 'PKG', 'google', 'dead-cal@example.test', 'reconnect_required');

-- ---------------------------------------------------------------- privileges
select ok(has_function_privilege('service_role', 'core.cal_events_apply_page(text, uuid, jsonb, jsonb, text, text, boolean, text[])', 'execute'),
          'service_role executes core.cal_events_apply_page');
select ok(not has_function_privilege('authenticated', 'core.cal_events_apply_page(text, uuid, jsonb, jsonb, text, text, boolean, text[])', 'execute')
          and not has_function_privilege('anon', 'core.cal_events_apply_page(text, uuid, jsonb, jsonb, text, text, boolean, text[])', 'execute'),
          'authenticated and anon do not');
select ok((select prosecdef and proconfig::text like '%search_path%' from pg_proc where oid = 'core.cal_events_apply_page(text, uuid, jsonb, jsonb, text, text, boolean, text[])'::regprocedure),
          'security definer with an empty search_path');
select ok(not has_table_privilege('service_role', 'core.sync_cursors', 'select, insert, update, delete'), 'service_role still has no direct grant on the cursor table');

-- ---------------------------------------------------------------- insert (timed, all-day, recurring instance)
set local role service_role;
select is(core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb,
  $$[{"calendar_id": "primary", "event_id": "e-1", "ical_uid": "u1@example.test", "source_url": "https://calendar.example.test/e-1", "title": "Standup",
      "location": "Room 1", "organizer_email": "boss@example.test", "organizer_name": "Boss", "start_at": "2026-10-21T18:00:00.000Z",
      "end_at": "2026-10-21T18:30:00.000Z", "all_day": false, "start_date": null, "end_date": null, "timezone": "America/New_York",
      "attendees": [{"email": "a@example.test", "name": "A", "response": "accepted"}], "status": "confirmed", "recurring_event_id": null,
      "original_start_at": null, "online_meeting_url": "https://meet.example.test/x", "source_updated_at": "2026-10-01T10:00:00.000Z"},
     {"calendar_id": "primary", "event_id": "e-dst", "title": "DST weekend", "start_at": "2026-11-01T04:00:00.000Z", "end_at": "2026-11-03T05:00:00.000Z",
      "all_day": true, "start_date": "2026-11-01", "end_date": "2026-11-03", "timezone": "America/New_York", "attendees": [], "status": "confirmed",
      "source_updated_at": "2026-10-01T10:00:00.000Z"},
     {"calendar_id": "c_team@group.calendar.google.com", "event_id": "ser1_20261022T130000Z", "title": "Weekly", "start_at": "2026-10-22T13:00:00.000Z",
      "end_at": "2026-10-22T14:00:00.000Z", "attendees": [], "status": "tentative", "recurring_event_id": "ser1", "original_start_at": "2026-10-22T13:00:00.000Z",
      "source_updated_at": "2026-10-01T10:00:00.000Z"}]$$::jsonb,
  null, 'g1.00000000-0000-4000-8000-000000000641.c:1', false), '{"removed": 0, "written": 3, "skipped": 0}'::jsonb, 'a page inserts its events');
select is(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000000641', 'calendar'), 'g1.00000000-0000-4000-8000-000000000641.c:1', 'the calendar cursor was stored with the page');
select is(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000000641', 'mail'), null, 'the mail cursor is a separate stream');
select is((select provider || ':' || lane_id from cal.event_index where event_id = 'e-1' and lane_id = 'PKG'), 'google:PKG', 'provider and lane come from the call, not the payload');
select is((select start_date::text || '/' || end_date::text || '/' || all_day::text from cal.event_index where event_id = 'e-dst' and lane_id = 'PKG'),
          '2026-11-01/2026-11-03/true', 'all-day dates are stored (end exclusive)');
select is((select attendees -> 0 ->> 'email' from cal.event_index where event_id = 'e-1' and lane_id = 'PKG'), 'a@example.test', 'attendees are stored as addresses and names');
select is((select recurring_event_id || '/' || status from cal.event_index where event_id = 'ser1_20261022T130000Z' and lane_id = 'PKG'), 'ser1/tentative', 'a recurring instance keeps its series id');
select is((select last_sync_at is null from core.connections where id = '00000000-0000-4000-8000-000000000641'), true, 'last_sync_at is set only when the run completes');

-- ---------------------------------------------------------------- replay, versions
select is(core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb,
  $$[{"calendar_id": "primary", "event_id": "e-1", "title": "Standup (moved)", "location": "Room 1", "organizer_email": "boss@example.test",
      "start_at": "2026-10-21T19:00:00.000Z", "end_at": "2026-10-21T19:30:00.000Z",
      "attendees": [{"email": "a@example.test"}], "status": "confirmed", "source_updated_at": "2026-10-01T10:00:00.000Z"}]$$::jsonb,
  'g1.00000000-0000-4000-8000-000000000641.c:1', 'g1.00000000-0000-4000-8000-000000000641.c:2', true), '{"removed": 0, "written": 1, "skipped": 0}'::jsonb, 'an equal version is applied (the cursor, not the timestamp, guards replays)');
select is((select title from cal.event_index where event_id = 'e-1' and lane_id = 'PKG'), 'Standup (moved)', 'the event was replaced');
select ok((select last_sync_at is not null from core.connections where id = '00000000-0000-4000-8000-000000000641'), 'a complete run sets last_sync_at');
select is(core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb,
  $$[{"calendar_id": "primary", "event_id": "e-1", "title": "OLDER", "start_at": "2026-10-21T19:00:00.000Z", "end_at": "2026-10-21T19:30:00.000Z",
      "attendees": [], "status": "confirmed", "source_updated_at": "2026-09-30T10:00:00.000Z"},
     {"calendar_id": "primary", "event_id": "e-1b", "title": "no version", "start_at": "2026-10-21T19:00:00.000Z", "end_at": "2026-10-21T19:30:00.000Z",
      "attendees": [], "status": "confirmed", "source_updated_at": null}]$$::jsonb,
  'g1.00000000-0000-4000-8000-000000000641.c:2', 'g1.00000000-0000-4000-8000-000000000641.c:3', false), '{"removed": 0, "written": 1, "skipped": 1}'::jsonb, 'an older version is skipped; a new event without a version is inserted');
select is((select title from cal.event_index where event_id = 'e-1' and lane_id = 'PKG'), 'Standup (moved)', 'the row kept its newer content');
select is(core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb,
  $$[{"calendar_id": "primary", "event_id": "e-1b", "title": "still no version", "start_at": "2026-10-21T19:00:00.000Z", "end_at": "2026-10-21T19:30:00.000Z",
      "attendees": [], "status": "confirmed", "source_updated_at": "2026-10-02T10:00:00.000Z"}]$$::jsonb,
  'g1.00000000-0000-4000-8000-000000000641.c:3', 'g1.00000000-0000-4000-8000-000000000641.c:4', false), '{"removed": 0, "written": 1, "skipped": 0}'::jsonb, 'a versioned event replaces a versionless row');

-- ---------------------------------------------------------------- cancelled stubs merge (status only)
select is(core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb,
  $$[{"calendar_id": "primary", "event_id": "e-1", "ical_uid": null, "source_url": null, "title": null, "location": null, "organizer_email": null, "organizer_name": null,
      "start_at": null, "end_at": null, "all_day": false, "start_date": null, "end_date": null, "timezone": null, "attendees": [], "status": "cancelled",
      "recurring_event_id": null, "original_start_at": null, "online_meeting_url": null, "source_updated_at": null}]$$::jsonb,
  'g1.00000000-0000-4000-8000-000000000641.c:4', 'g1.00000000-0000-4000-8000-000000000641.c:5', false), '{"removed": 0, "written": 1, "skipped": 0}'::jsonb, 'a cancelled stub without a version applies');
select is((select status || '/' || title || '/' || location || '/' || (start_at is not null)::text || '/' || jsonb_array_length(attendees)::text || '/' || organizer_email
           from cal.event_index where event_id = 'e-1' and lane_id = 'PKG'),
          'cancelled/Standup (moved)/Room 1/true/1/boss@example.test', 'the stub changed status only: title, location, times, organizer are kept');
select is((select source_updated_at::text from cal.event_index where event_id = 'e-1' and lane_id = 'PKG'), '2026-10-01 10:00:00+00', 'a versionless stub keeps the stored version');
select is(core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb,
  $$[{"calendar_id": "primary", "event_id": "e-1", "attendees": [], "status": "cancelled", "source_updated_at": "2026-10-05T10:00:00.000Z"}]$$::jsonb,
  'g1.00000000-0000-4000-8000-000000000641.c:5', 'g1.00000000-0000-4000-8000-000000000641.c:6', false), '{"removed": 0, "written": 1, "skipped": 0}'::jsonb, 'a stub with a newer version applies and advances the version');
select is((select source_updated_at::text || '/' || title from cal.event_index where event_id = 'e-1' and lane_id = 'PKG'), '2026-10-05 10:00:00+00/Standup (moved)', 'version advanced, fields still kept');
select is(core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb,
  $$[{"calendar_id": "primary", "event_id": "e-1", "attendees": [], "status": "cancelled", "source_updated_at": "2026-10-04T10:00:00.000Z"}]$$::jsonb,
  'g1.00000000-0000-4000-8000-000000000641.c:6', 'g1.00000000-0000-4000-8000-000000000641.c:7', false), '{"removed": 0, "written": 0, "skipped": 1}'::jsonb, 'a stub older than the stored version is skipped');
select is(core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb,
  $$[{"calendar_id": "primary", "event_id": "never-seen", "attendees": [], "status": "cancelled", "recurring_event_id": "ser9", "original_start_at": "2026-10-09T10:00:00.000Z", "source_updated_at": null}]$$::jsonb,
  'g1.00000000-0000-4000-8000-000000000641.c:7', 'g1.00000000-0000-4000-8000-000000000641.c:8', false), '{"removed": 0, "written": 1, "skipped": 0}'::jsonb, 'a stub for an unknown event inserts a stub row (no times)');
select is((select status || '/' || (start_at is null)::text || '/' || recurring_event_id from cal.event_index where event_id = 'never-seen' and lane_id = 'PKG'), 'cancelled/true/ser9', 'the stub row has no times');
select is(core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb,
  $$[{"calendar_id": "primary", "event_id": "e-1", "title": "Standup (restored)", "start_at": "2026-10-21T19:00:00.000Z", "end_at": "2026-10-21T19:30:00.000Z",
      "attendees": [], "status": "confirmed", "source_updated_at": "2026-10-06T10:00:00.000Z"}]$$::jsonb,
  'g1.00000000-0000-4000-8000-000000000641.c:8', 'g1.00000000-0000-4000-8000-000000000641.c:9', false), '{"removed": 0, "written": 1, "skipped": 0}'::jsonb, 'a newer confirmed copy restores a cancelled event');
select is((select status from cal.event_index where event_id = 'e-1' and lane_id = 'PKG'), 'confirmed', 'the event is confirmed again');

-- ---------------------------------------------------------------- removals, duplicates
select is(core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641',
  '[{"calendar_id": "primary", "event_id": "e-dst"}, {"calendar_id": "primary", "event_id": "unknown"}, {"calendar_id": "other", "event_id": "e-1"}]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000000641.c:9', 'g1.00000000-0000-4000-8000-000000000641.c:10', false),
  '{"removed": 1, "written": 0, "skipped": 0}'::jsonb, 'a removal marks the event cancelled (unknown ids and other calendars are ignored)');
select is((select status from cal.event_index where event_id = 'e-dst' and lane_id = 'PKG'), 'cancelled', 'e-dst reads as cancelled');
select is((select status from cal.event_index where event_id = 'e-1' and lane_id = 'PKG'), 'confirmed', 'the same event id in another calendar was not touched');
select is(core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb,
  $$[{"calendar_id": "primary", "event_id": "dup", "title": "first", "start_at": "2026-10-03T10:00:00.000Z", "end_at": "2026-10-03T11:00:00.000Z", "attendees": [], "status": "confirmed", "source_updated_at": "2026-10-03T10:00:00.000Z"},
     {"calendar_id": "primary", "event_id": "dup", "title": "last", "start_at": "2026-10-03T10:00:00.000Z", "end_at": "2026-10-03T11:00:00.000Z", "attendees": [], "status": "confirmed", "source_updated_at": "2026-10-03T10:00:00.000Z"},
     {"calendar_id": "primary", "event_id": "e-dst", "title": "back", "start_at": "2026-11-01T04:00:00.000Z", "end_at": "2026-11-03T05:00:00.000Z", "all_day": true, "start_date": "2026-11-01", "end_date": "2026-11-03", "attendees": [], "status": "confirmed", "source_updated_at": "2026-10-07T10:00:00.000Z"}]$$::jsonb,
  'g1.00000000-0000-4000-8000-000000000641.c:10', 'g1.00000000-0000-4000-8000-000000000641.c:11', false), '{"removed": 0, "written": 2, "skipped": 0}'::jsonb, 'duplicates collapse to the last; a later upsert revives a removed event');
select is((select title from cal.event_index where event_id = 'dup' and lane_id = 'PKG'), 'last', 'the last duplicate wins');
select is((select count(*)::int from cal.event_index where lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000000641'), 6, 'six events are indexed for the connection');

-- ---------------------------------------------------------------- atomicity and table checks
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[{"calendar_id": "primary", "event_id": "dup"}]'::jsonb,
  '[{"calendar_id": "primary", "event_id": "bad-allday", "start_at": "2026-10-04T04:00:00.000Z", "end_at": "2026-10-04T04:00:00.000Z", "all_day": true, "start_date": "2026-10-04", "end_date": "2026-10-04", "attendees": [], "status": "confirmed"}]'::jsonb,
  'g1.00000000-0000-4000-8000-000000000641.c:11', 'g1.00000000-0000-4000-8000-000000000641.c:999', false)$$, '23514', null, 'an all-day event whose end date is not after its start fails the table check');
select is((select status from cal.event_index where event_id = 'dup' and lane_id = 'PKG'), 'confirmed', 'the removal in the failed page was rolled back');
select is(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000000641', 'calendar'), 'g1.00000000-0000-4000-8000-000000000641.c:11', 'the cursor did not advance on failure');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb,
  '[{"calendar_id": "primary", "event_id": "no-times", "attendees": [], "status": "confirmed"}]'::jsonb, 'g1.00000000-0000-4000-8000-000000000641.c:11', 'g1.00000000-0000-4000-8000-000000000641.c:12', false)$$,
  '23514', null, 'a confirmed event without times is refused');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb,
  '[{"calendar_id": "primary", "event_id": "x", "start_at": "2026-10-04T04:00:00.000Z", "end_at": "2026-10-04T05:00:00.000Z", "attendees": [{"email": "a@example.test", "body": "x"}], "status": "confirmed"}]'::jsonb, 'g1.00000000-0000-4000-8000-000000000641.c:11', 'g1.00000000-0000-4000-8000-000000000641.c:12', false)$$,
  '23514', null, 'an attendee with an extra key (a smuggled field) is refused');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb, '[{"calendar_id": "primary", "event_id": "x", "status": "weird", "attendees": []}]'::jsonb, 'g1.00000000-0000-4000-8000-000000000641.c:11', 'g1.00000000-0000-4000-8000-000000000641.c:12', false)$$,
  '22023', null, 'an unknown status is refused up front');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb, '[{"event_id": "x", "status": "confirmed"}]'::jsonb, 'g1.00000000-0000-4000-8000-000000000641.c:11', 'g1.00000000-0000-4000-8000-000000000641.c:12', false)$$,
  '22023', null, 'an upsert without a calendar_id is refused up front');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '["x"]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000000641.c:11', 'g1.00000000-0000-4000-8000-000000000641.c:12', false)$$,
  '22023', null, 'removals must be objects');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000000641.c:11', 'g1.00000000-0000-4000-8000-000000000641.c:bad' || chr(10) || 'cursor', false)$$,
  '23514', null, 'a cursor with control characters is refused by the table check');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000000641.c:11', 'g1.00000000-0000-4000-8000-000000000642.c:1', false)$$,
  '22023', null, 'a cursor that belongs to another connection is refused');

-- ---------------------------------------------------------------- cursor compare-and-swap on every chunk
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[{"calendar_id": "primary", "event_id": "dup"}]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000000641.c:50', 'g1.00000000-0000-4000-8000-000000000641.c:13', false)$$,
  'D0409', null, 'a page started from a cursor that is no longer the stored one is refused');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb, '[]'::jsonb, null, 'g1.00000000-0000-4000-8000-000000000641.c:13', false)$$,
  'D0409', null, 'a first-page claim (no cursor) is refused when a cursor is stored');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[{"calendar_id": "primary", "event_id": "dup"}]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000000641.c:50', null, false)$$,
  'D0409', null, 'an intermediate chunk (no new cursor) from a stale run is refused too');
select is((select status from cal.event_index where event_id = 'dup' and lane_id = 'PKG'), 'confirmed', 'refused pages wrote nothing');
select lives_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[{"calendar_id": "primary", "event_id": "dup"}]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000000641.c:11', null, false)$$,
  'an intermediate chunk from the current cursor is applied');
select is(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000000641', 'calendar'), 'g1.00000000-0000-4000-8000-000000000641.c:11', 'an intermediate chunk does not touch the cursor');

-- ---------------------------------------------------------------- lane, provider, status, size
select throws_ok($$select core.cal_events_apply_page('APK', '00000000-0000-4000-8000-000000000641', '[]'::jsonb, '[]'::jsonb, null, 'x', false)$$,
  '42501', null, 'cross-lane: another lane cannot apply to this lane''s connection');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000642', '[]'::jsonb, '[]'::jsonb, null, 'x', false)$$,
  '42501', null, 'cross-lane: this lane cannot apply to another lane''s connection');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000643', '[]'::jsonb, '[]'::jsonb, null, 'x', false)$$,
  '42501', null, 'a QuickBooks connection cannot take events');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000644', '[]'::jsonb, '[]'::jsonb, null, 'x', false)$$,
  '42501', null, 'a reconnect_required connection cannot be written');
select throws_ok($$select core.cal_events_apply_page('PKG', null, '[]'::jsonb, '[]'::jsonb, null, 'x', false)$$, '22004', null, 'a missing argument is refused');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb,
  (select jsonb_agg(jsonb_build_object('calendar_id', 'primary', 'event_id', 'x' || i, 'status', 'cancelled')) from generate_series(1, 1001) i), 'g1.00000000-0000-4000-8000-000000000641.c:11', 'g1.00000000-0000-4000-8000-000000000641.c:13', false)$$,
  '22023', null, 'more than 1000 upserts are refused');
select lives_ok($$select core.cal_events_apply_page('APK', '00000000-0000-4000-8000-000000000642', '[]'::jsonb,
  '[{"calendar_id": "primary", "event_id": "apk-1", "start_at": "2026-10-04T04:00:00.000Z", "end_at": "2026-10-04T05:00:00.000Z", "attendees": [], "status": "confirmed"},
   {"calendar_id": "c_old", "event_id": "apk-old", "start_at": "2026-10-04T04:00:00.000Z", "end_at": "2026-10-04T05:00:00.000Z", "attendees": [], "status": "confirmed"}]'::jsonb, null, 'g1.00000000-0000-4000-8000-000000000642.c:apk', false)$$,
  'the APK connection takes its own page');

-- ---------------------------------------------------------------- un-cancel needs a strictly newer version
select is(core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb,
  '[{"calendar_id": "c_old", "event_id": "uc-1", "attendees": [], "status": "cancelled", "source_updated_at": "2026-10-10T10:00:00.000Z"},
    {"calendar_id": "primary", "event_id": "keep-1", "start_at": "2026-10-04T04:00:00.000Z", "end_at": "2026-10-04T05:00:00.000Z", "attendees": [], "status": "confirmed", "source_updated_at": "2026-10-10T10:00:00.000Z"}]'::jsonb,
  'g1.00000000-0000-4000-8000-000000000641.c:11', 'g1.00000000-0000-4000-8000-000000000641.c:12', false), '{"removed": 0, "written": 2, "skipped": 0}'::jsonb, 'a cancelled stub with a version and an event in a calendar that stays');
select is(core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb,
  '[{"calendar_id": "c_old", "event_id": "uc-1", "start_at": "2026-10-04T04:00:00.000Z", "end_at": "2026-10-04T05:00:00.000Z", "attendees": [], "status": "confirmed", "source_updated_at": "2026-10-10T10:00:00.000Z"}]'::jsonb,
  'g1.00000000-0000-4000-8000-000000000641.c:12', 'g1.00000000-0000-4000-8000-000000000641.c:13', false), '{"removed": 0, "written": 0, "skipped": 1}'::jsonb, 'an equal-version confirmed copy cannot un-cancel');
select is((select status from cal.event_index where event_id = 'uc-1' and lane_id = 'PKG'), 'cancelled', 'still cancelled');
select is(core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb,
  '[{"calendar_id": "c_old", "event_id": "uc-1", "start_at": "2026-10-04T04:00:00.000Z", "end_at": "2026-10-04T05:00:00.000Z", "attendees": [], "status": "confirmed", "source_updated_at": "2026-10-10T10:00:01.000Z"}]'::jsonb,
  'g1.00000000-0000-4000-8000-000000000641.c:13', 'g1.00000000-0000-4000-8000-000000000641.c:14', false), '{"removed": 0, "written": 1, "skipped": 0}'::jsonb, 'a strictly newer copy un-cancels');
select is((select status from cal.event_index where event_id = 'uc-1' and lane_id = 'PKG'), 'confirmed', 'confirmed again');

-- ---------------------------------------------------------------- calendars that left the selection
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000000641.c:14', 'g1.00000000-0000-4000-8000-000000000641.c:15', false, array_fill('c'::text, array[11]))$$,
  '22023', null, 'a drop list of more than 10 calendars is refused');
select lives_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000000641.c:14', 'g1.00000000-0000-4000-8000-000000000641.c:15', false, array['c_old'])$$,
  'a page can drop a calendar that left the selection');
select is((select count(*)::int from cal.event_index where lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000000641' and calendar_id = 'c_old'), 0, 'the PKG rows of that calendar are gone');
select ok((select count(*)::int from cal.event_index where lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000000641' and calendar_id = 'primary') > 0, 'the connection''s other calendars are untouched');
select is((select count(*)::int from cal.event_index where lane_id = 'APK' and calendar_id = 'c_old'), 1, 'cross-lane: the same calendar id in another lane is untouched');
reset role;

-- ---------------------------------------------------------------- reads: cross-lane denial
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from cal.event_index where lane_id = 'APK'), 0, 'a PKG-only user reads no APK events (cross-lane denial)');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000000641', '[]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000000641.c:11', 'x', false)$$,
  '42501', null, 'authenticated cannot call the apply function');
reset role;
set local role anon;
select throws_ok($$select event_id from cal.event_index$$, '42501', null, 'anon is denied');
reset role;

select * from finish();
rollback;
