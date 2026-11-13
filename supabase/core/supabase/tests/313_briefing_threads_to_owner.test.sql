-- T-240: core.briefing_threads.last_to_owner.
-- Covered: true only when the connection's mailbox address (case-insensitive) is in the TO list of the latest inbound message;
-- Cc only, a list address only and no recipients are false; the latest inbound message decides (not an earlier one);
-- the function returns a boolean and no recipient column; cross-lane, AAL1 and no-comms-view denial.
begin;
select plan(9);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');
delete from comms.message_index where lane_id in ('PKG', 'APK');
insert into core.connections (id, lane_id, provider, external_account_id, status) values
  ('00000000-0000-4000-8000-000000003131', 'PKG', 'google', 'Boss@Example.test', 'active'),
  ('00000000-0000-4000-8000-000000003132', 'APK', 'google', 'apkboss@example.test', 'active');

insert into comms.message_index (lane_id, connection_id, provider, message_id, thread_id, from_address, subject, received_at, is_read, folder, labels, to_recipients, cc_recipients, deleted, source_updated_at) values
  ('PKG', '00000000-0000-4000-8000-000000003131', 'google', 'to1', 'tt1', 'a@acme.test', 'In To', now() - interval '1 hour', false, 'INBOX', '{INBOX}', '[{"address": "BOSS@example.test"}, {"address": "x@acme.test"}]', '[]', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000003131', 'google', 'to2', 'tt2', 'a@acme.test', 'In Cc only', now() - interval '1 hour', false, 'INBOX', '{INBOX}', '[{"address": "x@acme.test"}]', '[{"address": "boss@example.test"}]', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000003131', 'google', 'to3', 'tt3', 'a@acme.test', 'List address', now() - interval '1 hour', false, 'INBOX', '{INBOX}', '[{"address": "team@acme.test"}]', '[]', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000003131', 'google', 'to4', 'tt4', 'a@acme.test', 'Earlier to owner, later not', now() - interval '5 hours', false, 'INBOX', '{INBOX}', '[{"address": "boss@example.test"}]', '[]', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000003131', 'google', 'to5', 'tt4', 'b@acme.test', 'Re: Earlier to owner, later not', now() - interval '1 hour', false, 'INBOX', '{INBOX}', '[{"address": "team@acme.test"}]', '[{"address": "boss@example.test"}]', false, now()),
  ('APK', '00000000-0000-4000-8000-000000003132', 'google', 'ta1', 'tx1', 'a@acme.test', 'Other company', now() - interval '1 hour', false, 'INBOX', '{INBOX}', '[{"address": "apkboss@example.test"}]', '[]', false, now());

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select last_to_owner from core.briefing_threads('PKG', now() - interval '7 days') where thread_key = 'tt1'), true, 'owner address in To (case-insensitive): true');
select is((select last_to_owner from core.briefing_threads('PKG', now() - interval '7 days') where thread_key = 'tt2'), false, 'owner only in Cc: false');
select is((select last_to_owner from core.briefing_threads('PKG', now() - interval '7 days') where thread_key = 'tt3'), false, 'a list address in To: false');
select is((select last_to_owner from core.briefing_threads('PKG', now() - interval '7 days') where thread_key = 'tt4'), false, 'the latest inbound message decides, not an earlier one');
select is((select count(*)::int from pg_proc p, unnest(p.proargnames) n where p.oid = 'core.briefing_threads(text, timestamptz)'::regprocedure and n ~* 'recipient|to_addr'), 0, 'no recipient column is returned');
select is((select count(*)::int from core.briefing_threads('APK', now() - interval '7 days')), 0, 'another lane: nothing');
reset role;

select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.briefing_threads('PKG', now() - interval '7 days')), 0, 'AAL1: nothing');
reset role;
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.briefing_threads('PKG', now() - interval '7 days') where last_to_owner), 0, 'viewer (no comms view): nothing');
reset role;
set local role service_role;
select is((select last_to_owner from core.briefing_threads('APK', now() - interval '7 days') where thread_key = 'tx1'), true, 'fixture check: APK thread is to its own owner');
reset role;

select * from finish();
rollback;
