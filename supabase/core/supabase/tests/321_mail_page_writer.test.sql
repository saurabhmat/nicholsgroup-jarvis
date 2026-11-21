-- T-252: provider-generic mail page writer (core.comms_mail_apply_page; docs/specs/microsoft.md 6.3) plus the owner-only mail
-- assertions of tests 080/319 for a Microsoft row (T-254 hand-over: core.mailbox_ids, the own-rows policy, a member who loses own_mail
-- between start and finish of a Microsoft connect, AAL1 on core.oauth_state_consume).
-- Covered: a Microsoft page applied (provider on the row from the connection), the Google page unchanged, a foreign-prefix cursor refused
-- for each provider, an over-long cursor, folder-scoped removals, absent flags kept on update (false on insert), cross-lane denial, a
-- disabled lane, a non-usable connection, and the owner-only reads.
-- Synthetic data only: example UUIDs, example.test addresses.
begin;
select plan(58);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
delete from comms.message_index where lane_id in ('PKG', 'APK');
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id) values
  ('00000000-0000-4000-8000-000000032101', 'PKG', 'microsoft', 'viewer@ms.example.test', 'active', '{}', pg_temp.uid('viewer@example.test')),
  ('00000000-0000-4000-8000-000000032102', 'PKG', 'google', 'g-t252@example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032103', 'APK', 'microsoft', 'apk-t252@ms.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032104', 'PKG', 'microsoft', 'robert-t252@ms.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032105', 'PKG', 'microsoft', 'dead-t252@ms.example.test', 'reconnect_required', '{}', pg_temp.uid('owner@example.test'));

-- ---------------------------------------------------------------- a Microsoft page is applied
set local role service_role;
select is(core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032101', '[]'::jsonb,
  $$[{"message_id": "ms-1", "thread_id": "conv-1", "source_url": "https://outlook.example.test/ms-1", "from_address": "a@example.test", "from_name": "A",
      "to_recipients": [], "cc_recipients": [], "subject": "Hello", "received_at": "2026-11-20T12:00:00.000Z", "is_read": true, "is_starred": false,
      "is_important": true, "has_attachments": true, "is_bulk": true, "folder": "INBOX", "labels": ["INBOX"], "source_updated_at": "2026-11-20T12:00:00.000Z"},
     {"message_id": "ms-2", "received_at": "2026-11-20T13:00:00.000Z", "folder": "ARCHIVE", "labels": ["ARCHIVE"], "source_updated_at": "2026-11-20T13:00:00.000Z"}]$$::jsonb,
  null, 'm1.00000000-0000-4000-8000-000000032101.m:eyJ2IjoxfQ', true, false), '{"removed": 0, "written": 2, "skipped": 0}'::jsonb, 'a Microsoft page is applied');
