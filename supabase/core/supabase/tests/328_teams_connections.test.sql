-- T-278: Microsoft Teams connections (provider 'microsoft_teams', docs/specs/messages.md 4.2, 7.1): the provider checks of four tables, the
-- owner and identity rules, core.connections.entra_object_id (set once with the tenant and cloud, immutable, hidden from authenticated), one usable
-- Teams connection per person per lane, one Teams account in one lane only (D-23), core.teams_connection_ids (fails closed), the own_mail connect
-- gate for the provider, and the proof that a Teams row is never a mailbox. Cross-lane AND cross-user denial throughout.
-- Synthetic data only: example UUIDs, example.test addresses.
begin;
select plan(98);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';

-- 32801 viewer / PKG / Teams, 32802 owner / PKG / Teams, 32803 owner / APK / Teams, 32804 viewer / PKG / Microsoft mail,
-- 32805 viewer / PKG / Google, 32806 admin_technical / PKG / Teams
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id) values
  ('00000000-0000-4000-8000-000000032801', 'PKG', 'microsoft_teams', 'viewer@teams.example.test', 'active', '{}', pg_temp.uid('viewer@example.test')),
  ('00000000-0000-4000-8000-000000032802', 'PKG', 'microsoft_teams', 'robert@teams.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032803', 'APK', 'microsoft_teams', 'robert-apk@teams.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032804', 'PKG', 'microsoft', 'viewer@ms.example.test', 'active', '{}', pg_temp.uid('viewer@example.test')),
  ('00000000-0000-4000-8000-000000032805', 'PKG', 'google', 'viewer@g.example.test', 'active', '{}', pg_temp.uid('viewer@example.test')),
  ('00000000-0000-4000-8000-000000032806', 'PKG', 'microsoft_teams', 'saurabh@teams.example.test', 'active', '{}', pg_temp.uid('admin-technical@example.test'));

-- ---------------------------------------------------------------- the provider checks of the four tables
select ok((select pg_get_constraintdef(oid) like '%microsoft_teams%' from pg_constraint where conrelid = 'core.connections'::regclass and conname = 'connections_provider_check'), 'core.connections accepts microsoft_teams');
select ok((select pg_get_constraintdef(oid) like '%microsoft_teams%' from pg_constraint where conrelid = 'core.oauth_states'::regclass and conname = 'oauth_states_provider_check'), 'core.oauth_states accepts microsoft_teams');
select ok((select pg_get_constraintdef(oid) like '%microsoft_teams%' from pg_constraint where conrelid = 'core.webhook_events'::regclass and conname = 'webhook_events_provider_check'), 'core.webhook_events accepts microsoft_teams');
select ok((select pg_get_constraintdef(oid) like '%microsoft_teams%' from pg_constraint where conrelid = 'core.push_subscriptions'::regclass and conname = 'push_subscriptions_provider_check'), 'core.push_subscriptions accepts microsoft_teams');
select lives_ok($$insert into core.webhook_events (lane_id, connection_id, provider, event_id, event_type, payload_hash) values ('PKG', '00000000-0000-4000-8000-000000032801', 'microsoft_teams', 'evt-teams-1', 'teams_chats.changed', repeat('a', 64))$$, 'a webhook receipt of provider microsoft_teams is accepted');
select throws_ok($$insert into core.webhook_events (lane_id, connection_id, provider, event_id, event_type, payload_hash) values ('PKG', '00000000-0000-4000-8000-000000032801', 'skype', 'evt-teams-2', 'x', repeat('a', 64))$$, '23514', null, 'an unknown provider is still refused');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status) values ('PKG', 'skype', 'x@teams.example.test', 'pending')$$, '23514', null, 'core.connections still refuses an unknown provider');
select lives_ok($$insert into core.push_subscriptions (lane_id, connection_id, provider, resource, subscription_id, resource_path, expires_at, vault_secret_id) values ('PKG', '00000000-0000-4000-8000-000000032801', 'microsoft_teams', 'mail', 'sub-teams-1', 'users/x/chats', now() + interval '1 day', vault.create_secret('known-secret-t278-328', 't278-328-known'))$$, 'a push subscription row of provider microsoft_teams (with a real Vault secret) is accepted by its check');

