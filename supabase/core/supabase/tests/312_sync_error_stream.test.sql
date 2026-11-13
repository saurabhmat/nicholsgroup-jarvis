-- T-238 review fix (H1): core.connections.last_error_stream and core.briefing_coverage per stream.
-- Covered: the check (mail | calendar | null), the trigger (clearing last_error clears the tag), coverage shows an error only on
-- its own stream (a calendar error is not a mail error, and the reverse), a whole-connection error (null tag) shows on both, the
-- trigger function is not executable by API roles, denial for another lane is unchanged, and (M1) a connection leaving
-- active/degraded drops its job_failures rows (other connections, lane-wide rows and other lanes keep theirs).
begin;
select plan(19);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');

insert into core.connections (id, lane_id, provider, external_account_id, status, last_error, last_error_stream) values
  ('00000000-0000-4000-8000-000000003121', 'PKG', 'google', 'stream-pkg@example.test', 'active',
   '{"kind": "forbidden", "message": "Calendar access was refused", "disposition": "fail", "endpoint": null, "http_status": 403, "provider_error_code": null, "provider_tid": null, "retry_after_seconds": null}'::jsonb,
   'calendar'),
  ('00000000-0000-4000-8000-000000003122', 'APK', 'google', 'stream-apk@example.test', 'active',
   '{"kind": "timeout", "message": "t", "disposition": "retry", "endpoint": null, "http_status": null, "provider_error_code": null, "provider_tid": null, "retry_after_seconds": null}'::jsonb,
   'mail');

-- ---------------------------------------------------------------- shape
select throws_ok($$update core.connections set last_error_stream = 'documents' where id = '00000000-0000-4000-8000-000000003121'$$,
                 '23514', null, 'last_error_stream is only mail, calendar or null');
select ok(not has_function_privilege('authenticated', 'core.connections_clear_error_stream()', 'execute')
          and not has_function_privilege('anon', 'core.connections_clear_error_stream()', 'execute'), 'API roles cannot execute the trigger function');

-- ---------------------------------------------------------------- coverage per stream (owner, aal2)
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select error_kind from core.briefing_coverage('PKG') where account = 'stream-pkg@example.test' and stream = 'calendar'), 'forbidden',
          'a calendar error shows on the calendar row');
select is((select error_kind from core.briefing_coverage('PKG') where account = 'stream-pkg@example.test' and stream = 'mail'), null,
          'a calendar error is NOT shown as a mail error');
select is((select count(*)::int from core.briefing_coverage('PKG') where account = 'stream-apk@example.test'), 0,
          'cross-lane: another lane''s connection is not listed');
select is((select count(*)::int from core.briefing_coverage('APK')), 0, 'cross-lane: no coverage rows for a lane the owner is not a member of');
reset role;

-- The reverse: a mail error on the mail row only.
update core.connections set last_error_stream = 'mail' where id = '00000000-0000-4000-8000-000000003121';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select string_agg(stream || '=' || coalesce(error_kind, '-'), ',' order by stream) from core.briefing_coverage('PKG') where account = 'stream-pkg@example.test'),
          'calendar=-,mail=forbidden', 'a mail error shows on the mail row only');
reset role;

-- A whole-connection error (no tag) shows on both rows.
update core.connections set last_error_stream = null where id = '00000000-0000-4000-8000-000000003121';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select string_agg(stream || '=' || coalesce(error_kind, '-'), ',' order by stream) from core.briefing_coverage('PKG') where account = 'stream-pkg@example.test'),
          'calendar=forbidden,mail=forbidden', 'an untagged error shows on both streams');
reset role;

-- ---------------------------------------------------------------- trigger: the tag never outlives its error
update core.connections set last_error_stream = 'calendar' where id = '00000000-0000-4000-8000-000000003121';
update core.connections set last_error = null where id = '00000000-0000-4000-8000-000000003121';
select is((select last_error_stream from core.connections where id = '00000000-0000-4000-8000-000000003121'), null,
          'clearing last_error clears last_error_stream (any writer: sync, reconnect, token health)');
