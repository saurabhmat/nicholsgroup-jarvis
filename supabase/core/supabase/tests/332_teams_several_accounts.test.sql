-- T-294: several Teams accounts per person in one lane (docs/specs/messages.md 22.1, 22.2, 22.12 tests 22 - 26).
-- Covered: core.teams_account_limit (a lane setting 1 - 5; missing, malformed or out of range is 1); core.teams_assert_one_per_owner (new meaning, same name, signature, grants and
-- codes); the trigger connections_teams_account_limit (only a move INTO a counted status is checked; D0024; an advisory lock per lane and owner); the kept unique indexes (one Microsoft
-- account is one row in one lane, owned by one person); the dropped index; lowering the limit never changes a row; every owner-only reader still sees only its owner's rows (two
-- connections per person now); approvals on a second connection. CROSS-LANE AND CROSS-USER denial for every changed object. Synthetic data only.
begin;
select plan(98);
\ir helpers/lane_rls.psql

create function pg_temp.claims_amr(p_email text, p_aal text, p_at bigint) returns text language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', (select id from auth.users where email = p_email), 'role', 'authenticated', 'aal', p_aal,
                      'amr', case when p_at is null then '[]'::json else json_build_array(json_build_object('method', 'totp', 'timestamp', p_at)) end)::text, true);
$$;
-- one new lane_config version: teams.max_accounts_per_person set to p_val (a jsonb value), every other key kept
create function pg_temp.limit_cfg(p_lane text, p_val jsonb) returns void language sql as $$
  insert into core.lane_config (lane_id, version, config)
  select lane_id, version + 1, jsonb_set(config, '{teams}', coalesce(config -> 'teams', '{}'::jsonb) || jsonb_build_object('max_accounts_per_person', p_val))
  from core.lane_config where lane_id = p_lane order by version desc limit 1;
$$;
create function pg_temp.cfg(p_lane text, p_key text, p_val jsonb) returns void language sql as $$
  insert into core.lane_config (lane_id, version, config)
  select lane_id, version + 1, jsonb_set(config, array[p_key], coalesce(config -> p_key, '{}'::jsonb) || p_val)
  from core.lane_config where lane_id = p_lane order by version desc limit 1;
$$;
create function pg_temp.lim(p_lane text) returns int language sql as $$ select core.teams_account_limit(p_lane); $$;
grant execute on function pg_temp.lim(text) to public;

update core.lanes set enabled = true where code = 'APK';

