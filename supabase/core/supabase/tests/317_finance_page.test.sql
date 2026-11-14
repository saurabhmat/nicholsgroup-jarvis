-- Finance page reads (T-244): core.finance_pnl_window (shared P&L extraction), core.finance_pnl (week / mtd / ytd),
-- core.finance_overview (open AR total, report metadata), and core.home_finance reading the month-to-date P&L from a row shaped
-- like the one the reports job now requests (start_date = first day of the month, end_date = today).
-- Covered: privileges and security mode, period validation, states, window matching (New York dates, Saturday week start, a
-- last-month row is not this month's), newest row wins, AR total equals the aging bucket sum, report metadata only (no payload,
-- current connections only), and denial: another lane, AAL1, no finance view, outsider, anon.
begin;
select plan(55);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code in ('APK', 'NC');
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');

delete from fin.payments where lane_id in ('PKG', 'APK', 'NC');
delete from fin.transactions where lane_id in ('PKG', 'APK', 'NC');
delete from fin.invoices where lane_id in ('PKG', 'APK', 'NC');
delete from fin.bills where lane_id in ('PKG', 'APK', 'NC');
delete from fin.accounts where lane_id in ('PKG', 'APK', 'NC');
delete from fin.report_cache where lane_id in ('PKG', 'APK', 'NC');
delete from fin.normalize_runs where lane_id in ('PKG', 'APK', 'NC');
delete from raw.source_records where lane_id in ('PKG', 'APK', 'NC') and provider = 'quickbooks';
delete from core.sync_runs where connection_id in (select id from core.connections where lane_id in ('PKG', 'APK', 'NC') and provider = 'quickbooks');
delete from core.connections where lane_id in ('PKG', 'APK', 'NC') and provider = 'quickbooks';

-- ---------------------------------------------------------------- privileges
select ok(has_function_privilege('authenticated', 'core.finance_pnl(text, text)', 'execute')
          and has_function_privilege('authenticated', 'core.finance_overview(text)', 'execute')
          and has_function_privilege('authenticated', 'core.finance_pnl_window(text, date, date, date, text)', 'execute'), 'authenticated executes the three');
select ok(not has_function_privilege('anon', 'core.finance_pnl(text, text)', 'execute')
          and not has_function_privilege('anon', 'core.finance_overview(text)', 'execute')
          and not has_function_privilege('anon', 'core.finance_pnl_window(text, date, date, date, text)', 'execute'), 'anon executes none');
select ok((select bool_and(not prosecdef and proconfig = array['search_path=""'] and provolatile = 's')
           from pg_proc where oid in ('core.finance_pnl(text, text)'::regprocedure, 'core.finance_overview(text)'::regprocedure,
                                      'core.finance_pnl_window(text, date, date, date, text)'::regprocedure)),
          'all three are security invoker, stable, with an empty search_path');

-- ---------------------------------------------------------------- helpers and fixtures
create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'America/New_York')::date $$;
-- Independent of the function under test: Monday-based week shifted so it starts on Saturday.
create function pg_temp.wstart() returns date language sql as $$ select (date_trunc('week', (pg_temp.today() + 2)::timestamp) - interval '2 days')::date $$;
create function pg_temp.mstart() returns date language sql as $$ select date_trunc('month', pg_temp.today()::timestamp)::date $$;
create function pg_temp.ystart() returns date language sql as $$ select date_trunc('year', pg_temp.today()::timestamp)::date $$;
create function pg_temp.pl(p_income text, p_expense text) returns jsonb language sql as $$
  select jsonb_build_object('Header', jsonb_build_object('ReportName', 'ProfitAndLoss', 'TotalsWithheld', 'false'),
    'Columns', jsonb_build_object('Column', '[]'::jsonb),
    'Rows', jsonb_build_object('Row', jsonb_build_array(
      jsonb_build_object('type', 'Data', 'level', 1, 'group', 'Income', 'ColData', jsonb_build_array(jsonb_build_object('value', 'Sales'), jsonb_build_object('value', p_income))),
      jsonb_build_object('type', 'Data', 'level', 1, 'group', 'Expenses', 'ColData', jsonb_build_array(jsonb_build_object('value', 'Software'), jsonb_build_object('value', p_expense))))))
