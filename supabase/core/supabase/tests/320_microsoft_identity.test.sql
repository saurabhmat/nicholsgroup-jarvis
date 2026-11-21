-- T-254: Microsoft identity on connections (tenant_id, cloud: set once by a service-role definer function, immutable, Microsoft rows
-- only, no content) and the own-mail connect gate for Microsoft (any member with own_mail; QuickBooks still owner/admin_technical).
-- Synthetic data only: example UUIDs, example.test addresses.
begin;
select plan(53);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';

insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id) values
  ('00000000-0000-4000-8000-000000032001', 'PKG', 'microsoft', 'viewer@ms.example.test', 'active', '{}', pg_temp.uid('viewer@example.test')),
  ('00000000-0000-4000-8000-000000032002', 'PKG', 'microsoft', 'robert@ms.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032003', 'APK', 'microsoft', 'robert-apk@ms.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032004', 'PKG', 'google', 'g@example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032005', 'PKG', 'quickbooks', 'realm-t254', 'active', '{}', null),
  ('00000000-0000-4000-8000-000000032006', 'PKG', 'microsoft', 'second@ms.example.test', 'active', '{}', pg_temp.uid('owner@example.test'));

-- ---------------------------------------------------------------- schema and privileges
select has_column('core', 'connections', 'tenant_id', 'core.connections.tenant_id exists');
select has_column('core', 'connections', 'cloud', 'core.connections.cloud exists');
select ok(has_column_privilege('authenticated', 'core.connections', 'tenant_id', 'select') and has_column_privilege('authenticated', 'core.connections', 'cloud', 'select'),
          'authenticated may read tenant_id and cloud (health columns, no content)');
select ok(not has_column_privilege('authenticated', 'core.connections', 'tenant_id', 'update, insert') and not has_column_privilege('authenticated', 'core.connections', 'cloud', 'update, insert'),
          'authenticated cannot write them');
select ok(not has_column_privilege('anon', 'core.connections', 'tenant_id', 'select') and not has_column_privilege('anon', 'core.connections', 'cloud', 'select'),
          'anon cannot read them');
select ok(has_function_privilege('service_role', 'core.connection_set_microsoft_identity(text, uuid, uuid, text)', 'execute')
          and not has_function_privilege('authenticated', 'core.connection_set_microsoft_identity(text, uuid, uuid, text)', 'execute')
          and not has_function_privilege('anon', 'core.connection_set_microsoft_identity(text, uuid, uuid, text)', 'execute'),
          'core.connection_set_microsoft_identity: service_role only (not authenticated, not anon)');
select ok((select prosecdef from pg_proc where oid = 'core.connection_set_microsoft_identity(text, uuid, uuid, text)'::regprocedure), 'the function is security definer');

-- ---------------------------------------------------------------- the table checks
select throws_ok($$update core.connections set tenant_id = '00000000-0000-4000-8000-0000000000a1' where id = '00000000-0000-4000-8000-000000032001'$$, '23514', null, 'tenant_id without cloud is refused (both or neither)');
select throws_ok($$update core.connections set cloud = 'commercial' where id = '00000000-0000-4000-8000-000000032001'$$, '23514', null, 'cloud without tenant_id is refused');
select throws_ok($$update core.connections set tenant_id = '00000000-0000-4000-8000-0000000000a1', cloud = 'azure' where id = '00000000-0000-4000-8000-000000032001'$$, '23514', null, 'an unknown cloud is refused');
select throws_ok($$update core.connections set tenant_id = '00000000-0000-4000-8000-0000000000a1', cloud = 'commercial' where id = '00000000-0000-4000-8000-000000032004'$$, '23514', null, 'a Google row cannot carry a tenant');
select throws_ok($$update core.connections set tenant_id = '00000000-0000-4000-8000-0000000000a1', cloud = 'commercial' where id = '00000000-0000-4000-8000-000000032005'$$, '23514', null, 'a QuickBooks row cannot carry a tenant');

