-- T-253: provider-generic calendar page writer (core.cal_events_apply_page; docs/specs/microsoft.md 6.3) and the reader inventory.
-- Covered: a Microsoft calendar page applied (provider from the connection, cursor, last_sync_at), the Google page unchanged, foreign-prefix and
-- mail-prefixed cursors refused for each provider, the 16384 limit, cancelled stubs and removals for a Microsoft row, cross-lane denial, a
-- disabled lane, a non-usable connection, grants; then the inventory: every function whose body names 'google' is listed (a new one fails this
-- test until docs/plan-review.md "T-253: review results" and this list say what it does), each generalised one names 'microsoft', and every
-- generalised reader, coverage, home status and sync/failure stream accepts a Microsoft connection and still refuses another user's rows, another
-- lane's rows (T-247 rules) and AAL1.
-- Synthetic data only: example UUIDs, example.test addresses.
begin;
select plan(143);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
delete from comms.message_index where lane_id in ('PKG', 'APK');
delete from cal.event_index where lane_id in ('PKG', 'APK');
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id) values
  ('00000000-0000-4000-8000-000000032201', 'PKG', 'microsoft', 'viewer-t253@ms.example.test', 'active', '{}', pg_temp.uid('viewer@example.test')),
  ('00000000-0000-4000-8000-000000032202', 'PKG', 'google', 'g-t253@example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032203', 'APK', 'microsoft', 'apk-t253@ms.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032204', 'PKG', 'microsoft', 'robert-t253@ms.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032205', 'PKG', 'microsoft', 'dead-t253@ms.example.test', 'reconnect_required', '{}', pg_temp.uid('owner@example.test'));

-- ---------------------------------------------------------------- a Microsoft calendar page is applied
set local role service_role;
select is(core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032201', '[]'::jsonb,
  jsonb_build_array(
    jsonb_build_object('calendar_id', 'AAMk-cal-1', 'event_id', 'AAMk-ev-1', 'ical_uid', 'ms-u1@example.test', 'source_url', 'https://outlook.example.test/ev-1',
      'title', 'Viewer MS meeting', 'organizer_email', 'boss@example.test', 'start_at', now() + interval '1 hour', 'end_at', now() + interval '2 hours',
      'all_day', false, 'timezone', 'America/New_York', 'attendees', '[{"email": "a@example.test"}]'::jsonb, 'status', 'confirmed',
      'online_meeting_url', 'https://teams.example.test/x', 'source_updated_at', '2026-11-20T12:00:00.000Z'),
    jsonb_build_object('calendar_id', 'AAMk-cal-1', 'event_id', 'AAMk-ev-2', 'title', 'Second', 'start_at', now() + interval '3 hours',
      'end_at', now() + interval '4 hours', 'attendees', '[]'::jsonb, 'status', 'tentative', 'source_updated_at', '2026-11-20T12:00:00.000Z')),
  null, 'm1.00000000-0000-4000-8000-000000032201.c:eyJ2IjoxfQ', true), '{"removed": 0, "written": 2, "skipped": 0}'::jsonb, 'a Microsoft calendar page is applied');