-- owner (A): PKG 33201 (first), 33202 (second), 33203 (pending, third), 33204 (disconnected, fourth); APK 33205
-- viewer (B): PKG 33211, 33212; finance-operator (F): PKG 33221; admin_technical: PKG 33231; A also has a Google row 33206
-- ---------------------------------------------------------------- the default limit is 1 (no teams.max_accounts_per_person anywhere)
select is((select core.teams_account_limit('PKG')), 1, 'no setting: the limit is 1');
select is((select core.teams_account_limit('APK')), 1, 'a lane without the key: 1');
select is((select core.teams_account_limit('ZZZ')), 1, 'an unknown lane: 1 (fail closed)');
select is((select core.teams_account_limit(null)), 1, 'a null lane: 1');
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id) values
  ('00000000-0000-4000-8000-000000033201', 'PKG', 'microsoft_teams', 'robert@teams.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033202', 'PKG', 'microsoft_teams', 'robert@second.example.test', 'pending', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033205', 'APK', 'microsoft_teams', 'robert-apk@teams.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033206', 'PKG', 'google', 'robert@g.example.test', 'active', '{}', pg_temp.uid('owner@example.test'));
select throws_ok($$update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000033202'$$, 'D0024', null, 'limit 1: a second Teams connection of the same person cannot become active (the trigger)');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status, owner_user_id) values ('PKG', 'microsoft_teams', 'robert@third.example.test', 'degraded', pg_temp.uid('owner@example.test'))$$, 'D0024', null, 'limit 1: an INSERT of a second counted row is refused too (degraded counts)');
select is((select status from core.connections where id = '00000000-0000-4000-8000-000000033202'), 'pending', 'the refused move changed nothing');
set local role service_role;
select throws_ok($$select core.teams_assert_one_per_owner('PKG', '00000000-0000-4000-8000-000000033202')$$, 'D0024', null, 'limit 1: teams_assert_one_per_owner refuses the second row');
select lives_ok($$select core.teams_assert_one_per_owner('PKG', '00000000-0000-4000-8000-000000033201')$$, 'the first, already counted row passes');
reset role;

-- ---------------------------------------------------------------- the limit is read from the lane's CURRENT config version; anything but an integer 1 - 5 is 1
select pg_temp.limit_cfg('PKG', '2'::jsonb);
select is((select core.teams_account_limit('PKG')), 2, 'limit 2 is read');
select pg_temp.limit_cfg('PKG', '5'::jsonb);
select is((select core.teams_account_limit('PKG')), 5, 'limit 5 is the most');
select pg_temp.limit_cfg('PKG', '6'::jsonb);
select is((select core.teams_account_limit('PKG')), 1, 'limit 6 (out of range) is 1');
select pg_temp.limit_cfg('PKG', '0'::jsonb);
select is((select core.teams_account_limit('PKG')), 1, 'limit 0 is 1');
select pg_temp.limit_cfg('PKG', '-3'::jsonb);
select is((select core.teams_account_limit('PKG')), 1, 'a negative limit is 1');
select pg_temp.limit_cfg('PKG', '2.5'::jsonb);
select is((select core.teams_account_limit('PKG')), 1, 'a fraction is 1');
select pg_temp.limit_cfg('PKG', '"2"'::jsonb);
select is((select core.teams_account_limit('PKG')), 1, 'a string "2" is 1');
select pg_temp.limit_cfg('PKG', 'true'::jsonb);
select is((select core.teams_account_limit('PKG')), 1, 'a boolean is 1');
select pg_temp.limit_cfg('PKG', 'null'::jsonb);
select is((select core.teams_account_limit('PKG')), 1, 'a JSON null is 1');
select pg_temp.limit_cfg('PKG', '[2]'::jsonb);
select is((select core.teams_account_limit('PKG')), 1, 'an array is 1');
select pg_temp.limit_cfg('PKG', '2'::jsonb);
select is((select core.teams_account_limit('APK')), 1, 'cross-lane: PKG''s setting does not leak to APK');

-- ---------------------------------------------------------------- limit 2: tests 22, 23
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id) values
  ('00000000-0000-4000-8000-000000033211', 'PKG', 'microsoft_teams', 'viewer@teams.example.test', 'active', '{}', pg_temp.uid('viewer@example.test')),
  ('00000000-0000-4000-8000-000000033212', 'PKG', 'microsoft_teams', 'viewer@second.example.test', 'active', '{}', pg_temp.uid('viewer@example.test'));
select is((select count(*)::int from core.connections where provider = 'microsoft_teams' and owner_user_id = pg_temp.uid('viewer@example.test') and status = 'active'), 2, 'another person (B) holds two counted rows at limit 2');
select lives_ok($$update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000033202'$$, 'limit 2: A''s second row becomes active although B holds two and A holds an APK row (other people and other lanes never count)');
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id) values
  ('00000000-0000-4000-8000-000000033203', 'PKG', 'microsoft_teams', 'robert@third.example.test', 'pending', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033204', 'PKG', 'microsoft_teams', 'robert@fourth.example.test', 'disconnected', '{}', pg_temp.uid('owner@example.test'));
select throws_ok($$update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000033203'$$, 'D0024', null, 'limit 2: a third counted row of A is refused by the trigger (pending -> active)');
select throws_ok($$update core.connections set status = 'degraded' where id = '00000000-0000-4000-8000-000000033204'$$, 'D0024', null, '...and a disconnected one cannot come back (disconnected -> degraded)');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status, owner_user_id) values ('PKG', 'microsoft_teams', 'robert@fifth.example.test', 'active', pg_temp.uid('owner@example.test'))$$, 'D0024', null, '...and an INSERT of a third active row is refused');
set local role service_role;
select throws_ok($$select core.teams_assert_one_per_owner('PKG', '00000000-0000-4000-8000-000000033203')$$, 'D0024', null, 'teams_assert_one_per_owner refuses the third (pending) row');
select throws_ok($$select core.teams_assert_one_per_owner('PKG', '00000000-0000-4000-8000-000000033204')$$, 'D0024', null, '...and the disconnected one');
select lives_ok($$select core.teams_assert_one_per_owner('PKG', '00000000-0000-4000-8000-000000033202')$$, 'the already counted second row passes');
select lives_ok($$select core.teams_assert_one_per_owner('PKG', '00000000-0000-4000-8000-000000033211')$$, 'B''s rows pass for B (A''s rows are not B''s)');
-- cross-lane and cross-user
select throws_ok($$select core.teams_assert_one_per_owner('APK', '00000000-0000-4000-8000-000000033203')$$, 'P0002', null, 'cross-lane: a PKG connection named under APK is refused (P0002)');
select throws_ok($$select core.teams_assert_one_per_owner('PKG', '00000000-0000-4000-8000-000000033205')$$, 'P0002', null, 'cross-lane: an APK connection named under PKG is refused (P0002)');
select throws_ok($$select core.teams_assert_one_per_owner('PKG', '00000000-0000-4000-8000-0000000099ff')$$, 'P0002', null, 'an unknown connection: the same P0002');
select throws_ok($$select core.teams_assert_one_per_owner('PKG', '00000000-0000-4000-8000-000000033206')$$, '23514', null, 'a Google connection is refused (23514)');
select throws_ok($$select core.teams_assert_one_per_owner(null, '00000000-0000-4000-8000-000000033203')$$, '22004', null, 'a null lane is refused (22004)');
select throws_ok($$select core.teams_assert_one_per_owner('PKG', null)$$, '22004', null, 'a null connection is refused (22004)');
select is((select core.teams_account_limit('PKG')), 2, 'service_role reads the limit');
reset role;
select is((select count(*)::int from core.connections where owner_user_id = pg_temp.uid('owner@example.test') and provider = 'microsoft_teams' and lane_id = 'PKG' and status not in ('disconnected', 'pending')), 2, 'A holds exactly two counted rows in PKG; nothing slipped in');

-- grants: nothing here is callable by the API roles
select ok(not has_function_privilege('authenticated', 'core.teams_account_limit(text)', 'execute') and not has_function_privilege('anon', 'core.teams_account_limit(text)', 'execute') and has_function_privilege('service_role', 'core.teams_account_limit(text)', 'execute'), 'core.teams_account_limit: service_role only');
select ok(not has_function_privilege('authenticated', 'core.teams_assert_one_per_owner(text, uuid)', 'execute') and not has_function_privilege('anon', 'core.teams_assert_one_per_owner(text, uuid)', 'execute') and has_function_privilege('service_role', 'core.teams_assert_one_per_owner(text, uuid)', 'execute'), 'core.teams_assert_one_per_owner: grants unchanged (service_role only)');
select ok(not has_function_privilege('authenticated', 'core.connections_teams_account_limit()', 'execute') and not has_function_privilege('anon', 'core.connections_teams_account_limit()', 'execute'), 'the trigger function: no API execute');
select ok((select bool_and(prosecdef and proconfig = array['search_path=""']) from pg_proc where oid in ('core.teams_account_limit(text)'::regprocedure, 'core.teams_assert_one_per_owner(text, uuid)'::regprocedure, 'core.connections_teams_account_limit()'::regprocedure)), 'all three are security definer with an empty search_path');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.teams_account_limit('PKG')$$, '42501', null, 'authenticated cannot call teams_account_limit');
select throws_ok($$select core.teams_assert_one_per_owner('PKG', '00000000-0000-4000-8000-000000033203')$$, '42501', null, 'authenticated cannot call teams_assert_one_per_owner');
select throws_ok($$select core.connections_teams_account_limit()$$, '42501', null, 'authenticated cannot call the trigger function');
select throws_ok($$update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000033203'$$, '42501', null, 'authenticated has no update on core.connections to start with (the trigger is not a way around it)');
reset role;
set local role anon;
select throws_ok($$select core.teams_account_limit('PKG')$$, '42501', null, 'anon cannot call teams_account_limit');
select throws_ok($$select core.teams_assert_one_per_owner('PKG', '00000000-0000-4000-8000-000000033203')$$, '42501', null, 'anon cannot call teams_assert_one_per_owner');
reset role;

-- the trigger takes an advisory lock per (lane, owner) (two connects of one person wait for each other); the key is the lane and the owner, nothing else
select is((select count(*)::int from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
           and ((classid::bigint << 32) | objid::bigint) = hashtextextended('teams_account_limit:PKG:' || pg_temp.uid('owner@example.test')::text, 0)), 1,
          'the checks above took the advisory lock for (PKG, A) and hold it to the end of the transaction');
select is((select count(*)::int from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
           and ((classid::bigint << 32) | objid::bigint) = hashtextextended('teams_account_limit:PKG:' || pg_temp.uid('admin-technical@example.test')::text, 0)), 0, 'cross-user: no lock was taken for another person (a key is one lane and one owner)');
select is((select tgenabled::text || '/' || (tgtype & 1)::text || '/' || (tgtype & 2)::text from pg_trigger where tgrelid = 'core.connections'::regclass and tgname = 'connections_teams_account_limit'), 'O/1/2', 'the trigger is enabled, per row, before');
select ok((select pg_get_triggerdef(oid) like '%BEFORE INSERT OR UPDATE OF status ON core.connections FOR EACH ROW WHEN ((new.provider = ''microsoft_teams''::text))%' from pg_trigger where tgrelid = 'core.connections'::regclass and tgname = 'connections_teams_account_limit'), 'the trigger fires on insert and update of status, for Teams rows only');

-- ---------------------------------------------------------------- test 25: only moves into "counted" are checked; lowering the limit changes nothing
select pg_temp.limit_cfg('PKG', '1'::jsonb);
select is((select core.teams_account_limit('PKG')), 1, 'the limit is lowered to 1 in a new version');
select is((select count(*)::int from core.connections where owner_user_id = pg_temp.uid('owner@example.test') and provider = 'microsoft_teams' and lane_id = 'PKG' and status = 'active'), 2, 'nothing was disconnected, paused or changed by lowering it: A still has two active rows');
select lives_ok($$update core.connections set status = 'reconnect_required' where id = '00000000-0000-4000-8000-000000033202'$$, 'active -> reconnect_required passes at limit 1 with two counted rows');
select lives_ok($$update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000033202'$$, 'reconnect_required -> active passes (a counted row is never refused by the limit)');
select lives_ok($$update core.connections set status = 'degraded' where id = '00000000-0000-4000-8000-000000033201'$$, 'active -> degraded passes');
select lives_ok($$update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000033201'$$, 'degraded -> active passes');
select lives_ok($$update core.connections set features = '{"teams_chat_read": true}' where id = '00000000-0000-4000-8000-000000033202'$$, 'a change that does not touch status does not fire the trigger''s check');
select throws_ok($$update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000033204'$$, 'D0024', null, 'disconnected -> active is refused at limit 1 with two counted rows');
select lives_ok($$update core.connections set status = 'disconnected' where id = '00000000-0000-4000-8000-000000033202'$$, 'A disconnects the second row');
select throws_ok($$update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000033202'$$, 'D0024', null, 'limit 1, one other counted row: the disconnected second row cannot come back (disconnected -> active)');
select pg_temp.limit_cfg('PKG', '2'::jsonb);
select lives_ok($$update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000033202'$$, 'limit raised to 2 again: the disconnected row can come back');

-- ---------------------------------------------------------------- test 24: uniqueness kept (one Microsoft account, one row, one lane, one person)
-- F (finance-operator) holds 33221 with an identity; the same account or object id cannot be active a second time anywhere
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id, tenant_id, cloud, entra_object_id) values
  ('00000000-0000-4000-8000-000000033221', 'PKG', 'microsoft_teams', 'finance@teams.example.test', 'active', '{}', pg_temp.uid('finance-operator@example.test'), '00000000-0000-4000-8000-0000000000a1', 'commercial', '00000000-0000-4000-8000-0000000000f1');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status, owner_user_id) values ('PKG', 'microsoft_teams', 'FINANCE@teams.example.test', 'active', pg_temp.uid('finance-operator@example.test'))$$, '23505', null, 'the same UPN (any case) cannot be active twice for the same person in the lane (limit 2 would allow a second row: the index refuses it)');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status, owner_user_id) values ('PKG', 'microsoft_teams', 'finance@teams.example.test', 'active', pg_temp.uid('viewer@example.test'))$$, 'D0024', null, 'cross-user: B is at the limit (two), so B''s attempt to hold F''s account stops at the limit');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status, owner_user_id) values ('PKG', 'microsoft_teams', 'finance@teams.example.test', 'active', pg_temp.uid('admin-technical@example.test'))$$, '23505', null, 'cross-user: another person (under their limit) cannot hold the same UPN in the lane (D-23 index)');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status, owner_user_id) values ('APK', 'microsoft_teams', 'Finance@Teams.Example.Test', 'active', pg_temp.uid('admin-technical@example.test'))$$, '23505', null, 'cross-lane: the same UPN cannot be active in another lane (D-23)');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status, owner_user_id, tenant_id, cloud, entra_object_id) values ('PKG', 'microsoft_teams', 'renamed@teams.example.test', 'active', pg_temp.uid('finance-operator@example.test'), '00000000-0000-4000-8000-0000000000a1', 'commercial', '00000000-0000-4000-8000-0000000000f1')$$, '23505', null, 'the same Entra object id cannot be active twice (same person, same lane)');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status, owner_user_id, tenant_id, cloud, entra_object_id) values ('APK', 'microsoft_teams', 'renamed@teams.example.test', 'active', pg_temp.uid('admin-technical@example.test'), '00000000-0000-4000-8000-0000000000a1', 'commercial', '00000000-0000-4000-8000-0000000000f1')$$, '23505', null, 'cross-lane and cross-user: the same Entra object id cannot be active in another lane for another person');
