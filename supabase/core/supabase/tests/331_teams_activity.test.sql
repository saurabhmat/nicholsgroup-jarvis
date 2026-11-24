-- T-289: comms.teams_activity (new-message notices of a Teams connection; spec 7.3) and the `teams_chats` resource of core.push_subscriptions (spec 7.4). Covered: the exact columns (times and a capped
-- counter: no chat, message or sender: rule 6), the primary key, RLS (owner of the Teams connection only, at AAL2), no write grant to any role, the service-only writer
-- comms.teams_activity_notice, the owner-only writer comms.teams_activity_seen, the owner's one read core.teams_activity_get, one answer for unknown / another lane's / another person's connection,
-- the provider trigger, deletion on disconnect and retention, and the push_subscriptions checks that tie each resource to its provider (mail and calendar keep working; teams_chats only for Teams).
-- CROSS-LANE AND CROSS-USER denial throughout. Synthetic data only: example UUIDs, example.test addresses.
begin;
select plan(122);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';

-- 33101 viewer / PKG / Teams, 33102 owner / PKG / Teams, 33103 owner / APK / Teams, 33104 owner / PKG / Microsoft mail, 33105 owner / PKG / Google, 33106 admin_technical / PKG / Teams,
-- 33107 owner / PKG / Teams disconnected, 33108 owner / PKG / Teams pending
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id) values
  ('00000000-0000-4000-8000-000000033101', 'PKG', 'microsoft_teams', 'viewer@teams.example.test', 'active', '{}', pg_temp.uid('viewer@example.test')),
  ('00000000-0000-4000-8000-000000033102', 'PKG', 'microsoft_teams', 'robert@teams.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033103', 'APK', 'microsoft_teams', 'robert-apk@teams.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033104', 'PKG', 'microsoft', 'robert@ms.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033105', 'PKG', 'google', 'robert@g.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033106', 'PKG', 'microsoft_teams', 'saurabh@teams.example.test', 'active', '{}', pg_temp.uid('admin-technical@example.test')),
  ('00000000-0000-4000-8000-000000033107', 'PKG', 'microsoft_teams', 'robert-old@teams.example.test', 'disconnected', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033108', 'PKG', 'microsoft_teams', 'robert-new@teams.example.test', 'pending', '{}', pg_temp.uid('owner@example.test'));

-- ---------------------------------------------------------------- the table: times and a capped counter, nothing about a chat
select has_table('comms', 'teams_activity', 'the table exists');
select columns_are('comms', 'teams_activity', array['lane_id', 'connection_id', 'last_notice_at', 'notices_since_seen', 'last_seen_at', 'updated_at'], 'exactly the listed columns: no chat id, message id, sender or text');
select col_type_is('comms', 'teams_activity', 'last_notice_at', 'timestamp with time zone', 'last_notice_at is timestamptz');
select col_type_is('comms', 'teams_activity', 'last_seen_at', 'timestamp with time zone', 'last_seen_at is timestamptz');
select col_type_is('comms', 'teams_activity', 'updated_at', 'timestamp with time zone', 'updated_at is timestamptz');
select col_is_pk('comms', 'teams_activity', array['connection_id'], 'primary key (connection_id)');
select fk_ok('comms', 'teams_activity', array['connection_id', 'lane_id'], 'core', 'connections', array['id', 'lane_id'], 'the composite foreign key (connection_id, lane_id) -> core.connections (id, lane_id) exists');
select ok((select relrowsecurity from pg_class where oid = 'comms.teams_activity'::regclass), 'RLS is enabled');
select is((select count(*)::int from pg_policy where polrelid = 'comms.teams_activity'::regclass), 1, 'exactly one policy');
select ok((select polcmd = 'r' and polroles = array[(select oid from pg_roles where rolname = 'authenticated')]::oid[] and polpermissive from pg_policy where polrelid = 'comms.teams_activity'::regclass), 'it is a permissive SELECT policy for authenticated only');
select ok((select pg_get_expr(polqual, polrelid) like '%teams_connection_ids%' and pg_get_expr(polqual, polrelid) like '%aal2%' from pg_policy where polrelid = 'comms.teams_activity'::regclass), 'it requires AAL2 and the owner''s Teams connection ids');
select ok(not has_table_privilege('authenticated', 'comms.teams_activity', 'insert, update, delete, truncate') and not has_any_column_privilege('authenticated', 'comms.teams_activity', 'insert, update'), 'authenticated has no write grant, table or column level');
select ok(has_table_privilege('authenticated', 'comms.teams_activity', 'select'), 'authenticated can select (the policy decides which rows)');
select ok(not has_table_privilege('anon', 'comms.teams_activity', 'select, insert, update, delete') and not has_any_column_privilege('anon', 'comms.teams_activity', 'select, insert, update, references'), 'anon has nothing');
select ok(not has_table_privilege('service_role', 'comms.teams_activity', 'select, insert, update, delete, truncate'), 'service_role has no direct table grant either (writes go through the functions)');
select ok((select bool_and(prosecdef and proconfig = array['search_path=""']) from pg_proc where oid in ('comms.teams_activity_notice(text, uuid)'::regprocedure, 'comms.teams_activity_seen(text, uuid)'::regprocedure, 'core.teams_activity_get(text, uuid)'::regprocedure, 'core.teams_activity_purge_connection(text, uuid)'::regprocedure, 'core.teams_activity_purge(text)'::regprocedure)), 'the writers, the read and the purges are security definer with an empty search_path');
select ok(not (select prosecdef from pg_proc where oid = 'core.teams_activity_notice(text, uuid)'::regprocedure) and not (select prosecdef from pg_proc where oid = 'core.teams_activity_seen(text, uuid)'::regprocedure), 'the two core wrappers are security INVOKER');
select ok(has_function_privilege('service_role', 'comms.teams_activity_notice(text, uuid)', 'execute') and has_function_privilege('service_role', 'core.teams_activity_notice(text, uuid)', 'execute') and not has_function_privilege('authenticated', 'comms.teams_activity_notice(text, uuid)', 'execute') and not has_function_privilege('authenticated', 'core.teams_activity_notice(text, uuid)', 'execute') and not has_function_privilege('anon', 'core.teams_activity_notice(text, uuid)', 'execute'), 'the notice writer: service_role only');
select ok(has_function_privilege('authenticated', 'comms.teams_activity_seen(text, uuid)', 'execute') and has_function_privilege('authenticated', 'core.teams_activity_seen(text, uuid)', 'execute') and has_function_privilege('authenticated', 'core.teams_activity_get(text, uuid)', 'execute') and not has_function_privilege('service_role', 'comms.teams_activity_seen(text, uuid)', 'execute') and not has_function_privilege('service_role', 'core.teams_activity_seen(text, uuid)', 'execute') and not has_function_privilege('service_role', 'core.teams_activity_get(text, uuid)', 'execute') and not has_function_privilege('anon', 'core.teams_activity_seen(text, uuid)', 'execute') and not has_function_privilege('anon', 'core.teams_activity_get(text, uuid)', 'execute'), 'the seen writer and the read: authenticated only (the person''s own session)');
select ok(has_function_privilege('service_role', 'core.teams_activity_purge_connection(text, uuid)', 'execute') and has_function_privilege('service_role', 'core.teams_activity_purge(text)', 'execute') and not has_function_privilege('authenticated', 'core.teams_activity_purge_connection(text, uuid)', 'execute') and not has_function_privilege('authenticated', 'core.teams_activity_purge(text)', 'execute') and not has_function_privilege('anon', 'core.teams_activity_purge(text)', 'execute'), 'the two purge functions: service_role only');

-- ---------------------------------------------------------------- the notice writer (service role): usable Teams connections of enabled lanes only
set local role service_role;
select is((select core.teams_activity_notice('PKG', '00000000-0000-4000-8000-000000033102')) is not null, true, 'a valid notice for the owner''s usable Teams connection is recorded');
select is((select core.teams_activity_notice('PKG', '00000000-0000-4000-8000-000000033102')) is not null, true, 'a second one too');
select throws_ok($$select core.teams_activity_notice('APK', '00000000-0000-4000-8000-000000033102')$$, 'P0002', null, 'cross-lane: a PKG connection named with lane APK');
select throws_ok($$select core.teams_activity_notice('PKG', '00000000-0000-4000-8000-000000033103')$$, 'P0002', null, 'cross-lane: the owner''s APK connection named with lane PKG');
select throws_ok($$select core.teams_activity_notice('PKG', '00000000-0000-4000-8000-000000033104')$$, 'P0002', null, 'a Microsoft mail connection is not a Teams connection');
select throws_ok($$select core.teams_activity_notice('PKG', '00000000-0000-4000-8000-000000033105')$$, 'P0002', null, 'a Google connection is not a Teams connection');
select throws_ok($$select core.teams_activity_notice('PKG', '00000000-0000-4000-8000-000000033107')$$, 'P0002', null, 'a disconnected Teams connection records nothing');
select throws_ok($$select core.teams_activity_notice('PKG', '00000000-0000-4000-8000-000000033108')$$, 'P0002', null, 'a pending Teams connection records nothing');
select throws_ok($$select core.teams_activity_notice('PKG', '00000000-0000-4000-8000-0000000099ff')$$, 'P0002', null, 'an unknown connection');
select throws_ok($$select core.teams_activity_notice(null, '00000000-0000-4000-8000-000000033102')$$, 'P0002', null, 'no lane');
select throws_ok($$select core.teams_activity_notice('PKG', null)$$, 'P0002', null, 'no connection');
select throws_ok($$select count(*) from comms.teams_activity$$, '42501', null, 'the service role cannot read the table directly');
reset role;
select is((select notices_since_seen from comms.teams_activity where connection_id = '00000000-0000-4000-8000-000000033102'), 2, 'two notices counted');
select ok((select last_notice_at > now() - interval '1 minute' and last_seen_at is null from comms.teams_activity where connection_id = '00000000-0000-4000-8000-000000033102'), 'last_notice_at is our clock now; nothing seen yet');
select is((select count(*)::int from comms.teams_activity), 1, 'only the one row exists (every refused notice left nothing)');
update comms.teams_activity set notices_since_seen = 998 where connection_id = '00000000-0000-4000-8000-000000033102';
set local role service_role;
select core.teams_activity_notice('PKG', '00000000-0000-4000-8000-000000033102');
select core.teams_activity_notice('PKG', '00000000-0000-4000-8000-000000033102');
select core.teams_activity_notice('PKG', '00000000-0000-4000-8000-000000033102');
reset role;
select is((select notices_since_seen from comms.teams_activity where connection_id = '00000000-0000-4000-8000-000000033102'), 999, 'the counter is capped at 999');
select throws_ok($$update comms.teams_activity set notices_since_seen = 1000 where connection_id is not null$$, '23514', null, 'the cap is a check as well (not only the function)');
update core.connections set status = 'degraded' where id = '00000000-0000-4000-8000-000000033102';
set local role service_role;
select lives_ok($$select core.teams_activity_notice('PKG', '00000000-0000-4000-8000-000000033102')$$, 'a degraded connection is still usable');
reset role;
update core.connections set status = 'reconnect_required' where id = '00000000-0000-4000-8000-000000033102';
set local role service_role;
select throws_ok($$select core.teams_activity_notice('PKG', '00000000-0000-4000-8000-000000033102')$$, 'P0002', null, 'a reconnect-required connection records nothing');
reset role;
update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000033102';
-- nobody else can write a notice
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.teams_activity_notice('PKG', '00000000-0000-4000-8000-000000033102')$$, '42501', null, 'the owner cannot forge a notice (service role only)');
select throws_ok($$select comms.teams_activity_notice('PKG', '00000000-0000-4000-8000-000000033102')$$, '42501', null, 'nor through the comms function');
select throws_ok($$insert into comms.teams_activity (lane_id, connection_id) values ('PKG', '00000000-0000-4000-8000-000000033106')$$, '42501', null, 'a direct insert is refused (no grant)');
select throws_ok($$update comms.teams_activity set last_seen_at = now()$$, '42501', null, 'a direct update is refused');
select throws_ok($$delete from comms.teams_activity$$, '42501', null, 'a direct delete is refused');
reset role;
set local role anon;
select throws_ok($$select core.teams_activity_notice('PKG', '00000000-0000-4000-8000-000000033102')$$, '42501', null, 'anon cannot write a notice');
select throws_ok($$select count(*) from comms.teams_activity$$, '42501', null, 'anon cannot read');
reset role;