select is(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000032201', 'calendar'), 'm1.00000000-0000-4000-8000-000000032201.c:eyJ2IjoxfQ', 'the Microsoft calendar cursor was stored');
select is(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000032201', 'mail'), null, 'the mail stream of that connection is untouched');
select is((select string_agg(provider, ',') from cal.event_index where lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000032201'), 'microsoft,microsoft', 'rows carry the connection''s own provider');
select ok((select last_sync_at is not null from core.connections where id = '00000000-0000-4000-8000-000000032201'), 'a complete Microsoft run sets last_sync_at');

-- ---------------------------------------------------------------- Google regression
select is(core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032202', '[]'::jsonb,
  jsonb_build_array(jsonb_build_object('calendar_id', 'primary', 'event_id', 'g-ev-1', 'title', 'Google meeting', 'start_at', now() + interval '1 hour',
    'end_at', now() + interval '2 hours', 'attendees', '[]'::jsonb, 'status', 'confirmed', 'source_updated_at', '2026-11-20T12:00:00.000Z')),
  null, 'g1.00000000-0000-4000-8000-000000032202.c:1', false), '{"removed": 0, "written": 1, "skipped": 0}'::jsonb, 'a Google calendar page is applied as before');
select is((select provider from cal.event_index where event_id = 'g-ev-1' and lane_id = 'PKG'), 'google', 'the Google row carries google');

-- ---------------------------------------------------------------- the cursor must belong to the connection, its provider and the calendar stream
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032202', '[]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000032202.c:1', 'm1.00000000-0000-4000-8000-000000032202.c:x', false)$$,
  '22023', null, 'a Google connection cannot store an m1 cursor');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032202', '[]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000032202.c:1', 'g1.00000000-0000-4000-8000-000000032202.h:2', false)$$,
  '22023', null, 'a Google calendar stream cannot store a mail-prefixed cursor (g1.<id>.h:)');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032202', '[]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000032202.c:1', 'g1.00000000-0000-4000-8000-000000032201.c:2', false)$$,
  '22023', null, 'a Google connection cannot store another connection''s cursor');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032202', '[]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000032202.c:1', 'c:2', false)$$,
  '22023', null, 'a Google connection cannot store an unprefixed cursor');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032201', '[]'::jsonb, '[]'::jsonb, 'm1.00000000-0000-4000-8000-000000032201.c:eyJ2IjoxfQ', 'g1.00000000-0000-4000-8000-000000032201.c:2', false)$$,
  '22023', null, 'a Microsoft connection cannot store a g1 cursor');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032201', '[]'::jsonb, '[]'::jsonb, 'm1.00000000-0000-4000-8000-000000032201.c:eyJ2IjoxfQ', 'm1.00000000-0000-4000-8000-000000032201.m:x', false)$$,
  '22023', null, 'a Microsoft calendar stream cannot store a mail-prefixed cursor (m1.<id>.m:)');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032201', '[]'::jsonb, '[]'::jsonb, 'm1.00000000-0000-4000-8000-000000032201.c:eyJ2IjoxfQ', 'm1.00000000-0000-4000-8000-000000032204.c:x', false)$$,
  '22023', null, 'a Microsoft connection cannot store another connection''s cursor');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032201', '[]'::jsonb, '[]'::jsonb, 'm1.00000000-0000-4000-8000-000000032201.c:eyJ2IjoxfQ', 'x', false)$$,
  '22023', null, 'a Microsoft connection cannot store an unprefixed cursor');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032201', '[]'::jsonb, '[]'::jsonb, 'm1.00000000-0000-4000-8000-000000032201.c:eyJ2IjoxfQ', 'M1.00000000-0000-4000-8000-000000032201.c:x', false)$$,
  '22023', null, 'a Microsoft connection cannot store an upper-case M1 prefix');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032202', '[]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000032202.c:1', 'G1.00000000-0000-4000-8000-000000032202.c:x', false)$$,
  '22023', null, 'a Google connection cannot store an upper-case G1 prefix');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032201', '[]'::jsonb, '[]'::jsonb, 'm1.00000000-0000-4000-8000-000000032201.c:eyJ2IjoxfQ', ' m1.00000000-0000-4000-8000-000000032201.c:x', false)$$,
  '22023', null, 'a Microsoft cursor with a leading space is refused');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032202', '[]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000032202.c:1', ' g1.00000000-0000-4000-8000-000000032202.c:x', false)$$,
  '22023', null, 'a Google cursor with a leading space is refused');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032201', '[]'::jsonb, '[]'::jsonb, 'm1.00000000-0000-4000-8000-000000032201.c:eyJ2IjoxfQ', '', false)$$,
  '22023', null, 'an empty-string cursor is refused for a Microsoft connection');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032202', '[]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000032202.c:1', '', false)$$,
  '22023', null, 'an empty-string cursor is refused for a Google connection');
select is(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000032201', 'calendar'), 'm1.00000000-0000-4000-8000-000000032201.c:eyJ2IjoxfQ', 'refused pages left the Microsoft cursor unchanged');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032201', '[]'::jsonb, '[]'::jsonb, 'm1.00000000-0000-4000-8000-000000032201.c:eyJ2IjoxfQ',
  'm1.00000000-0000-4000-8000-000000032201.c:' || repeat('a', 16384), false)$$, '22023', null, 'a cursor longer than 16384 characters is refused');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032202', '[]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000032202.c:1',
  'g1.00000000-0000-4000-8000-000000032202.c:' || repeat('a', 16384), false)$$, '22023', null, '...for a Google connection too');
select lives_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032201', '[]'::jsonb, '[]'::jsonb, 'm1.00000000-0000-4000-8000-000000032201.c:eyJ2IjoxfQ',
  'm1.00000000-0000-4000-8000-000000032201.c:' || repeat('a', 16384 - length('m1.00000000-0000-4000-8000-000000032201.c:')), false)$$, 'a cursor of exactly 16384 characters is stored');
select is(length(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000032201', 'calendar')), 16384, 'the 16384-character cursor was stored whole');
select lives_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032201', '[]'::jsonb, '[]'::jsonb,
  'm1.00000000-0000-4000-8000-000000032201.c:' || repeat('a', 16384 - length('m1.00000000-0000-4000-8000-000000032201.c:')), null, false)$$,
  'an intermediate chunk (no new cursor) needs no prefix');
select lives_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032201', '[]'::jsonb, '[]'::jsonb,
  'm1.00000000-0000-4000-8000-000000032201.c:' || repeat('a', 16384 - length('m1.00000000-0000-4000-8000-000000032201.c:')), 'm1.00000000-0000-4000-8000-000000032201.c:s2', false)$$,
  'the cursor moves on (the stored long one was the expected one)');