select ok(exists (select 1 from pg_indexes where schemaname = 'core' and indexname = 'connections_one_teams_per_entra_object') and exists (select 1 from pg_indexes where schemaname = 'core' and indexname = 'connections_one_lane_per_account'), 'both unique indexes are still there');
select ok(not exists (select 1 from pg_indexes where schemaname = 'core' and indexname = 'connections_one_teams_per_owner'), 'connections_one_teams_per_owner is gone');

-- ---------------------------------------------------------------- the identity function and the token store still work with two rows (unchanged bodies; the trigger says D0024)
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id) values
  ('00000000-0000-4000-8000-000000033231', 'PKG', 'microsoft_teams', 'saurabh@teams.example.test', 'active', '{}', pg_temp.uid('admin-technical@example.test')),
  ('00000000-0000-4000-8000-000000033232', 'PKG', 'microsoft_teams', 'saurabh@second.example.test', 'pending', '{}', pg_temp.uid('admin-technical@example.test')),
  ('00000000-0000-4000-8000-000000033233', 'PKG', 'microsoft_teams', 'saurabh@third.example.test', 'pending', '{}', pg_temp.uid('admin-technical@example.test'));
set local role service_role;
select lives_ok($$select core.connection_set_teams_identity('PKG', '00000000-0000-4000-8000-000000033232', '00000000-0000-4000-8000-0000000000a1', 'commercial', '00000000-0000-4000-8000-0000000000f2')$$, 'limit 2: the identity of a second account is set');
select lives_ok($$select core.connection_token_store('PKG', '00000000-0000-4000-8000-000000033232', 'synthetic-token-332-a', null)$$, 'limit 2: the token of the second account is stored and the row becomes active');
select throws_ok($$select core.connection_set_teams_identity('PKG', '00000000-0000-4000-8000-000000033233', '00000000-0000-4000-8000-0000000000a1', 'commercial', '00000000-0000-4000-8000-0000000000f3')$$, 'D0024', null, 'limit 2: the identity of a third account is refused before any token');
update core.connections set tenant_id = '00000000-0000-4000-8000-0000000000a1', cloud = 'commercial', entra_object_id = '00000000-0000-4000-8000-0000000000f3' where id = '00000000-0000-4000-8000-000000033233';
select throws_ok($$select core.connection_token_store('PKG', '00000000-0000-4000-8000-000000033233', 'synthetic-token-332-b', null)$$, 'D0024', null, 'limit 2: a crafted token store for a third account is refused by the trigger (D0024), not "unavailable"');
reset role;
select is((select status from core.connections where id = '00000000-0000-4000-8000-000000033233'), 'pending', 'the refused store changed nothing');
select ok(not exists (select 1 from core.connection_secrets where connection_id = '00000000-0000-4000-8000-000000033233'), 'and no secret is left behind (the Vault write rolled back with it)');
select is((select count(*)::int from core.connection_secrets where connection_id = '00000000-0000-4000-8000-000000033232'), 1, 'the second account''s secret exists');
select ok(has_function_privilege('service_role', 'core.connection_set_teams_identity(text, uuid, uuid, text, uuid)', 'execute') and not has_function_privilege('authenticated', 'core.connection_set_teams_identity(text, uuid, uuid, text, uuid)', 'execute'), 'connection_set_teams_identity: grants unchanged');

