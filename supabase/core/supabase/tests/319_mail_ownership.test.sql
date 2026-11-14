-- T-247: mailbox ownership and per-user mail privacy (Saurabh, Nov 14, 2026: every member sees only their own mail, admin_technical
-- included; briefings, drafts and email approvals are the mailbox owner's alone).
-- The key case: TWO users in the SAME lane (owner "Robert" and admin_technical "Saurabh"), each with their own mailbox(es). Neither
-- can read the other's messages, events, briefing, drafts or approvals, through the tables, the reader functions and the approval
-- functions. Also: cross-lane denial, the service-role job path (explicit owner), the connect gate (own_mail), the own_mail view
-- mapping, several accounts of one user, and the ownership rules on core.connections.
begin;
select plan(89);
\ir helpers/lane_rls.psql

-- A token whose amr carries a TOTP verification now (the step-up the approval needs).
create function pg_temp.amr(p_email text) returns text language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', (select id from auth.users where email = p_email), 'role', 'authenticated', 'aal', 'aal2',
                      'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text, true);
$$;
create temp table ids (k text primary key, id uuid);
grant all on ids to public;

update core.lanes set enabled = true where code = 'APK';
-- the owner is an APK member in the seed: keep it (the owner reads their own APK mailbox); admin_technical is NOT an APK member.
delete from comms.message_index where lane_id in ('PKG', 'APK');
delete from cal.event_index where lane_id in ('PKG', 'APK');
update core.lane_policies set store_outbound_drafts = true, write_actions_allowed = array['email_send', 'email_draft'] where lane_id in ('PKG', 'APK');
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{approvals}', coalesce(config -> 'approvals', '{}'::jsonb) || '{"approvals_live": true}'::jsonb)
from core.lane_config where lane_id = 'PKG' order by version desc limit 1;

-- Robert (owner): one mailbox. Saurabh (admin_technical): TWO accounts. The viewer: one. A QuickBooks connection has no owner.
-- admin's APK connection: he is not a member of APK, so it grants him nothing there.
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id) values
  ('00000000-0000-4000-8000-000000031901', 'PKG', 'google', 'robert@example.test', 'active', '{"gmail_compose": true}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000031902', 'PKG', 'google', 'saurabh@example.test', 'active', '{"gmail_compose": true}', pg_temp.uid('admin-technical@example.test')),
  ('00000000-0000-4000-8000-000000031903', 'PKG', 'google', 'saurabh2@example.test', 'active', '{"gmail_compose": true}', pg_temp.uid('admin-technical@example.test')),
  ('00000000-0000-4000-8000-000000031904', 'PKG', 'google', 'viewer-box@example.test', 'active', '{}', pg_temp.uid('viewer@example.test')),
  ('00000000-0000-4000-8000-000000031905', 'PKG', 'quickbooks', 'realm-t247', 'active', '{}', null),
  ('00000000-0000-4000-8000-000000031906', 'APK', 'google', 'robert-apk@example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000031907', 'APK', 'google', 'saurabh-apk@example.test', 'active', '{}', pg_temp.uid('admin-technical@example.test'));

