-- Functional Inbox reads (T-202): core.inbox_messages and core.inbox_message_ref.
-- Covered: privileges (authenticated only; anon and service_role not granted), invoker + empty search_path, argument
-- checks, filters (all / unread / important), inbox only, deleted hidden, newest first, keyset paging, the single-message
-- ref (any folder, connection id), and denial: another lane (rows exist), member without the comms view, AAL1, outsider.
begin;
select plan(24);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');
-- Start PKG and APK with no mail (a developer's own synced rows are removed inside this transaction only).
delete from comms.message_index where lane_id in ('PKG', 'APK');

insert into core.connections (id, lane_id, provider, external_account_id, status) values
  ('00000000-0000-4000-8000-000000002401', 'PKG', 'google', 'inbox-pkg@example.test', 'active'),
  ('00000000-0000-4000-8000-000000002402', 'APK', 'google', 'inbox-apk@example.test', 'active');

insert into comms.message_index (lane_id, connection_id, provider, message_id, from_address, from_name, subject, received_at, is_read, is_important, folder, labels, deleted, source_updated_at) values
  ('PKG', '00000000-0000-4000-8000-000000002401', 'google', 'i1', 'a@example.test', 'A', 'newest unread important', '2026-11-06 15:00Z', false, true, 'INBOX', '{}', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000002401', 'google', 'i2', 'b@example.test', 'B', 'read', '2026-11-06 14:00Z', true, false, 'INBOX', '{}', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000002401', 'google', 'i3', 'c@example.test', 'C', 'unread', '2026-11-06 13:00Z', false, false, 'INBOX', '{}', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000002401', 'google', 'i4', 'd@example.test', 'D', 'same time a', '2026-11-06 12:00Z', true, true, 'INBOX', '{}', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000002401', 'google', 'i5', 'e@example.test', 'E', 'same time b', '2026-11-06 12:00Z', true, false, 'INBOX', '{}', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000002401', 'google', 'i6', 'f@example.test', 'F', 'archived', '2026-11-06 11:00Z', false, true, null, '{}', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000002401', 'google', 'i7', 'g@example.test', 'G', 'deleted', '2026-11-06 10:00Z', false, true, 'INBOX', '{}', true, now()),
  ('APK', '00000000-0000-4000-8000-000000002402', 'google', 'x1', 'z@example.test', 'Z', 'other company', '2026-11-06 15:30Z', false, true, 'INBOX', '{}', false, now());

-- ---------------------------------------------------------------- privileges
select ok(has_function_privilege('authenticated', 'core.inbox_messages(text, text, timestamptz, text, integer)', 'execute')
          and has_function_privilege('authenticated', 'core.inbox_message_ref(text, text)', 'execute'), 'authenticated executes both');
select ok(not has_function_privilege('anon', 'core.inbox_messages(text, text, timestamptz, text, integer)', 'execute')
          and not has_function_privilege('anon', 'core.inbox_message_ref(text, text)', 'execute'), 'anon executes neither');
select ok(not has_function_privilege('service_role', 'core.inbox_message_ref(text, text)', 'execute'), 'service_role is not granted (no RLS-bypassing path)');
select ok((select bool_and(not prosecdef and proconfig = array['search_path=""']) from pg_proc
           where oid in ('core.inbox_messages(text, text, timestamptz, text, integer)'::regprocedure, 'core.inbox_message_ref(text, text)'::regprocedure)),
          'both are security invoker with an empty search_path');

-- ---------------------------------------------------------------- owner, aal2, own lane
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select array_agg(message_id) from core.inbox_messages('PKG', 'all')), array['i1', 'i2', 'i3', 'i5', 'i4'],
          'all: inbox only, deleted and archived left out, newest first (ties by id)');
select is((select array_agg(message_id) from core.inbox_messages('PKG', 'unread')), array['i1', 'i3'], 'unread');
select is((select array_agg(message_id) from core.inbox_messages('PKG', 'important')), array['i1', 'i4'], 'important');
select is((select array_agg(message_id) from core.inbox_messages('PKG', 'all', null, null, 2)), array['i1', 'i2'], 'first page of 2');
select is((select array_agg(message_id) from core.inbox_messages('PKG', 'all', '2026-11-06 14:00Z', 'i2', 2)), array['i3', 'i5'], 'next page continues after the last row');
select is((select array_agg(message_id) from core.inbox_messages('PKG', 'all', '2026-11-06 12:00Z', 'i5', 2)), array['i4'], 'paging splits rows with the same time correctly');
select is((select subject || '|' || from_name from core.inbox_messages('PKG', 'all') limit 1), 'newest unread important|A', 'metadata columns are returned');
select throws_ok($$select * from core.inbox_messages('PKG', 'spam')$$, '22023', null, 'an unknown filter is refused');
select throws_ok($$select * from core.inbox_messages('PKG', 'all', null, null, 101)$$, '22023', null, 'more than 100 rows is refused');
select throws_ok($$select * from core.inbox_messages('PKG', 'all', '2026-11-06 12:00Z', null)$$, '22023', null, 'paging needs both cursor parts');

select is((select connection_id::text from core.inbox_message_ref('PKG', 'i6')), '00000000-0000-4000-8000-000000002401', 'ref: an archived message is visible, with its connection');
select is((select count(*)::int from core.inbox_message_ref('PKG', 'i7')), 0, 'ref: a deleted message is not');
select is((select count(*)::int from core.inbox_message_ref('PKG', 'nope')), 0, 'ref: an unknown id gives no row');

-- ---------------------------------------------------------------- cross-lane: APK rows exist, owner is not a member
select is((select count(*)::int from core.inbox_messages('APK', 'all')), 0, 'another lane''s inbox is empty');
select is((select count(*)::int from core.inbox_message_ref('APK', 'x1')), 0, 'another lane''s message cannot be referenced');
select is((select count(*)::int from core.inbox_message_ref('PKG', 'x1')), 0, 'nor through the caller''s own lane');
reset role;

-- ---------------------------------------------------------------- AAL1, no comms view, outsider
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.inbox_messages('PKG', 'all')) + (select count(*)::int from core.inbox_message_ref('PKG', 'i1')), 0, 'AAL1 sees nothing');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.inbox_messages('PKG', 'all')) + (select count(*)::int from core.inbox_message_ref('PKG', 'i1')), 0, 'admin_technical (no comms view) sees nothing');
reset role;
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.inbox_messages('PKG', 'all')) + (select count(*)::int from core.inbox_message_ref('PKG', 'i1')), 0, 'a finance-only viewer sees nothing');
reset role;
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.inbox_messages('PKG', 'all')) + (select count(*)::int from core.inbox_message_ref('PKG', 'i1')), 0, 'an outsider sees nothing');
reset role;

select * from finish();
rollback;
