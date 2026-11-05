-- Vault token functions (T-032): store (connect/reconnect), read, rotate, revoke (disconnect), keyed by connection and
-- lane-checked; service_role only; authenticated cannot call them, read the mapping table or read vault.*; audit
-- entries carry no secret. Also pins the known limit: service_role itself can reach vault.* (docs/plan-review.md §7).
begin;
select plan(61);
\ir helpers/lane_rls.psql

insert into core.connections (id, lane_id, provider, external_account_id, status)
values ('00000000-0000-4000-8000-000000000041', 'PKG', 'quickbooks', 'realm-synthetic-tok', 'pending'),
       ('00000000-0000-4000-8000-000000000042', 'APK', 'quickbooks', 'realm-synthetic-tok-apk', 'active'),
       ('00000000-0000-4000-8000-000000000043', 'PKG', 'stripe', 'acct_synthetic_off', 'disconnected');

-- ---------------------------------------------------------------- privileges
select ok(not has_function_privilege('authenticated', 'core.connection_token_read(text, uuid)', 'execute'), 'authenticated cannot execute token read');
select ok(not has_function_privilege('authenticated', 'core.connection_token_store(text, uuid, text, timestamptz, uuid)', 'execute'), 'authenticated cannot execute token store');
select ok(not has_function_privilege('authenticated', 'core.connection_token_rotate(text, uuid, text, timestamptz, text)', 'execute'), 'authenticated cannot execute token rotate');
select ok(not has_function_privilege('authenticated', 'core.connection_token_revoke(text, uuid, uuid)', 'execute'), 'authenticated cannot execute token revoke');
select ok(not (has_function_privilege('anon', 'core.connection_token_read(text, uuid)', 'execute')
               or has_function_privilege('anon', 'core.connection_token_store(text, uuid, text, timestamptz, uuid)', 'execute')
               or has_function_privilege('anon', 'core.connection_token_rotate(text, uuid, text, timestamptz, text)', 'execute')
               or has_function_privilege('anon', 'core.connection_token_revoke(text, uuid, uuid)', 'execute')),
          'anon cannot execute any token function');
select ok(not has_function_privilege('service_role', 'core.connection_for_token(text, uuid, boolean)', 'execute'), 'the internal lane check is not callable');
select ok(not has_function_privilege('service_role', 'core.connections_no_orphan_secret()', 'execute'), 'the trigger function is not callable');
select ok(has_function_privilege('service_role', 'core.connection_token_read(text, uuid)', 'execute'), 'service_role may call the token functions');
select ok(not has_table_privilege('service_role', 'core.connection_secrets', 'select, insert, update, delete'), 'not even service_role touches the mapping table directly');
-- Known limit, pinned so a change is noticed: the vault extension grants service_role access to vault.* and a
-- migration cannot revoke it (granted by supabase_admin). T-033's lint rule confines its use to packages/connectors/src/vault.
select ok(has_table_privilege('service_role', 'vault.secrets', 'select'), 'known limit: service_role can read vault.secrets');

-- ---------------------------------------------------------------- store (connect)
set local role service_role;
select lives_ok($$select core.connection_token_store('PKG', '00000000-0000-4000-8000-000000000041', 'synthetic-canary-v1', '2027-02-01T00:00:00Z', pg_temp.uid('admin-technical@example.test'))$$, 'store a credential (connect)');
select is(core.connection_token_read('PKG', '00000000-0000-4000-8000-000000000041'), 'synthetic-canary-v1', 'read it back');
reset role;
select is((select status from core.connections where id = '00000000-0000-4000-8000-000000000041'), 'active', 'connect marks the connection active');
select is((select count(*)::int from audit.events where target = 'connection:00000000-0000-4000-8000-000000000041' and action = 'connection.token_stored'
             and actor_kind = 'user' and actor_id = pg_temp.uid('admin-technical@example.test')), 1, 'connect is audited with the acting user');
select is((select vault_secret_id from core.connection_secrets where connection_id = '00000000-0000-4000-8000-000000000041'),
          (select id from vault.secrets where name = 'connection:00000000-0000-4000-8000-000000000041'), 'the mapping points at the connection''s Vault secret');