$$;
create function pg_temp.pnl_params(p_start date, p_end date) returns jsonb language sql as $$
  select jsonb_build_object('start_date', to_char(p_start, 'YYYY-MM-DD'), 'end_date', to_char(p_end, 'YYYY-MM-DD'), 'method', 'accrual')
$$;

-- ---------------------------------------------------------------- not connected
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state from core.finance_pnl('NC', 'mtd')), 'not_connected', 'finance_pnl: a lane without QuickBooks is not_connected');
select is((select state from core.finance_overview('NC')), 'not_connected', 'finance_overview: not_connected');
select throws_ok($$select * from core.finance_pnl('NC', 'quarter')$$, '22023', null, 'an unknown period is refused');
select throws_ok($$select * from core.finance_pnl('NC', null)$$, '22023', null, 'a null period is refused');
select throws_ok($$select * from core.finance_pnl(null, 'mtd')$$, '22004', null, 'a lane is required (finance_pnl)');
select throws_ok($$select * from core.finance_overview(null)$$, '22004', null, 'a lane is required (finance_overview)');
reset role;

-- ---------------------------------------------------------------- connected, mapped, synced
insert into core.connections (id, lane_id, provider, external_account_id, status, last_sync_at) values
  ('00000000-0000-4000-8000-000000004401', 'PKG', 'quickbooks', '8800000000441', 'active', now() - interval '2 hours'),
  ('00000000-0000-4000-8000-000000004402', 'PKG', 'quickbooks', '8800000000442', 'disconnected', now() - interval '30 days'),
  ('00000000-0000-4000-8000-000000004403', 'APK', 'quickbooks', '8800000000443', 'active', now() - interval '1 hour');
insert into fin.normalize_runs (lane_id, connection_id, class_tracking, class_fallback, counts, started_at, finished_at)
values ('PKG', '00000000-0000-4000-8000-000000004401', false, false, '{}', now() - interval '3 hours', now() - interval '2 hours 59 minutes');
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1,
  (config - 'qbo') || jsonb_build_object('entities', jsonb_build_object('own_entity', 'PKG',
    'by_entity', jsonb_build_object('PKG', jsonb_build_object('qbo_class_ids', '[]'::jsonb, 'qbo_customer_ids', '[]'::jsonb,
                                                              'stripe_product_ids', '[]'::jsonb, 'ghl_tags', '[]'::jsonb, 'ghl_products', '[]'::jsonb)),
    'bank_accounts', '[]'::jsonb))
from core.lane_config_current where lane_id = 'PKG';

-- Only a year-to-date report that starts Jan 1 is cached (what the job did before T-244), plus last month's MTD and another lane's rows.
insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at) values
  ('PKG', '00000000-0000-4000-8000-000000004401', 'pnl', pg_temp.pnl_params(pg_temp.ystart(), greatest(pg_temp.today() - 1, pg_temp.ystart())), pg_temp.pl('5000.00', '1000.00'), now() - interval '1 day', now() - interval '1 day'),
  ('PKG', '00000000-0000-4000-8000-000000004401', 'pnl', pg_temp.pnl_params((pg_temp.mstart() - interval '1 month')::date, pg_temp.mstart() - 1), pg_temp.pl('999.00', '1.00'), now() - interval '40 days', now() - interval '40 days'),
  ('APK', '00000000-0000-4000-8000-000000004403', 'pnl', pg_temp.pnl_params(pg_temp.mstart(), pg_temp.today()), pg_temp.pl('777777.00', '1.00'), now() - interval '1 hour', now() - interval '1 hour');

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select pnl_reason from core.home_finance('PKG')), 'month_report_not_cached', 'home: no month report cached (the old situation) -> month_report_not_cached, last month is not this month');
select is((select pnl_reason from core.finance_pnl('PKG', 'mtd')), 'report_not_cached', 'finance_pnl mtd: not cached');
select is((select pnl_reason from core.finance_pnl('PKG', 'week')), 'report_not_cached', 'finance_pnl week: not cached');
select is((select state || '/' || pnl_net::text from core.finance_pnl('PKG', 'ytd')), 'ok/4000.00', 'finance_pnl ytd: the year report (starts Jan 1) is found: 5000.00 - 1000.00');
reset role;

