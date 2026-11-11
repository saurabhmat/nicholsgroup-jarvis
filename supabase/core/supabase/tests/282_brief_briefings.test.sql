-- Briefing store (T-231c): brief.briefings, core.briefing_save / briefing_save_own / briefing_latest, brief.briefings_purge.
-- Covered: lane_id + RLS present, privileges (save and purge service_role only; save_own authenticated), owner-only read,
-- reply drafts refused unless store_outbound_drafts, the owner must be a lane owner with the briefing view (also on a
-- direct insert), save_own (AAL2, owner, own uid, cooldown), latest = newest non-failed with the failed attempt after
-- it, purge floor/cap, and denial: other lane, same-lane user WITH the briefing view, AAL1, member without the view,
-- outsider, anon.
begin;
select plan(35);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
update core.lane_policies set store_outbound_drafts = false where lane_id = 'PKG';
-- A same-lane viewer who was given the briefing view (if the view can be granted by name): must still see nothing of the owner's.
update core.memberships set views = array['briefing']
 where lane_id = 'PKG' and user_id = pg_temp.uid('viewer@example.test') and 'briefing' = any (core.viewer_view_names());

select has_column('brief', 'briefings', 'lane_id', 'briefings has lane_id');
select ok((select relrowsecurity from pg_class where oid = 'brief.briefings'::regclass), 'RLS is on');
select ok(not has_function_privilege('authenticated', 'core.briefing_save(text, uuid, text, text, timestamptz, timestamptz, jsonb, jsonb, jsonb, text)', 'execute'), 'authenticated cannot use the service save');
select ok(has_function_privilege('authenticated', 'core.briefing_save_own(text, text, timestamptz, timestamptz, jsonb, jsonb, jsonb, text)', 'execute'), 'authenticated may save their own');
select ok(not has_function_privilege('anon', 'core.briefing_save_own(text, text, timestamptz, timestamptz, jsonb, jsonb, jsonb, text)', 'execute'), 'anon cannot save');
select ok(not has_function_privilege('authenticated', 'brief.briefings_purge(text, interval)', 'execute'), 'authenticated cannot purge (brief)');
select ok(not has_function_privilege('authenticated', 'core.briefings_purge(text, integer)', 'execute'), 'authenticated cannot purge (core)');
select ok(not has_table_privilege('authenticated', 'brief.briefings', 'insert'), 'authenticated has no insert');
select ok(not has_table_privilege('authenticated', 'brief.briefings', 'update') and not has_table_privilege('authenticated', 'brief.briefings', 'delete'), 'authenticated has no update or delete');
select ok(not has_table_privilege('anon', 'brief.briefings', 'select'), 'anon has no select');

set local role service_role;
select isnt(core.briefing_save('PKG', pg_temp.uid('owner@example.test'), 'schedule', 'ready', now() - interval '1 day', now() - interval '3 hours',
  '{"lines": ["Owner PKG briefing"]}', '[]', '[]', 'mock'), null, 'service_role saves a briefing');
select isnt(core.briefing_save('APK', pg_temp.uid('owner@example.test'), 'manual', 'ready', now() - interval '1 day', now(),
  '{"lines": ["Owner APK briefing"]}', '[]', '[]', 'mock'), null, 'and one in APK (owner is still an APK owner here)');
select throws_ok($$select core.briefing_save('PKG', pg_temp.uid('owner@example.test'), 'manual', 'ready', now() - interval '1 day', now(),
  '{"replies": [{"text": "x"}]}', '[]', '[]', 'mock')$$, '23514', null, 'reply drafts refused while store_outbound_drafts is false');
select throws_ok($$select core.briefing_save('PKG', pg_temp.uid('outsider@example.test'), 'manual', 'ready', now() - interval '1 day', now(), '{}', '[]', '[]', 'mock')$$,
  '23514', null, 'the owner must be a lane owner');
select throws_ok($$select core.briefing_save('PKG', pg_temp.uid('finance-operator@example.test'), 'manual', 'ready', now() - interval '1 day', now(), '{}', '[]', '[]', 'mock')$$,
  '23514', null, 'a member who is not an owner gets no briefing');