-- ---------------------------------------------------------------- lane checks and input validation
set local role service_role;
select throws_ok($$select core.connection_token_read('APK', '00000000-0000-4000-8000-000000000041')$$, 'P0002', null, 'wrong lane: read refused');
select throws_ok($$select core.connection_token_store('APK', '00000000-0000-4000-8000-000000000041', 'x', null)$$, 'P0002', null, 'wrong lane: store refused');
select throws_ok($$select core.connection_token_rotate('APK', '00000000-0000-4000-8000-000000000041', 'x', null, repeat('a', 64))$$, 'P0002', null, 'wrong lane: rotate refused');
select throws_ok($$select core.connection_token_revoke('APK', '00000000-0000-4000-8000-000000000041')$$, 'P0002', null, 'wrong lane: revoke refused');
select is(core.connection_token_read('PKG', '00000000-0000-4000-8000-000000000041'), 'synthetic-canary-v1', 'wrong-lane calls changed nothing');
select throws_ok($$select core.connection_token_read('PKG', '00000000-0000-4000-8000-0000000000ff')$$, 'P0002', null, 'unknown connection: same error as wrong lane');
select throws_ok($$select core.connection_token_read(null, '00000000-0000-4000-8000-000000000041')$$, '22004', null, 'a null lane is refused');
select throws_ok($$select core.connection_token_read('APK', '00000000-0000-4000-8000-000000000042')$$, 'P0002', null, 'a connection without a credential has none to read');
select throws_ok($$select core.connection_token_rotate('APK', '00000000-0000-4000-8000-000000000042', 'x', null, repeat('a', 64))$$, 'P0002', null, 'rotate with nothing stored is refused');
select throws_ok($$select core.connection_token_store('PKG', '00000000-0000-4000-8000-000000000042', '', null)$$, 'P0002', null, 'the lane check runs before input validation');
select throws_ok($$select core.connection_token_store('APK', '00000000-0000-4000-8000-000000000042', '', null)$$, '22023', null, 'an empty secret is refused');
select throws_ok(format($$select core.connection_token_store('APK', '00000000-0000-4000-8000-000000000042', %L, null)$$, repeat('s', 16385)),
                 '22023', null, 'an oversized secret is refused');

-- ---------------------------------------------------------------- rotate
select lives_ok($$select core.connection_token_rotate('PKG', '00000000-0000-4000-8000-000000000041', 'synthetic-canary-v2', '2027-02-02T00:00:00Z', encode(sha256(convert_to('synthetic-canary-v1', 'utf8')), 'hex'))$$, 'rotate the credential it read');
select is(core.connection_token_read('PKG', '00000000-0000-4000-8000-000000000041'), 'synthetic-canary-v2', 'read returns the rotated credential');
reset role;
select is((select token_expires_at from core.connections where id = '00000000-0000-4000-8000-000000000041'), '2027-02-02T00:00:00Z'::timestamptz, 'rotate records the new credential expiry');
select is((select count(*)::int from vault.secrets where name = 'connection:00000000-0000-4000-8000-000000000041'), 1, 'rotate keeps one Vault secret per connection');
select is((select count(*)::int from audit.events where target = 'connection:00000000-0000-4000-8000-000000000041'), 1, 'rotate is not audited');

-- ---------------------------------------------------------------- rotate is a compare-and-swap (T-050)
-- The stored credential is now v2. A refresh that read v1 and lost the race must not overwrite it.
set local role service_role;
select throws_ok($$select core.connection_token_rotate('PKG', '00000000-0000-4000-8000-000000000041', 'synthetic-canary-loser', '2027-03-03T00:00:00Z', encode(sha256(convert_to('synthetic-canary-v1', 'utf8')), 'hex'))$$,
                 '40001', 'connection token: the credential changed since it was read', 'a stale rotate (the loser of a concurrent refresh) is refused with 40001 and no secret in the message');
