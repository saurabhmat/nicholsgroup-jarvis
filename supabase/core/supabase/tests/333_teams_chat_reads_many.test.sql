-- T-295: core.teams_chat_reads_list_many (docs/specs/messages.md 22.5): the read markers of all of a person's Teams connections in ONE query. SECURITY INVOKER, so the existing row-level security
-- decides: a person gets the markers of their OWN Teams connections in the lane at AAL2, nothing else. CROSS-LANE AND CROSS-USER denial; at most 5 connections; at most 1,000 rows per connection.
-- Synthetic data only: example UUIDs, example.test addresses.
begin;
select plan(22);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
-- the limit (T-294) is 5 in PKG for this test: a person with several accounts
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{teams}', coalesce(config -> 'teams', '{}'::jsonb) || '{"max_accounts_per_person": 5}'::jsonb)
from core.lane_config where lane_id = 'PKG' order by version desc limit 1;

-- 33301 / 33302 owner / PKG / Teams (two accounts of one person), 33303 owner / APK / Teams, 33304 viewer / PKG / Teams, 33305 viewer / PKG / Teams (second account), 33306 admin_technical / PKG / Teams,
-- 33307 .. 33309 owner / PKG / Teams (disconnected: three more rows to reach more than five ids), 33310 owner / PKG / Google
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id) values
  ('00000000-0000-4000-8000-000000033301', 'PKG', 'microsoft_teams', 'robert@teams.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033302', 'PKG', 'microsoft_teams', 'robert@second.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033303', 'APK', 'microsoft_teams', 'robert-apk@teams.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033304', 'PKG', 'microsoft_teams', 'viewer@teams.example.test', 'active', '{}', pg_temp.uid('viewer@example.test')),
  ('00000000-0000-4000-8000-000000033305', 'PKG', 'microsoft_teams', 'viewer@second.example.test', 'active', '{}', pg_temp.uid('viewer@example.test')),
  ('00000000-0000-4000-8000-000000033306', 'PKG', 'microsoft_teams', 'saurabh@teams.example.test', 'active', '{}', pg_temp.uid('admin-technical@example.test')),
  ('00000000-0000-4000-8000-000000033307', 'PKG', 'microsoft_teams', 'old1@teams.example.test', 'disconnected', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033308', 'PKG', 'microsoft_teams', 'old2@teams.example.test', 'disconnected', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033309', 'PKG', 'microsoft_teams', 'old3@teams.example.test', 'disconnected', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033310', 'PKG', 'google', 'robert@g.example.test', 'active', '{}', pg_temp.uid('owner@example.test'));
insert into comms.teams_chat_reads (lane_id, connection_id, chat_id, read_through, updated_at) values
  ('PKG', '00000000-0000-4000-8000-000000033301', '19:a1@thread.v2', '2026-11-20T10:00:00Z', now()),
  ('PKG', '00000000-0000-4000-8000-000000033301', '19:a2@thread.v2', '2026-11-21T10:00:00Z', now()),
  ('PKG', '00000000-0000-4000-8000-000000033302', '19:b1@thread.v2', '2026-11-22T10:00:00Z', now()),
  ('APK', '00000000-0000-4000-8000-000000033303', '19:apk@thread.v2', '2026-11-22T10:00:00Z', now()),
  ('PKG', '00000000-0000-4000-8000-000000033304', '19:v1@thread.v2', '2026-11-22T10:00:00Z', now()),
  ('PKG', '00000000-0000-4000-8000-000000033305', '19:v2@thread.v2', '2026-11-22T10:00:00Z', now()),
  ('PKG', '00000000-0000-4000-8000-000000033306', '19:adm@thread.v2', '2026-11-22T10:00:00Z', now());
-- 1,003 markers on one more connection (the cap is 1,000 per connection)
insert into comms.teams_chat_reads (lane_id, connection_id, chat_id, read_through, updated_at)
select 'PKG', '00000000-0000-4000-8000-000000033307', '19:bulk' || g || '@thread.v2', '2026-11-22T10:00:00Z', now() - (g || ' seconds')::interval from generate_series(1, 1003) g;

-- ---------------------------------------------------------------- shape and grants
select ok(not (select prosecdef from pg_proc where oid = 'core.teams_chat_reads_list_many(text, uuid[])'::regprocedure), 'the wrapper is SECURITY INVOKER (RLS applies)');
select ok((select proconfig = array['search_path=""'] from pg_proc where oid = 'core.teams_chat_reads_list_many(text, uuid[])'::regprocedure), 'with an empty search_path');
select ok(has_function_privilege('authenticated', 'core.teams_chat_reads_list_many(text, uuid[])', 'execute') and not has_function_privilege('anon', 'core.teams_chat_reads_list_many(text, uuid[])', 'execute') and not has_function_privilege('service_role', 'core.teams_chat_reads_list_many(text, uuid[])', 'execute'), 'only authenticated can execute it');
select is((select proargnames from pg_proc where oid = 'core.teams_chat_reads_list_many(text, uuid[])'::regprocedure), array['p_lane', 'p_connections', 'connection_id', 'chat_id', 'read_through'], 'it takes the lane and the ids and returns the connection id, the chat id and the time and nothing else');

-- ---------------------------------------------------------------- the owner: both own connections in one call
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.teams_chat_reads_list_many('PKG', array['00000000-0000-4000-8000-000000033301', '00000000-0000-4000-8000-000000033302']::uuid[])), 3, 'the owner gets the markers of both own connections (2 + 1) in one call');
select is((select count(distinct connection_id)::int from core.teams_chat_reads_list_many('PKG', array['00000000-0000-4000-8000-000000033301', '00000000-0000-4000-8000-000000033302']::uuid[])), 2, '...each row names its connection');
select is((select count(*)::int from core.teams_chat_reads_list_many('PKG', array['00000000-0000-4000-8000-000000033301']::uuid[])), 2, 'one id: only that connection''s rows');
-- cross-user
select is((select count(*)::int from core.teams_chat_reads_list_many('PKG', array['00000000-0000-4000-8000-000000033304', '00000000-0000-4000-8000-000000033305']::uuid[])), 0, 'cross-user: the viewer''s two connections return nothing to the owner');
select is((select count(*)::int from core.teams_chat_reads_list_many('PKG', array['00000000-0000-4000-8000-000000033301', '00000000-0000-4000-8000-000000033304', '00000000-0000-4000-8000-000000033306']::uuid[])), 2, 'a mix of own and other people''s ids returns only the own rows');
-- cross-lane
select is((select count(*)::int from core.teams_chat_reads_list_many('APK', array['00000000-0000-4000-8000-000000033301', '00000000-0000-4000-8000-000000033302']::uuid[])), 0, 'cross-lane: PKG connections named with lane APK return nothing');
select is((select count(*)::int from core.teams_chat_reads_list_many('PKG', array['00000000-0000-4000-8000-000000033303']::uuid[])), 0, 'cross-lane: the owner''s APK connection named with lane PKG returns nothing');
select is((select count(*)::int from core.teams_chat_reads_list_many('PKG', array['00000000-0000-4000-8000-000000039999']::uuid[])), 0, 'an unknown id returns nothing');
-- bounds
select is((select count(*)::int from core.teams_chat_reads_list_many('PKG', '{}'::uuid[])), 0, 'no ids: nothing');
select is((select count(*)::int from core.teams_chat_reads_list_many('PKG', null)), 0, 'null: nothing');
select is((select count(*)::int from core.teams_chat_reads_list_many('PKG', array['00000000-0000-4000-8000-000000033301', '00000000-0000-4000-8000-000000033302', '00000000-0000-4000-8000-000000033307', '00000000-0000-4000-8000-000000033308', '00000000-0000-4000-8000-000000033309', '00000000-0000-4000-8000-000000033310']::uuid[])), 0, 'more than five ids: nothing (a person has at most five accounts)');
select is((select count(*)::int from core.teams_chat_reads_list_many('PKG', array['00000000-0000-4000-8000-000000033307']::uuid[])), 1000, 'at most 1,000 rows per connection');
reset role;
-- the viewer
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.teams_chat_reads_list_many('PKG', array['00000000-0000-4000-8000-000000033304', '00000000-0000-4000-8000-000000033305']::uuid[])), 2, 'the viewer gets their own two');
select is((select count(*)::int from core.teams_chat_reads_list_many('PKG', array['00000000-0000-4000-8000-000000033301', '00000000-0000-4000-8000-000000033302']::uuid[])), 0, 'cross-user: ...and none of the owner''s');
reset role;
-- an admin
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.teams_chat_reads_list_many('PKG', array['00000000-0000-4000-8000-000000033301', '00000000-0000-4000-8000-000000033302', '00000000-0000-4000-8000-000000033304']::uuid[])), 0, 'cross-user: an admin (connections view) gets no markers of other people''s connections');
select is((select count(*)::int from core.teams_chat_reads_list_many('PKG', array['00000000-0000-4000-8000-000000033306']::uuid[])), 1, 'but their own');
reset role;
-- no MFA, anon
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.teams_chat_reads_list_many('PKG', array['00000000-0000-4000-8000-000000033301', '00000000-0000-4000-8000-000000033302']::uuid[])), 0, 'AAL1: nothing');
reset role;
set local role anon;
select throws_ok($$select * from core.teams_chat_reads_list_many('PKG', array['00000000-0000-4000-8000-000000033301']::uuid[])$$, '42501', null, 'anon cannot call it');
reset role;

select * from finish();
rollback;