-- ---------------------------------------------------------------- the owner's read and the seen writer
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from comms.teams_activity), 1, 'the owner sees exactly their own row');
select ok((select last_notice_at is not null and last_seen_at is null from core.teams_activity_get('PKG', '00000000-0000-4000-8000-000000033102')), 'core.teams_activity_get: a notice, nothing seen (the dot)');
select is((select live from core.teams_activity_get('PKG', '00000000-0000-4000-8000-000000033102')), false, 'no live subscription yet: notices are not on');
select is((select count(*)::int from core.teams_activity_get('PKG', '00000000-0000-4000-8000-000000033102')), 1, 'one row');
select is((select core.teams_activity_seen('PKG', '00000000-0000-4000-8000-000000033102')) is not null, true, 'the owner opens the chat list: seen');
select ok((select last_seen_at >= last_notice_at from core.teams_activity_get('PKG', '00000000-0000-4000-8000-000000033102')), 'last_seen_at is now not before the last notice: no dot');
select is((select notices_since_seen from comms.teams_activity where connection_id = '00000000-0000-4000-8000-000000033102'), 0, 'the counter is reset');
select lives_ok($$select core.teams_activity_seen('PKG', '00000000-0000-4000-8000-000000033102')$$, 'seen twice is fine');
-- the owner cannot touch another lane's, a mailbox's, another person's or an unknown connection (one answer for all)
select throws_ok($$select core.teams_activity_seen('APK', '00000000-0000-4000-8000-000000033102')$$, 'P0002', null, 'cross-lane: a PKG connection named with lane APK');
select throws_ok($$select core.teams_activity_seen('PKG', '00000000-0000-4000-8000-000000033103')$$, 'P0002', null, 'cross-lane: the owner''s APK Teams connection named with lane PKG');
select throws_ok($$select core.teams_activity_seen('PKG', '00000000-0000-4000-8000-000000033104')$$, 'P0002', null, 'a Microsoft mail connection is not a Teams connection');
select throws_ok($$select core.teams_activity_seen('PKG', '00000000-0000-4000-8000-000000033105')$$, 'P0002', null, 'a Google connection is not a Teams connection');
select throws_ok($$select core.teams_activity_seen('PKG', '00000000-0000-4000-8000-000000033107')$$, 'P0002', null, 'a disconnected Teams connection');
select throws_ok($$select core.teams_activity_seen('PKG', '00000000-0000-4000-8000-000000033108')$$, 'P0002', null, 'a pending Teams connection');
select throws_ok($$select core.teams_activity_seen('PKG', '00000000-0000-4000-8000-0000000099ff')$$, 'P0002', null, 'an unknown connection');
select throws_ok($$select core.teams_activity_seen('PKG', '00000000-0000-4000-8000-000000033101')$$, 'P0002', null, 'cross-user: the viewer''s Teams connection');
select throws_ok($$select core.teams_activity_seen('PKG', '00000000-0000-4000-8000-000000033106')$$, 'P0002', null, 'cross-user: the admin_technical''s Teams connection');
select throws_ok($$select core.teams_activity_seen(null, '00000000-0000-4000-8000-000000033102')$$, 'P0002', null, 'no lane');
select is((select count(*)::int from core.teams_activity_get('PKG', '00000000-0000-4000-8000-000000033101')), 0, 'cross-user: reading the viewer''s connection returns nothing');
select is((select count(*)::int from core.teams_activity_get('APK', '00000000-0000-4000-8000-000000033102')), 0, 'cross-lane: reading the owner''s connection with another lane returns nothing');
select is((select count(*)::int from core.teams_activity_get('PKG', '00000000-0000-4000-8000-000000033104')), 0, 'a mail connection returns nothing');
reset role;

