-- T-265: a lane with mail and calendar ONLY (no QuickBooks, Stripe, GoHighLevel, KPIs, news, approvals config), the shape that
-- docs/runbooks/enable-lane-mail.md writes. Synthetic: lane APK stands in (enabled inside this transaction), example.test addresses, a made-up tenant id.
-- Covered: the config JSON of the runbook passes the database's own checks (insert-only version, no secret-like keys or values);
-- the Home and briefing reader functions answer for such a lane (finance reads say "not_connected", never fail); each member sees only their own
-- mail and calendar (owner "Robert" and admin_technical "Saurabh" in the same lane, D-43); and cross-lane denial: a user outside the lane
-- gets nothing from any of them, and the lane's rows never reach the full-finance lane PKG's readers.
begin;
select plan(18);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
insert into core.memberships (user_id, lane_id, role) values (pg_temp.uid('admin-technical@example.test'), 'APK', 'admin_technical')
  on conflict (user_id, lane_id) do nothing;
delete from comms.message_index where lane_id in ('PKG', 'APK');
delete from cal.event_index where lane_id in ('PKG', 'APK');
delete from core.connections where lane_id = 'APK';

-- The lane policy and config exactly as the manual SQL part writes them.
update core.lane_policies set llm_allowed_categories = array['email', 'calendar']::text[], store_content_bodies = false, store_outbound_drafts = false,
  indexing_enabled = false, retention_days = 90, cross_lane_summary_allowed = 'none', write_actions_allowed = array[]::text[] where lane_id = 'APK';
insert into core.lane_config (lane_id, version, config)
select 'APK', coalesce(max(version), 0) + 1, replace(replace($cfg${
    "enabled_modules": ["comms", "calendar", "briefing"],
    "limit_to_enabled_modules": true,
    "mail": { "providers": ["microsoft"], "allowed_domains": ["__MAIL_DOMAIN__"] },
    "microsoft": { "cloud": "commercial", "tenant_ids": ["__TENANT_ID__"] }
  }$cfg$, '__MAIL_DOMAIN__', 'mail-only.example.test'), '__TENANT_ID__', '11111111-2222-4333-8444-555555555555')::jsonb
from core.lane_config where lane_id = 'APK';

select is((select config -> 'mail' -> 'providers' from core.lane_config_current where lane_id = 'APK'), '["microsoft"]'::jsonb, 'the mail-only config is accepted as the lane''s current version');
select ok((select not (config ?| array['qbo', 'stripe', 'ghl', 'kpis', 'entities', 'news', 'approvals', 'finance']) from core.lane_config_current where lane_id = 'APK'), 'and carries no finance, news or approvals settings');

-- Robert (owner) and Saurabh (admin_technical): each with their OWN Microsoft mailbox in the lane; mail and a meeting each.
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id, tenant_id, cloud) values
  ('00000000-0000-4000-8000-000000032301', 'APK', 'microsoft', 'robert@mail-only.example.test', 'active', '{"graph_mail_write": false}', pg_temp.uid('owner@example.test'), '11111111-2222-4333-8444-555555555555', 'commercial'),
  ('00000000-0000-4000-8000-000000032302', 'APK', 'microsoft', 'saurabh@mail-only.example.test', 'active', '{"graph_mail_write": false}', pg_temp.uid('admin-technical@example.test'), '11111111-2222-4333-8444-555555555555', 'commercial');
insert into comms.message_index (lane_id, connection_id, provider, message_id, thread_id, from_address, subject, received_at, is_read, is_important, folder, labels, deleted, source_updated_at) values
  ('APK', '00000000-0000-4000-8000-000000032301', 'microsoft', 'r-1', 'rt1', 'a@x.test', 'Robert one', now() - interval '1 hour', false, true, 'INBOX', '{}', false, now()),
  ('APK', '00000000-0000-4000-8000-000000032302', 'microsoft', 's-1', 'st1', 'b@x.test', 'Saurabh one', now() - interval '1 hour', false, true, 'INBOX', '{}', false, now()),
  ('APK', '00000000-0000-4000-8000-000000032302', 'microsoft', 's-2', 'st2', 'c@x.test', 'Saurabh two', now() - interval '2 hours', false, true, 'INBOX', '{}', false, now());
insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, ical_uid, title, start_at, end_at, all_day, status, attendees, source_updated_at) values
  ('APK', '00000000-0000-4000-8000-000000032301', 'microsoft', 'primary', 're-1', 'u-re1', 'Robert meeting', now() + interval '1 hour', now() + interval '2 hours', false, 'confirmed', '[]', now()),
  ('APK', '00000000-0000-4000-8000-000000032302', 'microsoft', 'primary', 'se-1', 'u-se1', 'Saurabh meeting', now() + interval '1 hour', now() + interval '2 hours', false, 'confirmed', '[]', now());

-- ---------------------------------------------------------------- the finance reads of a lane without QuickBooks
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.home_finance('APK')), 1, 'home_finance answers one row for a lane with no QuickBooks (it does not fail)');
select is((select state from core.home_finance('APK')), 'not_connected', 'the owner''s finance state is not_connected (the app hides it for a mail-only lane: no figures, no sample numbers)');
select is((select state from core.home_finance_detail('APK')), 'not_connected', 'home_finance_detail the same');
reset role;

-- ---------------------------------------------------------------- Robert: his own mail and calendar only
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select unread_important from core.home_mail_attention('APK', now() - interval '1 day')), 1, 'owner: Home counts only his own unread important mail (1, not 3)');
select is(core.home_calendar_status('APK'), 'connected', 'owner: calendar status is connected through his own Microsoft mailbox');
select is((select array_agg(title) from core.home_meetings('APK', now(), now() + interval '1 day')), array['Robert meeting'], 'owner: only his own meeting');
select is((select array_agg(distinct account) from core.briefing_coverage('APK')), array['robert@mail-only.example.test'], 'owner: the briefing coverage lists only his own account');
select is((select count(*)::int from core.inbox_messages('APK', 'all')), 1, 'owner: the Inbox lists only his own message');
reset role;

-- ---------------------------------------------------------------- Saurabh (admin_technical): his own, never Robert's (D-43)
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select unread_important from core.home_mail_attention('APK', now() - interval '1 day')), 2, 'admin_technical: counts only his own two messages');
select is(core.home_calendar_status('APK'), 'connected', 'admin_technical: his own Microsoft mailbox gives him a calendar');
select is((select array_agg(title) from core.home_meetings('APK', now(), now() + interval '1 day')), array['Saurabh meeting'], 'admin_technical: only his own meeting');
select is((select array_agg(distinct account) from core.briefing_coverage('APK')), array['saurabh@mail-only.example.test'], 'admin_technical: coverage lists only his own account');
select is((select array_agg(subject order by subject) from core.inbox_messages('APK', 'all')), array['Saurabh one', 'Saurabh two'], 'admin_technical: the Inbox lists only his own messages');
reset role;

-- ---------------------------------------------------------------- cross-lane denial: nobody outside the lane reads any of it
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select state from core.home_finance('APK')), 'no_access', 'outsider: finance reads answer no_access for the lane');
select is((select count(*)::int from core.home_mail_attention('APK', now() - interval '1 day')) + (select count(*)::int from core.inbox_messages('APK', 'all'))
          + (select count(*)::int from core.home_meetings('APK', now(), now() + interval '1 day')) + (select count(*)::int from core.briefing_coverage('APK')), 0,
          'outsider: no mail, meeting or coverage row of the lane');
reset role;

-- the lane's mail never shows in the full lane's readers (the owner reads PKG: no APK mailbox rows)
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.inbox_messages('PKG', 'all')), 0, 'PKG readers do not return the mail-only lane''s messages');
reset role;

select * from finish();
rollback;
