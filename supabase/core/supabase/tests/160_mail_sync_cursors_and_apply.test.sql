-- Gmail metadata sync persistence (T-063): core.sync_cursors and core.comms_mail_apply_page / sync_cursor_get / _reset.
-- Covered: privileges (service_role only through definer functions), the standard lane policy on 'health', cursor
-- withheld from the API, apply (insert, update, idempotent replay, stale version skipped, removal, remove-then-re-add,
-- same-page duplicate ids, classifier columns untouched), atomicity (a bad row rolls back removals and cursor), lane and
-- provider checks (cross-lane, QuickBooks, reconnect_required, disabled lane), size limits, and cross-lane/anon denial.
begin;
select plan(67);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
insert into core.connections (id, lane_id, provider, external_account_id, status) values
  ('00000000-0000-4000-8000-000000000631', 'PKG', 'google', 'exec-sync@example.test', 'active'),
  ('00000000-0000-4000-8000-000000000632', 'APK', 'google', 'apk-sync@example.test', 'active'),
  ('00000000-0000-4000-8000-000000000633', 'PKG', 'quickbooks', 'realm-sync-63', 'active'),
  ('00000000-0000-4000-8000-000000000634', 'PKG', 'google', 'dead-sync@example.test', 'reconnect_required');

-- ---------------------------------------------------------------- shape and privileges
select has_table('core', 'sync_cursors', 'core.sync_cursors exists');
select has_column('core', 'sync_cursors', 'lane_id', 'sync_cursors has lane_id');
select pg_temp.has_standard_lane_policy('core.sync_cursors', 'health');
select ok(not has_table_privilege('service_role', 'core.sync_cursors', 'select, insert, update, delete')
          and not has_table_privilege('anon', 'core.sync_cursors', 'select, insert, update, delete')
          and not has_table_privilege('authenticated', 'core.sync_cursors', 'insert, update, delete'),
          'no role writes the cursor table directly; service_role has no table grants');
select ok(not has_column_privilege('authenticated', 'core.sync_cursors', 'cursor_value', 'select'), 'the cursor text is not readable through the API');
select ok(has_function_privilege('service_role', 'core.comms_mail_apply_page(text, uuid, jsonb, jsonb, text, text, boolean, boolean)', 'execute')
          and has_function_privilege('service_role', 'core.sync_cursor_get(text, uuid, text)', 'execute')
          and has_function_privilege('service_role', 'core.sync_cursor_reset(text, uuid, text)', 'execute'),
          'service_role executes the three functions');
select ok(not has_function_privilege('authenticated', 'core.comms_mail_apply_page(text, uuid, jsonb, jsonb, text, text, boolean, boolean)', 'execute')
          and not has_function_privilege('anon', 'core.comms_mail_apply_page(text, uuid, jsonb, jsonb, text, text, boolean, boolean)', 'execute')
          and not has_function_privilege('authenticated', 'core.sync_cursor_get(text, uuid, text)', 'execute')
          and not has_function_privilege('authenticated', 'core.sync_cursor_reset(text, uuid, text)', 'execute')
          and not has_function_privilege('anon', 'core.sync_cursor_reset(text, uuid, text)', 'execute'),
          'authenticated and anon execute none of them');

-- ---------------------------------------------------------------- apply: insert
set local role service_role;
select is(core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '[]'::jsonb,
  $$[{"message_id": "m-1", "thread_id": "t-1", "source_url": "https://mail.example.test/m-1", "from_address": "a@example.test", "from_name": "A Sender",
      "to_recipients": [{"address": "exec-sync@example.test", "name": "Exec"}], "cc_recipients": [], "subject": "First",
      "received_at": "2026-10-01T12:00:00.000Z", "is_read": false, "is_starred": false, "is_important": true, "has_attachments": false,
      "folder": "INBOX", "labels": ["INBOX", "IMPORTANT"], "source_updated_at": "2026-10-01T12:00:00.000Z"},
     {"message_id": "m-2", "thread_id": "t-2", "source_url": null, "from_address": null, "from_name": null, "to_recipients": [], "cc_recipients": [],
      "subject": null, "received_at": "2026-10-02T12:00:00.000Z", "is_read": true, "is_starred": true, "is_important": false, "has_attachments": true,
      "folder": null, "labels": [], "source_updated_at": "2026-10-02T12:00:00.000Z"}]$$::jsonb,
  null, 'h:100', false, false), '{"removed": 0, "written": 2, "skipped": 0}'::jsonb, 'a page inserts its messages');