select is(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000032101', 'mail'), 'm1.00000000-0000-4000-8000-000000032101.m:eyJ2IjoxfQ', 'the Microsoft cursor was stored');
select is((select string_agg(provider, ',') from comms.message_index where lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000032101'), 'microsoft,microsoft', 'rows carry the connection''s own provider');
select ok((select last_sync_at is not null from core.connections where id = '00000000-0000-4000-8000-000000032101'), 'a complete Microsoft run sets last_sync_at');

-- ---------------------------------------------------------------- Google regression
select is(core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032102', '["gone"]'::jsonb,
  '[{"message_id": "g-1", "received_at": "2026-11-20T12:00:00.000Z", "folder": "INBOX", "labels": ["INBOX"], "source_updated_at": "2026-11-20T12:00:00.000Z"}]'::jsonb,
  null, 'g1.00000000-0000-4000-8000-000000032102.h:1', false, false), '{"removed": 0, "written": 1, "skipped": 0}'::jsonb, 'a Google page is applied as before');
select is((select provider from comms.message_index where message_id = 'g-1' and lane_id = 'PKG'), 'google', 'the Google row carries google');

-- ---------------------------------------------------------------- the cursor must belong to the connection and its provider
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032102', '[]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000032102.h:1', 'm1.00000000-0000-4000-8000-000000032102.m:x', false, false)$$,
  '22023', null, 'a Google connection cannot store an m1 cursor');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032102', '[]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000032102.h:1', 'g1.00000000-0000-4000-8000-000000032101.h:2', false, false)$$,
  '22023', null, 'a Google connection cannot store another connection''s cursor');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032102', '[]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000032102.h:1', 'h:2', false, false)$$,
  '22023', null, 'a Google connection cannot store an unprefixed cursor');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032101', '[]'::jsonb, '[]'::jsonb, 'm1.00000000-0000-4000-8000-000000032101.m:eyJ2IjoxfQ', 'g1.00000000-0000-4000-8000-000000032101.h:2', false, false)$$,
  '22023', null, 'a Microsoft connection cannot store a g1 cursor');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032101', '[]'::jsonb, '[]'::jsonb, 'm1.00000000-0000-4000-8000-000000032101.m:eyJ2IjoxfQ', 'm1.00000000-0000-4000-8000-000000032104.m:x', false, false)$$,
  '22023', null, 'a Microsoft connection cannot store another connection''s cursor');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032101', '[]'::jsonb, '[]'::jsonb, 'm1.00000000-0000-4000-8000-000000032101.m:eyJ2IjoxfQ', 'm1.00000000-0000-4000-8000-000000032101.c:x', false, false)$$,
  '22023', null, 'a Microsoft mail stream cannot store a calendar-prefixed cursor');
select is(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000032101', 'mail'), 'm1.00000000-0000-4000-8000-000000032101.m:eyJ2IjoxfQ', 'refused pages left the Microsoft cursor unchanged');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032101', '[]'::jsonb, '[]'::jsonb, 'm1.00000000-0000-4000-8000-000000032101.m:eyJ2IjoxfQ',
  'm1.00000000-0000-4000-8000-000000032101.m:' || repeat('a', 16384), false, false)$$, '22023', null, 'a cursor longer than 16384 characters is refused');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032102', '[]'::jsonb, '[]'::jsonb, 'g1.00000000-0000-4000-8000-000000032102.h:1',
  'g1.00000000-0000-4000-8000-000000032102.' || repeat('a', 16384), false, false)$$, '22023', null, '...for a Google connection too');
select lives_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032101', '[]'::jsonb, '[]'::jsonb, 'm1.00000000-0000-4000-8000-000000032101.m:eyJ2IjoxfQ',
  'm1.00000000-0000-4000-8000-000000032101.m:' || repeat('a', 16384 - length('m1.00000000-0000-4000-8000-000000032101.m:')), false, false)$$, 'a cursor of exactly 16384 characters is stored');
select is(length(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000032101', 'mail')), 16384, 'the 16384-character cursor was stored whole');
select lives_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032101', '[]'::jsonb, '[]'::jsonb,
  'm1.00000000-0000-4000-8000-000000032101.m:' || repeat('a', 16384 - length('m1.00000000-0000-4000-8000-000000032101.m:')), null, false, false)$$,
  'an intermediate chunk (no new cursor) needs no prefix');
select lives_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032101', '[]'::jsonb, '[]'::jsonb,
  'm1.00000000-0000-4000-8000-000000032101.m:' || repeat('a', 16384 - length('m1.00000000-0000-4000-8000-000000032101.m:')), 'm1.00000000-0000-4000-8000-000000032101.m:s2', false, false)$$,
  'the cursor moves on (the stored long one was the expected one)');

-- ---------------------------------------------------------------- folder-scoped removals
select is(core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032101', '[{"message_id": "ms-1", "folder": "ARCHIVE"}]'::jsonb, '[]'::jsonb,
  'm1.00000000-0000-4000-8000-000000032101.m:s2', 'm1.00000000-0000-4000-8000-000000032101.m:s3', false, false), '{"removed": 0, "written": 0, "skipped": 0}'::jsonb,
  'a removal naming another folder than the stored row''s flags nothing');