-- ---------------------------------------------------------------- owner rules
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status) values ('PKG', 'microsoft_teams', 'noowner@teams.example.test', 'pending')$$, '23514', null, 'a Teams row without an owner is refused (it would be invisible to everyone)');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status, owner_user_id) values ('PKG', 'quickbooks', 'realm-t278', 'active', (select pg_temp.uid('owner@example.test')))$$, '23514', null, 'a QuickBooks row still cannot carry an owner');
select throws_ok($$update core.connections set owner_user_id = pg_temp.uid('owner@example.test') where id = '00000000-0000-4000-8000-000000032801'$$, '42501', null, 'the owner of a Teams row cannot change');
select throws_ok($$update core.connections set owner_user_id = null where id = '00000000-0000-4000-8000-000000032801'$$, '42501', null, 'the owner of a Teams row cannot be cleared');

-- ---------------------------------------------------------------- the Teams identity: schema and privileges
select has_column('core', 'connections', 'entra_object_id', 'core.connections.entra_object_id exists');
select ok(not has_column_privilege('authenticated', 'core.connections', 'entra_object_id', 'select') and not has_column_privilege('anon', 'core.connections', 'entra_object_id', 'select'),
          'neither authenticated nor anon can read entra_object_id (server-only)');
select ok(not has_column_privilege('authenticated', 'core.connections', 'entra_object_id', 'update, insert'), 'authenticated cannot write entra_object_id');
select ok(has_function_privilege('service_role', 'core.connection_set_teams_identity(text, uuid, uuid, text, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'core.connection_set_teams_identity(text, uuid, uuid, text, uuid)', 'execute')
          and not has_function_privilege('anon', 'core.connection_set_teams_identity(text, uuid, uuid, text, uuid)', 'execute'),
          'core.connection_set_teams_identity: service_role only (not authenticated, not anon)');
select ok((select prosecdef from pg_proc where oid = 'core.connection_set_teams_identity(text, uuid, uuid, text, uuid)'::regprocedure), 'the function is security definer');
select throws_ok($$update core.connections set entra_object_id = '00000000-0000-4000-8000-0000000000e1' where id = '00000000-0000-4000-8000-000000032804'$$, '23514', null, 'a Microsoft mail row cannot carry an object id');
select throws_ok($$update core.connections set entra_object_id = '00000000-0000-4000-8000-0000000000e1' where id = '00000000-0000-4000-8000-000000032805'$$, '23514', null, 'a Google row cannot carry an object id');
select throws_ok($$update core.connections set entra_object_id = '00000000-0000-4000-8000-0000000000e1' where id = '00000000-0000-4000-8000-000000032801'$$, '23514', null, 'a Teams row cannot carry an object id without a tenant (the identity is set together)');
select throws_ok($$update core.connections set tenant_id = '00000000-0000-4000-8000-0000000000a1', cloud = 'commercial' where id = '00000000-0000-4000-8000-000000032801'$$, '23514', null, 'a Teams row cannot carry a tenant without an object id');
select lives_ok($$update core.connections set tenant_id = '00000000-0000-4000-8000-0000000000a1', cloud = 'commercial' where id = '00000000-0000-4000-8000-000000032804'$$, 'the tenant columns still work for a Microsoft mail row (T-254 unchanged)');
select throws_ok($$update core.connections set tenant_id = '00000000-0000-4000-8000-0000000000a1', cloud = 'commercial' where id = '00000000-0000-4000-8000-000000032805'$$, '23514', null, 'a Google row still cannot carry a tenant');

-- ---------------------------------------------------------------- set the identity once (service_role)
set local role service_role;
select lives_ok($$select core.connection_set_teams_identity('PKG', '00000000-0000-4000-8000-000000032801', '00000000-0000-4000-8000-0000000000a1', 'commercial', '00000000-0000-4000-8000-0000000000e1')$$, 'service_role sets the identity of a Teams connection');
select throws_ok($$select core.connection_set_teams_identity('PKG', '00000000-0000-4000-8000-000000032801', '00000000-0000-4000-8000-0000000000a1', 'commercial', '00000000-0000-4000-8000-0000000000e1')$$, '55000', null, 'a second set (even the same values) is refused');
select throws_ok($$select core.connection_set_teams_identity('PKG', '00000000-0000-4000-8000-000000032801', '00000000-0000-4000-8000-0000000000a2', 'gcc_high', '00000000-0000-4000-8000-0000000000e2')$$, '55000', null, 'a second set with other values is refused');
select throws_ok($$select core.connection_set_teams_identity('PKG', '00000000-0000-4000-8000-000000032804', '00000000-0000-4000-8000-0000000000a1', 'commercial', '00000000-0000-4000-8000-0000000000e1')$$, '23514', null, 'a Microsoft mail connection is refused');
select throws_ok($$select core.connection_set_teams_identity('PKG', '00000000-0000-4000-8000-000000032805', '00000000-0000-4000-8000-0000000000a1', 'commercial', '00000000-0000-4000-8000-0000000000e1')$$, '23514', null, 'a Google connection is refused');
select throws_ok($$select core.connection_set_teams_identity('APK', '00000000-0000-4000-8000-000000032802', '00000000-0000-4000-8000-0000000000a1', 'commercial', '00000000-0000-4000-8000-0000000000e3')$$, 'P0002', null, 'cross-lane: a PKG connection named with lane APK is refused');
select throws_ok($$select core.connection_set_teams_identity('PKG', '00000000-0000-4000-8000-000000032803', '00000000-0000-4000-8000-0000000000a1', 'commercial', '00000000-0000-4000-8000-0000000000e3')$$, 'P0002', null, 'cross-lane: an APK connection named with lane PKG is refused');
select throws_ok($$select core.connection_set_teams_identity('PKG', '00000000-0000-4000-8000-0000000099ff', '00000000-0000-4000-8000-0000000000a1', 'commercial', '00000000-0000-4000-8000-0000000000e3')$$, 'P0002', null, 'an unknown connection is refused (same error as another lane)');
select throws_ok($$select core.connection_set_teams_identity('PKG', '00000000-0000-4000-8000-000000032802', '00000000-0000-4000-8000-0000000000a1', 'azure', '00000000-0000-4000-8000-0000000000e3')$$, '22023', null, 'an unknown cloud is refused');
select throws_ok($$select core.connection_set_teams_identity('PKG', '00000000-0000-4000-8000-000000032802', '00000000-0000-4000-8000-0000000000a1', 'commercial', null)$$, '22004', null, 'a null object id is refused');
select throws_ok($$select core.connection_set_teams_identity('PKG', '00000000-0000-4000-8000-000000032802', null, 'commercial', '00000000-0000-4000-8000-0000000000e3')$$, '22004', null, 'a null tenant is refused');
select throws_ok($$select core.connection_set_teams_identity(null, '00000000-0000-4000-8000-000000032802', '00000000-0000-4000-8000-0000000000a1', 'commercial', '00000000-0000-4000-8000-0000000000e3')$$, '22004', null, 'a null lane is refused');
select lives_ok($$select core.connection_set_teams_identity('PKG', '00000000-0000-4000-8000-000000032802', '00000000-0000-4000-8000-0000000000a1', 'commercial', '00000000-0000-4000-8000-0000000000e2')$$, 'a second person''s connection in the lane gets its own identity');
reset role;
select is((select tenant_id::text || '/' || cloud || '/' || entra_object_id::text from core.connections where id = '00000000-0000-4000-8000-000000032801'),
          '00000000-0000-4000-8000-0000000000a1/commercial/00000000-0000-4000-8000-0000000000e1', 'the first set stuck, unchanged by the refused ones');
select throws_like($$select core.connection_set_teams_identity('PKG', '00000000-0000-4000-8000-000000032801', '00000000-0000-4000-8000-0000000000a9', 'commercial', '00000000-0000-4000-8000-0000000000e9')$$, 'teams identity: already set', 'the error names no value');

-- ---------------------------------------------------------------- immutability (trigger; also against a direct update as the table owner)
select throws_ok($$update core.connections set entra_object_id = '00000000-0000-4000-8000-0000000000e5' where id = '00000000-0000-4000-8000-000000032801'$$, '42501', null, 'the object id cannot change afterwards');
select throws_ok($$update core.connections set tenant_id = '00000000-0000-4000-8000-0000000000a3' where id = '00000000-0000-4000-8000-000000032801'$$, '42501', null, 'the tenant cannot change afterwards');
select throws_ok($$update core.connections set cloud = 'gcc_high' where id = '00000000-0000-4000-8000-000000032801'$$, '42501', null, 'the cloud cannot change afterwards');
select throws_ok($$update core.connections set tenant_id = null, cloud = null, entra_object_id = null where id = '00000000-0000-4000-8000-000000032801'$$, '42501', null, 'the identity cannot be cleared');
select throws_ok($$update core.connections set provider = 'microsoft' where id = '00000000-0000-4000-8000-000000032801'$$, '42501', null, 'the provider of a Teams row cannot change (it could not become a mailbox)');
select lives_ok($$update core.connections set status = 'degraded' where id = '00000000-0000-4000-8000-000000032801'$$, 'other columns still update on a row that has an identity');
update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000032801';

-- ---------------------------------------------------------------- one usable Teams connection per person per lane; D-23 across lanes
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status, owner_user_id) values ('PKG', 'microsoft_teams', 'viewer2@teams.example.test', 'active', (select pg_temp.uid('viewer@example.test')))$$, '23505', null,
                 'a second usable Teams connection of the same person in the lane is refused by the index');
