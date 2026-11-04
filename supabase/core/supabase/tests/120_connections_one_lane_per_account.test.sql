-- One provider account per lane (D-23): a partial unique index on core.connections (provider, external_account_id) for
-- connections that are not disconnected. Same account in a second lane refused; a disconnected connection does not block
-- a new one; other providers, other accounts and the same lane's own constraint behave as before; cross-lane denial:
-- a lane admin cannot see the other lane's connection that holds the account.
begin;
select plan(16);
\ir helpers/lane_rls.psql

select has_index('core', 'connections', 'connections_one_lane_per_account', array['provider', 'external_account_id'],
                 'the one-lane-per-account index exists on (provider, external_account_id)');
select matches(pg_get_indexdef('core.connections_one_lane_per_account'::regclass), 'WHERE \(status <> ''disconnected''::text\)',
               'the index is partial: disconnected connections are excluded');
select ok((select indisunique from pg_index where indexrelid = 'core.connections_one_lane_per_account'::regclass), 'the index is unique');

set local role service_role;
insert into core.connections (id, lane_id, provider, external_account_id, status)
values ('00000000-0000-4000-8000-000000000121', 'PKG', 'quickbooks', 'realm-synthetic-d23', 'active');

-- ---------------------------------------------------------------- the same account in a second lane
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id) values ('APK', 'quickbooks', 'realm-synthetic-d23')$$,
                 '23505', null, 'the same QuickBooks realm in a second lane is refused');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id) values ('PKG', 'quickbooks', 'realm-synthetic-d23')$$,
                 '23505', null, 'the same account in the same lane is still refused');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status) values ('APK', 'quickbooks', 'realm-synthetic-d23', 'active')$$,
                 '23505', null, 'refused whatever status the new connection starts with');

-- every status except disconnected holds the account
select lives_ok($$update core.connections set status = 'degraded' where id = '00000000-0000-4000-8000-000000000121'$$, 'degraded');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id) values ('APK', 'quickbooks', 'realm-synthetic-d23')$$,
                 '23505', null, 'a degraded connection still holds the account');
select lives_ok($$update core.connections set status = 'reconnect_required' where id = '00000000-0000-4000-8000-000000000121'$$, 'reconnect_required');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id) values ('APK', 'quickbooks', 'realm-synthetic-d23')$$,
                 '23505', null, 'a connection that needs reconnecting still holds the account');

-- ---------------------------------------------------------------- other providers and other accounts are unaffected
select lives_ok($$insert into core.connections (lane_id, provider, external_account_id) values ('APK', 'stripe', 'realm-synthetic-d23')$$,
                'the same id under another provider is a different account');
select lives_ok($$insert into core.connections (lane_id, provider, external_account_id) values ('APK', 'quickbooks', 'realm-synthetic-d23-other')$$,
                'a different account in another lane is fine');

-- ---------------------------------------------------------------- disconnected does not block
select lives_ok($$update core.connections set status = 'disconnected', token_expires_at = null where id = '00000000-0000-4000-8000-000000000121'$$,
                'disconnect the PKG connection');
select lives_ok($$insert into core.connections (id, lane_id, provider, external_account_id) values ('00000000-0000-4000-8000-000000000122', 'APK', 'quickbooks', 'realm-synthetic-d23')$$,
                'a disconnected connection does not block the account in another lane');
select throws_ok($$update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000000121'$$,
                 '23505', null, 'the old connection cannot be reactivated while another lane holds the account');
reset role;

-- ---------------------------------------------------------------- cross-lane denial
update core.lanes set enabled = true where code = 'APK';
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.connections where external_account_id = 'realm-synthetic-d23' and lane_id = 'APK'), 0,
          'a PKG-only admin cannot see the APK connection that holds the account');
reset role;

select * from finish();
rollback;
