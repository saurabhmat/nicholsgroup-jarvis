-- T-235: SYNTHETIC data for the Home screenshots (before/after), LOCAL stack only (CLAUDE.md rule 10: no real records).
-- Every name, address, subject and link below is made up (example.test domains). Times are relative to now() so the
-- shots always show "today". Apply AFTER the e2e reset, before the screenshot spec:
--   docker exec -i supabase_db_nichols-jarvis-core psql -U postgres -v ON_ERROR_STOP=1 < apps/web/e2e/fixtures/home-shots.sql
-- Idempotent: it removes its own rows first (fixed ids).
begin;
delete from cal.event_index where connection_id = '00000000-0000-4000-8000-0000000235c1';
delete from comms.message_index where connection_id = '00000000-0000-4000-8000-0000000235c1';
delete from core.sync_cursors where connection_id = '00000000-0000-4000-8000-0000000235c1';
delete from core.connections where id = '00000000-0000-4000-8000-0000000235c1';

insert into core.connections (id, lane_id, provider, external_account_id, status, features, last_sync_at)
values ('00000000-0000-4000-8000-0000000235c1', 'PKG', 'google', 'ops@example.test', 'active', '{}', now() - interval '3 minutes');
insert into core.sync_cursors (lane_id, connection_id, stream, cursor_value, updated_at) values
  ('PKG', '00000000-0000-4000-8000-0000000235c1', 'mail', 'shots-1', now() - interval '3 minutes'),
  ('PKG', '00000000-0000-4000-8000-0000000235c1', 'calendar', 'shots-1', now() - interval '3 minutes');

-- Inbound mail: threads waiting on the owner (last message not from the owner), a mix of senders and ages.
insert into comms.message_index (lane_id, connection_id, provider, message_id, thread_id, from_address, from_name, to_recipients, subject, received_at, is_read, is_important, labels, is_auth_pass)
values
  ('PKG', '00000000-0000-4000-8000-0000000235c1', 'google', 'shot-m01', 'a1b2c3d4e5f60001', 'dana.whitfield@acme-federal.example.test', 'Dana Whitfield', '[{"address":"ops@example.test"}]', 'CMMC Level 2 evidence package: two controls still open', now() - interval '2 hours', false, true, '{INBOX,UNREAD,IMPORTANT}', true),
  ('PKG', '00000000-0000-4000-8000-0000000235c1', 'google', 'shot-m02', 'a1b2c3d4e5f60002', 'marcus.lee@harborline.example.test', 'Marcus Lee', '[{"address":"ops@example.test"}]', 'Re: Teaming agreement redlines for the Navy IDIQ bid', now() - interval '5 hours', false, true, '{INBOX,UNREAD,IMPORTANT}', true),
  ('PKG', '00000000-0000-4000-8000-0000000235c1', 'google', 'shot-m03', 'a1b2c3d4e5f60003', 'priya.nair@northgate.example.test', 'Priya Nair', '[{"address":"ops@example.test"}]', 'Question on the SAM.gov renewal date before Friday', now() - interval '1 day', true, false, '{INBOX}', true),
  ('PKG', '00000000-0000-4000-8000-0000000235c1', 'google', 'shot-m04', 'a1b2c3d4e5f60004', 'tom.becker@clearwater.example.test', 'Tom Becker', '[{"address":"ops@example.test"}]', 'Proposal pricing review: can we meet Thursday?', now() - interval '2 days', false, false, '{INBOX,UNREAD}', true),
  ('PKG', '00000000-0000-4000-8000-0000000235c1', 'google', 'shot-m05', 'a1b2c3d4e5f60005', 'elena.ruiz@summitgov.example.test', 'Elena Ruiz', '[{"address":"ops@example.test"}]', 'Re: Past performance write-up for the GSA MAS refresh', now() - interval '3 days', true, false, '{INBOX}', true),
  ('PKG', '00000000-0000-4000-8000-0000000235c1', 'google', 'shot-m06', 'a1b2c3d4e5f60006', 'sam.okafor@brightpath.example.test', 'Sam Okafor', '[{"address":"ops@example.test"}]', 'Subcontract onboarding forms (W-9 and insurance certificate)', now() - interval '4 days', false, false, '{INBOX,UNREAD}', true),
  ('PKG', '00000000-0000-4000-8000-0000000235c1', 'google', 'shot-m07', 'a1b2c3d4e5f60007', 'billing@ledgerly.example.test', 'Ledgerly Billing', '[{"address":"ops@example.test"}]', 'Invoice 4471 is due on Nov 20', now() - interval '6 hours', false, false, '{INBOX,UNREAD}', true),
  ('PKG', '00000000-0000-4000-8000-0000000235c1', 'google', 'shot-m08', 'a1b2c3d4e5f60008', 'news@govdigest.example.test', 'GovDigest', '[{"address":"ops@example.test"}]', 'This week in federal contracting', now() - interval '3 hours', false, false, '{INBOX,UNREAD,CATEGORY_PROMOTIONS}', true),
  ('PKG', '00000000-0000-4000-8000-0000000235c1', 'google', 'shot-m09', 'a1b2c3d4e5f60009', 'jordan.price@acme-federal.example.test', 'Jordan Price', '[{"address":"ops@example.test"}]', 'Kickoff deck for the Q1 capture plan', now() - interval '6 days', true, false, '{INBOX}', true),
  ('PKG', '00000000-0000-4000-8000-0000000235c1', 'google', 'shot-m10', 'a1b2c3d4e5f60010', 'avery.chen@northgate.example.test', 'Avery Chen', '[{"address":"ops@example.test"}]', 'Re: Security questionnaire follow-up', now() - interval '7 days', true, false, '{INBOX}', true);
