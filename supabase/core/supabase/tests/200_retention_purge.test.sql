-- Retention purge entry points (T-042): core.retention_comms_purge / retention_cal_purge (wrappers over the T-061
-- functions, comms/cal are not exposed to the API) and core.source_records_purge_bodies (T-039 note). Covered: privileges
-- (service_role only), time-shifted fixtures at the boundary (expired vs kept) in two lanes, a purge for one lane never
-- deletes the other lane's rows, floors and caps still enforced through the wrapper, a disabled lane refused, the body
-- purge only when store_content_bodies is off, metadata-only and non-content records kept.
begin;
select plan(37);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
update core.lane_policies set retention_days = 90 where lane_id = 'PKG';
update core.lane_policies set retention_days = 30 where lane_id = 'APK';
update core.lane_policies set store_content_bodies = true where lane_id in ('PKG', 'APK');

-- ---------------------------------------------------------------- privileges
select ok(has_function_privilege('service_role', 'core.retention_comms_purge(text, interval)', 'execute')
          and has_function_privilege('service_role', 'core.retention_cal_purge(text, interval)', 'execute')
          and has_function_privilege('service_role', 'core.source_records_purge_bodies(text)', 'execute'),
          'service_role executes the three entry points');
select ok(not has_function_privilege('authenticated', 'core.retention_comms_purge(text, interval)', 'execute')
          and not has_function_privilege('anon', 'core.retention_comms_purge(text, interval)', 'execute')
          and not has_function_privilege('authenticated', 'core.retention_cal_purge(text, interval)', 'execute')
          and not has_function_privilege('anon', 'core.retention_cal_purge(text, interval)', 'execute')
          and not has_function_privilege('authenticated', 'core.source_records_purge_bodies(text)', 'execute')
          and not has_function_privilege('anon', 'core.source_records_purge_bodies(text)', 'execute'),
          'authenticated and anon execute none of them');
select is((select prosecdef from pg_proc where oid = 'core.source_records_purge_bodies(text)'::regprocedure), true, 'the body purge is security definer (raw has no grants)');
select is((select prosecdef from pg_proc where oid = 'core.retention_comms_purge(text, interval)'::regprocedure)
          or (select prosecdef from pg_proc where oid = 'core.retention_cal_purge(text, interval)'::regprocedure), false, 'the comms and calendar wrappers are security invoker');

-- ---------------------------------------------------------------- fixtures (two lanes, time-shifted)
insert into core.connections (id, lane_id, provider, external_account_id, status) values
  ('00000000-0000-4000-8000-000000000421', 'PKG', 'google', 'ret-pkg@example.test', 'active'),
  ('00000000-0000-4000-8000-000000000422', 'APK', 'google', 'ret-apk@example.test', 'active'),
  ('00000000-0000-4000-8000-000000000423', 'PKG', 'quickbooks', 'realm-ret-42', 'active');

set local session_replication_role = replica;
insert into comms.message_index (lane_id, connection_id, provider, message_id, received_at) values
  ('PKG', '00000000-0000-4000-8000-000000000421', 'google', 'p-89', now() - interval '89 days'),
  ('PKG', '00000000-0000-4000-8000-000000000421', 'google', 'p-91', now() - interval '91 days'),
  ('PKG', '00000000-0000-4000-8000-000000000421', 'google', 'p-400', now() - interval '400 days'),
  ('APK', '00000000-0000-4000-8000-000000000422', 'google', 'a-29', now() - interval '29 days'),
  ('APK', '00000000-0000-4000-8000-000000000422', 'google', 'a-31', now() - interval '31 days'),
  ('APK', '00000000-0000-4000-8000-000000000422', 'google', 'a-400', now() - interval '400 days');
insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, start_at, end_at) values
  ('PKG', '00000000-0000-4000-8000-000000000421', 'google', 'primary', 'p-179', now() - interval '179 days', now() - interval '179 days'),
  ('PKG', '00000000-0000-4000-8000-000000000421', 'google', 'primary', 'p-181', now() - interval '181 days', now() - interval '181 days'),
  ('APK', '00000000-0000-4000-8000-000000000422', 'google', 'primary', 'a-179', now() - interval '179 days', now() - interval '179 days'),
  ('APK', '00000000-0000-4000-8000-000000000422', 'google', 'primary', 'a-181', now() - interval '181 days', now() - interval '181 days'),
  ('APK', '00000000-0000-4000-8000-000000000422', 'google', 'primary', 'a-100', now() - interval '100 days', now() - interval '100 days');
set local session_replication_role = origin;

-- ---------------------------------------------------------------- comms: lane policy cap, boundary, lane isolation
set local role service_role;
select is(core.retention_comms_purge('PKG', interval '90 days'), 2, 'PKG comms purge at 90 days deletes the 91 and 400 day rows');
select is((select array_agg(message_id order by message_id) from comms.message_index where lane_id = 'PKG'), array['p-89'], 'the 89-day-old PKG message is kept');
select is((select count(*)::int from comms.message_index where lane_id = 'APK'), 3, 'the PKG purge did not touch APK');
select is(core.retention_comms_purge('APK', interval '30 days'), 2, 'APK comms purge at 30 days deletes the 31 and 400 day rows');
select is((select array_agg(message_id) from comms.message_index where lane_id = 'APK'), array['a-29'], 'the 29-day-old APK message is kept');
select is((select count(*)::int from comms.message_index where lane_id = 'PKG'), 1, 'the APK purge did not touch PKG');
select is(core.retention_comms_purge('APK', interval '3650 days'), 0, 'a longer interval is capped at the lane policy (APK 30 days), nothing more is kept');
select throws_ok($$select core.retention_comms_purge('PKG', interval '1 hour')$$, '22023', null, 'the floor of one day still applies');
select throws_ok($$select core.retention_comms_purge('PKG', null)$$, '22004', null, 'an interval is required');
select throws_ok($$select core.retention_comms_purge(null, interval '90 days')$$, '22004', null, 'a lane is required');
reset role;

