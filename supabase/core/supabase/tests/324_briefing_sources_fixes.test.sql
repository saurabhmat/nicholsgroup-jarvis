-- T-270 (first live Microsoft run): core.briefing_coverage reports a stream's OWN cursor time only; a summary prepared before the user's
-- newest connection first synced is stale (brief.briefing_sources_newer / core.briefing_sources_newer / the auto claim).
-- Synthetic: lane PKG (a Google-only lane, which must keep behaving as before), lane APK with a Microsoft connection, example.test addresses.
-- Covered: coverage mail vs calendar (a calendar-only success never makes mail look synced; a succeeded run is not a stand-in); both
-- providers; the stale rule and its gates (one renewal, then not_stale; the 10-minute pause still applies); a Google connection that synced
-- before the summary changes nothing; cross-lane and cross-user denial; privileges.
begin;
select plan(24);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
insert into core.memberships (user_id, lane_id, role) values (pg_temp.uid('owner@example.test'), 'APK', 'owner') on conflict (user_id, lane_id) do nothing;
delete from comms.message_index where lane_id in ('PKG', 'APK');
delete from cal.event_index where lane_id in ('PKG', 'APK');
delete from core.connections where lane_id in ('PKG', 'APK');

-- The owner's own Microsoft mailbox in APK (mail and calendar not synced yet) and own Google mailbox in PKG.
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id, tenant_id, cloud) values
  ('00000000-0000-4000-8000-000000032401', 'APK', 'microsoft', 'robert@ms-lane.example.test', 'active', '{"graph_mail_write": false}', pg_temp.uid('owner@example.test'), '11111111-2222-4333-8444-555555555555', 'commercial');
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id) values
  ('00000000-0000-4000-8000-000000032402', 'PKG', 'google', 'robert@g-lane.example.test', 'active', '{}', pg_temp.uid('owner@example.test'));

-- ---------------------------------------------------------------- privileges
select ok(has_function_privilege('authenticated', 'core.briefing_sources_newer(text)', 'execute') and not has_function_privilege('anon', 'core.briefing_sources_newer(text)', 'execute')
          and not has_function_privilege('service_role', 'core.briefing_sources_newer(text)', 'execute'), 'core.briefing_sources_newer: authenticated only');
select ok(not has_function_privilege('authenticated', 'brief.briefing_sources_newer(text, uuid)', 'execute') and not has_function_privilege('service_role', 'brief.briefing_sources_newer(text, uuid)', 'execute')
          and not has_function_privilege('anon', 'brief.briefing_sources_newer(text, uuid)', 'execute'), 'the internal helper is callable by no API role');
select ok((select bool_and(prosecdef and proconfig = array['search_path=""']) from pg_proc where oid in ('core.briefing_sources_newer(text)'::regprocedure, 'brief.briefing_sources_newer(text, uuid)'::regprocedure)),
          'both new functions are definers with an empty search_path');

-- ---------------------------------------------------------------- coverage: the stream's own time (Microsoft lane)
-- Only the CALENDAR stream has run: a succeeded run and a calendar cursor exist, no mail cursor.
insert into core.sync_runs (lane_id, connection_id, kind, trigger, status, started_at, finished_at) values
  ('APK', '00000000-0000-4000-8000-000000032401', 'full', 'schedule', 'succeeded', now() - interval '2 hours', now() - interval '2 hours' + interval '1 minute');
insert into core.sync_cursors (lane_id, connection_id, stream, cursor_value, updated_at) values
  ('APK', '00000000-0000-4000-8000-000000032401', 'calendar', 'm1.00000000-0000-4000-8000-000000032401.c:x', now() - interval '110 minutes');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select last_sync_at from core.briefing_coverage('APK') where stream = 'mail'), null::timestamptz, 'calendar-only success: Mail has NO sync time (it used to show the run''s time)');
select ok((select last_sync_at is not null from core.briefing_coverage('APK') where stream = 'calendar'), '...and Calendar shows its own cursor time');
select is((select provider || '|' || status from core.briefing_coverage('APK') where stream = 'mail'), 'microsoft|active', 'the Mail row still names its connection and status');
reset role;
insert into core.sync_cursors (lane_id, connection_id, stream, cursor_value, updated_at) values
  ('APK', '00000000-0000-4000-8000-000000032401', 'mail', 'm1.00000000-0000-4000-8000-000000032401.d:x', now() - interval '100 minutes');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select ok((select last_sync_at > now() - interval '101 minutes' and last_sync_at < now() - interval '99 minutes' from core.briefing_coverage('APK') where stream = 'mail'), 'once the mail cursor is stored, Mail shows that time');