-- ---------------------------------------------------------------- a live subscription makes `live` true (only while active and not expired)
insert into core.push_subscriptions (lane_id, connection_id, provider, resource, subscription_id, resource_path, expires_at, vault_secret_id)
values ('PKG', '00000000-0000-4000-8000-000000033102', 'microsoft_teams', 'teams_chats', 'sub-33102', 'users/00000000-0000-4000-8000-0000000000b2/chats/getAllMessages', now() + interval '2 days', vault.create_secret('known-secret-t289-331-a', 't289-331-a'));
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select live from core.teams_activity_get('PKG', '00000000-0000-4000-8000-000000033102')), true, 'with an active unexpired subscription, live is true');
select ok((select live_until between now() + interval '47 hours' and now() + interval '49 hours' from core.teams_activity_get('PKG', '00000000-0000-4000-8000-000000033102')), 'and live_until is its expiry');
reset role;
update core.push_subscriptions set expires_at = now() - interval '1 minute' where subscription_id = 'sub-33102';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select live from core.teams_activity_get('PKG', '00000000-0000-4000-8000-000000033102')), false, 'an expired subscription is not live');
select ok((select live_until is null from core.teams_activity_get('PKG', '00000000-0000-4000-8000-000000033102')), 'and has no live_until');
reset role;
update core.push_subscriptions set expires_at = now() + interval '2 days', status = 'reauthorization_required' where subscription_id = 'sub-33102';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select live from core.teams_activity_get('PKG', '00000000-0000-4000-8000-000000033102')), false, 'reauthorization_required is not live either');
reset role;