-- ---------------------------------------------------------------- calendar: boundary, cap 180, floor 30, lane isolation
set local role service_role;
select is(core.retention_cal_purge('PKG', interval '180 days'), 1, 'PKG calendar purge at 180 days deletes the 181-day event only');
select is((select array_agg(event_id) from cal.event_index where lane_id = 'PKG'), array['p-179'], 'the 179-day PKG event is kept');
select is((select count(*)::int from cal.event_index where lane_id = 'APK'), 3, 'the PKG calendar purge did not touch APK');
select is(core.retention_cal_purge('APK', interval '150 days'), 2, 'a shorter keep (150 days) deletes the 179 and 181 day APK events');
select is((select array_agg(event_id) from cal.event_index where lane_id = 'APK'), array['a-100'], 'the 100-day APK event is kept');
select is((select count(*)::int from cal.event_index where lane_id = 'PKG'), 1, 'the APK calendar purge did not touch PKG');
select throws_ok($$select core.retention_cal_purge('PKG', interval '5 days')$$, '22023', null, 'the 30-day floor still applies');
select is(core.retention_cal_purge('PKG', interval '3650 days'), 0, 'a longer interval is capped at 180 days');
select throws_ok($$select core.retention_cal_purge('PKG', null)$$, '22004', null, 'an interval is required');
reset role;

-- a disabled lane is refused by all three
update core.lanes set enabled = false where code = 'APK';
set local role service_role;
select throws_ok($$select core.retention_comms_purge('APK', interval '30 days')$$, '42501', null, 'comms purge refuses a disabled lane');
select throws_ok($$select core.retention_cal_purge('APK', interval '90 days')$$, '42501', null, 'calendar purge refuses a disabled lane');
select throws_ok($$select core.source_records_purge_bodies('APK')$$, '42501', null, 'body purge refuses a disabled lane');
select throws_ok($$select core.source_records_purge_bodies('ZZZ')$$, '42501', null, 'body purge refuses an unknown lane');
reset role;
update core.lanes set enabled = true where code = 'APK';

-- ---------------------------------------------------------------- raw bodies: purged only when store_content_bodies is off
set local role service_role;
select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000421', $j$[
  {"object_type": "Message", "external_id": "pkg-body", "payload": {"id": "pkg-body", "body": {"content": "synthetic"}}, "synced_at": "2026-11-03T10:00:00Z"},
  {"object_type": "Message", "external_id": "pkg-meta", "payload": {"id": "pkg-meta", "subject": "synthetic", "labels": ["INBOX"]}, "synced_at": "2026-11-03T10:00:00Z"}
]$j$);
select core.source_records_upsert('APK', '00000000-0000-4000-8000-000000000422', $j$[
  {"object_type": "Message", "external_id": "apk-body", "payload": {"id": "apk-body", "snippet": "synthetic"}, "synced_at": "2026-11-03T10:00:00Z"}
]$j$);
select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000423', $j$[
  {"object_type": "Invoice", "external_id": "pkg-inv", "payload": {"Id": "pkg-inv", "PrivateNote": "synthetic"}, "synced_at": "2026-11-03T10:00:00Z"}
]$j$);
select is(core.source_records_purge_bodies('PKG'), 0, 'with store_content_bodies on, nothing is purged');
reset role;
select is((select count(*)::int from raw.source_records), 4, 'all four raw records are still there');

update core.lane_policies set store_content_bodies = false where lane_id = 'PKG';
set local role service_role;
select is(core.source_records_purge_bodies('PKG'), 1, 'with the policy off, only the PKG record that carries a body is deleted');
select is(core.source_records_purge_bodies('PKG'), 0, 'a second run deletes nothing');
reset role;
select is((select array_agg(external_id order by external_id) from raw.source_records), array['apk-body', 'pkg-inv', 'pkg-meta'],
          'the PKG metadata record, the non-content provider record and the APK record (policy still on) are kept');

update core.lane_policies set store_content_bodies = false where lane_id = 'APK';
set local role service_role;
select is(core.source_records_purge_bodies('APK'), 1, 'APK purge deletes its own body record');
reset role;
select is((select count(*)::int from raw.source_records where lane_id = 'PKG'), 2, 'the APK purge did not touch PKG');

-- a lane with no policy row counts as "bodies off" (as the write trigger does), and its comms purge is refused
update core.lane_policies set store_content_bodies = true where lane_id = 'APK';
set local role service_role;
select core.source_records_upsert('APK', '00000000-0000-4000-8000-000000000422', $j$[
  {"object_type": "Message", "external_id": "apk-body-2", "payload": {"id": "apk-body-2", "snippet": "synthetic"}, "synced_at": "2026-11-03T10:00:00Z"}
]$j$);
reset role;
delete from core.lane_policies where lane_id = 'APK';
set local role service_role;
select is(core.source_records_purge_bodies('APK'), 1, 'no policy row: the APK body record is purged (fails closed)');
select throws_ok($$select core.retention_comms_purge('APK', interval '30 days')$$, '22023', null, 'no policy row: the comms purge is refused');
reset role;
select is((select count(*)::int from raw.source_records where lane_id = 'PKG'), 2, 'and PKG is still untouched');

select * from finish();
rollback;