select lives_ok($$insert into core.connections (id, lane_id, provider, external_account_id, status, owner_user_id) values ('00000000-0000-4000-8000-000000032807', 'PKG', 'microsoft_teams', 'viewer2@teams.example.test', 'pending', (select pg_temp.uid('viewer@example.test')))$$,
                'a pending Teams row of the same person does not count (it is the account being connected)');
set local role service_role;
select throws_ok($$select core.connection_set_teams_identity('PKG', '00000000-0000-4000-8000-000000032807', '00000000-0000-4000-8000-0000000000a1', 'commercial', '00000000-0000-4000-8000-0000000000e7')$$, 'D0024', null,
                 'setting the identity of a second Teams account of the same person is refused (D0024) before any token is stored');
reset role;
update core.connections set status = 'disconnected' where id = '00000000-0000-4000-8000-000000032801';
set local role service_role;
select lives_ok($$select core.connection_set_teams_identity('PKG', '00000000-0000-4000-8000-000000032807', '00000000-0000-4000-8000-0000000000a1', 'commercial', '00000000-0000-4000-8000-0000000000e7')$$,
                'after a Disconnect the person can connect another Teams account');
reset role;
update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000032807';
select throws_ok($$update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000032801'$$, '23505', null, 'the disconnected account cannot be reactivated beside the new one (index)');
-- the same person, another lane: allowed (the index is per lane)
select is((select count(*)::int from core.connections where provider = 'microsoft_teams' and owner_user_id = pg_temp.uid('owner@example.test')), 2, 'the owner holds one Teams connection in each of two lanes');
-- D-23: one Teams account in one lane only (same address, another lane, both usable)
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status, owner_user_id) values ('APK', 'microsoft_teams', 'ROBERT@teams.example.test', 'active', (select pg_temp.uid('admin-technical@example.test')))$$, '23505', null,
                 'D-23: a Teams account (case-insensitive) that is usable in PKG cannot be usable in APK');