select is(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000000631', 'mail'), 'h:100', 'the cursor was stored with the page');
select is((select labels from comms.message_index where message_id = 'm-1' and lane_id = 'PKG'), array['INBOX', 'IMPORTANT'], 'labels are stored');
select is((select provider || ':' || lane_id from comms.message_index where message_id = 'm-1' and lane_id = 'PKG'), 'google:PKG', 'provider and lane come from the call, not the payload');
select is((select last_sync_at is null from core.connections where id = '00000000-0000-4000-8000-000000000631'), true, 'last_sync_at is set only when the run completes');

-- ---------------------------------------------------------------- classifier columns survive an update; replay is idempotent
update comms.message_index set priority_score = 80, classified_at = now(), classifier_model = 'synthetic-model', needs_reply = true
 where message_id = 'm-1' and lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000000631';
select is(core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '[]'::jsonb,
  $$[{"message_id": "m-1", "thread_id": "t-1", "source_url": "https://mail.example.test/m-1", "from_address": "a@example.test", "from_name": "A Sender",
      "to_recipients": [], "cc_recipients": [], "subject": "First, relabelled", "received_at": "2026-10-01T12:00:00.000Z", "is_read": true, "is_starred": false,
      "is_important": true, "has_attachments": false, "folder": null, "labels": ["IMPORTANT"], "source_updated_at": "2026-10-01T12:00:00.000Z"}]$$::jsonb,
  'h:100', 'h:101', true, false), '{"removed": 0, "written": 1, "skipped": 0}'::jsonb, 'an equal source_updated_at is applied (labels change without a new timestamp)');
select is((select subject || '/' || is_read::text || '/' || priority_score::text || '/' || needs_reply::text from comms.message_index where message_id = 'm-1' and lane_id = 'PKG'),
          'First, relabelled/true/80/true', 'metadata updated; classifier columns untouched');
select ok((select last_sync_at is not null from core.connections where id = '00000000-0000-4000-8000-000000000631'), 'a complete run sets last_sync_at');
reset role;
select is((select cursor_value from core.sync_cursors where connection_id = '00000000-0000-4000-8000-000000000631' and stream = 'mail'), 'h:101', 'the cursor advanced');
set local role service_role;

-- ---------------------------------------------------------------- stale version skipped
select is(core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '[]'::jsonb,
  $$[{"message_id": "m-1", "thread_id": "t-1", "from_address": "a@example.test", "to_recipients": [], "cc_recipients": [], "subject": "OLDER",
      "received_at": "2026-10-01T12:00:00.000Z", "labels": [], "source_updated_at": "2026-09-30T12:00:00.000Z"}]$$::jsonb,
  'h:101', 'h:102', false, false), '{"removed": 0, "written": 0, "skipped": 1}'::jsonb, 'an older version does not replace a newer row');
select is((select subject from comms.message_index where message_id = 'm-1' and lane_id = 'PKG'), 'First, relabelled', 'the row kept its newer content');

-- ---------------------------------------------------------------- removal, re-add, duplicates in one page
select is(core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '["m-2", "never-indexed"]'::jsonb, '[]'::jsonb, 'h:102', 'h:103', false, false),
          '{"removed": 1, "written": 0, "skipped": 0}'::jsonb, 'a removal flags the row (an unknown id is ignored)');
select is((select deleted from comms.message_index where message_id = 'm-2' and lane_id = 'PKG'), true, 'm-2 is flagged deleted, not removed');
select is(core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '[]'::jsonb,
  $$[{"message_id": "m-2", "received_at": "2026-10-02T12:00:00.000Z", "subject": "back", "source_updated_at": "2026-10-02T12:00:00.000Z", "labels": []},
     {"message_id": "m-3", "received_at": "2026-10-03T12:00:00.000Z", "subject": "dup first", "source_updated_at": "2026-10-03T12:00:00.000Z", "labels": []},
     {"message_id": "m-3", "received_at": "2026-10-03T12:00:00.000Z", "subject": "dup last", "source_updated_at": "2026-10-03T12:00:00.000Z", "labels": ["INBOX"]}]$$::jsonb,
  'h:103', 'h:104', false, true), '{"removed": 0, "written": 2, "skipped": 0}'::jsonb, 'a re-added id is written; duplicate ids in one page collapse to the last');