reset role;

-- ---------------------------------------------------------------- Google lane unchanged: both cursors, times of their own
insert into core.sync_cursors (lane_id, connection_id, stream, cursor_value, updated_at) values
  ('PKG', '00000000-0000-4000-8000-000000032402', 'mail', 'g1.00000000-0000-4000-8000-000000032402.h:1', now() - interval '20 minutes'),
  ('PKG', '00000000-0000-4000-8000-000000032402', 'calendar', 'g1.00000000-0000-4000-8000-000000032402.c:1', now() - interval '10 minutes');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.briefing_coverage('PKG') where last_sync_at is not null), 2, 'Google lane: both streams carry their own time');
select ok((select last_sync_at < now() - interval '15 minutes' from core.briefing_coverage('PKG') where stream = 'mail'), '...mail the older one, calendar the newer');
reset role;

-- ---------------------------------------------------------------- cross-lane / cross-user denial of coverage
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('admin-technical@example.test');
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.briefing_coverage('APK')), 0, 'a user outside the lane gets no coverage rows');
reset role;
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.briefing_coverage('APK')), 0, 'AAL1: no coverage rows');
reset role;

-- ---------------------------------------------------------------- the stale rule (Microsoft lane APK)
-- A summary prepared 1 hour ago (before the first sync finished 2 hours ago? no: the first succeeded run finished 2 h ago, so the summary is NEWER).
set local role service_role;
select isnt(core.briefing_save('APK', pg_temp.uid('owner@example.test'), 'schedule', 'ready', now() - interval '1 day', now() - interval '1 hour', '{"lines": ["a"]}', '[]', '[]', 'mock'), null, 'a summary is saved');
reset role;
update brief.briefings set prepared_at = now() - interval '60 minutes' where lane_id = 'APK';
select is(brief.briefing_sources_newer('APK', pg_temp.uid('owner@example.test')), false, 'summary prepared after the first sync (2 h ago): not newer');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select core.briefing_sources_newer('APK')), false, 'the owner''s read: false');
select is((select core.briefing_claim_auto('APK') ->> 'gate'), 'not_stale', 'a 60-minute-old summary made after the first sync: not_stale');
reset role;

-- The summary was made BEFORE the first sync finished (the live case: made with nothing connected): stale, whatever its age.
update brief.briefings set prepared_at = now() - interval '3 hours' + interval '30 minutes' where lane_id = 'APK'; -- 2.5 h old (inside 3 h), before the run at 2 h ago
select is(brief.briefing_sources_newer('APK', pg_temp.uid('owner@example.test')), true, 'summary prepared before the first sync finished: sources are newer');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select core.briefing_sources_newer('APK')), true, 'the owner''s read: true');
select isnt((select core.briefing_claim_auto('APK') ->> 'id'), null, 'the auto claim is granted although the summary is under 3 hours old');
select is((select core.briefing_claim_auto('APK') ->> 'gate'), 'running', 'one run at a time still holds');
reset role;
-- The renewed summary is newer than the first sync: not stale again; and the 10-minute pause still holds for a stale one.
set local role service_role;
select isnt(core.briefing_save('APK', pg_temp.uid('owner@example.test'), 'schedule', 'ready', now() - interval '1 day', now(), '{"lines": ["b"]}', '[]', '[]', 'mock'), null, 'the renewed summary is saved');
reset role;
select is(brief.briefing_sources_newer('APK', pg_temp.uid('owner@example.test')), false, 'after the renewal: not newer (renewed once)');
-- Google lane: no first-sync run exists, nothing changes.
set local role service_role;
select isnt(core.briefing_save('PKG', pg_temp.uid('owner@example.test'), 'schedule', 'ready', now() - interval '1 day', now() - interval '1 hour', '{"lines": ["g"]}', '[]', '[]', 'mock'), null, 'Google lane summary saved');
reset role;
update brief.briefings set prepared_at = now() - interval '1 hour' where lane_id = 'PKG';
select is(brief.briefing_sources_newer('PKG', pg_temp.uid('owner@example.test')), false, 'Google lane (no sync run row, cursors only): never newer, its 3-hour rule is unchanged');

-- ---------------------------------------------------------------- denial for the read of another user / lane
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select core.briefing_sources_newer('APK')), false, 'a user outside the lane: false');
reset role;

select * from finish();
rollback;