insert into comms.message_index (lane_id, connection_id, provider, message_id, thread_id, from_address, subject, received_at, is_read, is_important, folder, labels, deleted, source_updated_at) values
  ('PKG', '00000000-0000-4000-8000-000000031901', 'google', 'r-1', 'rt1', 'a@x.test', 'Robert one', now() - interval '1 hour', false, true, 'INBOX', '{}', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000031901', 'google', 'r-2', 'rt2', 'b@x.test', 'Robert two', now() - interval '2 hours', false, false, 'INBOX', '{}', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000031902', 'google', 's-1', 'st1', 'c@x.test', 'Saurabh one', now() - interval '1 hour', false, true, 'INBOX', '{}', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000031903', 'google', 's-2', 'st2', 'd@x.test', 'Saurabh second account', now() - interval '3 hours', false, true, 'INBOX', '{}', false, now()),
  ('PKG', '00000000-0000-4000-8000-000000031904', 'google', 'v-1', 'vt1', 'e@x.test', 'Viewer one', now() - interval '1 hour', false, true, 'INBOX', '{}', false, now()),
  ('APK', '00000000-0000-4000-8000-000000031906', 'google', 'ra-1', 'rat1', 'f@x.test', 'Robert APK', now() - interval '1 hour', false, true, 'INBOX', '{}', false, now()),
  ('APK', '00000000-0000-4000-8000-000000031907', 'google', 'sa-1', 'sat1', 'g@x.test', 'Saurabh APK (not a member)', now() - interval '1 hour', false, true, 'INBOX', '{}', false, now());
insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, ical_uid, title, start_at, end_at, all_day, status, attendees, source_updated_at) values
  ('PKG', '00000000-0000-4000-8000-000000031901', 'google', 'primary', 're-1', 'u-re1', 'Robert meeting', now() + interval '2 hours', now() + interval '3 hours', false, 'confirmed', '[]', now()),
  ('PKG', '00000000-0000-4000-8000-000000031902', 'google', 'primary', 'se-1', 'u-se1', 'Saurabh meeting', now() + interval '2 hours', now() + interval '3 hours', false, 'confirmed', '[]', now()),
  ('PKG', '00000000-0000-4000-8000-000000031903', 'google', 'primary', 'se-2', 'u-se2', 'Saurabh second meeting', now() + interval '4 hours', now() + interval '5 hours', false, 'confirmed', '[]', now());

-- ---------------------------------------------------------------- the own_mail view
select ok('own_mail' = any (core.view_names()) and 'own_mail' = any (core.role_views('owner')) and 'own_mail' = any (core.role_views('admin_technical'))
          and 'own_mail' = any (core.role_views('viewer')) and not ('own_mail' = any (core.role_views('finance_operator'))),
          'own_mail: owner, admin_technical and viewer hold it, finance_operator does not');
select ok(pg_temp.lanes_for('admin-technical@example.test', 'own_mail') = array['PKG'] and pg_temp.lanes_for('finance-operator@example.test', 'own_mail') = '{}'::text[]
          and pg_temp.lanes_for('outsider@example.test', 'own_mail') = '{}'::text[], 'own_mail resolves for admin_technical in PKG, for a finance operator and an outsider nowhere');

-- ---------------------------------------------------------------- core.connections: ownership rules
select throws_ok($$update core.connections set owner_user_id = pg_temp.uid('viewer@example.test') where id = '00000000-0000-4000-8000-000000031901'$$, '42501', null, 'the owner of a connection cannot change');
select throws_ok($$update core.connections set owner_user_id = null where id = '00000000-0000-4000-8000-000000031901'$$, '42501', null, '...nor be cleared');
select throws_ok($$update core.connections set owner_user_id = pg_temp.uid('owner@example.test') where id = '00000000-0000-4000-8000-000000031905'$$, '23514', null, 'a QuickBooks connection never has an owner');
select lives_ok($$update core.connections set status = 'degraded' where id = '00000000-0000-4000-8000-000000031901'$$, 'other updates of an owned connection still work');
update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000031901';

-- RLS on core.connections: the connections view (owner, admin_technical) reads the lane's health; a member reads their own
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.connections where lane_id = 'PKG'), 5, 'owner (connections view): health of all five PKG connections');
select is((select count(*)::int from core.connections where lane_id = 'APK'), 2, 'owner: the two APK connections');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.connections where lane_id = 'PKG'), 5, 'admin_technical (connections view): health of all PKG connections');
select is((select count(*)::int from core.connections where lane_id = 'APK'), 0, 'admin_technical: nothing of a lane they are not a member of');
select is((select array_agg(owner_user_id) filter (where id = '00000000-0000-4000-8000-000000031901') from core.connections), array[pg_temp.uid('owner@example.test')], 'the owner column is readable (who owns what), no mail content');
reset role;
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select array_agg(external_account_id) from core.connections), array['viewer-box@example.test'], 'a viewer (own_mail) reads only their own connection row');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.connections), 0, 'a finance operator (no own_mail, no connections view) reads no connection');
reset role;