-- ---------------------------------------------------------------- removals and stubs for a Microsoft row
select is(core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032201', '[{"calendar_id": "AAMk-cal-1", "event_id": "AAMk-ev-2"}]'::jsonb,
  '[{"calendar_id": "AAMk-cal-1", "event_id": "AAMk-ev-1", "status": "cancelled"}]'::jsonb,
  'm1.00000000-0000-4000-8000-000000032201.c:s2', 'm1.00000000-0000-4000-8000-000000032201.c:s3', false), '{"removed": 1, "written": 1, "skipped": 0}'::jsonb,
  'a Microsoft removal and a cancelled stub apply');
select is((select string_agg(event_id || ':' || status || ':' || coalesce(title, '-'), ',' order by event_id) from cal.event_index where lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000032201'),
  'AAMk-ev-1:cancelled:Viewer MS meeting,AAMk-ev-2:cancelled:Second', 'both read as cancelled; the stub kept the stored title');
-- restore a live event for the reader tests below (a strictly newer copy un-cancels)
select is(core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032201', '[]'::jsonb,
  jsonb_build_array(jsonb_build_object('calendar_id', 'AAMk-cal-1', 'event_id', 'AAMk-ev-1', 'title', 'Viewer MS meeting', 'start_at', now() + interval '1 hour',
    'end_at', now() + interval '2 hours', 'attendees', '[]'::jsonb, 'status', 'confirmed', 'source_updated_at', '2026-11-20T13:00:00.000Z')),
  'm1.00000000-0000-4000-8000-000000032201.c:s3', 'm1.00000000-0000-4000-8000-000000032201.c:s4', false), '{"removed": 0, "written": 1, "skipped": 0}'::jsonb,
  'a newer Microsoft copy un-cancels');
select is(core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032204', '[]'::jsonb,
  jsonb_build_array(jsonb_build_object('calendar_id', 'AAMk-cal-9', 'event_id', 'AAMk-ev-9', 'title', 'Owner MS meeting', 'start_at', now() + interval '1 hour',
    'end_at', now() + interval '2 hours', 'attendees', '[]'::jsonb, 'status', 'confirmed', 'source_updated_at', '2026-11-20T12:00:00.000Z')),
  null, 'm1.00000000-0000-4000-8000-000000032204.c:a', false), '{"removed": 0, "written": 1, "skipped": 0}'::jsonb, 'setup: the owner''s own Microsoft mailbox has an event');

-- ---------------------------------------------------------------- lane, status and disabled-lane checks
select throws_ok($$select core.cal_events_apply_page('APK', '00000000-0000-4000-8000-000000032201', '[]'::jsonb, '[]'::jsonb, null, 'm1.00000000-0000-4000-8000-000000032201.c:x', false)$$,
  '42501', null, 'cross-lane: lane B naming a lane A Microsoft connection is refused');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032203', '[]'::jsonb, '[]'::jsonb, null, 'm1.00000000-0000-4000-8000-000000032203.c:x', false)$$,
  '42501', null, 'cross-lane: lane A naming a lane B Microsoft connection is refused');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-000000032205', '[]'::jsonb, '[]'::jsonb, null, 'm1.00000000-0000-4000-8000-000000032205.c:x', false)$$,
  '42501', null, 'a reconnect_required Microsoft connection cannot be written');
select throws_ok($$select core.cal_events_apply_page('PKG', '00000000-0000-4000-8000-0000000099ff', '[]'::jsonb, '[]'::jsonb, null, 'm1.00000000-0000-4000-8000-0000000099ff.c:x', false)$$,
  '42501', null, 'an unknown connection is refused');
select lives_ok($$select core.cal_events_apply_page('APK', '00000000-0000-4000-8000-000000032203', '[]'::jsonb, '[]'::jsonb, null, 'm1.00000000-0000-4000-8000-000000032203.c:x', false)$$,
  'the lane''s own Microsoft connection works in an enabled lane');
select is((select count(*)::int from cal.event_index where lane_id = 'APK'), 0, 'nothing leaked into the other lane');
reset role;
update core.lanes set enabled = false where code = 'APK';
set local role service_role;
select throws_ok($$select core.cal_events_apply_page('APK', '00000000-0000-4000-8000-000000032203', '[]'::jsonb, '[]'::jsonb, 'm1.00000000-0000-4000-8000-000000032203.c:x', 'm1.00000000-0000-4000-8000-000000032203.c:y', false)$$,
  '42501', null, 'a disabled lane cannot be written (Microsoft)');
reset role;
update core.lanes set enabled = true where code = 'APK';
select ok(has_function_privilege('service_role', 'core.cal_events_apply_page(text, uuid, jsonb, jsonb, text, text, boolean, text[])', 'execute')
          and not has_function_privilege('authenticated', 'core.cal_events_apply_page(text, uuid, jsonb, jsonb, text, text, boolean, text[])', 'execute')
          and not has_function_privilege('anon', 'core.cal_events_apply_page(text, uuid, jsonb, jsonb, text, text, boolean, text[])', 'execute'),
          'grants unchanged: service_role only');