select is(core.connection_token_read('PKG', '00000000-0000-4000-8000-000000000041'), 'synthetic-canary-v2', 'the refused rotate changed nothing');
select throws_ok($$select core.connection_token_rotate('PKG', '00000000-0000-4000-8000-000000000041', 'synthetic-canary-v9', null, null)$$, '22023', null, 'a null expected hash is refused');
select throws_ok($$select core.connection_token_rotate('PKG', '00000000-0000-4000-8000-000000000041', 'synthetic-canary-v9', null, 'synthetic-canary-v2')$$, '22023', null, 'a plain secret is not an accepted expected hash');
-- Cross-lane denial: the right hash does not help from another lane.
select throws_ok($$select core.connection_token_rotate('APK', '00000000-0000-4000-8000-000000000041', 'synthetic-canary-v9', null, encode(sha256(convert_to('synthetic-canary-v2', 'utf8')), 'hex'))$$,
                 'P0002', null, 'wrong lane with the correct hash: rotate refused');
select is(core.connection_token_read('PKG', '00000000-0000-4000-8000-000000000041'), 'synthetic-canary-v2', 'the wrong-lane rotate changed nothing');
reset role;
select is((select token_expires_at from core.connections where id = '00000000-0000-4000-8000-000000000041'), '2027-02-02T00:00:00Z'::timestamptz, 'the refused rotates left the expiry alone');

-- ---------------------------------------------------------------- reconnect (store over an existing credential)
update core.connections set status = 'reconnect_required' where id = '00000000-0000-4000-8000-000000000041';
set local role service_role;
select is(core.connection_token_read('PKG', '00000000-0000-4000-8000-000000000041'), 'synthetic-canary-v2', 'reconnect_required may still read (to revoke at the provider)');
select lives_ok($$select core.connection_token_store('PKG', '00000000-0000-4000-8000-000000000041', 'synthetic-canary-v3', null)$$, 'reconnect replaces the credential in one call');
select is(core.connection_token_read('PKG', '00000000-0000-4000-8000-000000000041'), 'synthetic-canary-v3', 'read returns the reconnected credential');
reset role;
select is((select status from core.connections where id = '00000000-0000-4000-8000-000000000041'), 'active', 'reconnect marks the connection active');
select is((select count(*)::int from vault.secrets where name = 'connection:00000000-0000-4000-8000-000000000041'), 1, 'reconnect reuses the Vault secret');
select is((select count(*)::int from audit.events where target = 'connection:00000000-0000-4000-8000-000000000041' and action = 'connection.token_stored'), 2, 'reconnect is audited');

-- ---------------------------------------------------------------- disconnect
select throws_ok($$update core.connections set status = 'disconnected', token_expires_at = null where id = '00000000-0000-4000-8000-000000000041'$$,
                 '55000', null, 'a direct status change cannot orphan a stored credential');
set local role service_role;
select is(core.connection_token_revoke('PKG', '00000000-0000-4000-8000-000000000041'), true, 'revoke deletes the credential');
select is(core.connection_token_revoke('PKG', '00000000-0000-4000-8000-000000000041'), false, 'revoke is idempotent');
select throws_ok($$select core.connection_token_read('PKG', '00000000-0000-4000-8000-000000000041')$$, '55000', null, 'a disconnected connection cannot be read');
select throws_ok($$select core.connection_token_rotate('PKG', '00000000-0000-4000-8000-000000000041', 'x', null, repeat('a', 64))$$, '55000', null, 'a disconnected connection cannot rotate');
select lives_ok($$select core.connection_token_revoke('PKG', '00000000-0000-4000-8000-000000000043')$$, 'revoke works on an already disconnected connection');
reset role;
select is((select status from core.connections where id = '00000000-0000-4000-8000-000000000041'), 'disconnected', 'revoke marks the connection disconnected');
select is((select count(*)::int from vault.secrets where name like 'connection:00000000-0000-4000-8000-00000000004%'), 0, 'the Vault secret is gone');
select is((select token_expires_at from core.connections where id = '00000000-0000-4000-8000-000000000041'), null, 'revoke clears the expiry');
select is((select count(*)::int from audit.events where target = 'connection:00000000-0000-4000-8000-000000000041' and action = 'connection.disconnected'),
          1, 'disconnect is audited once');
select is((select count(*)::int from audit.events where metadata::text like '%canary%' or target like '%canary%'), 0, 'no secret in the audit log');

-- Reconnect after a disconnect: store again in one call.
set local role service_role;
select lives_ok($$select core.connection_token_store('PKG', '00000000-0000-4000-8000-000000000041', 'synthetic-canary-v4', null)$$, 'a disconnected connection can reconnect');
reset role;

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