-- ---------------------------------------------------------------- message_index and event_index: own mailboxes only
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select array_agg(message_id order by message_id) from comms.message_index), array['r-1', 'r-2', 'ra-1'], 'owner reads only their own messages (PKG and APK), none of Saurabh''s or the viewer''s');
select is((select array_agg(event_id) from cal.event_index), array['re-1'], 'owner reads only their own events');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select array_agg(message_id order by message_id) from comms.message_index), array['s-1', 's-2'], 'admin_technical reads only their own messages from BOTH their accounts, not Robert''s, and not APK (not a member there)');
select is((select array_agg(event_id order by event_id) from cal.event_index), array['se-1', 'se-2'], 'admin_technical reads the events of both their own accounts only');
reset role;
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select array_agg(message_id) from comms.message_index), array['v-1'], 'a viewer reads only their own message');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from comms.message_index) + (select count(*)::int from cal.event_index), 0, 'a finance operator reads no mail and no events');
reset role;
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from comms.message_index) + (select count(*)::int from cal.event_index), 0, 'an outsider reads no mail and no events');
reset role;
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from comms.message_index) + (select count(*)::int from cal.event_index), 0, 'AAL1 reads nothing, even of one''s own mailbox');
reset role;
-- the old lane views grant no content any more: a viewer given the named calendar view still reads nobody else's events
update core.memberships set views = array['calendar']::text[] where user_id = pg_temp.uid('viewer@example.test') and lane_id = 'PKG';
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from cal.event_index), 0, 'the named calendar view grants no content (only mailbox ownership does)');
reset role;
update core.memberships set views = '{}' where user_id = pg_temp.uid('viewer@example.test') and lane_id = 'PKG';

-- ---------------------------------------------------------------- reader functions
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select array_agg(message_id order by message_id) from core.inbox_messages('PKG', 'all')), array['r-1', 'r-2'], 'inbox_messages: only the caller''s own mail');
select is((select count(*)::int from core.inbox_message_ref('PKG', 's-1')), 0, 'inbox_message_ref: Saurabh''s message is not visible to Robert');
select is((select count(*)::int from core.inbox_message_ref('PKG', 'r-1')), 1, '...and Robert''s own is');
select is((select unread_important from core.home_mail_attention('PKG', now() - interval '1 day')), 1, 'home_mail_attention counts only the caller''s own mail (Robert: 1 important)');
select is((select string_agg(title, ',') from core.home_meetings('PKG', now(), now() + interval '1 day')), 'Robert meeting', 'home_meetings: only the caller''s own calendars');
select is((select array_agg(thread_key order by thread_key) from core.briefing_threads('PKG', now() - interval '1 day')), array['rt1', 'rt2'], 'briefing_threads: only the caller''s own threads');
select is((select string_agg(title, ',') from core.briefing_events('PKG', now(), now() + interval '1 day')), 'Robert meeting', 'briefing_events: only the caller''s own events');
select is((select string_agg(distinct account, ',') from core.briefing_coverage('PKG') where connection_id is not null), 'robert@example.test', 'briefing_coverage: only the caller''s own account');
select is(core.home_calendar_status('PKG'), 'connected', 'home_calendar_status: connected (own calendar)');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select array_agg(message_id order by message_id) from core.inbox_messages('PKG', 'all')), array['s-1', 's-2'], 'inbox_messages: both accounts of one user, nobody else''s');
select is((select count(*)::int from core.inbox_message_ref('PKG', 'r-1')), 0, 'inbox_message_ref: Robert''s message is not visible to Saurabh');
select is((select unread_important from core.home_mail_attention('PKG', now() - interval '1 day')), 2, 'home_mail_attention: Saurabh counts his two accounts only');
select is((select string_agg(title, ',' order by title) from core.home_meetings('PKG', now(), now() + interval '1 day')), 'Saurabh meeting,Saurabh second meeting', 'home_meetings: both his calendars');
select is((select array_agg(thread_key order by thread_key) from core.briefing_threads('PKG', now() - interval '1 day')), array['st1', 'st2'], 'briefing_threads: his own threads only');
select is((select string_agg(title, ',' order by title) from core.briefing_events('PKG', now(), now() + interval '1 day')), 'Saurabh meeting,Saurabh second meeting', 'briefing_events: his own events only');
select is((select count(*)::int from core.briefing_coverage('PKG') where connection_id is not null), 4, 'briefing_coverage: two accounts x two streams, both his');
select is((select count(*)::int from core.briefing_threads('PKG', now() - interval '1 day', pg_temp.uid('owner@example.test'))), 2, 'a signed-in caller naming another owner (p_owner) still gets only their own threads (p_owner is for service_role)');
select is(core.home_calendar_status('PKG'), 'connected', 'home_calendar_status: connected (his own calendars)');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.inbox_messages('PKG', 'all')) + (select count(*)::int from core.briefing_threads('PKG', now() - interval '1 day'))
          + (select count(*)::int from core.briefing_events('PKG', now(), now() + interval '1 day')), 0, 'a finance operator reads no mail through any reader');