select ok((select prosecdef and proconfig::text like '%search_path%' from pg_proc where oid = 'core.cal_events_apply_page(text, uuid, jsonb, jsonb, text, text, boolean, text[])'::regprocedure),
          'still security definer with an empty search_path');

-- ---------------------------------------------------------------- the inventory: every function naming 'google' (the latest bodies)
select is((select array_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where p.prosrc ilike '%''google''%' and n.nspname in ('core', 'act', 'raw', 'comms', 'cal', 'brief', 'audit', 'mem', 'ops', 'public')),
  array['act.insert_proposal', 'core.briefing_coverage', 'core.cal_events_apply_page', 'core.comms_mail_apply_page', 'core.connection_activate_composio',
        'core.connection_token_store', 'core.home_calendar_status', 'core.mailbox_ids', 'core.oauth_state_consume', 'core.oauth_state_create', 'raw.is_content_provider'],
  'the functions naming google are exactly the inventoried ones (a new one must be added to docs/plan-review.md and here)');
select is((select array_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where p.prosrc ilike '%''google''%' and p.prosrc not ilike '%''microsoft''%' and n.nspname in ('core', 'act', 'raw', 'comms', 'cal', 'brief', 'audit', 'mem', 'ops', 'public')),
  array['core.connection_activate_composio', 'core.connection_token_store'],
  'every one of them also names microsoft except the two Composio duplicate checks (Google-only on purpose)');
select is((select count(*)::int from pg_views where definition ilike '%''google''%' and schemaname in ('core', 'act', 'raw', 'comms', 'cal', 'brief', 'audit', 'mem', 'ops', 'public')), 0,
  'no view names google (the connection and index views are provider-neutral)');
select is((select count(*)::int from pg_policies where (qual ilike '%''google''%' or with_check ilike '%''google''%') and schemaname in ('core', 'act', 'raw', 'comms', 'cal', 'brief', 'audit', 'mem', 'ops', 'public')), 0,
  'no row-level policy names google');

-- ---------------------------------------------------------------- the generalised readers accept a Microsoft connection (viewer = own mailbox 32201)
set local role service_role;
select is(core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032201', '[]'::jsonb,
  jsonb_build_array(jsonb_build_object('message_id', 'ms-v-1', 'from_address', 'a@example.test', 'subject', 'Viewer mail', 'received_at', now() - interval '1 hour',
    'is_read', false, 'is_important', true, 'folder', 'INBOX', 'labels', '[]'::jsonb, 'source_updated_at', now() - interval '1 hour')),
  null, 'm1.00000000-0000-4000-8000-000000032201.m:a', false), '{"removed": 0, "written": 1, "skipped": 0}'::jsonb, 'setup: the viewer''s Microsoft mailbox has a message');
select is(core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032204', '[]'::jsonb,
  jsonb_build_array(jsonb_build_object('message_id', 'ms-o-1', 'from_address', 'b@example.test', 'subject', 'Owner mail', 'received_at', now() - interval '1 hour',
    'is_read', false, 'is_important', true, 'folder', 'INBOX', 'labels', '[]'::jsonb, 'source_updated_at', now() - interval '1 hour')),
  null, 'm1.00000000-0000-4000-8000-000000032204.m:a', false), '{"removed": 0, "written": 1, "skipped": 0}'::jsonb, 'setup: the owner''s Microsoft mailbox has a message');
select is(core.cal_events_apply_page('APK', '00000000-0000-4000-8000-000000032203', '[]'::jsonb,
  jsonb_build_array(jsonb_build_object('calendar_id', 'AAMk-cal-a', 'event_id', 'AAMk-ev-a', 'title', 'APK MS meeting', 'start_at', now() + interval '1 hour',
    'end_at', now() + interval '2 hours', 'attendees', '[]'::jsonb, 'status', 'confirmed', 'source_updated_at', '2026-11-20T12:00:00.000Z')),
  'm1.00000000-0000-4000-8000-000000032203.c:x', 'm1.00000000-0000-4000-8000-000000032203.c:y', false), '{"removed": 0, "written": 1, "skipped": 0}'::jsonb, 'setup: the other lane''s Microsoft mailbox has an event');
select is(core.comms_mail_apply_page('APK', '00000000-0000-4000-8000-000000032203', '[]'::jsonb,
  jsonb_build_array(jsonb_build_object('message_id', 'ms-a-1', 'from_address', 'c@example.test', 'subject', 'APK mail', 'received_at', now() - interval '1 hour',
    'is_read', false, 'is_important', true, 'folder', 'INBOX', 'labels', '[]'::jsonb, 'source_updated_at', now() - interval '1 hour')),
  null, 'm1.00000000-0000-4000-8000-000000032203.m:a', false), '{"removed": 0, "written": 1, "skipped": 0}'::jsonb, 'setup: the other lane''s Microsoft mailbox has a message');