-- ---------------------------------------------------------------- other people see nothing of it (cross-user denial)
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from comms.teams_activity), 0, 'cross-user: the viewer sees no row (not the owner''s)');
select is((select count(*)::int from core.teams_activity_get('PKG', '00000000-0000-4000-8000-000000033102')), 0, 'cross-user: the viewer cannot read the owner''s activity');
select lives_ok($$select core.teams_activity_seen('PKG', '00000000-0000-4000-8000-000000033101')$$, 'the viewer''s own connection: seen works (their own row)');
select is((select count(*)::int from comms.teams_activity), 1, 'and they see exactly that row');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from comms.teams_activity), 0, 'an admin (owner of the lane''s connections view) sees no activity row of anyone else');
select is((select count(*)::int from core.teams_activity_get('PKG', '00000000-0000-4000-8000-000000033102')), 0, 'an admin asking for the owner''s connection gets nothing');
select is((select count(*)::int from core.teams_activity_get('PKG', '00000000-0000-4000-8000-000000033101')), 0, 'nor the viewer''s');
reset role;
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from comms.teams_activity), 0, 'missing MFA (aal1): no row at all');
select is((select count(*)::int from core.teams_activity_get('PKG', '00000000-0000-4000-8000-000000033102')), 0, 'missing MFA (aal1): the read returns nothing');
select throws_ok($$select core.teams_activity_seen('PKG', '00000000-0000-4000-8000-000000033102')$$, 'P0002', null, 'missing MFA (aal1): the seen writer refuses');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from comms.teams_activity), 0, 'a member without own_mail sees nothing');
select throws_ok($$select core.teams_activity_seen('PKG', '00000000-0000-4000-8000-000000033102')$$, 'P0002', null, 'and cannot mark seen');
reset role;