-- ---------------------------------------------------------------- the set-once function (service_role)
set local role service_role;
select lives_ok($$select core.connection_set_microsoft_identity('PKG', '00000000-0000-4000-8000-000000032001', '00000000-0000-4000-8000-0000000000a1', 'commercial')$$, 'service_role sets the identity of a Microsoft connection');
select throws_ok($$select core.connection_set_microsoft_identity('PKG', '00000000-0000-4000-8000-000000032001', '00000000-0000-4000-8000-0000000000a1', 'commercial')$$, '55000', null, 'a second set (even the same values) is refused');
select throws_ok($$select core.connection_set_microsoft_identity('PKG', '00000000-0000-4000-8000-000000032001', '00000000-0000-4000-8000-0000000000a2', 'gcc_high')$$, '55000', null, 'a second set with other values is refused');
select throws_ok($$select core.connection_set_microsoft_identity('PKG', '00000000-0000-4000-8000-000000032004', '00000000-0000-4000-8000-0000000000a1', 'commercial')$$, '23514', null, 'a Google connection is refused');
select throws_ok($$select core.connection_set_microsoft_identity('PKG', '00000000-0000-4000-8000-000000032005', '00000000-0000-4000-8000-0000000000a1', 'commercial')$$, '23514', null, 'a QuickBooks connection is refused');
select throws_ok($$select core.connection_set_microsoft_identity('APK', '00000000-0000-4000-8000-000000032002', '00000000-0000-4000-8000-0000000000a1', 'commercial')$$, 'P0002', null, 'cross-lane: a PKG connection named with lane APK is refused');
select throws_ok($$select core.connection_set_microsoft_identity('PKG', '00000000-0000-4000-8000-000000032003', '00000000-0000-4000-8000-0000000000a1', 'commercial')$$, 'P0002', null, 'cross-lane: an APK connection named with lane PKG is refused');
select throws_ok($$select core.connection_set_microsoft_identity('PKG', '00000000-0000-4000-8000-0000000099ff', '00000000-0000-4000-8000-0000000000a1', 'commercial')$$, 'P0002', null, 'an unknown connection is refused (same error as another lane)');
select throws_ok($$select core.connection_set_microsoft_identity('PKG', '00000000-0000-4000-8000-000000032002', '00000000-0000-4000-8000-0000000000a1', 'azure')$$, '22023', null, 'an unknown cloud is refused');
select throws_ok($$select core.connection_set_microsoft_identity('PKG', '00000000-0000-4000-8000-000000032002', null, 'commercial')$$, '22004', null, 'a null tenant is refused');
select throws_ok($$select core.connection_set_microsoft_identity(null, '00000000-0000-4000-8000-000000032002', '00000000-0000-4000-8000-0000000000a1', 'commercial')$$, '22004', null, 'a null lane is refused');
select lives_ok($$select core.connection_set_microsoft_identity('PKG', '00000000-0000-4000-8000-000000032002', '00000000-0000-4000-8000-0000000000a2', 'gcc_high')$$, 'both cloud values are accepted (gcc_high too; the lane-config gate is elsewhere)');
reset role;
select is((select tenant_id::text || '/' || cloud from core.connections where id = '00000000-0000-4000-8000-000000032001'), '00000000-0000-4000-8000-0000000000a1/commercial', 'the first set stuck, unchanged by the refused ones');
select is((select count(*)::int from core.connections where tenant_id is not null), 2, 'only the two intended rows carry an identity');
-- the error text carries no value
select throws_like($$select core.connection_set_microsoft_identity('PKG', '00000000-0000-4000-8000-000000032001', '00000000-0000-4000-8000-0000000000a9', 'commercial')$$, 'connection identity: already set', 'the error names no value');
select ok(not exists (select 1 from core.connections where tenant_id = '00000000-0000-4000-8000-0000000000a9'), 'the refused value was not stored');

-- ---------------------------------------------------------------- immutability (trigger; also against a direct service_role update)
select throws_ok($$update core.connections set tenant_id = '00000000-0000-4000-8000-0000000000a3' where id = '00000000-0000-4000-8000-000000032001'$$, '42501', null, 'the tenant cannot change afterwards');
select throws_ok($$update core.connections set cloud = 'gcc_high' where id = '00000000-0000-4000-8000-000000032001'$$, '42501', null, 'the cloud cannot change afterwards');
select throws_ok($$update core.connections set tenant_id = null, cloud = null where id = '00000000-0000-4000-8000-000000032001'$$, '42501', null, 'the identity cannot be cleared');
select lives_ok($$update core.connections set status = 'degraded' where id = '00000000-0000-4000-8000-000000032001'$$, 'other columns still update on a row that has an identity');
update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000032001';

