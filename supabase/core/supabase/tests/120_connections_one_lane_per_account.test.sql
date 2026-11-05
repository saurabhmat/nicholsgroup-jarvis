-- One provider account per lane (D-23): a partial unique index on core.connections
-- (provider, lower(external_account_id)) for connections that are usable (not disconnected, not pending).
-- Covered: the index shape; the same account in a second lane refused whatever its case; a disconnected or pending
-- connection does not hold the account; other providers and accounts unaffected; the refusal from
-- core.connection_token_store carries SQLSTATE D0023 and rolls back the Vault secret and mapping; other unique
-- violations keep 23505 (not "account in use"); the exact INSERT ... ON CONFLICT DO NOTHING statement that the connect
-- flow's ensureConnection sends; cross-lane denial with a positive control and an aal1 case.
begin;
select plan(38);
\ir helpers/lane_rls.psql

select has_index('core', 'connections', 'connections_one_lane_per_account', 'the one-lane-per-account index exists');
select matches(pg_get_indexdef('core.connections_one_lane_per_account'::regclass), 'lower\(external_account_id\)',
               'the key is case-insensitive: (provider, lower(external_account_id))');
select matches(pg_get_indexdef('core.connections_one_lane_per_account'::regclass), '\(provider, lower\(external_account_id\)\)',
               'the key starts with the provider');
select matches(pg_get_indexdef('core.connections_one_lane_per_account'::regclass), 'WHERE.*disconnected.*pending',
               'the index is partial: disconnected and pending connections are excluded');
select ok((select indisunique from pg_index where indexrelid = 'core.connections_one_lane_per_account'::regclass), 'the index is unique');

set local role service_role;
insert into core.connections (id, lane_id, provider, external_account_id, status)
values ('00000000-0000-4000-8000-000000000121', 'PKG', 'quickbooks', 'realm-synthetic-d23', 'active');

-- ---------------------------------------------------------------- the same account in a second lane
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status) values ('APK', 'quickbooks', 'realm-synthetic-d23', 'active')$$,
                 '23505', null, 'the same QuickBooks realm in a second lane is refused');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id) values ('PKG', 'quickbooks', 'realm-synthetic-d23')$$,
                 '23505', null, 'the same account in the same lane is still refused (per-lane constraint)');

-- case-insensitive: a mailbox written with other capitals is the same account
insert into core.connections (id, lane_id, provider, external_account_id, status)
values ('00000000-0000-4000-8000-000000000124', 'PKG', 'google', 'ops@x.com', 'active');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status) values ('APK', 'google', 'Ops@x.com', 'active')$$,
                 '23505', null, 'Ops@x.com in APK is refused while ops@x.com is connected in PKG');
select lives_ok($$insert into core.connections (lane_id, provider, external_account_id, status) values ('APK', 'google', 'other@x.com', 'active')$$,
                'a different mailbox in another lane is fine');

-- every usable status holds the account
select lives_ok($$update core.connections set status = 'degraded' where id = '00000000-0000-4000-8000-000000000121'$$, 'degraded');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status) values ('APK', 'quickbooks', 'realm-synthetic-d23', 'active')$$,
                 '23505', null, 'a degraded connection still holds the account');
select lives_ok($$update core.connections set status = 'reconnect_required' where id = '00000000-0000-4000-8000-000000000121'$$, 'reconnect_required');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status) values ('APK', 'quickbooks', 'realm-synthetic-d23', 'degraded')$$,
                 '23505', null, 'a connection that needs reconnecting still holds the account');