-- ---------------------------------------------------------------- readers: owner-only, per connection, both rows of one person
select is((select core.teams_connection_ids(pg_temp.uid('owner@example.test'), 'PKG')), array['00000000-0000-4000-8000-000000033201', '00000000-0000-4000-8000-000000033202', '00000000-0000-4000-8000-000000033203', '00000000-0000-4000-8000-000000033204']::uuid[], 'service_role (a job): every Teams row of A in PKG, none of B''s, none of APK''s');
insert into comms.teams_chat_reads (lane_id, connection_id, chat_id, read_through) values
  ('PKG', '00000000-0000-4000-8000-000000033201', '19:one@thread.v2', now()), ('PKG', '00000000-0000-4000-8000-000000033202', '19:two@thread.v2', now()),
  ('PKG', '00000000-0000-4000-8000-000000033211', '19:bee@thread.v2', now()), ('PKG', '00000000-0000-4000-8000-000000033212', '19:bee2@thread.v2', now()),
  ('APK', '00000000-0000-4000-8000-000000033205', '19:apk@thread.v2', now());
insert into comms.teams_activity (lane_id, connection_id, last_notice_at, notices_since_seen) values
  ('PKG', '00000000-0000-4000-8000-000000033201', now(), 1), ('PKG', '00000000-0000-4000-8000-000000033202', now(), 2),
  ('PKG', '00000000-0000-4000-8000-000000033211', now(), 3), ('APK', '00000000-0000-4000-8000-000000033205', now(), 4);
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select core.teams_connection_ids(pg_temp.uid('owner@example.test'), 'PKG')), array['00000000-0000-4000-8000-000000033201', '00000000-0000-4000-8000-000000033202', '00000000-0000-4000-8000-000000033203', '00000000-0000-4000-8000-000000033204']::uuid[], 'A sees both counted rows (and the pending and disconnected ones) and nothing of B or of APK in PKG');
select is((select count(*)::int from comms.teams_chat_reads where lane_id = 'PKG'), 2, 'A reads the markers of BOTH own connections and none of B''s (cross-user)');
select is((select count(*)::int from comms.teams_activity where lane_id = 'PKG'), 2, 'A reads the activity of both own connections and none of B''s (cross-user)');
select is((select count(*)::int from comms.teams_chat_reads where connection_id in ('00000000-0000-4000-8000-000000033211', '00000000-0000-4000-8000-000000033212')), 0, 'cross-user: B''s markers, both connections, are invisible to A');
select is((select count(*)::int from comms.teams_activity where connection_id = '00000000-0000-4000-8000-000000033211'), 0, 'cross-user: B''s activity is invisible to A');
select throws_ok($$select entra_object_id from core.connections$$, '42501', null, 'the lane owner reads other people''s rows as health only: never the Entra object id');
reset role;
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from comms.teams_chat_reads), 2, 'B reads both own markers and none of A''s, none of APK''s');
select is((select core.teams_connection_ids(pg_temp.uid('owner@example.test'), 'PKG')), '{}'::uuid[], 'cross-user: B cannot resolve A''s connection ids');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.connections where provider = 'microsoft_teams' and owner_user_id = pg_temp.uid('owner@example.test')), 4, 'an admin (connections view) reads the health rows of A: all of them, one row each');
select throws_ok($$select entra_object_id from core.connections$$, '42501', null, 'an admin cannot read the Entra object id of any row');
select is((select count(*)::int from comms.teams_chat_reads), 0, 'an admin reads no marker of anyone else''s connections');
select is((select count(*)::int from comms.teams_activity), 0, 'an admin reads no activity of anyone else''s connections');
reset role;
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from comms.teams_chat_reads), 0, 'AAL1: nothing');
reset role;