select lives_ok($$insert into core.connections (lane_id, provider, external_account_id, status, owner_user_id) values ('APK', 'microsoft', 'robert@teams.example.test', 'active', (select pg_temp.uid('owner@example.test')))$$,
                'a Microsoft MAIL account at the same address is a different key: Teams and mail do not collide');

-- ---------------------------------------------------------------- reading: own rows only; admins read health columns, never the object id
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.connections where id = '00000000-0000-4000-8000-000000032807'), 1, 'a member reads their own Teams row');
select is((select tenant_id::text || '/' || cloud from core.connections where id = '00000000-0000-4000-8000-000000032807'), '00000000-0000-4000-8000-0000000000a1/commercial', '...with its tenant and cloud');
select is((select count(*)::int from core.connections where id in ('00000000-0000-4000-8000-000000032802', '00000000-0000-4000-8000-000000032806')), 0, 'cross-user: a viewer cannot read another person''s Teams row');
select is((select count(*)::int from core.connections where provider = 'microsoft_teams'), 2, '...nor find them by filtering on the provider: only the viewer''s own two rows (one disconnected, one active)');
select throws_ok($$select entra_object_id from core.connections$$, '42501', null, 'the object id is not readable even for the row''s own owner');
select is((select core.teams_connection_ids(pg_temp.uid('viewer@example.test'), 'PKG')), array['00000000-0000-4000-8000-000000032801', '00000000-0000-4000-8000-000000032807']::uuid[], 'teams_connection_ids: the viewer''s own Teams connections in PKG (the disconnected row too, as mailbox_ids lists every status)');
select is((select core.teams_connection_ids(pg_temp.uid('owner@example.test'), 'PKG')), '{}'::uuid[], 'cross-user: asking for another person''s ids returns nothing');
select is((select core.teams_connection_ids(pg_temp.uid('viewer@example.test'), 'APK')), '{}'::uuid[], 'cross-lane: a lane the viewer is not in returns nothing');
select is((select core.teams_connection_ids(pg_temp.uid('viewer@example.test'))), array['00000000-0000-4000-8000-000000032801', '00000000-0000-4000-8000-000000032807']::uuid[], 'without a lane: every lane the person is in (one here)');
reset role;
select pg_temp.claims('viewer@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.connections), 0, 'missing MFA (aal1): no connection row at all');
select is((select core.teams_connection_ids(pg_temp.uid('viewer@example.test'), 'PKG')), '{}'::uuid[], 'teams_connection_ids fails closed without AAL2');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.connections where provider = 'microsoft_teams' and lane_id = 'PKG'), 4, 'admin_technical (connections view) reads the health of the lane''s Teams rows: four in PKG');
select is((select count(*)::int from core.connections where lane_id = 'APK' and provider = 'microsoft_teams'), 0, 'cross-lane: nothing of APK');
select throws_ok($$select entra_object_id from core.connections$$, '42501', null, 'an admin cannot read the object id either (no column grant)');
select is((select core.teams_connection_ids(pg_temp.uid('admin-technical@example.test'), 'PKG')), array['00000000-0000-4000-8000-000000032806']::uuid[], 'an admin''s teams_connection_ids is their own connection only, not the lane''s');
select is((select core.teams_connection_ids(pg_temp.uid('viewer@example.test'), 'PKG')), '{}'::uuid[], 'an admin cannot resolve another person''s Teams connections (the uid must be the caller)');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.connections where provider = 'microsoft_teams'), 0, 'a finance operator (no own_mail, no connections view) reads no Teams row');
select is((select core.teams_connection_ids(pg_temp.uid('finance-operator@example.test'), 'PKG')), '{}'::uuid[], 'and has no Teams connection ids');
reset role;
set local role anon;
select throws_ok($$select id from core.connections$$, '42501', null, 'anon cannot read core.connections');
select throws_ok($$select core.teams_connection_ids('00000000-0000-4000-8000-000000000001', 'PKG')$$, '42501', null, 'anon cannot call teams_connection_ids');
reset role;
-- the service role asks on a job's behalf: it resolves any person's ids, in a lane
set local role service_role;
select is((select core.teams_connection_ids(pg_temp.uid('owner@example.test'), 'PKG')), array['00000000-0000-4000-8000-000000032802']::uuid[], 'service_role resolves a named person''s Teams connection (jobs)');
reset role;