reset role;

select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is(core.mailbox_ids(pg_temp.uid('viewer@example.test'), 'PKG'), array['00000000-0000-4000-8000-000000032201']::uuid[], 'core.mailbox_ids: the viewer''s Microsoft mailbox, only theirs');
select is(core.mailbox_ids(pg_temp.uid('viewer@example.test'), 'APK'), '{}'::uuid[], 'core.mailbox_ids: nothing in a lane the viewer has no mail in');
select is(core.home_calendar_status('PKG'), 'connected', 'core.home_calendar_status: connected with only a Microsoft connection');
select is(core.home_calendar_status('APK'), 'no_access', 'core.home_calendar_status: another lane is no_access');
select is((select string_agg(stream || ':' || account || ':' || provider || ':' || status, ',' order by stream desc) from core.briefing_coverage('PKG')),
  'mail:viewer-t253@ms.example.test:microsoft:active,calendar:viewer-t253@ms.example.test:microsoft:active'
  , 'core.briefing_coverage: mail and calendar rows for the viewer''s Microsoft account, no one else''s');
select is((select count(*)::int from core.briefing_coverage('APK')), 0, 'core.briefing_coverage: another lane shows nothing');
select is((select array_agg(title) from core.home_meetings('PKG', now(), now() + interval '1 day')), array['Viewer MS meeting'], 'core.home_meetings: the viewer''s Microsoft event only');
select is((select array_agg(subject) from core.inbox_messages('PKG', 'all')), array['Viewer mail'], 'core.inbox_messages: the viewer''s Microsoft message only');
select is((select unread_important from core.home_mail_attention('PKG', now() - interval '1 day')), 1, 'core.home_mail_attention: counts the viewer''s Microsoft message only');
select is((select count(*)::int from core.home_meetings('APK', now(), now() + interval '1 day')), 0, 'core.home_meetings: another lane shows nothing');
select is((select count(*)::int from core.inbox_messages('APK', 'all')), 0, 'core.inbox_messages: another lane shows nothing');
select is((select count(*)::int from core.home_mail_attention('APK', now() - interval '1 day')), 0, 'core.home_mail_attention: another lane returns no row');
select is((select count(*)::int from core.home_meetings('APK', now(), now() + interval '1 day') where title = 'APK MS meeting')
        + (select count(*)::int from core.home_meetings('PKG', now(), now() + interval '1 day') where title = 'APK MS meeting'), 0, 'cross-lane: the viewer sees the APK event under neither lane');
select is((select count(*)::int from core.inbox_messages('APK', 'all') where subject = 'APK mail')
        + (select count(*)::int from core.inbox_messages('PKG', 'all') where subject = 'APK mail'), 0, 'cross-lane: the viewer sees the APK message under neither lane');
select ok(not ('00000000-0000-4000-8000-000000032203'::uuid = any (core.mailbox_ids(pg_temp.uid('viewer@example.test'), 'PKG') || core.mailbox_ids(pg_temp.uid('viewer@example.test'), 'APK'))), 'cross-lane: the APK Microsoft mailbox is not the viewer''s under either lane');
select is((select count(*)::int from core.briefing_coverage('PKG') where account = 'apk-t253@ms.example.test') + (select count(*)::int from core.briefing_coverage('APK') where account = 'apk-t253@ms.example.test'), 0, 'cross-lane: coverage names the APK account under neither lane');
select is((select unread_important from core.home_mail_attention('PKG', now() - interval '1 day')), 1, 'cross-lane: the viewer''s PKG attention count excludes the APK message');
-- briefing readers and message ref: the viewer's own Microsoft rows, no one else's
select is((select array_agg(title) from core.briefing_events('PKG', now(), now() + interval '1 day')), array['Viewer MS meeting'], 'core.briefing_events: the viewer''s Microsoft event only');
select is((select count(*)::int from core.briefing_events('APK', now(), now() + interval '1 day')), 0, 'core.briefing_events: another lane shows the viewer nothing (the APK event is not shown)');
select is((select array_agg(thread_key || '@' || connection_id::text) from core.briefing_threads('PKG', now() - interval '1 day')), array['m:ms-v-1@00000000-0000-4000-8000-000000032201'], 'core.briefing_threads: the viewer''s Microsoft thread only');
select is((select count(*)::int from core.briefing_threads('APK', now() - interval '1 day')), 0, 'core.briefing_threads: another lane shows the viewer nothing (the APK thread is not shown)');
select is((select array_agg(thread_key) from core.briefing_threads('PKG', now() - interval '1 day', pg_temp.uid('owner@example.test'))), array['m:ms-v-1'], 'core.briefing_threads: a signed-in caller naming another owner still gets only their own threads');
select is((select provider || ':' || connection_id::text from core.inbox_message_ref('PKG', 'ms-v-1')), 'microsoft:00000000-0000-4000-8000-000000032201', 'core.inbox_message_ref: the viewer''s own Microsoft message');
select is((select count(*)::int from core.inbox_message_ref('PKG', 'ms-o-1')), 0, 'core.inbox_message_ref: another user''s message is refused');
select is((select count(*)::int from core.inbox_message_ref('PKG', 'ms-a-1')) + (select count(*)::int from core.inbox_message_ref('APK', 'ms-a-1')), 0, 'core.inbox_message_ref: another lane''s message is refused under either lane');
select is((select count(*)::int from core.inbox_message_ref('APK', 'ms-v-1')), 0, 'core.inbox_message_ref: the viewer''s message is not found under another lane');
reset role;

