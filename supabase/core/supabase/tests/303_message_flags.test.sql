-- T-234 part 2: header-derived flags on comms.message_index (is_bulk, is_calendar, is_auto), written by
-- core.comms_mail_apply_page and read by core.briefing_threads; core.inbox_message_ref returns thread_id.
-- Covered: columns exist, not null default false, no header/body column appeared, the apply writes and updates the flags
-- (absent = false), briefing_threads returns the latest inbound message's flags, inbox_message_ref returns the thread id, and
-- cross-lane / AAL1 / no-comms-view denial on both reads.
begin;
select plan(14);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');
delete from comms.message_index where lane_id in ('PKG', 'APK');
insert into core.connections (id, lane_id, provider, external_account_id, status) values
  ('00000000-0000-4000-8000-000000003031', 'PKG', 'google', 'flags-pkg@example.test', 'active'),
  ('00000000-0000-4000-8000-000000003032', 'APK', 'google', 'flags-apk@example.test', 'active');
insert into comms.message_index (lane_id, connection_id, provider, message_id, thread_id, from_address, subject, received_at, is_read, folder, labels, deleted, source_updated_at) values
  ('APK', '00000000-0000-4000-8000-000000003032', 'google', 'fa1', '18c2f0a1b2c3d400', 'x@acme.test', 'Other company', now() - interval '1 hour', false, 'INBOX', '{INBOX}', false, now());

select has_column('comms', 'message_index', 'is_bulk', 'is_bulk exists');
select has_column('comms', 'message_index', 'is_calendar', 'is_calendar exists');
select has_column('comms', 'message_index', 'is_auto', 'is_auto exists');
select is((select count(*)::int from pg_attribute where attrelid = 'comms.message_index'::regclass and attnum > 0 and not attisdropped
            and attname in ('headers', 'header', 'body', 'snippet', 'preview', 'list_unsubscribe', 'content')), 0, 'no header or body column was added (rule 6)');
select is((select string_agg(column_default || '/' || is_nullable, ',' order by column_name) from information_schema.columns
            where table_schema = 'comms' and table_name = 'message_index' and column_name in ('is_auto', 'is_bulk', 'is_calendar')),
          'false/NO,false/NO,false/NO', 'the flags are not null and default false');

set local role service_role;
select is(core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000003031', '[]'::jsonb,
  $$[{"message_id": "f1", "thread_id": "18c2f0a1b2c3d4e1", "source_url": null, "from_address": "weekly@pubk.example.test", "from_name": "Weekly", "to_recipients": [], "cc_recipients": [],
      "subject": "This week", "received_at": "2026-11-10T12:00:00.000Z", "is_read": false, "is_starred": false, "is_important": false, "has_attachments": false,
      "is_bulk": true, "is_calendar": false, "is_auto": false, "folder": "INBOX", "labels": ["INBOX"], "source_updated_at": "2026-11-10T12:00:00.000Z"},
     {"message_id": "f2", "thread_id": "18c2f0a1b2c3d4e2", "source_url": null, "from_address": "calendar-notification@google.com", "from_name": null, "to_recipients": [], "cc_recipients": [],
      "subject": "Updated invitation: Review", "received_at": "2026-11-10T13:00:00.000Z", "is_read": false, "is_starred": false, "is_important": false, "has_attachments": false,
      "is_bulk": false, "is_calendar": true, "is_auto": false, "folder": "INBOX", "labels": ["INBOX"], "source_updated_at": "2026-11-10T13:00:00.000Z"},
     {"message_id": "f3", "thread_id": "18c2f0a1b2c3d4e3", "source_url": null, "from_address": "away@example.test", "from_name": null, "to_recipients": [], "cc_recipients": [],
      "subject": "Automatic reply: Hi", "received_at": "2026-11-10T14:00:00.000Z", "is_read": false, "is_starred": false, "is_important": false, "has_attachments": false,
      "is_bulk": false, "is_calendar": false, "is_auto": true, "folder": "INBOX", "labels": ["INBOX"], "source_updated_at": "2026-11-10T14:00:00.000Z"},
     {"message_id": "f4", "thread_id": "18c2f0a1b2c3d4e4", "source_url": null, "from_address": "person@example.test", "from_name": null, "to_recipients": [], "cc_recipients": [],
      "subject": "Question", "received_at": "2026-11-10T15:00:00.000Z", "is_read": false, "is_starred": false, "is_important": false, "has_attachments": false,
      "folder": "INBOX", "labels": ["INBOX"], "source_updated_at": "2026-11-10T15:00:00.000Z"}]$$::jsonb,
  null, 'h:1', false, false), '{"removed": 0, "written": 4, "skipped": 0}'::jsonb, 'the apply writes four messages, one without flags in the payload');
select is((select string_agg(message_id || ':' || is_bulk::text || is_calendar::text || is_auto::text, ',' order by message_id) from comms.message_index where lane_id = 'PKG'),
          'f1:truefalsefalse,f2:falsetruefalse,f3:falsefalsetrue,f4:falsefalsefalse', 'flags are stored; absent flags are false');
select core.comms_mail_apply_page('PKG', '00000000-0000-4000-8000-000000003031', '[]'::jsonb,
  $$[{"message_id": "f4", "thread_id": "18c2f0a1b2c3d4e4", "source_url": null, "from_address": "person@example.test", "from_name": null, "to_recipients": [], "cc_recipients": [],
      "subject": "Question", "received_at": "2026-11-10T15:00:00.000Z", "is_read": false, "is_starred": false, "is_important": false, "has_attachments": false,
      "is_bulk": true, "folder": "INBOX", "labels": ["INBOX"], "source_updated_at": "2026-11-10T15:00:01.000Z"}]$$::jsonb,
  'h:1', 'h:2', false, false);
select is((select is_bulk from comms.message_index where message_id = 'f4' and lane_id = 'PKG'), true, 'a re-synced message updates its flags');
reset role;

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select string_agg(thread_key || ':' || is_bulk::text || is_calendar::text || is_auto::text, ',' order by thread_key) from core.briefing_threads('PKG', now() - interval '14 days')),
          '18c2f0a1b2c3d4e1:truefalsefalse,18c2f0a1b2c3d4e2:falsetruefalse,18c2f0a1b2c3d4e3:falsefalsetrue,18c2f0a1b2c3d4e4:truefalsefalse', 'briefing_threads returns the flags');
select is((select thread_id from core.inbox_message_ref('PKG', 'f2')), '18c2f0a1b2c3d4e2', 'inbox_message_ref returns the thread id');
select is((select count(*)::int from core.briefing_threads('APK', now() - interval '14 days')) + (select count(*)::int from core.inbox_message_ref('APK', 'fa1')), 0, 'another lane: nothing through either read');
reset role;
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.briefing_threads('PKG', now() - interval '14 days')) + (select count(*)::int from core.inbox_message_ref('PKG', 'f2')), 0, 'AAL1: nothing');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.briefing_threads('PKG', now() - interval '14 days')) + (select count(*)::int from core.inbox_message_ref('PKG', 'f2')), 0, 'no comms view: nothing');
reset role;
select ok(not has_function_privilege('anon', 'core.inbox_message_ref(text, text)', 'execute') and not has_function_privilege('service_role', 'core.inbox_message_ref(text, text)', 'execute')
          and has_function_privilege('authenticated', 'core.briefing_threads(text, timestamptz)', 'execute') and not has_function_privilege('anon', 'core.briefing_threads(text, timestamptz)', 'execute'),
          'grants are unchanged after the recreate');

select * from finish();
rollback;
