-- Connections and sync runs (T-031): constraints, lane-consistent runs, column grants and RLS
-- ('connections' / 'health' views: owner, admin_technical), including cross-lane denial.
begin;
select plan(39);
\ir helpers/lane_rls.psql

-- ---------------------------------------------------------------- schema and policies
select has_table('core', 'connections', 'core.connections exists');
select has_table('core', 'sync_runs', 'core.sync_runs exists');
select pg_temp.has_standard_lane_policy('core.connections', 'connections');
select pg_temp.has_standard_lane_policy('core.sync_runs', 'health');
select hasnt_column('core', 'connections', 'access_token', 'no token column on core.connections');
select is(
  (select count(*)::int from information_schema.columns
   where table_schema = 'core' and table_name = 'connections' and column_name ~ '(token|secret)' and column_name <> 'token_expires_at'),
  0,
  'no token or secret columns on core.connections (only token_expires_at)'
);
select ok(not has_column_privilege('authenticated', 'core.connections', 'created_by', 'select'),
          'authenticated cannot read connections.created_by (health columns only)');
select ok(has_column_privilege('authenticated', 'core.connections', 'status', 'select'),
          'authenticated may read connections.status');

-- ---------------------------------------------------------------- constraints
insert into core.connections (id, lane_id, provider, external_account_id, status)
values ('00000000-0000-4000-8000-000000000031', 'PKG', 'quickbooks', 'realm-synthetic-1', 'active'),
       ('00000000-0000-4000-8000-000000000032', 'APK', 'stripe', 'acct_synthetic', 'active');

select throws_ok($$insert into core.connections (lane_id, provider, external_account_id) values ('PKG', 'mock', 'x')$$,
                 '23514', null, 'the mock provider is rejected');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id) values ('PKG', 'quickbooks', 'realm-synthetic-1')$$,
                 '23505', null, 'one connection per lane, provider and account');
select lives_ok($$insert into core.connections (lane_id, provider, external_account_id) values ('APK', 'quickbooks', 'realm-synthetic-1')$$,
                'the same account may be connected in another lane');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status) values ('PKG', 'stripe', 'a', 'broken')$$,
                 '23514', null, 'unknown status rejected');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id) values ('PKG', 'stripe', ' padded ')$$,
                 '23514', null, 'untrimmed account id rejected');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id) values ('PKG', 'stripe', 'sk_live_abc')$$,
                 '23514', null, 'a secret as account id is rejected');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, features) values ('PKG', 'stripe', 'b', '{"refresh_token": true}')$$,
                 '23514', null, 'credential-named feature key rejected');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status, token_expires_at) values ('PKG', 'stripe', 'c', 'disconnected', now())$$,
                 '23514', null, 'a disconnected connection has no token expiry');
select lives_ok(
  $$update core.connections set status = 'degraded',
      last_error = '{"kind": "transient", "disposition": "retry", "message": "upstream 503", "http_status": 503,
                     "provider_error_code": null, "provider_tid": "tid-1", "retry_after_seconds": 30, "endpoint": "/v3/company/{realm}/query"}'
    where id = '00000000-0000-4000-8000-000000000031'$$,
  'a ConnectorErrorInfo is accepted as last_error'
);
select throws_ok($$update core.connections set last_error = '{"kind": "transient", "disposition": "retry"}' where id = '00000000-0000-4000-8000-000000000031'$$,
                 '23514', null, 'last_error without a message is rejected');
select throws_ok($$update core.connections set last_error = '{"kind": "transient", "disposition": "retry", "message": "x", "body": "y"}' where id = '00000000-0000-4000-8000-000000000031'$$,
                 '23514', null, 'last_error with an unknown key is rejected');
select throws_ok($$update core.connections set last_error = '{"kind": "forbidden", "disposition": "fail", "message": "Bearer abc.def"}' where id = '00000000-0000-4000-8000-000000000031'$$,
                 '23514', null, 'last_error carrying a credential is rejected');
select ok((select updated_at >= created_at from core.connections where id = '00000000-0000-4000-8000-000000000031'), 'updated_at is maintained');

-- ---------------------------------------------------------------- sync runs
select lives_ok(
  $$insert into core.sync_runs (lane_id, connection_id, kind, trigger) values ('PKG', '00000000-0000-4000-8000-000000000031', 'full', 'connect')$$,
  'a run is recorded for a connection in the same lane'
);
select throws_ok(
  $$insert into core.sync_runs (lane_id, connection_id, kind, trigger) values ('PKG', '00000000-0000-4000-8000-000000000032', 'full', 'manual')$$,
  '23503', null, 'a run cannot point at another lane''s connection'
);
select throws_ok(
  $$insert into core.sync_runs (lane_id, connection_id, kind, trigger, status) values ('PKG', '00000000-0000-4000-8000-000000000031', 'full', 'manual', 'succeeded')$$,
  '23514', null, 'a finished run needs finished_at'
);
select throws_ok(
  $$insert into core.sync_runs (lane_id, connection_id, kind, trigger, status, finished_at) values ('PKG', '00000000-0000-4000-8000-000000000031', 'full', 'manual', 'failed', now())$$,
  '23514', null, 'a failed run needs an error'
);
select lives_ok(
  $$insert into core.sync_runs (lane_id, connection_id, kind, trigger, status, finished_at, records_received, records_written)
    values ('PKG', '00000000-0000-4000-8000-000000000031', 'incremental', 'schedule', 'succeeded', now(), 10, 10)$$,
  'a succeeded run is recorded'
);
select throws_ok(
  $$delete from core.connections where id = '00000000-0000-4000-8000-000000000031'$$,
  '23503', null, 'a connection with runs cannot be deleted (history is kept; disconnect instead)'
);

-- ---------------------------------------------------------------- RLS
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select set_eq($$select lane_id from core.connections$$, array['PKG'], 'admin_technical reads PKG connections');
select is((select count(*)::int from core.sync_runs), 2, 'admin_technical reads PKG sync runs');
select throws_ok($$select created_by from core.connections$$, '42501', null, 'admin_technical cannot read created_by');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id) values ('PKG', 'notion', 'w')$$,
                 '42501', null, 'authenticated cannot create connections');
select throws_ok($$update core.connections set status = 'active'$$, '42501', null, 'authenticated cannot update connections');
reset role;

select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.connections), 0, 'finance_operator has no connections view');
select is((select count(*)::int from core.sync_runs), 0, 'finance_operator has no health view');
reset role;

select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.connections), 0, 'a non-member reads no connections');
reset role;

select pg_temp.claims('admin-technical@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.connections), 0, 'AAL1 reads no connections');
reset role;

set local role anon;
select throws_ok($$select id from core.connections$$, '42501', null, 'anon is denied');
reset role;

-- Cross-lane: with APK enabled, the PKG-only admin still reads no APK connection; the owner (member of both) reads both.
update core.lanes set enabled = true where code = 'APK';
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select set_eq($$select lane_id from core.connections$$, array['PKG'], 'cross-lane: PKG admin reads no APK connection');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select set_eq($$select distinct lane_id from core.connections$$, array['APK', 'PKG'], 'the owner reads both enabled lanes');
reset role;

select * from finish();
rollback;