select is(core.home_calendar_status('PKG'), 'no_access', 'home_calendar_status: no_access without own_mail');
reset role;

-- the job path: service_role names the owner; it gets that owner's mail only, and nobody's without a name
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select is((select array_agg(thread_key order by thread_key) from core.briefing_threads('PKG', now() - interval '1 day', pg_temp.uid('owner@example.test'))), array['rt1', 'rt2'], 'job path: the named owner''s threads only');
select is((select array_agg(thread_key order by thread_key) from core.briefing_threads('PKG', now() - interval '1 day', pg_temp.uid('admin-technical@example.test'))), array['st1', 'st2'], 'job path: the other user''s threads only');
select is((select count(*)::int from core.briefing_threads('PKG', now() - interval '1 day')), 0, 'job path: no owner named, no threads');
select is((select string_agg(title, ',') from core.briefing_events('PKG', now(), now() + interval '1 day', pg_temp.uid('owner@example.test'))), 'Robert meeting', 'job path: the named owner''s events only');
select is((select count(*)::int from core.briefing_threads('PKG', now() - interval '1 day', pg_temp.uid('finance-operator@example.test'))), 0, 'job path: a user without own_mail gets nothing');
reset role;

-- ---------------------------------------------------------------- briefings: one per person
set local role service_role;
select lives_ok($$select core.briefing_save('PKG', pg_temp.uid('admin-technical@example.test'), 'schedule', 'ready', now() - interval '1 day', now(), '{"lines":["Saurabh''s briefing"]}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'm')$$, 'a briefing can be saved for an admin_technical member who holds own_mail');
select lives_ok($$select core.briefing_save('PKG', pg_temp.uid('owner@example.test'), 'schedule', 'ready', now() - interval '1 day', now(), '{"lines":["Robert''s briefing"]}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'm')$$, '...and for the owner');
select throws_ok($$select core.briefing_save('PKG', pg_temp.uid('finance-operator@example.test'), 'schedule', 'ready', now() - interval '1 day', now(), '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'm')$$, '23514', null, 'a member without own_mail cannot be given a briefing');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select content -> 'lines' ->> 0 from core.briefing_latest('PKG')), 'Robert''s briefing', 'Robert reads his own briefing, never Saurabh''s');
select is((select count(*)::int from brief.briefings), 1, 'and the table shows him only his own row');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select content -> 'lines' ->> 0 from core.briefing_latest('PKG')), 'Saurabh''s briefing', 'Saurabh reads his own briefing (admin_technical, own_mail)');
select is((select count(*)::int from brief.briefings), 1, 'and only his own row');
select is((select core.briefing_claim_regenerate('PKG') ->> 'gate'), null, 'Saurabh can claim a briefing run of his own (admin_technical, own_mail)');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.briefing_claim_auto('PKG')$$, '42501', null, 'a member without own_mail cannot claim a briefing run');
reset role;

-- ---------------------------------------------------------------- drafts and email approvals: the mailbox owner's alone
set local role service_role;
select lives_ok($$insert into ids select 'robert', act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000031901', '{"mailbox":"robert@example.test"}', '{"fromMailbox":"robert@example.test","to":["x@y.test"],"cc":[],"bcc":[],"subject":"S","bodyText":"B"}', 1, repeat('a', 64), null, '[]', 'job', pg_temp.uid('owner@example.test'), true)$$, 'a job proposes a draft for Robert (proposer = the mailbox owner)');
select lives_ok($$insert into ids select 'saurabh', act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000031902', '{"mailbox":"saurabh@example.test"}', '{"fromMailbox":"saurabh@example.test","to":["x@y.test"],"cc":[],"bcc":[],"subject":"S","bodyText":"B"}', 1, repeat('b', 64), null, '[]', 'job', pg_temp.uid('admin-technical@example.test'), true)$$, '...and one for Saurabh');
select throws_ok($$select act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000031902', '{"mailbox":"saurabh@example.test"}', '{"fromMailbox":"saurabh@example.test"}', 1, repeat('c', 64), null, '[]', 'user', pg_temp.uid('owner@example.test'), false)$$, '42501', null, 'a draft cannot be proposed for someone else''s mailbox (Robert for Saurabh''s)');
select throws_ok($$select act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000031902', '{"mailbox":"saurabh@example.test"}', '{"fromMailbox":"saurabh@example.test"}', 1, repeat('c', 64), null, '[]', 'job', null, false)$$, '42501', null, 'an email proposal without a proposer (no mailbox owner) is refused');
reset role;

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select array_agg(id) from act.proposed_actions), array[(select id from ids where k = 'robert')], 'Robert, a lane owner, sees only his own draft, not Saurabh''s');
select is(core.act_pending_count('PKG'), 1, 'his pending count is his own');
select is((select count(*)::int from act.status_history), 1, 'status history: only his own action''s');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select array_agg(id) from act.proposed_actions), array[(select id from ids where k = 'saurabh')], 'Saurabh, admin_technical, sees his own draft only');
select is((select count(*)::int from act.status_history), 1, 'status history: only his own');
reset role;
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from act.proposed_actions), 0, 'a viewer sees neither draft');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from act.proposed_actions), 0, 'a finance operator sees neither draft');
reset role;

