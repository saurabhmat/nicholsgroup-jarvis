-- T-282: comms.teams_chat_reads, the portal's own read markers for Teams chats (spec 7.2, 8.1). Covered: the exact columns (ids and a time, nothing else: rule 6), the primary key, RLS (owner of the
-- Teams connection only, at AAL2), no write grant to any role, the one writer comms.teams_chat_read_mark (owner only; forward only; not more than 5 minutes ahead; 1,000 rows per connection;
-- one answer for unknown, another lane's and another person's connection), the core wrappers, the provider trigger, deletion on disconnect and retention. Cross-lane AND cross-user denial throughout.
-- Synthetic data only: example UUIDs, example.test addresses.
begin;
select plan(86);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';

-- 32901 viewer / PKG / Teams, 32902 owner / PKG / Teams, 32903 owner / APK / Teams, 32904 owner / PKG / Microsoft mail, 32905 owner / PKG / Google, 32906 admin_technical / PKG / Teams
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id) values
  ('00000000-0000-4000-8000-000000032901', 'PKG', 'microsoft_teams', 'viewer@teams.example.test', 'active', '{}', pg_temp.uid('viewer@example.test')),
  ('00000000-0000-4000-8000-000000032902', 'PKG', 'microsoft_teams', 'robert@teams.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032903', 'APK', 'microsoft_teams', 'robert-apk@teams.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032904', 'PKG', 'microsoft', 'robert@ms.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032905', 'PKG', 'google', 'robert@g.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032906', 'PKG', 'microsoft_teams', 'saurabh@teams.example.test', 'active', '{}', pg_temp.uid('admin-technical@example.test')),
  ('00000000-0000-4000-8000-000000032907', 'PKG', 'microsoft_teams', 'robert-old@teams.example.test', 'disconnected', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032908', 'PKG', 'microsoft_teams', 'robert-new@teams.example.test', 'pending', '{}', pg_temp.uid('owner@example.test'));

-- ---------------------------------------------------------------- the table: nothing but ids and a time
select has_table('comms', 'teams_chat_reads', 'the table exists');
select columns_are('comms', 'teams_chat_reads', array['lane_id', 'connection_id', 'chat_id', 'read_through', 'updated_at'], 'exactly the five listed columns: no topic, member, preview, message id or sender');
select col_type_is('comms', 'teams_chat_reads', 'read_through', 'timestamp with time zone', 'read_through is timestamptz');
select col_type_is('comms', 'teams_chat_reads', 'updated_at', 'timestamp with time zone', 'updated_at is timestamptz');
select col_is_pk('comms', 'teams_chat_reads', array['connection_id', 'chat_id'], 'primary key (connection_id, chat_id)');
select ok((select relrowsecurity from pg_class where oid = 'comms.teams_chat_reads'::regclass), 'RLS is enabled');
select is((select count(*)::int from pg_policy where polrelid = 'comms.teams_chat_reads'::regclass), 1, 'exactly one policy');
select ok((select polcmd = 'r' and polroles = array[(select oid from pg_roles where rolname = 'authenticated')]::oid[] and polpermissive from pg_policy where polrelid = 'comms.teams_chat_reads'::regclass), 'it is a permissive SELECT policy for authenticated only');
select ok((select pg_get_expr(polqual, polrelid) like '%teams_connection_ids%' and pg_get_expr(polqual, polrelid) like '%aal2%' from pg_policy where polrelid = 'comms.teams_chat_reads'::regclass), 'it requires AAL2 and the owner''s Teams connection ids');
select ok(not has_table_privilege('authenticated', 'comms.teams_chat_reads', 'insert, update, delete, truncate') and not has_any_column_privilege('authenticated', 'comms.teams_chat_reads', 'insert, update'), 'authenticated has no write grant, table or column level');
select ok(has_table_privilege('authenticated', 'comms.teams_chat_reads', 'select'), 'authenticated can select (the policy decides which rows)');
select ok(not has_table_privilege('anon', 'comms.teams_chat_reads', 'select, insert, update, delete') and not has_any_column_privilege('anon', 'comms.teams_chat_reads', 'select, insert, update, references'), 'anon has nothing');
select ok(not has_table_privilege('service_role', 'comms.teams_chat_reads', 'select, insert, update, delete, truncate'), 'service_role has no direct table grant either (writes go through the functions)');
select ok((select prosecdef from pg_proc where oid = 'comms.teams_chat_read_mark(text, uuid, text, timestamptz)'::regprocedure) and (select proconfig = array['search_path=""'] from pg_proc where oid = 'comms.teams_chat_read_mark(text, uuid, text, timestamptz)'::regprocedure), 'the writer is security definer with an empty search_path');
select ok(has_function_privilege('authenticated', 'comms.teams_chat_read_mark(text, uuid, text, timestamptz)', 'execute') and not has_function_privilege('anon', 'comms.teams_chat_read_mark(text, uuid, text, timestamptz)', 'execute') and not has_function_privilege('service_role', 'comms.teams_chat_read_mark(text, uuid, text, timestamptz)', 'execute'), 'the writer: authenticated only');
select ok(not (select prosecdef from pg_proc where oid = 'core.teams_chat_reads_list(text, uuid)'::regprocedure) and not (select prosecdef from pg_proc where oid = 'core.teams_chat_read_mark(text, uuid, text, timestamptz)'::regprocedure), 'the core wrappers are security INVOKER (RLS and the caller''s identity apply)');
select ok(has_function_privilege('service_role', 'core.teams_chat_reads_purge_connection(text, uuid)', 'execute') and has_function_privilege('service_role', 'core.teams_chat_reads_purge(text)', 'execute') and not has_function_privilege('authenticated', 'core.teams_chat_reads_purge_connection(text, uuid)', 'execute') and not has_function_privilege('authenticated', 'core.teams_chat_reads_purge(text)', 'execute') and not has_function_privilege('anon', 'core.teams_chat_reads_purge(text)', 'execute'), 'the two purge functions: service_role only');

-- ---------------------------------------------------------------- the owner marks a chat
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032902', '19:chat-a@thread.v2', now() - interval '1 hour')) is not null, true, 'the owner marks a chat read (through the core wrapper)');
select is((select count(*)::int from comms.teams_chat_reads), 1, 'one row, visible to the owner');
select is((select count(*)::int from core.teams_chat_reads_list('PKG', '00000000-0000-4000-8000-000000032902')), 1, 'the wrapper lists it');
select is((select chat_id from core.teams_chat_reads_list('PKG', '00000000-0000-4000-8000-000000032902')), '19:chat-a@thread.v2', 'with the chat id and the time only');
-- forward only
select is((select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032902', '19:chat-a@thread.v2', now() - interval '3 hours')) > now() - interval '2 hours', true, 'an older time does not move the marker back (the stored later time is returned)');
select is((select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032902', '19:chat-a@thread.v2', now() - interval '10 minutes')) > now() - interval '15 minutes', true, 'a newer time moves it forward');
select lives_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032902', '19:chat-a@thread.v2', now() + interval '4 minutes')$$, 'a time up to 5 minutes ahead is accepted (clock skew)');
select throws_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032902', '19:chat-b@thread.v2', now() + interval '6 minutes')$$, '22023', null, 'a time more than 5 minutes ahead of now is refused');
select throws_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032902', '19:chat-b@thread.v2', timestamptz '2001-01-01')$$, '22023', null, 'an absurdly old time is refused');
select throws_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032902', '19:chat-b@thread.v2', null)$$, '22023', null, 'no time is refused');
select throws_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032902', 'not-a-chat', now())$$, '22023', null, 'a chat id that is not a Graph chat id is refused');
select throws_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032902', '19:' || repeat('a', 198), now())$$, '22023', null, 'a chat id longer than 200 characters is refused');
select throws_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032902', '19:x/../y', now())$$, '22023', null, 'a chat id with a path character is refused');
select throws_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032902', null, now())$$, '22023', null, 'no chat id is refused');
select lives_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032902', '19:' || repeat('a', 197), now())$$, 'a chat id of exactly 200 characters is accepted');
-- the owner cannot mark another lane's, a mailbox's or an unknown connection (one answer for all)
select throws_ok($$select core.teams_chat_read_mark('APK', '00000000-0000-4000-8000-000000032902', '19:chat-a@thread.v2', now())$$, 'P0002', null, 'cross-lane: a PKG connection named with lane APK');
select throws_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032903', '19:chat-a@thread.v2', now())$$, 'P0002', null, 'cross-lane: the owner''s APK Teams connection named with lane PKG');
select throws_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032904', '19:chat-a@thread.v2', now())$$, 'P0002', null, 'a Microsoft mail connection is not a Teams connection');
select throws_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032905', '19:chat-a@thread.v2', now())$$, 'P0002', null, 'a Google connection is not a Teams connection');
select throws_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-0000000099ff', '19:chat-a@thread.v2', now())$$, 'P0002', null, 'an unknown connection');
select throws_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032901', '19:chat-a@thread.v2', now())$$, 'P0002', null, 'cross-user: the viewer''s Teams connection');
select throws_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032906', '19:chat-a@thread.v2', now())$$, 'P0002', null, 'cross-user: the admin_technical''s Teams connection');
select throws_ok($$select core.teams_chat_read_mark(null, '00000000-0000-4000-8000-000000032902', '19:chat-a@thread.v2', now())$$, 'P0002', null, 'no lane');
select throws_ok($$insert into comms.teams_chat_reads (lane_id, connection_id, chat_id, read_through) values ('PKG', '00000000-0000-4000-8000-000000032902', '19:direct@thread.v2', now())$$, '42501', null, 'a direct insert is refused (no grant)');
select throws_ok($$update comms.teams_chat_reads set read_through = now()$$, '42501', null, 'a direct update is refused');
select throws_ok($$delete from comms.teams_chat_reads$$, '42501', null, 'a direct delete is refused');
reset role;

-- ---------------------------------------------------------------- a marker is touched each time the chat is opened (so an active chat never ages out) but never moves back
update comms.teams_chat_reads set updated_at = now() - interval '30 days' where chat_id = '19:chat-a@thread.v2';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select lives_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032902', '19:chat-a@thread.v2', now() - interval '5 hours')$$, 'opening the chat again with an older newest message');
reset role;
select ok((select updated_at > now() - interval '1 minute' from comms.teams_chat_reads where chat_id = '19:chat-a@thread.v2'), 'touches updated_at');
select ok((select read_through > now() - interval '1 hour' from comms.teams_chat_reads where chat_id = '19:chat-a@thread.v2'), 'and the marker did not move back');

-- ---------------------------------------------------------------- only a usable connection records a marker (T-281 review SL1)
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032907', '19:chat-a@thread.v2', now())$$, 'P0002', null, 'a disconnected Teams connection records no marker');
select throws_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032908', '19:chat-a@thread.v2', now())$$, 'P0002', null, 'a pending Teams connection records no marker');
reset role;
update core.connections set status = 'reconnect_required' where id = '00000000-0000-4000-8000-000000032902';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032902', '19:chat-a@thread.v2', now())$$, 'P0002', null, 'a reconnect-required Teams connection records no marker');
reset role;
update core.connections set status = 'degraded' where id = '00000000-0000-4000-8000-000000032902';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select lives_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032902', '19:chat-a@thread.v2', now() - interval '1 hour')$$, 'a degraded connection still records (it is usable)');
reset role;
update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000032902';

-- ---------------------------------------------------------------- reads: owner only (cross-user and cross-lane denial)
-- the viewer, the admin and the owner each have a marker on their own connection
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select lives_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032901', '19:viewer-chat@thread.v2', now())$$, 'setup: the viewer marks a chat on their own connection');
select is((select count(*)::int from comms.teams_chat_reads), 1, 'cross-user: the viewer sees only their own row (not the owner''s two)');
select is((select count(*)::int from core.teams_chat_reads_list('PKG', '00000000-0000-4000-8000-000000032902')), 0, 'cross-user: asking for the owner''s connection through the wrapper returns nothing');
select is((select count(*)::int from core.teams_chat_reads_list('PKG', '00000000-0000-4000-8000-000000032901')), 1, 'their own connection returns their row');
select is((select count(*)::int from core.teams_chat_reads_list('APK', '00000000-0000-4000-8000-000000032901')), 0, 'cross-lane: their connection named with another lane returns nothing');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from comms.teams_chat_reads), 0, 'an admin (owner of the lane''s connections view) sees no marker of anyone else');
select is((select count(*)::int from core.teams_chat_reads_list('PKG', '00000000-0000-4000-8000-000000032902')), 0, 'an admin asking for the owner''s connection gets nothing');
select is((select count(*)::int from core.teams_chat_reads_list('PKG', '00000000-0000-4000-8000-000000032906')), 0, 'and their own connection has none yet');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from comms.teams_chat_reads), 2, 'the owner sees exactly their own two rows');
select is((select count(*)::int from core.teams_chat_reads_list('PKG', '00000000-0000-4000-8000-000000032901')), 0, 'cross-user: the owner asking for the viewer''s connection gets nothing');
select is((select count(*)::int from core.teams_chat_reads_list('APK', '00000000-0000-4000-8000-000000032902')), 0, 'cross-lane: the owner''s PKG connection named with lane APK returns nothing');
reset role;
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from comms.teams_chat_reads), 0, 'missing MFA (aal1): no marker at all');
select throws_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032902', '19:chat-a@thread.v2', now())$$, 'P0002', null, 'missing MFA (aal1): the writer refuses');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from comms.teams_chat_reads), 0, 'a member without own_mail sees nothing');
select throws_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032902', '19:chat-a@thread.v2', now())$$, 'P0002', null, 'and cannot mark');
reset role;
set local role anon;
select throws_ok($$select count(*) from comms.teams_chat_reads$$, '42501', null, 'anon cannot read');
select throws_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032902', '19:chat-a@thread.v2', now())$$, '42501', null, 'anon cannot call the writer');
reset role;