select is((select deleted from comms.message_index where message_id = 'm-2' and lane_id = 'PKG'), false, 'a later upsert clears the deleted flag');
select is((select subject from comms.message_index where message_id = 'm-3' and lane_id = 'PKG'), 'dup last', 'the last duplicate wins');
select is((select count(*)::int from comms.message_index where lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000000631'), 3, 'three messages indexed');

-- ---------------------------------------------------------------- atomicity: one bad row rolls back removals and the cursor
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '["m-3"]'::jsonb,
  '[{"message_id": "m-9", "received_at": "2026-10-04T12:00:00.000Z", "to_recipients": [{"address": "a@example.test", "body": "x"}], "labels": []}]'::jsonb, 'h:104', 'h:999', false, false)$$,
  '23514', null, 'a record that breaks a table check fails the whole page');
select is((select deleted from comms.message_index where message_id = 'm-3' and lane_id = 'PKG'), false, 'the removal in the failed page was rolled back');
select is(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000000631', 'mail'), 'h:104', 'the cursor did not advance on failure');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '[]'::jsonb,
  '[{"message_id": "m-9", "received_at": "2026-10-04T12:00:00.000Z", "labels": []}]'::jsonb, 'h:104', 'bad' || chr(10) || 'cursor', false, false)$$,
  '23514', null, 'a cursor with control characters is refused');

-- ---------------------------------------------------------------- cursor compare-and-swap and revive (T-063 review)
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '["m-3"]'::jsonb, '[]'::jsonb, 'h:50', 'h:105', false, false)$$,
  'D0409', null, 'a page started from a cursor that is no longer the stored one is refused (stale or concurrent run)');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '[]'::jsonb, '[]'::jsonb, null, 'h:105', false, false)$$,
  'D0409', null, 'a first-page claim (no cursor) is refused when a cursor is stored');
select is((select deleted from comms.message_index where message_id = 'm-3' and lane_id = 'PKG'), false, 'the refused page wrote nothing');
select is(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000000631', 'mail'), 'h:104', 'the cursor is unchanged after a conflict');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '["m-3"]'::jsonb, '[]'::jsonb, 'h:50', null, false, false)$$,
  'D0409', null, 'an intermediate chunk (no new cursor) from a stale run is refused too');
select is((select deleted from comms.message_index where message_id = 'm-3' and lane_id = 'PKG'), false, 'the refused intermediate chunk wrote nothing');
select lives_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '["m-3"]'::jsonb, '[]'::jsonb, 'h:104', null, false, false)$$,
  'an intermediate chunk from the current cursor is applied');
select is(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000000631', 'mail'), 'h:104', 'an intermediate chunk does not touch the cursor');
select is(core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '[]'::jsonb,
  '[{"message_id": "m-3", "received_at": "2026-10-03T12:00:00.000Z", "subject": "revived?", "source_updated_at": "2026-10-03T12:00:00.000Z", "labels": []}]'::jsonb,
  'h:104', 'h:105', false, false), '{"removed": 0, "written": 1, "skipped": 0}'::jsonb, 'without p_revive an upsert updates a deleted row but leaves it deleted');
select is((select deleted from comms.message_index where message_id = 'm-3' and lane_id = 'PKG'), true, 'm-3 stays deleted without p_revive');
select is(core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '[]'::jsonb,
  '[{"message_id": "m-3", "received_at": "2026-10-03T12:00:00.000Z", "subject": "revived", "source_updated_at": "2026-10-03T12:00:00.000Z", "labels": []}]'::jsonb,
  'h:105', 'h:106', false, true), '{"removed": 0, "written": 1, "skipped": 0}'::jsonb, 'with p_revive a fresh upsert clears deleted');
select is((select deleted from comms.message_index where message_id = 'm-3' and lane_id = 'PKG'), false, 'm-3 is back');
select is(core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '[]'::jsonb,
  '[{"message_id": "m-3", "received_at": "2026-10-03T12:00:00.000Z", "subject": "no version", "source_updated_at": null, "labels": []}]'::jsonb,
  'h:106', 'h:107', false, true), '{"removed": 0, "written": 0, "skipped": 1}'::jsonb, 'an incoming null version counts as oldest and does not replace a versioned row');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '[]'::jsonb, '[{"subject": "x"}]'::jsonb, 'h:107', 'h:108', false, false)$$,
  '22023', null, 'an upsert without message_id is refused up front');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '[]'::jsonb, '[{"message_id": "z", "received_at": "2026-10-03T12:00:00.000Z", "labels": "INBOX"}]'::jsonb, 'h:107', 'h:108', false, false)$$,
  '22023', null, 'labels that are not an array are refused up front');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '[]'::jsonb, '[{"message_id": "z", "labels": []}]'::jsonb, 'h:107', 'h:108', false, false)$$,
  '22023', null, 'an upsert without received_at is refused up front');