-- ---------------------------------------------------------------- a Teams row is never a mailbox
select ok(not exists (select 1 from core.connections c where c.provider = 'microsoft_teams' and c.id = any (core.mailbox_ids(c.owner_user_id, c.lane_id))), 'no Teams row appears in core.mailbox_ids (as owner of the table)');
set local role service_role;
select is((select count(*)::int from unnest(core.mailbox_ids(pg_temp.uid('viewer@example.test'), 'PKG')) as m(mid) join core.connections c on c.id = m.mid where c.provider = 'microsoft_teams'), 0, 'service_role: no Teams connection is in mailbox_ids');
select is((select core.mailbox_ids(pg_temp.uid('viewer@example.test'), 'PKG')), array['00000000-0000-4000-8000-000000032804', '00000000-0000-4000-8000-000000032805']::uuid[], 'service_role: the viewer''s mailboxes are the Microsoft and Google rows only');
reset role;


-- ---------------------------------------------------------------- T-278 review: the reconnect check, the Entra-account index, the token store's two new refusals, the readable columns
set local role service_role;
select throws_ok($$select core.teams_assert_one_per_owner('PKG', '00000000-0000-4000-8000-000000032801')$$, 'D0024', null, 'a disconnected Teams row cannot be reconnected beside another usable one of the same person (D0024, before any token)');
select lives_ok($$select core.teams_assert_one_per_owner('PKG', '00000000-0000-4000-8000-000000032807')$$, 'the person''s one usable row passes the check');
select throws_ok($$select core.teams_assert_one_per_owner('APK', '00000000-0000-4000-8000-000000032807')$$, 'P0002', null, 'cross-lane: a PKG connection named with lane APK is refused');
select throws_ok($$select core.teams_assert_one_per_owner('PKG', '00000000-0000-4000-8000-000000032804')$$, '23514', null, 'a Microsoft mail connection is refused');
reset role;
select ok(has_function_privilege('service_role', 'core.teams_assert_one_per_owner(text, uuid)', 'execute') and not has_function_privilege('authenticated', 'core.teams_assert_one_per_owner(text, uuid)', 'execute') and not has_function_privilege('anon', 'core.teams_assert_one_per_owner(text, uuid)', 'execute'), 'core.teams_assert_one_per_owner: service_role only');