-- The reports job's three windows arrive (older and newer copies of the month: the newest as_of wins).
insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at) values
  ('PKG', '00000000-0000-4000-8000-000000004401', 'pnl', pg_temp.pnl_params(pg_temp.wstart(), pg_temp.today()), pg_temp.pl('100.00', '40.00'), now() - interval '1 hour', now() - interval '1 hour'),
  ('PKG', '00000000-0000-4000-8000-000000004401', 'pnl', pg_temp.pnl_params(pg_temp.mstart(), pg_temp.today()), pg_temp.pl('1.00', '1.00'), now() - interval '3 hours', now() - interval '3 hours'),
  ('PKG', '00000000-0000-4000-8000-000000004401', 'pnl', pg_temp.pnl_params(pg_temp.mstart(), pg_temp.today()), pg_temp.pl('1000.00', '300.00'), now() - interval '1 hour', now() - interval '1 hour'),
  ('PKG', '00000000-0000-4000-8000-000000004401', 'ar_aging_summary', jsonb_build_object('report_date', to_char(pg_temp.today(), 'YYYY-MM-DD')),
   jsonb_build_object('Header', '{}'::jsonb, 'Columns', '{"Column": []}'::jsonb, 'Rows', '{"Row": []}'::jsonb), now() - interval '1 hour', now() - interval '1 hour'),
  -- a disconnected (replaced) connection's report is not listed
  ('PKG', '00000000-0000-4000-8000-000000004402', 'pnl', pg_temp.pnl_params(date '2020-01-01', date '2020-12-31'), pg_temp.pl('1.00', '1.00'), now() - interval '300 days', now() - interval '300 days');

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select pnl_reason is null and pnl_income = 1000.00 and pnl_expenses = 300.00 and pnl_net = 700.00 and pnl_start = pg_temp.mstart() and pnl_end = pg_temp.today() and pnl_method = 'accrual' and not pnl_partial
           from core.home_finance('PKG')), true, 'home_finance: net income month to date comes from a row shaped like the new request (newest copy wins)');
select is((select pnl_as_of is not null and pnl_as_of > now() - interval '2 hours' from core.home_finance('PKG')), true, 'home_finance: pnl_as_of is the newest row''s as_of');
select is((select pnl_net from core.finance_pnl('PKG', 'mtd')), 700.00::numeric, 'finance_pnl mtd = home_finance month to date');
select is((select pnl_net from core.finance_pnl('PKG', 'mtd')), (select pnl_net from core.home_finance('PKG')), 'the two readers agree');
select is((select pnl_income || '/' || pnl_expenses || '/' || pnl_net from core.finance_pnl('PKG', 'week')), '100.00/40.00/60.00', 'finance_pnl week: income, expenses, net');
select is((select window_start from core.finance_pnl('PKG', 'week')), pg_temp.wstart(), 'the week window starts on the most recent Saturday (New York)');
select is((select extract(dow from window_start)::int from core.finance_pnl('PKG', 'week')), 6, 'the week starts on a Saturday');
select is((select window_start || '..' || window_end from core.finance_pnl('PKG', 'mtd')), pg_temp.mstart() || '..' || pg_temp.today(), 'mtd window: first of the month to today');
select is((select window_start from core.finance_pnl('PKG', 'ytd')), pg_temp.ystart(), 'ytd window starts Jan 1 (calendar year)');
select is((select period from core.finance_pnl('PKG', 'week')), 'week', 'the period is echoed');
select is((select pnl_start || '..' || pnl_end from core.finance_pnl('PKG', 'week')), pg_temp.wstart() || '..' || pg_temp.today(), 'the row''s own range is returned');
select is((select count(*)::int from core.finance_pnl('PKG', 'mtd')), 1, 'always exactly one row');
select ok((select as_of is not null and last_sync_at is not null and connection_status = 'active' from core.finance_pnl('PKG', 'mtd')), 'as_of, last sync and connection status are set');
reset role;