select is(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000000631', 'mail'), 'h:107', 'the cursor is the last applied one');

-- ---------------------------------------------------------------- lane, provider and status checks
select throws_ok($$select core.comms_mail_apply_page('APK', '00000000-0000-4000-8000-000000000631', '[]'::jsonb, '[]'::jsonb, null, 'h:1', false, false)$$,
  '42501', null, 'cross-lane: another lane cannot apply to this lane''s connection');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000632', '[]'::jsonb, '[]'::jsonb, null, 'h:1', false, false)$$,
  '42501', null, 'cross-lane: this lane cannot apply to another lane''s connection');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000633', '[]'::jsonb, '[]'::jsonb, null, 'h:1', false, false)$$,
  '42501', null, 'a QuickBooks connection cannot take mail');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000634', '[]'::jsonb, '[]'::jsonb, null, 'h:1', false, false)$$,
  '42501', null, 'a reconnect_required connection cannot be written');
select throws_ok($$select core.sync_cursor_get('APK', '00000000-0000-4000-8000-000000000631', 'mail')$$, '42501', null, 'cross-lane: the cursor of another lane''s connection is not readable');
select throws_ok($$select core.sync_cursor_reset('APK', '00000000-0000-4000-8000-000000000631', 'mail')$$, '42501', null, 'cross-lane: the cursor of another lane''s connection cannot be reset');
select throws_ok($$select core.comms_mail_apply_page('PKG', null, '[]'::jsonb, '[]'::jsonb, null, 'h:1', false, false)$$, '22004', null, 'a missing argument is refused');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '{}'::jsonb, '[]'::jsonb, null, 'h:1', false, false)$$, '22023', null, 'removals must be an array');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '[1]'::jsonb, '[]'::jsonb, null, 'h:1', false, false)$$, '22023', null, 'removals must be strings');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '[]'::jsonb,
  (select jsonb_agg(jsonb_build_object('message_id', 'x' || i)) from generate_series(1, 1001) i), null, 'h:1', false, false)$$, '22023', null, 'more than 1000 upserts are refused');
reset role;
update core.lanes set enabled = false where code = 'APK';
set local role service_role;
select throws_ok($$select core.comms_mail_apply_page('APK', '00000000-0000-4000-8000-000000000632', '[]'::jsonb, '[]'::jsonb, null, 'h:1', false, false)$$,
  '42501', null, 'a disabled lane cannot be written');
reset role;
update core.lanes set enabled = true where code = 'APK';

-- ---------------------------------------------------------------- reset
set local role service_role;
select is(core.sync_cursor_reset('PKG', '00000000-0000-4000-8000-000000000631', 'mail'), true, 'reset deletes the cursor');
select is(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000000631', 'mail'), null, 'no cursor after reset');
select is(core.sync_cursor_reset('PKG', '00000000-0000-4000-8000-000000000631', 'mail'), false, 'a second reset finds nothing');
select lives_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000000631', '[]'::jsonb, '[]'::jsonb, null, 'h:8', false, false)$$, 'the PKG connection stores a fresh cursor after the reset');
select lives_ok($$select core.comms_mail_apply_page('APK', '00000000-0000-4000-8000-000000000632', '[]'::jsonb, '[]'::jsonb, null, 'h:7', false, false)$$, 'the APK connection takes its own page (seeds an APK cursor)');
reset role;

-- ---------------------------------------------------------------- reads: standard lane policy, cross-lane denial
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.sync_cursors where lane_id = 'PKG'), 1, 'admin_technical reads the PKG cursor row (the one left by the apply calls)');
select is((select count(*)::int from core.sync_cursors where lane_id = 'APK'), 0, 'admin_technical reads no APK cursor (cross-lane denial)');
select throws_ok($$select cursor_value from core.sync_cursors$$, '42501', null, 'the cursor text is hidden');
select throws_ok($$insert into core.sync_cursors (lane_id, connection_id, stream, cursor_value) values ('PKG', '00000000-0000-4000-8000-000000000631', 'mail', 'x')$$, '42501', null, 'authenticated cannot insert');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.sync_cursors), 0, 'AAL1 reads nothing');
reset role;
set local role anon;
select throws_ok($$select lane_id from core.sync_cursors$$, '42501', null, 'anon is denied');
reset role;

select * from finish();
rollback;