-- ---------------------------------------------------------------- the provider guard and the composite foreign key (as the table owner: the only way to try)
select throws_ok($$insert into comms.teams_chat_reads (lane_id, connection_id, chat_id, read_through) values ('PKG', '00000000-0000-4000-8000-000000032904', '19:x@thread.v2', now())$$, '23514', null, 'a marker for a Microsoft mail connection is refused by the trigger');
select throws_ok($$insert into comms.teams_chat_reads (lane_id, connection_id, chat_id, read_through) values ('PKG', '00000000-0000-4000-8000-000000032905', '19:x@thread.v2', now())$$, '23514', null, 'a marker for a Google connection is refused');
select throws_ok($$insert into comms.teams_chat_reads (lane_id, connection_id, chat_id, read_through) values ('APK', '00000000-0000-4000-8000-000000032902', '19:x@thread.v2', now())$$, '23514', null, 'cross-lane: a PKG connection with lane APK is refused by the provider guard (it checks the lane as well)');
select fk_ok('comms', 'teams_chat_reads', array['connection_id', 'lane_id'], 'core', 'connections', array['id', 'lane_id'], 'the composite foreign key (connection_id, lane_id) -> core.connections (id, lane_id) exists');
select throws_ok($$insert into comms.teams_chat_reads (lane_id, connection_id, chat_id, read_through) values ('PKG', '00000000-0000-4000-8000-000000032902', 'bad', now())$$, '23514', null, 'the chat id check holds for the table owner too');

