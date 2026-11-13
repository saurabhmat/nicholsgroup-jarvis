-- T-196: core.connector_api_errors (RLS, service-role-only writes, database guards, purge) and run logging for every QuickBooks
-- job (core.sync_runs.job). Includes the cross-lane denial.
begin;
select plan(33);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
insert into core.connections (id, lane_id, provider, external_account_id, status) values
  ('00000000-0000-4000-8000-000000009601', 'PKG', 'quickbooks', 'realm-t196-pkg', 'active'),
  ('00000000-0000-4000-8000-000000009602', 'APK', 'quickbooks', 'realm-t196-apk', 'active');

select has_table('core', 'connector_api_errors', 'core.connector_api_errors exists');
select pg_temp.has_standard_lane_policy('core.connector_api_errors', 'health');
select ok(not has_table_privilege('service_role', 'core.connector_api_errors', 'update, delete'), 'the service role cannot update or delete rows directly');
select ok(has_table_privilege('service_role', 'core.connector_api_errors', 'select, insert'), 'the service role reads and inserts');

-- ---------------------------------------------------------------- writes: service role only
set local role service_role;
select lives_ok($$insert into core.connector_api_errors (lane_id, connection_id, provider, endpoint, http_status, provider_error_code, provider_message, provider_tid, kind, disposition)
  values ('PKG', '00000000-0000-4000-8000-000000009601', 'quickbooks', '/v3/company/{realm}/query', 400, '4000', 'QuickBooks could not read the request. Nothing was changed.', '1-65a1b2c3-0123456789abcdef01234567', 'invalid_input', 'fail')$$,
  'the service role records a PKG error');
select lives_ok($$insert into core.connector_api_errors (lane_id, connection_id, provider, endpoint, http_status, provider_message, kind, disposition)
  values ('APK', '00000000-0000-4000-8000-000000009602', 'quickbooks', '/v3/company/{realm}/reports/ProfitAndLoss', 429, 'QuickBooks is limiting requests right now. It will be tried again shortly.', 'rate_limited', 'retry')$$,
  'and an APK error');
select throws_ok($$insert into core.connector_api_errors (lane_id, connection_id, provider, provider_message, kind, disposition)
  values ('APK', '00000000-0000-4000-8000-000000009601', 'quickbooks', 'x', 'transient', 'retry')$$,
  '23503', null, 'cross-lane: a PKG connection cannot carry an APK error');
reset role;

-- ---------------------------------------------------------------- database guards (second line after the connector)
set local role service_role;
select throws_ok($$insert into core.connector_api_errors (lane_id, connection_id, provider, provider_message, kind, disposition)
  values ('PKG', '00000000-0000-4000-8000-000000009601', 'quickbooks', 'Customer jane@example.test was rejected', 'invalid_input', 'fail')$$,
  '23514', null, 'a message with an @ is refused');
select throws_ok($$insert into core.connector_api_errors (lane_id, connection_id, provider, provider_message, kind, disposition)
  values ('PKG', '00000000-0000-4000-8000-000000009601', 'quickbooks', 'Authorization: Bearer abc', 'invalid_input', 'fail')$$,
  '23514', null, 'a message with a Bearer pattern is refused');
select throws_ok($$insert into core.connector_api_errors (lane_id, connection_id, provider, provider_message, kind, disposition)
  values ('PKG', '00000000-0000-4000-8000-000000009601', 'quickbooks', 'Invoice 1234567 failed', 'invalid_input', 'fail')$$,
  '23514', null, 'a message with a run of 5 or more digits is refused');
select throws_ok($$insert into core.connector_api_errors (lane_id, connection_id, provider, endpoint, provider_message, kind, disposition)
  values ('PKG', '00000000-0000-4000-8000-000000009601', 'quickbooks', '/v3/company/9130350000000/query', 'x', 'invalid_input', 'fail')$$,
  '23514', null, 'an endpoint with a realm id is refused');
select throws_ok($$insert into core.connector_api_errors (lane_id, connection_id, provider, endpoint, provider_message, kind, disposition)
  values ('PKG', '00000000-0000-4000-8000-000000009601', 'quickbooks', '/v3/company/{realm}/query?query=select * from Customer', 'x', 'invalid_input', 'fail')$$,
  '23514', null, 'an endpoint with a query string is refused');
select throws_ok($$insert into core.connector_api_errors (lane_id, connection_id, provider, provider_error_code, provider_message, kind, disposition)
  values ('PKG', '00000000-0000-4000-8000-000000009601', 'quickbooks', 'Jane Doe', 'x', 'invalid_input', 'fail')$$,
  '23514', null, 'an error code with spaces (a name) is refused');