-- one Entra account in one lane only, whatever the sign-in name (the D-23 index is keyed on the name, which can be renamed)
set local role service_role;
select lives_ok($$select core.connection_set_teams_identity('APK', '00000000-0000-4000-8000-000000032803', '00000000-0000-4000-8000-0000000000a1', 'commercial', '00000000-0000-4000-8000-0000000000e3')$$, 'setup: the owner''s APK Teams connection gets its identity');
reset role;
select throws_ok($$update core.connections set tenant_id = '00000000-0000-4000-8000-0000000000a1', cloud = 'commercial', entra_object_id = '00000000-0000-4000-8000-0000000000e3' where id = '00000000-0000-4000-8000-000000032806'$$, '23505', null,
                 'the same Entra account cannot be usable in two lanes (index connections_one_teams_per_entra_object)');
-- a renamed account: another sign-in name, the same Entra object, in PKG, pending until its token is stored
insert into core.connections (id, lane_id, provider, external_account_id, status, owner_user_id, tenant_id, cloud, entra_object_id) values
  ('00000000-0000-4000-8000-000000032810', 'PKG', 'microsoft_teams', 'renamed@teams.example.test', 'pending', pg_temp.uid('finance-operator@example.test'), '00000000-0000-4000-8000-0000000000a1', 'commercial', '00000000-0000-4000-8000-0000000000e3');
-- a second account of a person who already has a usable Teams connection in the lane (admin_technical: 32806), pending until its token is stored
insert into core.connections (id, lane_id, provider, external_account_id, status, owner_user_id, tenant_id, cloud, entra_object_id) values
  ('00000000-0000-4000-8000-000000032811', 'PKG', 'microsoft_teams', 'saurabh2@teams.example.test', 'pending', pg_temp.uid('admin-technical@example.test'), '00000000-0000-4000-8000-0000000000a1', 'commercial', '00000000-0000-4000-8000-0000000000e9');