-- ---------------------------------------------------------------- at most 1,000 rows per connection (the least recently touched go)
insert into comms.teams_chat_reads (lane_id, connection_id, chat_id, read_through, updated_at)
select 'PKG', '00000000-0000-4000-8000-000000032906', '19:bulk' || g::text || '@thread.v2', now() - interval '1 day', now() - (g || ' minutes')::interval from generate_series(1, 1000) g;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select lives_ok($$select core.teams_chat_read_mark('PKG', '00000000-0000-4000-8000-000000032906', '19:one-more@thread.v2', now())$$, 'the 1,001st chat is marked');
reset role;
select is((select count(*)::int from comms.teams_chat_reads where connection_id = '00000000-0000-4000-8000-000000032906'), 1000, 'the connection holds exactly 1,000 rows');
select ok(exists (select 1 from comms.teams_chat_reads where chat_id = '19:one-more@thread.v2') and not exists (select 1 from comms.teams_chat_reads where chat_id = '19:bulk1000@thread.v2'), 'the new one is kept and the least recently touched one is gone');
select is((select count(*)::int from comms.teams_chat_reads where connection_id = '00000000-0000-4000-8000-000000032902'), 2, 'another connection''s rows are untouched by the cap');

-- ---------------------------------------------------------------- deletion on disconnect and retention (service_role only; lane-keyed)
set local role authenticated;
select throws_ok($$select core.teams_chat_reads_purge_connection('PKG', '00000000-0000-4000-8000-000000032902')$$, '42501', null, 'authenticated cannot purge a connection');
select throws_ok($$select core.teams_chat_reads_purge('PKG')$$, '42501', null, 'authenticated cannot run the retention purge');
reset role;
set local role service_role;
select throws_ok($$select core.teams_chat_reads_purge_connection('NOPE', '00000000-0000-4000-8000-000000032902')$$, '42501', null, 'an unknown lane is refused');
select is((select core.teams_chat_reads_purge_connection('APK', '00000000-0000-4000-8000-000000032902')), 0, 'cross-lane: a PKG connection named with lane APK deletes nothing');
select is((select core.teams_chat_reads_purge_connection('PKG', '00000000-0000-4000-8000-000000032901')), 1, 'the disconnect purge deletes exactly that connection''s rows (the viewer''s one)');
reset role;
select is((select count(*)::int from comms.teams_chat_reads where connection_id = '00000000-0000-4000-8000-000000032902'), 2, 'and not another person''s');
-- retention: untouched for 90 days, and the rows of a disconnected connection
update comms.teams_chat_reads set updated_at = now() - interval '91 days' where chat_id = '19:chat-a@thread.v2';
update core.connections set status = 'disconnected' where id = '00000000-0000-4000-8000-000000032906';
set local role service_role;
select is((select core.teams_chat_reads_purge('APK')), 0, 'cross-lane: purging APK deletes nothing of PKG');
select is((select core.teams_chat_reads_purge('PKG')), 1001, 'the retention purge deletes the 91-day-old marker and every marker of the disconnected connection (1,000 + 1)');
reset role;
select is((select count(*)::int from comms.teams_chat_reads), 1, 'what is left: the owner''s one recent marker (the 200-character chat id)');
select ok(not exists (select 1 from comms.teams_chat_reads where updated_at < now() - interval '90 days'), 'nothing older than 90 days remains');

select * from finish();
rollback;