-- another user with their own mail view in the lane but no mailbox of their own sees none of it
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is(core.mailbox_ids(pg_temp.uid('admin-technical@example.test'), 'PKG'), '{}'::uuid[], 'another user: core.mailbox_ids is empty (not the viewer''s or the owner''s mailbox)');
select is(core.home_calendar_status('PKG'), 'not_connected', 'another user: core.home_calendar_status is not_connected');
select is((select string_agg(stream || ':' || status, ',' order by stream desc) from core.briefing_coverage('PKG')), 'mail:not_configured,calendar:not_configured', 'another user: core.briefing_coverage names no Microsoft account');
select is((select count(*)::int from core.home_meetings('PKG', now(), now() + interval '1 day')), 0, 'another user: core.home_meetings shows nothing');
select is((select count(*)::int from core.inbox_messages('PKG', 'all')), 0, 'another user: core.inbox_messages shows nothing');
select is((select unread_important from core.home_mail_attention('PKG', now() - interval '1 day')), 0, 'another user: core.home_mail_attention counts nothing');
select is((select count(*)::int from core.briefing_events('PKG', now(), now() + interval '1 day')), 0, 'another user: core.briefing_events shows nothing');
select is((select count(*)::int from core.briefing_threads('PKG', now() - interval '1 day')), 0, 'another user: core.briefing_threads shows nothing');
select is((select count(*)::int from core.briefing_threads('PKG', now() - interval '1 day', pg_temp.uid('viewer@example.test'))), 0, 'another user naming the viewer as p_owner still gets nothing');
select is((select count(*)::int from core.inbox_message_ref('PKG', 'ms-v-1')) + (select count(*)::int from core.inbox_message_ref('PKG', 'ms-o-1')), 0, 'another user: core.inbox_message_ref finds neither the viewer''s nor the owner''s message');
reset role;

-- a member without own_mail
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is(core.home_calendar_status('PKG'), 'no_access', 'no own_mail: core.home_calendar_status is no_access');
select is((select count(*)::int from core.briefing_coverage('PKG')), 0, 'no own_mail: core.briefing_coverage shows nothing');
select is(core.mailbox_ids(pg_temp.uid('finance-operator@example.test'), 'PKG'), '{}'::uuid[], 'no own_mail: core.mailbox_ids is empty');
select is((select count(*)::int from core.briefing_events('PKG', now(), now() + interval '1 day')), 0, 'no own_mail: core.briefing_events shows nothing');
select is((select count(*)::int from core.briefing_threads('PKG', now() - interval '1 day')), 0, 'no own_mail: core.briefing_threads shows nothing');
select is((select count(*)::int from core.inbox_message_ref('PKG', 'ms-v-1')) + (select count(*)::int from core.inbox_message_ref('PKG', 'ms-o-1')), 0, 'no own_mail: core.inbox_message_ref finds nothing');
reset role;

-- AAL1
select pg_temp.claims('viewer@example.test', 'aal1');
set local role authenticated;
select is(core.home_calendar_status('PKG'), 'no_access', 'AAL1: core.home_calendar_status is no_access');
select is((select count(*)::int from core.briefing_coverage('PKG')), 0, 'AAL1: core.briefing_coverage shows nothing');
select is((select count(*)::int from core.home_mail_attention('PKG', now() - interval '1 day')), 0, 'AAL1: core.home_mail_attention returns no row');
select is((select count(*)::int from core.inbox_messages('PKG', 'all')), 0, 'AAL1: core.inbox_messages shows nothing (row-level policy)');
select is((select count(*)::int from core.home_meetings('PKG', now(), now() + interval '1 day')), 0, 'AAL1: core.home_meetings shows nothing (row-level policy)');
select is((select count(*)::int from core.briefing_events('PKG', now(), now() + interval '1 day')), 0, 'AAL1: core.briefing_events shows nothing');
select is((select count(*)::int from core.briefing_threads('PKG', now() - interval '1 day')), 0, 'AAL1: core.briefing_threads shows nothing');
select is((select count(*)::int from core.inbox_message_ref('PKG', 'ms-v-1')), 0, 'AAL1: core.inbox_message_ref finds nothing');
reset role;