set local role service_role;
select throws_ok($$select core.connection_token_store('PKG', '00000000-0000-4000-8000-000000032810', 'synthetic-token-set-328', null)$$, 'D0023', null, 'storing a token for the renamed account of an Entra account that is usable in another lane: D0023 (another company)');
select throws_ok($$select core.connection_token_store('PKG', '00000000-0000-4000-8000-000000032811', 'synthetic-token-set-328', null)$$, 'D0024', null, 'storing a token for a second Teams account of the same person: D0024 (the person already has one here), not a raw unique violation');
reset role;
select is((select status from core.connections where id = '00000000-0000-4000-8000-000000032811'), 'pending', 'the refused activation changed nothing');
select ok(not exists (select 1 from core.connection_secrets where connection_id in ('00000000-0000-4000-8000-000000032810', '00000000-0000-4000-8000-000000032811')), 'and no secret is left behind');

-- S8: exactly these columns of core.connections can be read by authenticated (so what an admin reads of someone else''s Teams row through the connections view is known and a later change is noticed)
select is((select array_agg(column_name::text order by column_name) from information_schema.column_privileges where table_schema = 'core' and table_name = 'connections' and grantee = 'authenticated' and privilege_type = 'SELECT'),
          array['account_identity', 'cloud', 'created_at', 'external_account_id', 'features', 'features_checked_at', 'id', 'lane_id', 'last_error', 'last_sync_at', 'owner_user_id', 'provider', 'status', 'tenant_id', 'token_expires_at', 'toolkit', 'transport', 'updated_at'],
          'authenticated can read exactly these columns of core.connections (not created_by, reconnect_notified_at, last_error_stream or entra_object_id)');

-- ---------------------------------------------------------------- connect gate: microsoft_teams like google and microsoft
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select lives_ok($$select core.oauth_state_create('PKG', 'microsoft_teams', repeat('a', 64), repeat('v', 43), 'https://app.example.test/api/connect/teams/callback')$$, 'a viewer (own_mail) may start a Teams connect');
select throws_ok($$select core.oauth_state_create('PKG', 'quickbooks', repeat('b', 64), repeat('v', 43), 'https://app.example.test/cb')$$, '42501', null, '...but not a QuickBooks connect');
select throws_ok($$select core.oauth_state_create('APK', 'microsoft_teams', repeat('c', 64), repeat('v', 43), 'https://app.example.test/cb')$$, '42501', null, 'cross-lane: not in a lane they are not a member of');
select is((select provider from core.oauth_state_consume('PKG', repeat('a', 64))), 'microsoft_teams', 'the viewer finishes their own Teams connect');
select lives_ok($$select core.oauth_state_create('PKG', 'microsoft_teams', repeat('d', 64), repeat('v', 43), 'https://app.example.test/cb')$$, 'setup: a second Teams state');
select is((select count(*)::int from core.oauth_state_consume('APK', repeat('d', 64))), 0, 'cross-lane: a PKG state cannot be consumed under APK');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.oauth_state_consume('PKG', repeat('d', 64))), 0, 'cross-user: a state started by someone else is not consumable');
select throws_ok($$select core.oauth_state_create('PKG', 'microsoft_teams', repeat('f', 64), repeat('v', 43), 'https://app.example.test/cb')$$, '42501', null, 'a finance operator (no own_mail) cannot start a Teams connect');
reset role;
select pg_temp.claims('viewer@example.test', 'aal1');
set local role authenticated;
select throws_ok($$select core.oauth_state_create('PKG', 'microsoft_teams', repeat('e', 64), repeat('v', 43), 'https://app.example.test/cb')$$, '42501', null, 'aal1 is refused');
reset role;
set local role anon;
select throws_ok($$select core.oauth_state_create('PKG', 'microsoft_teams', repeat('2', 64), repeat('v', 43), 'https://app.example.test/cb')$$, '42501', null, 'anon cannot start a connect');
reset role;

select * from finish();
rollback;