select throws_ok($$insert into brief.briefings (lane_id, owner_user_id, trigger, status, window_from, window_to)
  values ('PKG', pg_temp.uid('finance-operator@example.test'), 'manual', 'ready', now() - interval '1 day', now())$$,
  '23514', null, 'a direct insert is checked by the trigger too');
select throws_ok($$select core.briefing_save('PKG', pg_temp.uid('owner@example.test'), 'manual', 'ready', now(), now() - interval '1 day', '{}', '[]', '[]', 'mock')$$,
  '23514', null, 'the window must end after it starts');
reset role;
update core.lane_policies set store_outbound_drafts = true where lane_id = 'PKG';
set local role service_role;
select isnt(core.briefing_save('PKG', pg_temp.uid('owner@example.test'), 'schedule', 'ready', now() - interval '1 day', now() - interval '2 hours',
  '{"lines": ["Owner PKG with drafts"], "replies": [{"text": "x"}]}', '[]', '[]', 'mock'), null, 'reply drafts allowed with store_outbound_drafts');
reset role;
-- order the two PKG rows (prepared_at defaults to clock time) and drop the owner from APK: that row must not be readable
update brief.briefings set prepared_at = now() - interval '3 hours' where lane_id = 'PKG' and content -> 'lines' ->> 0 = 'Owner PKG briefing';
update brief.briefings set prepared_at = now() - interval '2 hours' where lane_id = 'PKG' and content -> 'lines' ->> 0 = 'Owner PKG with drafts';
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');

-- save_own: AAL2 owner saves their own (owner = auth.uid(), trigger manual); a failed attempt never hides the good one.
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select isnt(core.briefing_save_own('PKG', 'failed', now() - interval '1 day', now(), '{"notes": ["model_failed"]}', '[]', '[]', 'mock'), null, 'owner saves their own (failed) attempt');
select throws_ok($$select core.briefing_save_own('PKG', 'ready', now() - interval '1 day', now(), '{}', '[]', '[]', 'mock')$$, 'P0001', 'too_soon', 'cooldown: a second attempt within 2 minutes is refused');
select is((select content -> 'lines' ->> 0 from core.briefing_latest('PKG')), 'Owner PKG with drafts', 'latest is the newest non-failed briefing');
select ok((select last_failed_at is not null and last_run_at >= last_failed_at from core.briefing_latest('PKG')), 'and it says a newer attempt failed');
select is((select count(*)::int from brief.briefings), 3, 'owner sees their own PKG rows only');
select is((select count(*)::int from core.briefing_latest('APK')), 0, 'another lane: nothing');
select throws_ok($$select core.briefing_save_own('APK', 'ready', now() - interval '1 day', now(), '{}', '[]', '[]', 'mock')$$, '42501', null, 'save_own in a lane the caller does not own is refused');
reset role;
select is((select trigger || ':' || (owner_user_id = pg_temp.uid('owner@example.test'))::text from brief.briefings where status = 'failed'), 'manual:true', 'save_own stored a manual row for the caller');

select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from brief.briefings), 0, 'AAL1: nothing');
select throws_ok($$select core.briefing_save_own('PKG', 'ready', now() - interval '1 day', now(), '{}', '[]', '[]', 'mock')$$, '42501', null, 'AAL1: save_own refused');
reset role;
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from brief.briefings), 0, 'same-lane viewer (briefing view if grantable): none of the owner''s rows');
select is((select count(*)::int from core.briefing_latest('PKG')), 0, 'same-lane viewer: briefing_latest gives nothing');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from brief.briefings), 0, 'finance operator: nothing (no briefing view, not the owner)');
reset role;
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.briefing_latest('PKG')), 0, 'outsider: nothing');
reset role;

set local role service_role;
select throws_ok($$select brief.briefings_purge('PKG', interval '1 hour')$$, '22023', null, 'purge floor: at least 1 day');
reset role;
update brief.briefings set prepared_at = now() - interval '200 days' where lane_id = 'PKG';
set local role service_role;
select is(brief.briefings_purge('PKG', interval '3650 days'), 3, 'purge is capped at the lane policy retention (old PKG rows go)');
select is((select count(*)::int from brief.briefings where lane_id = 'APK'), 1, 'purge of PKG leaves APK alone');
reset role;

select * from finish();
rollback;