select throws_ok($$insert into core.connector_api_errors (lane_id, connection_id, provider, provider_message, kind, disposition)
  values ('PKG', '00000000-0000-4000-8000-000000009601', 'quickbooks', 'x', 'made_up', 'fail')$$,
  '23514', null, 'an unknown kind is refused');
select throws_ok($$insert into core.connector_api_errors (lane_id, connection_id, provider, provider_message, http_status, kind, disposition)
  values ('PKG', '00000000-0000-4000-8000-000000009601', 'quickbooks', 'x', 99, 'invalid_input', 'fail')$$,
  '23514', null, 'an impossible HTTP status is refused');
reset role;

-- ---------------------------------------------------------------- reads
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select set_eq($$select lane_id from core.connector_api_errors$$, array['PKG'], 'admin_technical reads the PKG errors and no other lane');
select throws_ok($$insert into core.connector_api_errors (lane_id, connection_id, provider, provider_message, kind, disposition)
  values ('PKG', '00000000-0000-4000-8000-000000009601', 'quickbooks', 'x', 'transient', 'retry')$$, '42501', null, 'authenticated cannot insert');
select throws_ok($$update core.connector_api_errors set provider_message = 'y'$$, '42501', null, 'authenticated cannot update');
select throws_ok($$delete from core.connector_api_errors$$, '42501', null, 'authenticated cannot delete');
reset role;

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select set_eq($$select distinct lane_id from core.connector_api_errors$$, array['APK', 'PKG'], 'the owner (member of both lanes) reads both');
reset role;

select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.connector_api_errors), 0, 'finance_operator reads none');
reset role;
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.connector_api_errors), 0, 'a non-member reads none (cross-lane denial)');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.connector_api_errors), 0, 'AAL1 reads none');
reset role;
set local role anon;
select throws_ok($$select id from core.connector_api_errors$$, '42501', null, 'anon is denied');
reset role;

-- ---------------------------------------------------------------- purge
update core.connector_api_errors set at = now() - interval '91 days' where lane_id = 'PKG';
set local role service_role;
select lives_ok($$insert into core.connector_api_errors (lane_id, connection_id, provider, provider_message, kind, disposition)
  values ('PKG', '00000000-0000-4000-8000-000000009601', 'quickbooks', 'new', 'transient', 'retry')$$, 'a fresh PKG error');
select is(core.connector_api_errors_purge('PKG'), 1, 'the purge deletes the PKG error older than 90 days');
select is((select count(*)::int from core.connector_api_errors where lane_id = 'PKG'), 1, 'the fresh PKG error stays');
select is((select count(*)::int from core.connector_api_errors where lane_id = 'APK'), 1, 'cross-lane: the purge of PKG leaves APK alone');
reset role;
select ok(has_function_privilege('service_role', 'core.connector_api_errors_purge(text)', 'execute')
          and not has_function_privilege('authenticated', 'core.connector_api_errors_purge(text)', 'execute')
          and not has_function_privilege('anon', 'core.connector_api_errors_purge(text)', 'execute'), 'only service_role runs the purge');
update core.lanes set enabled = false where code = 'APK';
set local role service_role;
select throws_ok($$select core.connector_api_errors_purge('APK')$$, '42501', null, 'a disabled lane is refused');
reset role;
update core.lanes set enabled = true where code = 'APK';

-- ---------------------------------------------------------------- sync_runs.job
insert into core.sync_runs (lane_id, connection_id, kind, trigger, job) values ('PKG', '00000000-0000-4000-8000-000000009601', 'incremental', 'webhook', 'sync');
select lives_ok($$insert into core.sync_runs (lane_id, connection_id, kind, trigger, job) values ('PKG', '00000000-0000-4000-8000-000000009601', 'snapshot', 'schedule', 'reports')$$,
  'a reports run may run next to a sync of the same connection');
select throws_ok($$insert into core.sync_runs (lane_id, connection_id, kind, trigger, job) values ('PKG', '00000000-0000-4000-8000-000000009601', 'snapshot', 'schedule', 'reports')$$,
  '23505', null, 'but not two reports runs at once');
select throws_ok($$insert into core.sync_runs (lane_id, connection_id, kind, trigger, job) values ('PKG', '00000000-0000-4000-8000-000000009601', 'full', 'schedule', 'normalize')$$,
  '23514', null, 'a normalize run is a snapshot, not a full load');

select * from finish();
rollback;