select is((select deleted from comms.message_index where message_id = 'ms-1' and lane_id = 'PKG'), false, 'ms-1 (INBOX) is still visible');
select is(core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032101', '[{"message_id": "ms-1", "folder": "INBOX"}, {"message_id": "ms-2", "folder": null}]'::jsonb, '[]'::jsonb,
  'm1.00000000-0000-4000-8000-000000032101.m:s3', 'm1.00000000-0000-4000-8000-000000032101.m:s4', false, false), '{"removed": 2, "written": 0, "skipped": 0}'::jsonb,
  'a removal in the stored folder, and one with a null folder, flag the rows');
select is((select string_agg(message_id || ':' || deleted::text, ',' order by message_id) from comms.message_index where lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000032101'), 'ms-1:true,ms-2:true', 'both rows are flagged deleted, not removed');
select is(core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032102', '[{"message_id": "g-1"}, "never"]'::jsonb, '[]'::jsonb,
  'g1.00000000-0000-4000-8000-000000032102.h:1', 'g1.00000000-0000-4000-8000-000000032102.h:2', false, false), '{"removed": 1, "written": 0, "skipped": 0}'::jsonb,
  'an object without a folder and a plain string both work');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032101', '[{"message_id": "ms-1", "folder": 5}]'::jsonb, '[]'::jsonb, 'm1.00000000-0000-4000-8000-000000032101.m:s4', null, false, false)$$,
  '22023', null, 'a non-string folder is refused');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032101', '[{"message_id": "ms-1", "extra": "x"}]'::jsonb, '[]'::jsonb, 'm1.00000000-0000-4000-8000-000000032101.m:s4', null, false, false)$$,
  '22023', null, 'an unknown removal key is refused');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032101', '[{"folder": "INBOX"}]'::jsonb, '[]'::jsonb, 'm1.00000000-0000-4000-8000-000000032101.m:s4', null, false, false)$$,
  '22023', null, 'a removal without a message id is refused');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032101', '[{"message_id": ""}]'::jsonb, '[]'::jsonb, 'm1.00000000-0000-4000-8000-000000032101.m:s4', null, false, false)$$,
  '22023', null, 'an empty message id is refused');

-- ---------------------------------------------------------------- flags: absent = false on insert, kept on update
select is(core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032104', '[]'::jsonb,
  $$[{"message_id": "fl-1", "received_at": "2026-11-20T12:00:00.000Z", "is_read": true, "is_starred": true, "is_important": true, "has_attachments": true,
      "is_bulk": true, "is_calendar": true, "is_auto": true, "is_generated": true, "is_auth_pass": true, "labels": [], "source_updated_at": "2026-11-20T12:00:00.000Z"},
     {"message_id": "fl-2", "received_at": "2026-11-20T12:00:00.000Z", "labels": [], "source_updated_at": "2026-11-20T12:00:00.000Z"}]$$::jsonb,
  null, 'm1.00000000-0000-4000-8000-000000032104.m:a', false, false), '{"removed": 0, "written": 2, "skipped": 0}'::jsonb, 'setup: one message with every flag, one with none');
select is((select is_read::text || is_starred::text || is_important::text || has_attachments::text || is_bulk::text || is_calendar::text || is_auto::text || is_generated::text || is_auth_pass::text
           from comms.message_index where message_id = 'fl-2' and lane_id = 'PKG'), 'falsefalsefalsefalsefalsefalsefalsefalsefalse', 'on insert an absent flag is false');
