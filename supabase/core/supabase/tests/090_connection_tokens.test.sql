-- Vault token functions (T-032): store/read/rotate/revoke keyed by connection, lane-checked; service_role only;
-- authenticated cannot call them, read the mapping table or read vault.*; audit entries carry no secret.
begin;
select plan(34);
\ir helpers/lane_rls.psql

insert into core.connections (id, lane_id, provider, external_account_id, status)
values ('00000000-0000-4000-8000-000000000041', 'PKG', 'quickbooks', 'realm-synthetic-tok', 'active'),
       ('00000000-0000-4000-8000-000000000042', 'APK', 'quickbooks', 'realm-synthetic-tok', 'active'),
       ('00000000-0000-4000-8000-000000000043', 'PKG', 'stripe', 'acct_synthetic_off', 'disconnected');

-- ---------------------------------------------------------------- privileges
select ok(not has_function_privilege('authenticated', 'core.connection_token_read(text, uuid)', 'execute'), 'authenticated cannot execute token read');
select ok(not has_function_privilege('authenticated', 'core.connection_token_store(text, uuid, text, timestamptz)', 'execute'), 'authenticated cannot execute token store');
select ok(not has_function_privilege('authenticated', 'core.connection_token_rotate(text, uuid, text, timestamptz)', 'execute'), 'authenticated cannot execute token rotate');
select ok(not has_function_privilege('authenticated', 'core.connection_token_revoke(text, uuid)', 'execute'), 'authenticated cannot execute token revoke');
select ok(not has_function_privilege('anon', 'core.connection_token_read(text, uuid)', 'execute'), 'anon cannot execute token read');
select ok(not has_function_privilege('service_role', 'core.connection_for_token(text, uuid)', 'execute'), 'the internal lane check is not callable');
select ok(has_function_privilege('service_role', 'core.connection_token_read(text, uuid)', 'execute'), 'service_role may read tokens');
select ok(not has_table_privilege('service_role', 'core.connection_secrets', 'select, insert, update, delete'), 'not even service_role touches the mapping table directly');

-- ---------------------------------------------------------------- service_role: store, read, rotate, revoke
set local role service_role;
select lives_ok($$select core.connection_token_store('PKG', '00000000-0000-4000-8000-000000000041', 'synthetic-canary-v1', '2026-12-01T00:00:00Z')$$, 'store a credential');
select is(core.connection_token_read('PKG', '00000000-0000-4000-8000-000000000041'), 'synthetic-canary-v1', 'read it back');
select throws_ok($$select core.connection_token_store('PKG', '00000000-0000-4000-8000-000000000041', 'again')$$, '23505', null, 'a second store is refused (rotate instead)');
select throws_ok($$select core.connection_token_read('APK', '00000000-0000-4000-8000-000000000041')$$, 'P0002', null, 'wrong lane: read refused');
select throws_ok($$select core.connection_token_rotate('APK', '00000000-0000-4000-8000-000000000041', 'x')$$, 'P0002', null, 'wrong lane: rotate refused');
select throws_ok($$select core.connection_token_revoke('APK', '00000000-0000-4000-8000-000000000041')$$, 'P0002', null, 'wrong lane: revoke refused');
select throws_ok($$select core.connection_token_read('APK', '00000000-0000-4000-8000-000000000042')$$, 'P0002', null, 'a connection without a credential has none to read');
select throws_ok($$select core.connection_token_store('PKG', '00000000-0000-4000-8000-000000000043', 'x')$$, '55000', null, 'a disconnected connection cannot store');
select throws_ok($$select core.connection_token_store('PKG', '00000000-0000-4000-8000-000000000042', '')$$, 'P0002', null, 'store with the wrong lane is refused before validation');
select throws_ok($$select core.connection_token_store('APK', '00000000-0000-4000-8000-000000000042', '')$$, '22023', null, 'an empty secret is refused');
select throws_ok($$select core.connection_token_read(null, '00000000-0000-4000-8000-000000000041')$$, '22004', null, 'a null lane is refused');
select lives_ok($$select core.connection_token_rotate('PKG', '00000000-0000-4000-8000-000000000041', 'synthetic-canary-v2', '2026-12-02T00:00:00Z')$$, 'rotate the credential');
select is(core.connection_token_read('PKG', '00000000-0000-4000-8000-000000000041'), 'synthetic-canary-v2', 'read returns the rotated credential');
reset role;
select is((select token_expires_at from core.connections where id = '00000000-0000-4000-8000-000000000041'), '2026-12-02T00:00:00Z'::timestamptz, 'rotate records the new expiry');
select is((select count(*)::int from vault.secrets where name = 'connection:00000000-0000-4000-8000-000000000041'), 1, 'one Vault secret per connection');

set local role service_role;
select is(core.connection_token_revoke('PKG', '00000000-0000-4000-8000-000000000041'), true, 'revoke deletes the credential');
select is(core.connection_token_revoke('PKG', '00000000-0000-4000-8000-000000000041'), false, 'revoke is idempotent');
select throws_ok($$select core.connection_token_read('PKG', '00000000-0000-4000-8000-000000000041')$$, 'P0002', null, 'nothing to read after revoke');
reset role;
select is((select count(*)::int from vault.secrets where name like 'connection:00000000-0000-4000-8000-00000000004%'), 0, 'the Vault secret is gone');
select is((select token_expires_at from core.connections where id = '00000000-0000-4000-8000-000000000041'), null, 'revoke clears the expiry');
select is(
  (select count(*)::int from audit.events where target = 'connection:00000000-0000-4000-8000-000000000041'
     and action in ('connection.token_stored', 'connection.token_revoked')),
  2, 'store and revoke are audited'
);
select is((select count(*)::int from audit.events where metadata::text like '%canary%' or target like '%canary%'), 0, 'no secret in the audit log');

-- ---------------------------------------------------------------- authenticated
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select id from vault.secrets$$, '42501', null, 'authenticated cannot read vault.secrets');
select throws_ok($$select decrypted_secret from vault.decrypted_secrets$$, '42501', null, 'authenticated cannot read vault.decrypted_secrets');
select throws_ok($$select vault_secret_id from core.connection_secrets$$, '42501', null, 'authenticated cannot read the mapping table');
select throws_ok($$select core.connection_token_read('PKG', '00000000-0000-4000-8000-000000000041')$$, '42501', null, 'authenticated cannot call token read');
reset role;

select * from finish();
rollback;