update comms.message_index set folder = 'INBOX' where connection_id = '00000000-0000-4000-8000-0000000235c1';
update comms.message_index set is_bulk = true where message_id = 'shot-m08';

-- Today's calendar (overlap + back-to-back + RSVP pending + external attendees) and two later this week.
insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, title, organizer_email, organizer_name, start_at, end_at, timezone, attendees, status, online_meeting_url, source_url)
values
  ('PKG', '00000000-0000-4000-8000-0000000235c1', 'google', 'primary', 'shot-e1', 'Capture review: Navy IDIQ', 'ops@example.test', 'Ops', date_trunc('hour', now()) + interval '2 hours', date_trunc('hour', now()) + interval '3 hours', 'America/New_York',
   '[{"email":"ops@example.test","name":"Ops","response":"accepted"},{"email":"marcus.lee@harborline.example.test","name":"Marcus Lee","response":"accepted"},{"email":"dana.whitfield@acme-federal.example.test","name":"Dana Whitfield","response":"tentative"},{"email":"jordan.price@acme-federal.example.test","name":"Jordan Price","response":"accepted"},{"email":"priya.nair@northgate.example.test","name":"Priya Nair","response":"needs_action"}]',
   'confirmed', 'https://meet.example.test/abc-defg-hij', 'https://calendar.example.test/event?eid=shot-e1'),
  ('PKG', '00000000-0000-4000-8000-0000000235c1', 'google', 'primary', 'shot-e2', 'SOC 2 audit: daily standup', 'avery.chen@northgate.example.test', 'Avery Chen', date_trunc('hour', now()) + interval '2 hours', date_trunc('hour', now()) + interval '2 hours 15 minutes', 'America/New_York',
   '[{"email":"ops@example.test","name":"Ops","response":"accepted"},{"email":"avery.chen@northgate.example.test","name":"Avery Chen","response":"accepted"}]',
   'confirmed', 'https://meet.example.test/soc-stand-up', 'https://calendar.example.test/event?eid=shot-e2'),
  ('PKG', '00000000-0000-4000-8000-0000000235c1', 'google', 'primary', 'shot-e3', 'Weekly leadership sync', 'ops@example.test', 'Ops', date_trunc('hour', now()) + interval '3 hours', date_trunc('hour', now()) + interval '4 hours', 'America/New_York',
   '[{"email":"ops@example.test","name":"Ops","response":"needs_action"},{"email":"elena.ruiz@summitgov.example.test","name":"Elena Ruiz","response":"accepted"},{"email":"sam.okafor@brightpath.example.test","name":"Sam Okafor","response":"accepted"}]',
   'confirmed', 'https://meet.example.test/weekly-sync', 'https://calendar.example.test/event?eid=shot-e3'),
  ('PKG', '00000000-0000-4000-8000-0000000235c1', 'google', 'primary', 'shot-e4', 'Pricing review with Clearwater', 'tom.becker@clearwater.example.test', 'Tom Becker', date_trunc('day', now()) + interval '2 days 15 hours', date_trunc('day', now()) + interval '2 days 16 hours', 'America/Chicago',
   '[{"email":"ops@example.test","name":"Ops","response":"needs_action"},{"email":"tom.becker@clearwater.example.test","name":"Tom Becker","response":"accepted"}]',
   'confirmed', 'https://meet.example.test/pricing', 'https://calendar.example.test/event?eid=shot-e4'),
  ('PKG', '00000000-0000-4000-8000-0000000235c1', 'google', 'primary', 'shot-e5', 'GSA MAS refresh working session', 'ops@example.test', 'Ops', date_trunc('day', now()) + interval '4 days 14 hours', date_trunc('day', now()) + interval '4 days 15 hours', 'America/New_York',
   '[{"email":"ops@example.test","name":"Ops","response":"accepted"},{"email":"elena.ruiz@summitgov.example.test","name":"Elena Ruiz","response":"accepted"}]',
   'confirmed', null, 'https://calendar.example.test/event?eid=shot-e5');
commit;