-- concurrency shape: the check and the write are one UPDATE ... where tenant_id is null
select ok((select prosrc ~ 'tenant_id is null' from pg_proc where oid = 'core.connection_set_microsoft_identity(text, uuid, uuid, text)'::regprocedure),
          'compare-and-set: the update itself is conditional on tenant_id being null');

-- ---------------------------------------------------------------- reading: the own-rows policy exposes only the caller's rows
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select tenant_id::text || '/' || cloud from core.connections where id = '00000000-0000-4000-8000-000000032001'), '00000000-0000-4000-8000-0000000000a1/commercial', 'an own_mail member reads the tenant and cloud of their own row');
select is((select count(*)::int from core.connections where id = '00000000-0000-4000-8000-000000032002'), 0, 'an own_mail member cannot read another user''s row (so not their tenant column)');
select is((select count(*)::int from core.connections where tenant_id = '00000000-0000-4000-8000-0000000000a2'), 0, '...and cannot find it by filtering on the tenant column either');
reset role;
select pg_temp.claims('viewer@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.connections), 0, 'missing MFA (aal1): no connection row, so no tenant');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.connections where tenant_id is not null), 0, 'a finance operator reads no tenant');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.connections where tenant_id is not null and lane_id = 'PKG'), 2, 'admin_technical (connections view) reads the identity of the lane''s rows');
select is((select count(*)::int from core.connections where lane_id = 'APK'), 0, 'cross-lane: nothing of APK');
reset role;
set local role anon;
select throws_ok($$select tenant_id from core.connections$$, '42501', null, 'anon cannot read the tenant column');
reset role;

-- ---------------------------------------------------------------- connect gate: microsoft like google
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select lives_ok($$select core.oauth_state_create('PKG', 'microsoft', repeat('a', 64), repeat('v', 43), 'https://app.example.test/api/connect/microsoft/callback')$$, 'a viewer (own_mail) may start a Microsoft connect');
select throws_ok($$select core.oauth_state_create('PKG', 'quickbooks', repeat('b', 64), repeat('v', 43), 'https://app.example.test/cb')$$, '42501', null, '...but not a QuickBooks connect');
select throws_ok($$select core.oauth_state_create('APK', 'microsoft', repeat('c', 64), repeat('v', 43), 'https://app.example.test/cb')$$, '42501', null, 'cross-lane: not in a lane they are not a member of');
select is((select provider from core.oauth_state_consume('PKG', repeat('a', 64))), 'microsoft', 'the viewer finishes their own Microsoft connect');
select lives_ok($$select core.oauth_state_create('PKG', 'microsoft', repeat('d', 64), repeat('v', 43), 'https://app.example.test/cb')$$, 'setup: a second Microsoft state');
select is((select count(*)::int from core.oauth_state_consume('APK', repeat('d', 64))), 0, 'cross-lane: a PKG state cannot be consumed under APK');
reset role;
select pg_temp.claims('viewer@example.test', 'aal1');
set local role authenticated;
select throws_ok($$select core.oauth_state_create('PKG', 'microsoft', repeat('e', 64), repeat('v', 43), 'https://app.example.test/cb')$$, '42501', null, 'aal1 is refused');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.oauth_state_create('PKG', 'microsoft', repeat('f', 64), repeat('v', 43), 'https://app.example.test/cb')$$, '42501', null, 'a finance operator (no own_mail) cannot start a Microsoft connect');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select lives_ok($$select core.oauth_state_create('PKG', 'quickbooks', repeat('1', 64), repeat('v', 43), 'https://app.example.test/cb')$$, 'admin_technical still starts a QuickBooks connect');
reset role;
-- a viewer's Microsoft state cannot be consumed by someone else
select is((select count(*)::int from core.oauth_states where provider = 'microsoft'), 1, 'only the one unconsumed Microsoft state remains');
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.oauth_state_consume('PKG', repeat('d', 64))), 0, 'a state started by someone else is not consumable');
reset role;
set local role anon;
select throws_ok($$select core.oauth_state_create('PKG', 'microsoft', repeat('2', 64), repeat('v', 43), 'https://app.example.test/cb')$$, '42501', null, 'anon cannot start a connect');
reset role;

select * from finish();
rollback;
