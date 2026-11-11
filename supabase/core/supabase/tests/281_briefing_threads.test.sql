-- Home briefing reads part 2 (T-231b): core.briefing_threads.
-- Covered: privileges, invoker + empty search_path, one row per inbox thread with the latest inbound message, the
-- owner's SENT reply detection (last and ever), unread/inbound counts, archived/deleted/old mail ignored, window
-- check, and denial: other lane, AAL1, member without the comms view, outsider.
begin;
select plan(17);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');
delete from comms.message_index where lane_id in ('PKG', 'APK');

insert into core.connections (id, lane_id, provider, external_account_id, status) values
  ('00000000-0000-4000-8000-000000002811', 'PKG', 'google', 'thr-pkg@example.test', 'active'),
  ('00000000-0000-4000-8000-000000002812', 'APK', 'google', 'thr-apk@example.test', 'active');

insert into comms.message_index (lane_id, connection_id, provider, message_id, thread_id, from_address, from_name, subject, received_at, is_read, folder, labels, deleted, source_updated_at) values
  -- t1: client wrote twice, unread, owner never replied -> waiting
  ('PKG', '00000000-0000-4000-8000-000000002811', 'google', 'm1', 't1', 'client@acme.test', 'Client', 'Contract question', now() - interval '3 hours', false, 'INBOX', '{INBOX,UNREAD}', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000002811', 'google', 'm2', 't1', 'client@acme.test', 'Client', 'Re: Contract question', now() - interval '1 hour', false, 'INBOX', '{INBOX,UNREAD}', false, now()),
  -- t2: partner wrote, owner replied last -> answered
  ('PKG', '00000000-0000-4000-8000-000000002811', 'google', 'm3', 't2', 'partner@acme.test', null, 'Lunch', now() - interval '5 hours', true, 'INBOX', '{INBOX}', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000002811', 'google', 'm4', 't2', 'thr-pkg@example.test', null, 'Re: Lunch', now() - interval '4 hours', true, null, '{SENT}', false, now()),
  -- t3: archived only (no inbox message) -> not listed
  ('PKG', '00000000-0000-4000-8000-000000002811', 'google', 'm5', 't3', 'old@acme.test', null, 'Archived', now() - interval '2 hours', true, null, '{}', false, now()),
  -- t4: deleted -> not listed; t5: older than the window -> not listed
  ('PKG', '00000000-0000-4000-8000-000000002811', 'google', 'm6', 't4', 'gone@acme.test', null, 'Deleted', now() - interval '2 hours', false, 'INBOX', '{INBOX}', true, now()),
  ('PKG', '00000000-0000-4000-8000-000000002811', 'google', 'm7', 't5', 'stale@acme.test', null, 'Old', now() - interval '10 days', false, 'INBOX', '{INBOX}', false, now()),
  ('APK', '00000000-0000-4000-8000-000000002812', 'google', 'a1', 'x1', 'client@acme.test', null, 'Other company', now() - interval '1 hour', false, 'INBOX', '{INBOX}', false, now());

select ok(has_function_privilege('authenticated', 'core.briefing_threads(text, timestamptz)', 'execute'), 'authenticated executes');
select ok(not has_function_privilege('anon', 'core.briefing_threads(text, timestamptz)', 'execute'), 'anon does not');
select ok((select not prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = 'core.briefing_threads(text, timestamptz)'::regprocedure), 'invoker, empty search_path');

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select array_agg(thread_key order by thread_key) from core.briefing_threads('PKG', now() - interval '7 days')), array['t1', 't2'], 'inbox threads only; archived, deleted and old left out');
select is((select message_id || '|' || subject from core.briefing_threads('PKG', now() - interval '7 days') where thread_key = 't1'), 'm2|Re: Contract question', 't1: the latest inbound message');
select is((select unread_count::text || '/' || inbound_count::text || '/' || owner_replied::text || '/' || last_is_owner::text from core.briefing_threads('PKG', now() - interval '7 days') where thread_key = 't1'),
          '2/2/false/false', 't1: two unread inbound, never answered');
select is((select message_id || '|' || owner_replied::text || '|' || last_is_owner::text from core.briefing_threads('PKG', now() - interval '7 days') where thread_key = 't2'),
          'm3|true|true', 't2: the latest inbound is the partner, the owner answered last');
select is((select count(*)::int from core.briefing_threads('PKG', now() - interval '14 days')), 3, 'a 14-day window includes the older thread');
select throws_ok($$select * from core.briefing_threads('PKG', now() - interval '15 days')$$, '22023', null, 'more than 14 days back is refused');
select throws_ok($$select * from core.briefing_threads(null, now())$$, '22004', null, 'a lane is required');
select is((select count(*)::int from core.briefing_threads('APK', now() - interval '7 days')), 0, 'another lane: no threads');
reset role;
set local role service_role;
select is((select count(*)::int from core.briefing_threads('APK', now() - interval '7 days')), 1, 'fixture check: APK has a thread');
reset role;

select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.briefing_threads('PKG', now() - interval '7 days')), 0, 'AAL1: no threads');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.briefing_threads('PKG', now() - interval '7 days')), 0, 'admin_technical (no comms view): no threads');
reset role;
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.briefing_threads('PKG', now() - interval '7 days')), 0, 'viewer: no threads');
reset role;
select pg_temp.claims('operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.briefing_threads('PKG', now() - interval '7 days')), 0, 'finance operator (no comms view): no threads');
reset role;
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.briefing_threads('PKG', now() - interval '7 days')), 0, 'outsider: no threads');
reset role;

select * from finish();
rollback;