select is(core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032104', '[]'::jsonb,
  $$[{"message_id": "fl-1", "received_at": "2026-11-20T12:00:00.000Z", "subject": "changed", "labels": [], "source_updated_at": "2026-11-20T12:05:00.000Z"},
     {"message_id": "fl-2", "received_at": "2026-11-20T12:00:00.000Z", "is_read": true, "is_bulk": null, "labels": [], "source_updated_at": "2026-11-20T12:05:00.000Z"}]$$::jsonb,
  'm1.00000000-0000-4000-8000-000000032104.m:a', 'm1.00000000-0000-4000-8000-000000032104.m:b', false, false), '{"removed": 0, "written": 2, "skipped": 0}'::jsonb, 'a second page with flags absent is written');
select is((select subject || '/' || is_read::text || is_starred::text || is_important::text || has_attachments::text || is_bulk::text || is_calendar::text || is_auto::text || is_generated::text || is_auth_pass::text
           from comms.message_index where message_id = 'fl-1' and lane_id = 'PKG'), 'changed/truetruetruetruetruetruetruetruetrue', 'on update an absent flag keeps the stored value (other columns updated)');
select is((select is_read::text || is_bulk::text from comms.message_index where message_id = 'fl-2' and lane_id = 'PKG'), 'truefalse', 'a present flag is written; a null flag counts as absent');
select is(core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032104', '[]'::jsonb,
  $$[{"message_id": "fl-1", "received_at": "2026-11-20T12:00:00.000Z", "is_read": false, "is_bulk": false, "labels": [], "source_updated_at": "2026-11-20T12:10:00.000Z"}]$$::jsonb,
  'm1.00000000-0000-4000-8000-000000032104.m:b', 'm1.00000000-0000-4000-8000-000000032104.m:c', false, false), '{"removed": 0, "written": 1, "skipped": 0}'::jsonb, 'an explicit false is applied');
select is((select is_read::text || is_bulk::text || is_starred::text from comms.message_index where message_id = 'fl-1' and lane_id = 'PKG'), 'falsefalsetrue', 'an explicit false overwrites; the others stay');

-- ---------------------------------------------------------------- lane, status and disabled-lane checks
select throws_ok($$select core.comms_mail_apply_page('APK', '00000000-0000-4000-8000-000000032101', '[]'::jsonb, '[]'::jsonb, null, 'm1.00000000-0000-4000-8000-000000032101.m:x', false, false)$$,
  '42501', null, 'cross-lane: lane B naming a lane A Microsoft connection is refused');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032103', '[]'::jsonb, '[]'::jsonb, null, 'm1.00000000-0000-4000-8000-000000032103.m:x', false, false)$$,
  '42501', null, 'cross-lane: lane A naming a lane B Microsoft connection is refused');
select throws_ok($$select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000032105', '[]'::jsonb, '[]'::jsonb, null, 'm1.00000000-0000-4000-8000-000000032105.m:x', false, false)$$,
  '42501', null, 'a reconnect_required Microsoft connection cannot be written');
select lives_ok($$select core.comms_mail_apply_page('APK', '00000000-0000-4000-8000-000000032103', '[]'::jsonb, '[]'::jsonb, null, 'm1.00000000-0000-4000-8000-000000032103.m:x', false, false)$$,
  'the lane''s own Microsoft connection works in an enabled lane');
reset role;
update core.lanes set enabled = false where code = 'APK';
set local role service_role;
select throws_ok($$select core.comms_mail_apply_page('APK', '00000000-0000-4000-8000-000000032103', '[]'::jsonb, '[]'::jsonb, 'm1.00000000-0000-4000-8000-000000032103.m:x', 'm1.00000000-0000-4000-8000-000000032103.m:y', false, false)$$,
  '42501', null, 'a disabled lane cannot be written (Microsoft)');
