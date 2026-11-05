-- Connections and sync runs (T-031): constraints, value checks, identity immutability, lane-consistent runs, column
-- grants, service_role writes and RLS ('connections' / 'health' views: owner, admin_technical), incl. cross-lane denial.
begin;
select plan(61);
\ir helpers/lane_rls.psql

-- ---------------------------------------------------------------- schema and policies
select has_table('core', 'connections', 'core.connections exists');
select has_table('core', 'sync_runs', 'core.sync_runs exists');
select pg_temp.has_standard_lane_policy('core.connections', 'connections');
select pg_temp.has_standard_lane_policy('core.sync_runs', 'health');
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
select has_trigger('core', 'connections', 'connections_set_updated_at', 'connections maintain updated_at');
select has_trigger('core', 'sync_runs', 'sync_runs_set_updated_at', 'sync_runs maintain updated_at');
select ok(has_function_privilege('service_role', 'core.is_connector_error(jsonb)', 'execute')
          and has_function_privilege('service_role', 'core.is_connection_features(jsonb)', 'execute'),
          'service_role can evaluate the check-constraint functions');

-- ---------------------------------------------------------------- error and feature value checks
create temp table good_error on commit drop as select
  '{"kind": "transient", "disposition": "retry", "message": "upstream 503", "http_status": 503, "provider_error_code": null,
    "provider_tid": "tid-1", "retry_after_seconds": 30, "endpoint": "/v3/company/{realm}/query"}'::jsonb as e;
grant select on good_error to service_role;
select ok(core.is_connector_error((select e from good_error)), 'a full ConnectorErrorInfo is accepted');
select ok(not core.is_connector_error('{"kind": "transient", "disposition": "retry", "message": "x"}'), 'missing nullable keys are rejected (strict schema)');
select ok(not core.is_connector_error((select e || '{"kind": "bogus"}' from good_error)), 'unknown kind rejected');
select ok(not core.is_connector_error((select e || '{"disposition": "maybe"}' from good_error)), 'unknown disposition rejected');
select ok(not core.is_connector_error((select e || '{"message": ""}' from good_error)), 'empty message rejected');
select ok(not core.is_connector_error((select e || jsonb_build_object('message', repeat('m', 501)) from good_error)), 'message over 500 characters rejected');
select ok(not core.is_connector_error((select e || '{"http_status": "abc"}' from good_error)), 'non-numeric http_status rejected');
select ok(not core.is_connector_error((select e || '{"http_status": 700}' from good_error)), 'out-of-range http_status rejected');
select ok(not core.is_connector_error((select e || '{"retry_after_seconds": -1}' from good_error)), 'negative retry_after rejected');
select ok(not core.is_connector_error((select e || '{"endpoint": "https://x.test/y?q=1"}' from good_error)), 'full URL as endpoint rejected');
select ok(not core.is_connector_error((select e || '{"endpoint": "/v3/query?id=5"}' from good_error)), 'endpoint with a query rejected');
select ok(not core.is_connector_error((select e || '{"body": "y"}' from good_error)), 'unknown key rejected');
select ok(not core.is_connector_error((select e || '{"message": "Bearer abc.def"}' from good_error)), 'credential in the message rejected');
select ok(not core.is_connector_error('"a string"'), 'a non-object is rejected without an error');
select ok(core.is_connection_features('{"class_tracking": true, "multicurrency": false}'), 'snake_case boolean features accepted');
select ok(not core.is_connection_features('{"ClassTracking": true}'), 'non-snake_case feature key rejected');
select ok(not core.is_connection_features('{"class_tracking": "yes"}'), 'non-boolean feature value rejected');
select ok(not core.is_connection_features('[]'), 'non-object features rejected without an error');