-- ---------------------------------------------------------------- test 26: approvals on A's SECOND connection
update core.lane_policies set store_outbound_drafts = true, write_actions_allowed = array['teams_send', 'email_send', 'email_draft', 'qbo_disconnect'] where lane_id in ('PKG', 'APK');
select pg_temp.cfg('PKG', 'approvals', '{"approvals_live": true}');
select pg_temp.cfg('PKG', 'teams', '{"enabled": true, "features": ["chat_read", "chat_send"]}');
update core.connections set features = '{"teams_chat_send": true}' where id in ('00000000-0000-4000-8000-000000033201', '00000000-0000-4000-8000-000000033202');
create temp table ids (k text primary key, id uuid);
grant all on ids to public;
set local role service_role;
insert into ids select 'second', act.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033202'::uuid, jsonb_build_object('chat_id', '19:abc123@thread.v2', 'client_request_id', '5e11d0c0-0000-4000-8000-000000000001'), jsonb_build_object('content_type', 'text', 'text', 'CANARY text of a chat message'), 1, encode(sha256(convert_to('hash-second', 'utf8')), 'hex'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false);
select throws_ok($$select act.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033202'::uuid, jsonb_build_object('chat_id', '19:abc123@thread.v2', 'client_request_id', '5e11d0c0-0000-4000-8000-000000000002'), jsonb_build_object('content_type', 'text', 'text', 'x'), 1, encode(sha256(convert_to('hash-b', 'utf8')), 'hex'), null, '[]', 'user', pg_temp.uid('admin-technical@example.test'), false)$$, '42501', null, 'cross-user: another person (an admin) cannot propose on A''s second connection');
select throws_ok($$select act.propose('APK', 'teams.chat.send', '00000000-0000-4000-8000-000000033202'::uuid, jsonb_build_object('chat_id', '19:abc123@thread.v2', 'client_request_id', '5e11d0c0-0000-4000-8000-000000000003'), jsonb_build_object('content_type', 'text', 'text', 'x'), 1, encode(sha256(convert_to('hash-c', 'utf8')), 'hex'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false)$$, '23503', null, 'cross-lane: the second connection named under APK is refused');
reset role;
select is((select connection_id::text from act.proposed_actions where id = (select id from ids where k = 'second')), '00000000-0000-4000-8000-000000033202', 'the action belongs to the second connection');
select pg_temp.claims_amr('admin-technical@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'second'), encode(sha256(convert_to('hash-second', 'utf8')), 'hex')), 'P0002', null, 'cross-user: another person (an admin) cannot approve A''s second-connection action (not found)');
reset role;
select pg_temp.claims_amr('owner@example.test', 'aal2', extract(epoch from now())::bigint);
set local role authenticated;
select lives_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'second'), encode(sha256(convert_to('hash-second', 'utf8')), 'hex')), 'A approves the action on the second connection');
reset role;
select is((select status from act.proposed_actions where id = (select id from ids where k = 'second')), 'approved', 'it is approved');

select * from finish();
rollback;