-- approve and reject: Robert cannot touch Saurabh's draft (the same not_found as an unknown id), Saurabh can approve his own
select pg_temp.amr('owner@example.test');
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, repeat('b', 64))$$, (select id from ids where k = 'saurabh')), 'P0002', 'act: not_found', 'Robert cannot approve Saurabh''s draft');
select throws_ok(format($$select core.act_reject('PKG', %L, 'no')$$, (select id from ids where k = 'saurabh')), 'P0002', 'act: not_found', 'Robert cannot reject Saurabh''s draft');
reset role;
select pg_temp.amr('admin-technical@example.test');
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, repeat('a', 64))$$, (select id from ids where k = 'robert')), 'P0002', 'act: not_found', 'Saurabh (admin_technical) cannot approve Robert''s draft either');
select is(core.act_approve('PKG', (select id from ids where k = 'saurabh'), repeat('b', 64)), repeat('b', 64), 'Saurabh approves his own draft (admin_technical, mailbox owner)');
select is((select status from act.proposed_actions where id = (select id from ids where k = 'saurabh')), 'approved', '...and it is approved');
reset role;
select is((select status from act.proposed_actions where id = (select id from ids where k = 'robert')), 'proposed', 'Robert''s draft is untouched');
select pg_temp.amr('owner@example.test');
set local role authenticated;
select lives_ok(format($$select core.act_reject('PKG', %L, 'not now')$$, (select id from ids where k = 'robert')), 'Robert rejects his own draft');
reset role;