-- ---------------------------------------------------------------- constraints (as service_role, the real writer)
set local role service_role;
insert into core.connections (id, lane_id, provider, external_account_id, status)
values ('00000000-0000-4000-8000-000000000031', 'PKG', 'quickbooks', 'realm-synthetic-1', 'active'),
       ('00000000-0000-4000-8000-000000000032', 'APK', 'stripe', 'acct_synthetic', 'active');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id) values ('PKG', 'mock', 'x')$$,
                 '23514', null, 'the mock provider is rejected');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id) values ('PKG', 'quickbooks', 'realm-synthetic-1')$$,
                 '23505', null, 'one connection per lane, provider and account');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, status) values ('APK', 'quickbooks', 'realm-synthetic-1', 'active')$$,
                 '23505', null, 'the same account cannot be connected in a second lane (D-23; see 120_connections_one_lane_per_account)');
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
  format($$update core.connections set status = 'degraded', last_error = %L where id = '00000000-0000-4000-8000-000000000031'$$, (select e from good_error)),
  'service_role records a ConnectorErrorInfo as last_error'
);
select throws_ok($$update core.connections set last_error = '{"kind": "transient", "disposition": "retry", "message": "x"}' where id = '00000000-0000-4000-8000-000000000031'$$,
                 '23514', null, 'an incomplete last_error is rejected');
select throws_ok($$update core.connections set lane_id = 'APK' where id = '00000000-0000-4000-8000-000000000031'$$,
                 '42501', null, 'a connection cannot move to another lane');
select throws_ok($$update core.connections set external_account_id = 'realm-other' where id = '00000000-0000-4000-8000-000000000031'$$,
                 '42501', null, 'a connection cannot change account');

-- ---------------------------------------------------------------- sync runs
select lives_ok(
  $$insert into core.sync_runs (lane_id, connection_id, kind, trigger) values ('PKG', '00000000-0000-4000-8000-000000000031', 'full', 'connect')$$,
  'a run is recorded for a connection in the same lane'
);
select lives_ok(
  $$insert into core.sync_runs (lane_id, connection_id, kind, trigger, status, finished_at) values ('APK', '00000000-0000-4000-8000-000000000032', 'full', 'connect', 'succeeded', now())$$,
  'a run is recorded in APK'
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
reset role;

-- ---------------------------------------------------------------- RLS
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select set_eq($$select lane_id from core.connections$$, array['PKG'], 'admin_technical reads PKG connections');
select is((select count(*)::int from core.sync_runs), 2, 'admin_technical reads the PKG sync runs');
select throws_ok($$select created_by from core.connections$$, '42501', null, 'admin_technical cannot read created_by');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id) values ('PKG', 'notion', 'w')$$,
                 '42501', null, 'authenticated cannot create connections');
select throws_ok($$update core.connections set status = 'active'$$, '42501', null, 'authenticated cannot update connections');
select throws_ok($$insert into core.sync_runs (lane_id, connection_id, kind, trigger) values ('PKG', '00000000-0000-4000-8000-000000000031', 'full', 'manual')$$,
                 '42501', null, 'authenticated cannot create sync runs');
reset role;

select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.connections) + (select count(*)::int from core.sync_runs), 0,
          'finance_operator has neither the connections nor the health view');
reset role;

select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.connections) + (select count(*)::int from core.sync_runs), 0,
          'a non-member reads no connections or runs');
reset role;

select pg_temp.claims('admin-technical@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.connections) + (select count(*)::int from core.sync_runs), 0,
          'AAL1 reads no connections or runs');
reset role;

set local role anon;
select throws_ok($$select id from core.connections$$, '42501', null, 'anon is denied connections');
select throws_ok($$select id from core.sync_runs$$, '42501', null, 'anon is denied sync runs');
reset role;

-- Cross-lane: with APK enabled, the PKG-only admin still reads nothing of APK; the owner (member of both) reads both.
update core.lanes set enabled = true where code = 'APK';
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select set_eq($$select distinct lane_id from core.connections$$, array['PKG'], 'cross-lane: PKG admin reads no APK connection');
select set_eq($$select distinct lane_id from core.sync_runs$$, array['PKG'], 'cross-lane: PKG admin reads no APK sync run');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select set_eq($$select distinct lane_id from core.sync_runs$$, array['APK', 'PKG'], 'the owner reads runs in both enabled lanes');
reset role;

select * from finish();
rollback;