select lives_ok($$update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000000121'$$, 'active again');

-- ---------------------------------------------------------------- other providers and other accounts are unaffected
select lives_ok($$insert into core.connections (lane_id, provider, external_account_id, status) values ('APK', 'stripe', 'realm-synthetic-d23', 'active')$$,
                'the same id under another provider is a different account');
select lives_ok($$insert into core.connections (lane_id, provider, external_account_id, status) values ('APK', 'quickbooks', 'realm-synthetic-d23-other', 'active')$$,
                'a different account in another lane is fine');

-- ---------------------------------------------------------------- the statement ensureConnection sends (R-L4)
-- insert ... on conflict (lane_id, provider, external_account_id) do nothing, status pending.
select lives_ok($$insert into core.connections (lane_id, provider, external_account_id, status) values ('PKG', 'quickbooks', 'realm-synthetic-l4', 'pending')
                  on conflict (lane_id, provider, external_account_id) do nothing$$, 'ensureConnection: creates the pending row');
update core.connections set status = 'active' where lane_id = 'PKG' and external_account_id = 'realm-synthetic-l4';
select lives_ok($$insert into core.connections (lane_id, provider, external_account_id, status) values ('PKG', 'quickbooks', 'realm-synthetic-l4', 'pending')
                  on conflict (lane_id, provider, external_account_id) do nothing$$, 'ensureConnection: same lane again does nothing, no error');
select is((select status from core.connections where lane_id = 'PKG' and external_account_id = 'realm-synthetic-l4'), 'active',
          'ensureConnection: the existing row is left untouched (a reconnect does not downgrade it)');
select lives_ok($$insert into core.connections (lane_id, provider, external_account_id, status) values ('APK', 'quickbooks', 'realm-synthetic-l4', 'pending')
                  on conflict (lane_id, provider, external_account_id) do nothing$$,
                'ensureConnection: another lane gets a pending row (a pending row never holds the account)');
select is((select status from core.connections where lane_id = 'PKG' and external_account_id = 'realm-synthetic-l4'), 'active',
          'ensureConnection from another lane did not touch the holder''s row');
select throws_ok($$select core.connection_token_store('APK', (select id from core.connections where lane_id = 'APK' and external_account_id = 'realm-synthetic-l4'), 'synthetic-token-l4', null)$$,
                 'D0023', null, 'the other lane is refused when the credential is stored (pending -> active)');
select is((select status from core.connections where lane_id = 'APK' and external_account_id = 'realm-synthetic-l4'), 'pending', 'the refused lane stays pending');

-- ---------------------------------------------------------------- pending does not hold the account (R-L3): the first to store wins
insert into core.connections (id, lane_id, provider, external_account_id)
values ('00000000-0000-4000-8000-000000000125', 'PKG', 'quickbooks', 'realm-synthetic-race'),
       ('00000000-0000-4000-8000-000000000126', 'APK', 'quickbooks', 'realm-synthetic-race');
select lives_ok($$select core.connection_token_store('APK', '00000000-0000-4000-8000-000000000126', 'synthetic-token-race-a', null)$$,
                'an abandoned pending row in PKG did not block APK from connecting the account');
select throws_ok($$select core.connection_token_store('PKG', '00000000-0000-4000-8000-000000000125', 'synthetic-token-race-b', null)$$,
                 'D0023', null, 'the pending PKG row is refused once APK holds the account');

-- ---------------------------------------------------------------- disconnected does not block; reactivation through the token function
select lives_ok($$update core.connections set status = 'disconnected', token_expires_at = null where id = '00000000-0000-4000-8000-000000000121'$$,
                'disconnect the PKG connection');
select lives_ok($$insert into core.connections (id, lane_id, provider, external_account_id, status) values ('00000000-0000-4000-8000-000000000122', 'APK', 'quickbooks', 'realm-synthetic-d23', 'active')$$,
                'a disconnected connection does not block the account in another lane');
select throws_ok($$update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000000121'$$,
                 '23505', null, 'the old connection cannot be reactivated directly while another lane holds the account');
select throws_ok($$select core.connection_token_store('PKG', '00000000-0000-4000-8000-000000000121', 'synthetic-token-reactivate', null)$$,
                 'D0023', null, 'reactivating through core.connection_token_store is refused with D0023');
reset role;
select is((select status from core.connections where id = '00000000-0000-4000-8000-000000000121'), 'disconnected', 'the refused reactivation left the row disconnected');
select is((select count(*)::int from core.connection_secrets where connection_id = '00000000-0000-4000-8000-000000000121')
        + (select count(*)::int from vault.secrets where name = 'connection:00000000-0000-4000-8000-000000000121')
        + (select count(*)::int from audit.events where target = 'connection:00000000-0000-4000-8000-000000000121'), 0,
          'full rollback: no mapping, no Vault secret and no audit row were left behind');

-- ---------------------------------------------------------------- other 23505 are not "account in use"
select lives_ok($$insert into core.connections (id, lane_id, provider, external_account_id) values ('00000000-0000-4000-8000-000000000123', 'PKG', 'quickbooks', 'realm-synthetic-names')$$,
                'a fresh pending connection');
select lives_ok($$select vault.create_secret('synthetic-squatter', 'connection:00000000-0000-4000-8000-000000000123', 'test')$$, 'a stray Vault secret already uses the connection''s secret name');
set local role service_role;
select throws_ok($$select core.connection_token_store('PKG', '00000000-0000-4000-8000-000000000123', 'synthetic-token-names', null)$$,
                 '23505', null, 'a clash on the Vault secret name stays 23505 (not D0023, so not reported as "account in use")');
reset role;
insert into core.connection_secrets (connection_id, lane_id, vault_secret_id)
values ('00000000-0000-4000-8000-000000000124', 'PKG', (select id from vault.secrets where name = 'connection:00000000-0000-4000-8000-000000000123'));
select throws_like($$insert into core.connection_secrets (connection_id, lane_id, vault_secret_id) values ('00000000-0000-4000-8000-000000000124', 'PKG', gen_random_uuid())$$,
                   '%connection_secrets_pkey%', 'a duplicate on connection_secrets is a different constraint, with its own name');

-- ---------------------------------------------------------------- cross-lane denial
update core.lanes set enabled = true where code = 'APK';
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.connections where external_account_id = 'realm-synthetic-d23' and lane_id = 'APK'), 0,
          'a PKG-only admin cannot see the APK connection that holds the account');
select is((select count(*)::int from core.connections where external_account_id = 'realm-synthetic-l4' and lane_id = 'PKG'), 1,
          'positive control: the same role sees a PKG connection');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.connections), 0, 'without MFA (aal1) the same role sees no connection, not even in PKG');
reset role;

select * from finish();
rollback;