-- the owner sees their own Microsoft rows, not the viewer's
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select array_agg(title order by title) from core.home_meetings('PKG', now(), now() + interval '1 day')), array['Google meeting', 'Owner MS meeting'], 'the owner: own Microsoft and Google events, not the viewer''s');
select is((select array_agg(subject) from core.inbox_messages('PKG', 'all')), array['Owner mail'], 'the owner: own Microsoft message, not the viewer''s');
select is((select string_agg(distinct account, ',' order by account) from core.briefing_coverage('PKG') where account is not null and status <> 'not_connected' and provider = 'microsoft'),
  'dead-t253@ms.example.test,robert-t253@ms.example.test'::text, 'the owner: coverage lists their own Microsoft accounts (the dead one too), never the viewer''s');
-- the owner's APK mailbox: shown under APK, absent under PKG
select is(core.mailbox_ids(pg_temp.uid('owner@example.test'), 'APK'), array['00000000-0000-4000-8000-000000032203']::uuid[], 'cross-lane: the owner''s APK mailbox is returned for APK');
select ok(not ('00000000-0000-4000-8000-000000032203'::uuid = any (core.mailbox_ids(pg_temp.uid('owner@example.test'), 'PKG'))), 'cross-lane: ...and not for PKG');
select is(core.home_calendar_status('APK'), 'connected', 'cross-lane: the owner''s APK calendar status is connected');
select is((select string_agg(distinct account, ',') from core.briefing_coverage('APK') where connection_id is not null), 'apk-t253@ms.example.test', 'cross-lane: coverage for APK names the APK account');
select is((select count(*)::int from core.briefing_coverage('PKG') where account = 'apk-t253@ms.example.test'), 0, 'cross-lane: coverage for PKG never names the APK account');
select is((select array_agg(title) from core.home_meetings('APK', now(), now() + interval '1 day')), array['APK MS meeting'], 'cross-lane: home_meetings for APK shows the APK event');
select is((select count(*)::int from core.home_meetings('PKG', now(), now() + interval '1 day') where title = 'APK MS meeting'), 0, 'cross-lane: ...and PKG does not');
select is((select array_agg(subject) from core.inbox_messages('APK', 'all')), array['APK mail'], 'cross-lane: inbox_messages for APK shows the APK message');
select is((select count(*)::int from core.inbox_messages('PKG', 'all') where subject = 'APK mail'), 0, 'cross-lane: ...and PKG does not');
select is((select unread_important from core.home_mail_attention('APK', now() - interval '1 day')), 1, 'cross-lane: home_mail_attention for APK counts the APK message');
select is((select unread_important from core.home_mail_attention('PKG', now() - interval '1 day')), 1, 'cross-lane: home_mail_attention for PKG counts only the PKG message (would be 2 on a leak)');
-- briefing readers and message ref
select is((select array_agg(title order by title) from core.briefing_events('PKG', now(), now() + interval '1 day')), array['Google meeting', 'Owner MS meeting'], 'core.briefing_events: the owner''s PKG events, not the viewer''s or the APK one');
select is((select array_agg(title) from core.briefing_events('APK', now(), now() + interval '1 day')), array['APK MS meeting'], 'core.briefing_events: the APK event under APK');
select is((select array_agg(thread_key) from core.briefing_threads('PKG', now() - interval '1 day')), array['m:ms-o-1'], 'core.briefing_threads: the owner''s PKG Microsoft thread only');
select is((select array_agg(thread_key) from core.briefing_threads('APK', now() - interval '1 day')), array['m:ms-a-1'], 'core.briefing_threads: the APK thread under APK');
select is((select provider || ':' || connection_id::text from core.inbox_message_ref('PKG', 'ms-o-1')), 'microsoft:00000000-0000-4000-8000-000000032204', 'core.inbox_message_ref: the owner''s own Microsoft message');
select is((select provider || ':' || connection_id::text from core.inbox_message_ref('APK', 'ms-a-1')), 'microsoft:00000000-0000-4000-8000-000000032203', 'core.inbox_message_ref: the owner''s APK message under APK');
select is((select count(*)::int from core.inbox_message_ref('PKG', 'ms-a-1')), 0, 'core.inbox_message_ref: the APK message is not found under PKG');
select is((select count(*)::int from core.inbox_message_ref('PKG', 'ms-v-1')) + (select count(*)::int from core.inbox_message_ref('APK', 'ms-v-1')), 0, 'core.inbox_message_ref: the viewer''s message is refused to the owner');
reset role;