update core.connections set last_error_stream = 'mail' where id = '00000000-0000-4000-8000-000000003121';
select is((select last_error_stream from core.connections where id = '00000000-0000-4000-8000-000000003121'), null,
          'a tag cannot be set without an error');
select is((select last_error_stream from core.connections where id = '00000000-0000-4000-8000-000000003122'), 'mail',
          'the other lane''s row is untouched');

-- ---------------------------------------------------------------- M1: failure rows of a connection that is no longer synced
insert into core.job_failures (lane_id, function_id, connection_id, consecutive_failures, alerted_at) values
  ('PKG', 'conn-sync.mail', '00000000-0000-4000-8000-000000003121', 3, now()),
  ('PKG', 'mail-ingest-delta', '', 3, now()),
  ('APK', 'conn-sync.mail', '00000000-0000-4000-8000-000000003122', 3, now());
update core.connections set status = 'degraded' where id = '00000000-0000-4000-8000-000000003121';
select is((select count(*)::int from core.job_failures where connection_id = '00000000-0000-4000-8000-000000003121'), 1,
          'active -> degraded keeps the streak (still synced)');
update core.connections set status = 'disconnected' where id = '00000000-0000-4000-8000-000000003121';
select is((select count(*)::int from core.job_failures where connection_id = '00000000-0000-4000-8000-000000003121'), 0,
          'leaving the syncable states drops that connection''s failure rows (the banner cannot stick)');
select is((select count(*)::int from core.job_failures where (lane_id, connection_id) in (('PKG', ''), ('APK', '00000000-0000-4000-8000-000000003122'))), 2,
          'lane-wide rows and other lanes are untouched');

-- ---------------------------------------------------------------- the production path: service_role updates fire both triggers
update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000003121';
update core.connections set last_error = '{"kind": "timeout", "message": "t", "disposition": "retry", "endpoint": null, "http_status": null, "provider_error_code": null, "provider_tid": null, "retry_after_seconds": null}'::jsonb,
                            last_error_stream = 'calendar' where id = '00000000-0000-4000-8000-000000003121';
insert into core.job_failures (lane_id, function_id, connection_id, consecutive_failures, alerted_at) values
  ('PKG', 'conn-sync.calendar', '00000000-0000-4000-8000-000000003121', 3, now());
set local role service_role;
update core.connections set last_error = null where id = '00000000-0000-4000-8000-000000003121';
update core.connections set status = 'reconnect_required' where id = '00000000-0000-4000-8000-000000003121';
reset role;
select is((select last_error_stream from core.connections where id = '00000000-0000-4000-8000-000000003121'), null, 'service_role clearing last_error clears the tag');
select is((select count(*)::int from core.job_failures where connection_id = '00000000-0000-4000-8000-000000003121'), 0, 'service_role moving the status drops the failure rows');

-- ---------------------------------------------------------------- M-1: no streak for a connection that is not syncable or not the lane's
set local role service_role;
select is((select consecutive_failures from core.job_failure_record('PKG', 'conn-sync.mail', '00000000-0000-4000-8000-000000003121', 'reconnect_required')), 0,
          'a failure of a connection that is no longer synced records nothing');
select is((select consecutive_failures from core.job_failure_record('PKG', 'conn-sync.mail', '00000000-0000-4000-8000-000000003122', 'timeout')), 0,
          'a connection of another lane records nothing (connection bound to its lane)');
reset role;
select is((select count(*)::int from core.job_failures where connection_id in ('00000000-0000-4000-8000-000000003121', '00000000-0000-4000-8000-000000003122') and function_id = 'conn-sync.mail' and consecutive_failures > 0 and lane_id = 'PKG'), 0,
          '...and no row was written');

select * from finish();
rollback;