-- ---------------------------------------------------------------- the provider guard and the composite foreign key (as the table owner: the only way to try)
select throws_ok($$insert into comms.teams_activity (lane_id, connection_id) values ('PKG', '00000000-0000-4000-8000-000000033104')$$, '23514', null, 'an activity row for a Microsoft mail connection is refused by the trigger');
select throws_ok($$insert into comms.teams_activity (lane_id, connection_id) values ('PKG', '00000000-0000-4000-8000-000000033105')$$, '23514', null, 'an activity row for a Google connection is refused');
select throws_ok($$insert into comms.teams_activity (lane_id, connection_id) values ('APK', '00000000-0000-4000-8000-000000033102')$$, '23514', null, 'cross-lane: a PKG connection with lane APK is refused (the trigger checks the lane as well)');

-- ---------------------------------------------------------------- core.push_subscriptions: every resource belongs to its provider
select ok((select pg_get_constraintdef(oid) like '%teams_chats%' from pg_constraint where conrelid = 'core.push_subscriptions'::regclass and conname = 'push_subscriptions_resource_check'), 'the resource check lists teams_chats');
select ok(exists (select 1 from pg_constraint where conrelid = 'core.push_subscriptions'::regclass and conname = 'push_subscriptions_provider_resource_check'), 'the provider-resource tie exists');
set local role service_role;
select lives_ok($$select core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000033106', 'microsoft_teams', 'teams_chats', 'sub-33106', 'users/00000000-0000-4000-8000-0000000000c3/chats/getAllMessages', now() + interval '2 days', repeat('s', 40))$$, 'the existing record function accepts a Teams subscription for a Teams connection');
select lives_ok($$select core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000033104', 'microsoft', 'mail', 'sub-33104', 'me/mailfolders(''inbox'')/messages', now() + interval '2 days', repeat('s', 40))$$, 'and still a mail subscription for a mail connection');
select lives_ok($$select core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000033104', 'microsoft', 'calendar', 'sub-33104c', 'me/events', now() + interval '2 days', repeat('s', 40))$$, 'and a calendar one');
select throws_ok($$select core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000033104', 'microsoft', 'teams_chats', 'sub-x1', 'users/00000000-0000-4000-8000-0000000000c3/chats/getAllMessages', now() + interval '2 days', repeat('s', 40))$$, '23514', null, 'a teams_chats resource under provider microsoft is refused');
select throws_ok($$select core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000033101', 'microsoft_teams', 'mail', 'sub-x2', 'me/mailfolders(''inbox'')/messages', now() + interval '2 days', repeat('s', 40))$$, '23514', null, 'a mail resource under provider microsoft_teams is refused');
select throws_ok($$select core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000033101', 'microsoft_teams', 'calendar', 'sub-x3', 'me/events', now() + interval '2 days', repeat('s', 40))$$, '23514', null, 'a calendar resource under provider microsoft_teams is refused');
select throws_ok($$select core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000033105', 'google', 'teams_chats', 'sub-x4', 'users/00000000-0000-4000-8000-0000000000c3/chats/getAllMessages', now() + interval '2 days', repeat('s', 40))$$, '23514', null, 'a teams_chats resource under provider google is refused');
select throws_ok($$select core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000033101', 'microsoft_teams', 'teams_chats', 'sub-x5', 'me/chats', now() + interval '2 days', repeat('s', 40))$$, '23514', null, 'a teams_chats resource path that is not users/<uuid>/chats/getAllMessages is refused');
select throws_ok($$select core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000033101', 'microsoft_teams', 'teams_chats', 'sub-x6', 'users/someone@example.test/chats/getAllMessages', now() + interval '2 days', repeat('s', 40))$$, '23514', null, 'a resource path that holds an address is refused');
select throws_ok($$select core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000033104', 'microsoft_teams', 'teams_chats', 'sub-x7', 'users/00000000-0000-4000-8000-0000000000c3/chats/getAllMessages', now() + interval '2 days', repeat('s', 40))$$, '42501', null, 'the provider named must be the connection''s own: a mail connection is not a Teams one');
select throws_ok($$select core.push_subscription_record('APK', '00000000-0000-4000-8000-000000033102', 'microsoft_teams', 'teams_chats', 'sub-x8', 'users/00000000-0000-4000-8000-0000000000c3/chats/getAllMessages', now() + interval '2 days', repeat('s', 40))$$, '42501', null, 'cross-lane: a PKG Teams connection named with lane APK');
-- one live all-chats subscription per connection: recording again supersedes (never two)
select lives_ok($$select core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000033106', 'microsoft_teams', 'teams_chats', 'sub-33106b', 'users/00000000-0000-4000-8000-0000000000c3/chats/getAllMessages', now() + interval '2 days', repeat('t', 40))$$, 'a second record for the same Teams connection supersedes the first');
select is((select count(*)::int from core.push_subscription_list('PKG', '00000000-0000-4000-8000-000000033106')), 1, 'exactly one live all-chats subscription per connection');
select is((select resource from core.push_subscription_lookup('PKG', 'microsoft_teams', array['sub-33106b'])), 'teams_chats', 'the lookup returns the resource for the Teams provider');
select is((select count(*)::int from core.push_subscription_lookup('PKG', 'microsoft', array['sub-33106b'])), 0, 'and nothing under provider microsoft (the receiver asks both)');
reset role;

-- ---------------------------------------------------------------- the receiver's claim names the connection's provider (a Teams subscription's connection is `microsoft_teams`)
set local role service_role;
select is((select core.webhook_event_claim('PKG', '00000000-0000-4000-8000-000000033102', 'microsoft_teams', 'ms:change:t289a', 'teams_chats.changed', repeat('a', 64))), 'process', 'a Teams notice is claimed under microsoft_teams');
select is((select core.webhook_event_claim('PKG', '00000000-0000-4000-8000-000000033102', 'microsoft_teams', 'ms:change:t289a', 'teams_chats.changed', repeat('a', 64))), 'duplicate', 'and a replay is a duplicate');
select throws_ok($$select core.webhook_event_claim('PKG', '00000000-0000-4000-8000-000000033102', 'microsoft', 'ms:change:t289b', 'teams_chats.changed', repeat('a', 64))$$, '42501', null, 'the same claim naming provider microsoft is refused (the connection is a Teams one)');
select throws_ok($$select core.webhook_event_claim('APK', '00000000-0000-4000-8000-000000033102', 'microsoft_teams', 'ms:change:t289c', 'teams_chats.changed', repeat('a', 64))$$, '42501', null, 'cross-lane: a PKG Teams connection named with lane APK is refused');
select is((select core.webhook_event_mark('PKG', 'microsoft_teams', 'ms:change:t289a', 'enqueued')), true, 'the Teams receipt is marked enqueued');
select is((select core.webhook_event_mark('APK', 'microsoft_teams', 'ms:change:t289a', 'failed')), false, 'cross-lane: another lane cannot mark it');
reset role;

-- ---------------------------------------------------------------- the renewal's ownership question (the job asks core.teams_connection_ids for the owner, as the service role)
set local role service_role;
select ok('00000000-0000-4000-8000-000000033102'::uuid = any (core.teams_connection_ids(pg_temp.uid('owner@example.test'), 'PKG')), 'the job can ask: the owner still holds own_mail in PKG, so their usable Teams connection is listed');
select is((select core.teams_connection_ids(pg_temp.uid('finance-operator@example.test'), 'PKG')), '{}'::uuid[], 'a member without own_mail owns no Teams connection here (the renewal then stops the subscription)');
select is((select core.teams_connection_ids(pg_temp.uid('owner@example.test'), 'APK') @> array['00000000-0000-4000-8000-000000033102']::uuid[]), false, 'cross-lane: asking with another lane never lists a PKG connection');
reset role;

-- ---------------------------------------------------------------- deletion on disconnect and retention (service_role only; lane-keyed)
set local role authenticated;
select throws_ok($$select core.teams_activity_purge_connection('PKG', '00000000-0000-4000-8000-000000033102')$$, '42501', null, 'authenticated cannot purge a connection');
select throws_ok($$select core.teams_activity_purge('PKG')$$, '42501', null, 'authenticated cannot run the retention purge');
reset role;
set local role service_role;
select throws_ok($$select core.teams_activity_purge_connection('NOPE', '00000000-0000-4000-8000-000000033102')$$, '42501', null, 'an unknown lane is refused');
select is((select core.teams_activity_purge_connection('APK', '00000000-0000-4000-8000-000000033102')), 0, 'cross-lane: a PKG connection named with lane APK deletes nothing');
select is((select core.teams_activity_purge_connection('PKG', '00000000-0000-4000-8000-000000033101')), 1, 'the disconnect purge deletes exactly that connection''s row (the viewer''s)');
reset role;
select is((select count(*)::int from comms.teams_activity where connection_id = '00000000-0000-4000-8000-000000033102'), 1, 'and not another person''s');
-- retention: the row of a disconnected connection goes, nothing else
select core.teams_activity_notice('PKG', '00000000-0000-4000-8000-000000033106');
update core.connections set status = 'disconnected' where id = '00000000-0000-4000-8000-000000033106';
set local role service_role;
select is((select core.teams_activity_purge('APK')), 0, 'cross-lane: purging APK deletes nothing of PKG');
select is((select core.teams_activity_purge('PKG')), 1, 'the retention purge deletes the row of the disconnected connection');
reset role;
select is((select count(*)::int from comms.teams_activity), 1, 'what is left: the owner''s row');

select * from finish();
rollback;