-- a figure that cannot be read, class split required, columns
update fin.report_cache set payload = pg_temp.pl('abc', '1.00')
where lane_id = 'PKG' and report = 'pnl' and params ->> 'start_date' = to_char(pg_temp.wstart(), 'YYYY-MM-DD') and params ->> 'end_date' = to_char(pg_temp.today(), 'YYYY-MM-DD');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select pnl_reason from core.finance_pnl('PKG', 'week')), 'figure_unreadable', 'an unreadable figure gives a reason, not a number');
select is((select pnl_net is null from core.finance_pnl('PKG', 'week')), true, 'and no figure');
reset role;
update fin.report_cache set payload = jsonb_set(pg_temp.pl('1.00', '1.00'), '{Rows,Row}', '[]')
where lane_id = 'PKG' and report = 'pnl' and params ->> 'start_date' = to_char(pg_temp.wstart(), 'YYYY-MM-DD') and params ->> 'end_date' = to_char(pg_temp.today(), 'YYYY-MM-DD');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select pnl_reason from core.finance_pnl('PKG', 'week')), 'report_empty', 'a report with no income or expense lines: report_empty');
reset role;

-- ---------------------------------------------------------------- overview: AR total and report metadata
insert into fin.invoices (id, lane_id, connection_id, source_id, customer_name, issue_date, due_date, total, balance, entity_code, voided, deleted, currency_code) values
  ('00000000-0000-4000-8000-000000004411', 'PKG', '00000000-0000-4000-8000-000000004401', 'i-1', 'Synthetic A', pg_temp.today() - 100, pg_temp.today() + 5,  10.50, 10.50, 'PKG', false, false, 'USD'),
  ('00000000-0000-4000-8000-000000004412', 'PKG', '00000000-0000-4000-8000-000000004401', 'i-2', 'Synthetic B', pg_temp.today() - 100, pg_temp.today() - 45, 200.25, 200.25, 'PKG', false, false, 'USD'),
  ('00000000-0000-4000-8000-000000004413', 'PKG', '00000000-0000-4000-8000-000000004401', 'i-3', 'Synthetic C', pg_temp.today() - 400, pg_temp.today() - 300, 3000.00, 3000.00, 'PKG', false, false, 'USD'),
  ('00000000-0000-4000-8000-000000004414', 'PKG', '00000000-0000-4000-8000-000000004401', 'i-4', 'Voided', pg_temp.today() - 400, pg_temp.today() - 300, 9999.00, 9999.00, 'PKG', true, false, 'USD'),
  ('00000000-0000-4000-8000-000000004415', 'PKG', '00000000-0000-4000-8000-000000004401', 'i-5', 'Paid', pg_temp.today() - 400, pg_temp.today() - 300, 9999.00, 0.00, 'PKG', false, false, 'USD'),
  ('00000000-0000-4000-8000-000000004416', 'PKG', '00000000-0000-4000-8000-000000004401', 'i-6', 'Unmapped', pg_temp.today() - 400, pg_temp.today() - 300, 9999.00, 9999.00, 'unmapped', false, false, 'USD'),
  ('00000000-0000-4000-8000-000000004417', 'PKG', '00000000-0000-4000-8000-000000004401', 'i-7', 'CAD', pg_temp.today() - 400, pg_temp.today() - 300, 9999.00, 9999.00, 'PKG', false, false, 'CAD'),
  ('00000000-0000-4000-8000-000000004418', 'APK', '00000000-0000-4000-8000-000000004403', 'a-1', 'Other lane', pg_temp.today() - 400, pg_temp.today() - 300, 7777.00, 7777.00, 'PKG', false, false, 'USD');
insert into fin.bills (id, lane_id, connection_id, source_id, issue_date, due_date, total, balance, entity_code, voided, deleted) values
  ('00000000-0000-4000-8000-000000004421', 'PKG', '00000000-0000-4000-8000-000000004401', 'b-1', pg_temp.today() - 30, pg_temp.today() - 20, 50.00, 50.00, 'unmapped', false, false),
  ('00000000-0000-4000-8000-000000004422', 'PKG', '00000000-0000-4000-8000-000000004401', 'b-2', pg_temp.today() - 30, pg_temp.today() - 20, 50.00, 50.00, 'unmapped', true, false),
  ('00000000-0000-4000-8000-000000004423', 'PKG', '00000000-0000-4000-8000-000000004401', 'b-3', pg_temp.today() - 30, pg_temp.today() - 20, 50.00, 50.00, 'PKG', false, false);

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state from core.finance_overview('PKG')), 'ok', 'overview: ok');
select is((select ar_total from core.finance_overview('PKG')), 3210.75::numeric, 'AR total: open own-entity USD invoices only (voided, paid, unmapped, CAD and the other lane left out)');
select is((select ar_invoices from core.finance_overview('PKG')), 3, 'AR invoices: three');
select is((select ar_total from core.finance_overview('PKG')),
          (select sum((e ->> 'total')::numeric) from core.home_finance_detail('PKG') d, jsonb_array_elements(d.aging) e), 'AR total equals the sum of the aging buckets');