-- the execution claim re-checks that the approver still owns the mailbox
set local role service_role;
select is((select (core.act_claim_execution('PKG', (select id from ids where k = 'saurabh'))).status), 'executing', 'the execution claim passes for the mailbox owner''s approval');
reset role;

-- the reply drawer state answers only for one's own mailbox
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select pending_id is null and not blocked from core.act_reply_state('PKG', '00000000-0000-4000-8000-000000031902', 'st1', 's-1')), true, 'act_reply_state for someone else''s mailbox: nothing (and blocked = false)');
reset role;

-- ---------------------------------------------------------------- the connect gate
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select lives_ok($$select core.oauth_state_create('PKG', 'google', repeat('1', 64), repeat('v', 43), 'https://app.example.test/cb')$$, 'a viewer (own_mail) may start a Google connect of their own account');
select throws_ok($$select core.oauth_state_create('PKG', 'quickbooks', repeat('2', 64), repeat('v', 43), 'https://app.example.test/cb')$$, '42501', null, '...but not a QuickBooks connect');
select is((select count(*)::int from core.oauth_state_consume('PKG', repeat('1', 64))), 1, 'the viewer finishes their own Google connect');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.oauth_state_create('PKG', 'google', repeat('3', 64), repeat('v', 43), 'https://app.example.test/cb')$$, '42501', null, 'a finance operator (no own_mail) cannot start a Google connect');
reset role;
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.oauth_state_create('PKG', 'google', repeat('4', 64), repeat('v', 43), 'https://app.example.test/cb')$$, '42501', null, 'an outsider cannot start a Google connect');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select lives_ok($$select core.oauth_state_create('PKG', 'quickbooks', repeat('5', 64), repeat('v', 43), 'https://app.example.test/cb')$$, 'admin_technical still starts a QuickBooks connect');
select is((select count(*)::int from core.oauth_state_consume('PKG', repeat('1', 64))), 0, 'a state started by someone else is not consumable');
reset role;

-- ---------------------------------------------------------------- review fixes: cut-over, role of the owner, per-owner caps
-- the cut-over statements of migration 20261124150000 (briefings made before it are derived from the whole lane's mail and are removed)
delete from brief.briefings where prepared_at < pg_catalog.clock_timestamp() and owner_user_id = pg_temp.uid('owner@example.test');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from brief.briefings), 0, 'after the cut-over delete the owner has no briefing: nothing built from the old lane-wide mail remains');
select is((select count(*)::int from core.briefing_latest('PKG')), 0, '...and briefing_latest returns nothing for them');
reset role;
set local role service_role;
select throws_ok($$select act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000031904', '{"mailbox":"viewer-box@example.test"}', '{"fromMailbox":"viewer-box@example.test"}', 1, repeat('e', 64), null, '[]', 'job', pg_temp.uid('viewer@example.test'), false)$$, '42501', null, 'a draft for a viewer''s mailbox is refused: the owner cannot approve it (no undecidable draft)');
-- per-owner caps: Robert fills his 20 slots; Saurabh can still propose
select count(*) from (select act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000031901', '{"mailbox":"robert@example.test"}', '{"fromMailbox":"robert@example.test"}', 1, lpad(to_hex(g), 64, 'f'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false) from generate_series(1, 20) g) x;
select throws_ok($$select act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000031901', '{"mailbox":"robert@example.test"}', '{"fromMailbox":"robert@example.test"}', 1, repeat('9', 64), null, '[]', 'user', pg_temp.uid('owner@example.test'), false)$$, '54000', null, 'one user''s 21st pending draft is refused (the cap is 20 per mailbox owner)');
select lives_ok($$select act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000031903', '{"mailbox":"saurabh2@example.test"}', '{"fromMailbox":"saurabh2@example.test"}', 1, repeat('8', 64), null, '[]', 'user', pg_temp.uid('admin-technical@example.test'), false)$$, '...but Saurabh can still propose: caps are per mailbox owner');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select runs_today from core.briefing_run_state('PKG')), 1, 'runs_today shows only the caller''s own runs');
reset role;

select * from finish();
rollback;