reset role;
update core.lanes set enabled = true where code = 'APK';
select ok(has_function_privilege('service_role', 'core.comms_mail_apply_page(text, uuid, jsonb, jsonb, text, text, boolean, boolean)', 'execute')
          and not has_function_privilege('authenticated', 'core.comms_mail_apply_page(text, uuid, jsonb, jsonb, text, text, boolean, boolean)', 'execute')
          and not has_function_privilege('anon', 'core.comms_mail_apply_page(text, uuid, jsonb, jsonb, text, text, boolean, boolean)', 'execute'),
          'grants unchanged: service_role only');

-- ---------------------------------------------------------------- owner-only mail for a Microsoft row (hand-over from T-254)
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is(core.mailbox_ids(pg_temp.uid('viewer@example.test'), 'PKG'), array['00000000-0000-4000-8000-000000032101']::uuid[], 'core.mailbox_ids: the viewer''s Microsoft mailbox, and only theirs');
select is((select array_agg(message_id order by message_id) from comms.message_index), array['ms-1', 'ms-2'], 'the own-rows policy: the viewer reads the messages of their own Microsoft mailbox only');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select array_agg(message_id order by message_id) from comms.message_index where lane_id = 'PKG'), array['fl-1', 'fl-2', 'g-1'], 'the owner reads only their own mailboxes (Microsoft and Google), not the viewer''s');
select is(core.mailbox_ids(pg_temp.uid('viewer@example.test'), 'PKG'), '{}'::uuid[], 'core.mailbox_ids answers nothing for another user''s id');
reset role;
select pg_temp.claims('viewer@example.test', 'aal1');
set local role authenticated;
select is(core.mailbox_ids(pg_temp.uid('viewer@example.test'), 'PKG'), '{}'::uuid[], 'core.mailbox_ids at AAL1: nothing');
select is((select count(*)::int from comms.message_index), 0, 'AAL1 reads no Microsoft mail');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from comms.message_index), 0, 'a member without own_mail reads no Microsoft mail');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from comms.message_index) + cardinality(core.mailbox_ids(pg_temp.uid('admin-technical@example.test'), 'APK')), 0, 'cross-lane: a PKG admin reads no mail of the Microsoft mailboxes and owns none in APK');
reset role;

-- ---------------------------------------------------------------- Microsoft connect: AAL1 on finish, and rights lost between start and finish
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select lives_ok($$select core.oauth_state_create('PKG', 'microsoft', repeat('3', 64), repeat('v', 43), 'https://app.example.test/api/connect/microsoft/callback')$$, 'setup: the viewer starts a Microsoft connect');
select lives_ok($$select core.oauth_state_create('PKG', 'microsoft', repeat('4', 64), repeat('v', 43), 'https://app.example.test/api/connect/microsoft/callback')$$, 'setup: a second Microsoft connect');
reset role;
select pg_temp.claims('viewer@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.oauth_state_consume('PKG', repeat('3', 64))), 0, 'AAL1: the Microsoft state is not consumed');
reset role;
select is((select count(*)::int from core.oauth_states where provider = 'microsoft' and state_hash = repeat('3', 64)), 1, '...and it is still there for the AAL2 finish');
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select provider from core.oauth_state_consume('PKG', repeat('3', 64))), 'microsoft', 'at AAL2 the same state is consumed once');
select is((select count(*)::int from core.oauth_state_consume('PKG', repeat('3', 64))), 0, '...and only once');
reset role;
-- the member loses own_mail (role without it, no extra views) between start and finish
update core.memberships set role = 'finance_operator', views = '{}' where user_id = pg_temp.uid('viewer@example.test') and lane_id = 'PKG';
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.oauth_state_consume('PKG', repeat('4', 64))), 0, 'a member who lost own_mail after starting a Microsoft connect cannot finish it');
reset role;
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is(core.mailbox_ids(pg_temp.uid('viewer@example.test'), 'PKG'), '{}'::uuid[], 'and core.mailbox_ids then answers nothing for them, so their own Microsoft mail is no longer readable');
select is((select count(*)::int from comms.message_index), 0, '...through the own-rows policy either');
reset role;

select * from finish();
rollback;