select is((select unmapped_bills_open from core.finance_overview('PKG')), 1, 'open unmapped bills: the voided one is not counted');
select ok((select last_normalized_at > now() - interval '3 hours 5 minutes' and last_normalized_at < now() - interval '2 hours 50 minutes' from core.finance_overview('PKG')), 'last normalizer run');
select is((select count(*)::int from core.finance_overview('PKG')), 1, 'one row');
-- report metadata
select is((select jsonb_array_length(reports) from core.finance_overview('PKG')), 5, 'reports: one entry per type and range (ytd, week, month once, the aging; last month''s) and none from the disconnected connection');
select is((select not exists (select 1 from jsonb_array_elements(reports) e where (select array_agg(k order by k) from jsonb_object_keys(e) k) <> array['as_of', 'class_filtered', 'end_date', 'method', 'report', 'report_date', 'start_date'])
           from core.finance_overview('PKG')), true, 'reports: metadata keys only');
select is((select reports::text !~ '(Rows|Sales|Software|Header|payload)' from core.finance_overview('PKG')), true, 'reports: no payload content');
select is((select e ->> 'as_of' is not null and (e ->> 'start_date') = to_char(pg_temp.mstart(), 'YYYY-MM-DD')
           from core.finance_overview('PKG') o, jsonb_array_elements(o.reports) e
           where e ->> 'report' = 'pnl' and e ->> 'start_date' = to_char(pg_temp.mstart(), 'YYYY-MM-DD') and e ->> 'end_date' = to_char(pg_temp.today(), 'YYYY-MM-DD')),
          true, 'reports: the month window is listed');
reset role;

-- ---------------------------------------------------------------- cross-lane
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state from core.finance_pnl('APK', 'mtd')), 'no_access', 'another lane: finance_pnl is no_access');
select is((select pnl_net is null and pnl_income is null and window_start is null from core.finance_pnl('APK', 'mtd')), true, 'another lane: no figure');
select is((select state from core.finance_overview('APK')), 'no_access', 'another lane: finance_overview is no_access');
select is((select ar_total is null and reports = '[]'::jsonb and as_of is null from core.finance_overview('APK')), true, 'another lane: nothing at all');
select is((select count(*)::int from fin.report_cache where lane_id = 'APK'), 0, 'RLS: the owner sees no APK report rows');
select is((select pnl_net from core.finance_pnl('PKG', 'mtd')), 700.00::numeric, 'PKG never uses the other lane''s 777777.00 month report');
reset role;
select is((select count(*)::int from fin.report_cache where lane_id = 'APK'), 1, 'fixture check: APK has a month report');

-- ---------------------------------------------------------------- AAL1, no finance view, outsider, anon
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select state from core.finance_pnl('PKG', 'mtd')), 'no_access', 'AAL1: finance_pnl no_access');
select is((select state from core.finance_overview('PKG')), 'no_access', 'AAL1: finance_overview no_access');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select state from core.finance_pnl('PKG', 'mtd')), 'no_access', 'admin_technical (no finance view): no_access');
select is((select state || '/' || reports::text from core.finance_overview('PKG')), 'no_access/[]', 'admin_technical: no report list');
reset role;
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select state from core.finance_pnl('PKG', 'mtd')), 'no_access', 'an outsider: no_access');
reset role;
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select pnl_net from core.finance_pnl('PKG', 'mtd')), 700.00::numeric, 'a viewer with the finance view reads the figure');
reset role;
set local role anon;
select throws_ok($$select * from core.finance_pnl('PKG', 'mtd')$$, '42501', null, 'anon cannot call finance_pnl');
select throws_ok($$select * from core.finance_overview('PKG')$$, '42501', null, 'anon cannot call finance_overview');
reset role;

select * from finish();
rollback;