-- the job path: service_role names the owner (p_owner) and gets that person's Microsoft rows only
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select is((select array_agg(thread_key) from core.briefing_threads('PKG', now() - interval '1 day', pg_temp.uid('viewer@example.test'))), array['m:ms-v-1'], 'job path: core.briefing_threads for the viewer returns the viewer''s Microsoft thread');
select is((select array_agg(title) from core.briefing_events('PKG', now(), now() + interval '1 day', pg_temp.uid('viewer@example.test'))), array['Viewer MS meeting'], 'job path: core.briefing_events for the viewer returns the viewer''s Microsoft event');
select is((select array_agg(thread_key) from core.briefing_threads('PKG', now() - interval '1 day', pg_temp.uid('owner@example.test'))), array['m:ms-o-1'], 'job path: naming the owner does not return the viewer''s thread');
select is((select array_agg(title order by title) from core.briefing_events('PKG', now(), now() + interval '1 day', pg_temp.uid('owner@example.test'))), array['Google meeting', 'Owner MS meeting'], 'job path: naming the owner does not return the viewer''s event');
select is((select count(*)::int from core.briefing_threads('APK', now() - interval '1 day', pg_temp.uid('viewer@example.test'))) + (select count(*)::int from core.briefing_events('APK', now(), now() + interval '1 day', pg_temp.uid('viewer@example.test'))), 0, 'job path: the viewer in another lane returns nothing');
select is((select array_agg(thread_key) from core.briefing_threads('APK', now() - interval '1 day', pg_temp.uid('owner@example.test'))), array['m:ms-a-1'], 'job path: the owner in APK returns the APK thread');
select is((select count(*)::int from core.briefing_threads('PKG', now() - interval '1 day', pg_temp.uid('finance-operator@example.test'))) + (select count(*)::int from core.briefing_events('PKG', now(), now() + interval '1 day', pg_temp.uid('finance-operator@example.test'))), 0, 'job path: a user without own_mail returns nothing');
select is((select count(*)::int from core.briefing_threads('PKG', now() - interval '1 day')) + (select count(*)::int from core.briefing_events('PKG', now(), now() + interval '1 day')), 0, 'job path: no owner named, nothing');
reset role;

-- ---------------------------------------------------------------- failure and sync streams treat a Microsoft connection like a Google one
set local role service_role;
select is((select consecutive_failures from core.job_failure_record('PKG', 'mail-ingest-delta', '00000000-0000-4000-8000-000000032201', 'timeout')), 1, 'core.job_failure_record: a Microsoft connection starts a streak');
select is((select consecutive_failures from core.job_failure_record('PKG', 'mail-ingest-delta', '00000000-0000-4000-8000-000000032201', 'timeout')), 2, '...and counts the next failure');
select is((select consecutive_failures from core.job_failure_record('APK', 'mail-ingest-delta', '00000000-0000-4000-8000-000000032201', 'timeout')), 0, 'cross-lane: another lane''s name for the connection starts no streak');
select is((select consecutive_failures from core.job_failure_record('PKG', 'mail-ingest-delta', '00000000-0000-4000-8000-000000032205', 'timeout')), 0, 'a reconnect_required Microsoft connection starts no streak');
select is((select count(*)::int from core.job_failures where lane_id = 'APK' and connection_id = '00000000-0000-4000-8000-000000032201'), 0, 'nothing was recorded in the other lane');
select lives_ok($$select core.job_failure_clear('PKG', 'mail-ingest-delta', '00000000-0000-4000-8000-000000032201')$$, 'core.job_failure_clear: resets the Microsoft streak');
select is((select consecutive_failures from core.job_failures where lane_id = 'PKG' and function_id = 'mail-ingest-delta' and connection_id = '00000000-0000-4000-8000-000000032201'), 0, '...to zero');
select is((select consecutive_failures from core.job_failure_record('PKG', 'cal-ingest-delta', '00000000-0000-4000-8000-000000032201', 'timeout')), 1, 'the calendar job has its own streak for the same Microsoft connection');
reset role;
update core.connections set status = 'reconnect_required' where id = '00000000-0000-4000-8000-000000032201';
select is((select count(*)::int from core.job_failures where lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000032201'), 0, 'a Microsoft connection that leaves active drops its streaks (trigger)');
update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000032201';

-- sync-now is lane-level and provider-neutral: a lane with Microsoft connections only is claimed like any other
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((core.sync_now_claim('PKG') ->> 'ok')::boolean, true, 'core.sync_now_claim: the owner claims a sync in a lane of Microsoft connections');
reset role;
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.sync_now_claim('PKG')$$, '42501', null, 'core.sync_now_claim: a viewer is refused');
reset role;
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select throws_ok($$select core.sync_now_claim('PKG')$$, '42501', null, 'core.sync_now_claim: AAL1 is refused');
reset role;

-- the generic cursor reader sees a Microsoft connection in its own lane only
set local role service_role;
select is(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000032201', 'mail'), 'm1.00000000-0000-4000-8000-000000032201.m:a', 'core.sync_cursor_get: a Microsoft connection''s mail cursor is read');
select throws_ok($$select core.sync_cursor_get('APK', '00000000-0000-4000-8000-000000032201', 'mail')$$, '42501', null, 'core.sync_cursor_get: cross-lane is refused');
reset role;

select * from finish();
rollback;
