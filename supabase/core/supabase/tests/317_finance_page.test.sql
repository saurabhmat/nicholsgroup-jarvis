-- Finance page reads (T-244): core.finance_pnl_window (shared P&L extraction), core.finance_pnl (week / mtd / ytd),
-- core.finance_overview (open AR total, report metadata), and core.home_finance reading the month-to-date P&L from a row shaped
-- like the one the reports job now requests (start_date = first day of the month, end_date = today).
-- Date independence: the window logic is tested with FIXED dates in 2020 (never today's window) through core.finance_pnl_window.
-- The today()-based part (finance_pnl, home_finance, finance_overview) uses distinct as_of values everywhere, and every expectation
-- that depends on whether the week, month or year windows share a start date (January, a Saturday that is the 1st) is conditional,
-- so the file passes on any date.
-- Covered: privileges and security mode, period validation, states, window matching, newest row wins, only the lane's current
-- connections are read (a disconnected connection's newer row is ignored by home_finance and finance_pnl), AR total equals the aging
-- sum, report metadata only (no payload, one entry per type and start date), and denial: another lane, AAL1, no finance view,
-- outsider, anon (also direct calls of the window function).
begin;
select plan(73);
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
          and has_function_privilege('authenticated', 'core.finance_pnl_window(text, date, date, date, text, uuid[])', 'execute'), 'authenticated executes the three');
select ok(not has_function_privilege('anon', 'core.finance_pnl(text, text)', 'execute')
          and not has_function_privilege('anon', 'core.finance_overview(text)', 'execute')
          and not has_function_privilege('anon', 'core.finance_pnl_window(text, date, date, date, text, uuid[])', 'execute'), 'anon executes none');
select ok((select bool_and(not prosecdef and proconfig = array['search_path=""'] and provolatile = 's')
           from pg_proc where oid in ('core.finance_pnl(text, text)'::regprocedure, 'core.finance_overview(text)'::regprocedure,
                                      'core.finance_pnl_window(text, date, date, date, text, uuid[])'::regprocedure)),
          'all three are security invoker, stable, with an empty search_path');

-- ---------------------------------------------------------------- helpers
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
create function pg_temp.put(p_lane text, p_conn uuid, p_start date, p_end date, p_payload jsonb, p_as_of timestamptz, p_extra jsonb default '{}') returns void language sql as $$
  insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at)
  values (p_lane, p_conn, 'pnl', pg_temp.pnl_params(p_start, p_end) || p_extra, p_payload, p_as_of, p_as_of)
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
select throws_ok($$select * from core.finance_pnl_window(null, date '2020-03-01', date '2020-03-01', date '2020-03-31', null, '{}')$$, '22004', null, 'a lane is required (finance_pnl_window)');
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

-- ================================================================ window logic with FIXED dates (2020: never today's window)
-- March 2020 window [2020-03-01, 2020-03-31]. Connection 4401 is current, 4402 is disconnected.
select pg_temp.put('PKG', '00000000-0000-4000-8000-000000004401', date '2020-03-01', date '2020-03-10', pg_temp.pl('10.00', '4.00'),   timestamptz '2020-03-10 12:00+00');
select pg_temp.put('PKG', '00000000-0000-4000-8000-000000004401', date '2020-03-01', date '2020-03-14', pg_temp.pl('100.00', '30.00'), timestamptz '2020-03-14 12:00+00');
select pg_temp.put('PKG', '00000000-0000-4000-8000-000000004401', date '2020-02-01', date '2020-02-28', pg_temp.pl('9999.00', '1.00'), timestamptz '2020-03-20 12:00+00');   -- last month: not matched
select pg_temp.put('PKG', '00000000-0000-4000-8000-000000004401', date '2020-03-01', date '2020-04-02', pg_temp.pl('8888.00', '1.00'), timestamptz '2020-04-02 12:00+00');   -- ends outside the window: not matched
select pg_temp.put('PKG', '00000000-0000-4000-8000-000000004402', date '2020-03-01', date '2020-03-14', pg_temp.pl('5000.00', '1000.00'), timestamptz '2020-03-15 12:00+00'); -- newer, but a disconnected connection
select pg_temp.put('PKG', '00000000-0000-4000-8000-000000004401', date '2019-01-01', date '2019-01-31', pg_temp.pl('abc', '1.00'),      timestamptz '2019-02-01 12:00+00');
select pg_temp.put('PKG', '00000000-0000-4000-8000-000000004401', date '2019-02-01', date '2019-02-28', jsonb_set(pg_temp.pl('1.00', '1.00'), '{Rows,Row}', '[]'), timestamptz '2019-03-01 12:00+00');
select pg_temp.put('PKG', '00000000-0000-4000-8000-000000004401', date '2019-03-01', date '2019-03-31', jsonb_set(pg_temp.pl('1.00', '1.00'), '{Header,SummarizeColumnsBy}', '"Month"'), timestamptz '2019-04-01 12:00+00');
select pg_temp.put('APK', '00000000-0000-4000-8000-000000004403', date '2020-03-01', date '2020-03-14', pg_temp.pl('7777.00', '1.00'), timestamptz '2020-03-14 12:00+00');

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select pnl_income || '/' || pnl_expenses || '/' || pnl_net || '/' || pnl_end from core.finance_pnl_window('PKG', date '2020-03-01', date '2020-03-01', date '2020-03-31', null, array['00000000-0000-4000-8000-000000004401']::uuid[])),
          '100.00/30.00/70.00/2020-03-14', 'window: the newest matching row of the current connection (not last month, not the row ending outside, not the disconnected one)');
select is((select pnl_start || '..' || pnl_end || ' ' || pnl_method from core.finance_pnl_window('PKG', date '2020-03-01', date '2020-03-01', date '2020-03-31', null, array['00000000-0000-4000-8000-000000004401']::uuid[])), '2020-03-01..2020-03-14 accrual', 'window: the row''s own range and method');
select is((select pnl_net from core.finance_pnl_window('PKG', date '2020-03-01', date '2020-03-01', date '2020-03-31', null, array['00000000-0000-4000-8000-000000004402']::uuid[])), 4000.00::numeric, 'window: the connection list decides which connection is read');
select is((select pnl_net from core.finance_pnl_window('PKG', date '2020-03-01', date '2020-03-01', date '2020-03-31', null, array['00000000-0000-4000-8000-000000004401', '00000000-0000-4000-8000-000000004402']::uuid[])), 4000.00::numeric, 'window: with both connections the newest row wins');
select is((select pnl_reason from core.finance_pnl_window('PKG', date '2020-03-01', date '2020-03-01', date '2020-03-31', null, '{}')), 'report_not_cached', 'window: no connections, nothing read');
select is((select pnl_reason from core.finance_pnl_window('PKG', date '2020-03-01', date '2020-03-01', date '2020-03-31', null, null)), 'report_not_cached', 'window: a null connection list reads nothing');
select is((select pnl_reason from core.finance_pnl_window('PKG', date '2020-04-01', date '2020-04-01', date '2020-04-30', null, array['00000000-0000-4000-8000-000000004401']::uuid[])), 'report_not_cached', 'window: another start date is not cached');
select is((select pnl_reason from core.finance_pnl_window('PKG', date '2020-03-01', date '2020-03-01', date '2020-03-31', 'file_class', array['00000000-0000-4000-8000-000000004401']::uuid[])), 'report_not_split_by_class', 'window: a class-split mapping needs a class-filtered report');
select is((select pnl_reason from core.finance_pnl_window('PKG', date '2019-01-01', date '2019-01-01', date '2019-01-31', null, array['00000000-0000-4000-8000-000000004401']::uuid[])), 'figure_unreadable', 'window: an unreadable figure gives a reason');
select is((select pnl_reason from core.finance_pnl_window('PKG', date '2019-02-01', date '2019-02-01', date '2019-02-28', null, array['00000000-0000-4000-8000-000000004401']::uuid[])), 'report_empty', 'window: no income or expense lines');
select is((select pnl_reason from core.finance_pnl_window('PKG', date '2019-03-01', date '2019-03-01', date '2019-03-31', null, array['00000000-0000-4000-8000-000000004401']::uuid[])), 'report_has_columns', 'window: a report with columns is refused');
select is((select pnl_net is null and pnl_income is null from core.finance_pnl_window('PKG', date '2019-01-01', date '2019-01-01', date '2019-01-31', null, array['00000000-0000-4000-8000-000000004401']::uuid[])), true, 'window: a reason carries no figure');
-- direct cross-lane: APK has a matching row, the owner is not an APK member
select is((select pnl_reason from core.finance_pnl_window('APK', date '2020-03-01', date '2020-03-01', date '2020-03-31', null, array['00000000-0000-4000-8000-000000004403']::uuid[])), 'report_not_cached', 'window, cross-lane: another lane''s report is not readable (RLS)');
reset role;
select is((select pnl_net from core.finance_pnl_window('APK', date '2020-03-01', date '2020-03-01', date '2020-03-31', null, array['00000000-0000-4000-8000-000000004403']::uuid[])), 7776.00::numeric, 'fixture check: APK has a matching row');
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select pnl_reason from core.finance_pnl_window('PKG', date '2020-03-01', date '2020-03-01', date '2020-03-31', null, array['00000000-0000-4000-8000-000000004401']::uuid[])), 'report_not_cached', 'window, AAL1: nothing is readable');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select pnl_reason from core.finance_pnl_window('PKG', date '2020-03-01', date '2020-03-01', date '2020-03-31', null, array['00000000-0000-4000-8000-000000004401']::uuid[])), 'report_not_cached', 'window, no finance view: nothing is readable');
reset role;

-- ================================================================ today()-based part (safe on any date: distinct as_of everywhere)
-- Nothing of today's windows is cached yet (the 2019/2020 rows are never today's window).
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select pnl_reason from core.home_finance('PKG')), 'month_report_not_cached', 'home: no month report cached (the old situation) -> month_report_not_cached');
select is((select pnl_reason from core.finance_pnl('PKG', 'mtd')), 'report_not_cached', 'finance_pnl mtd: not cached');
select is((select pnl_reason from core.finance_pnl('PKG', 'week')), 'report_not_cached', 'finance_pnl week: not cached');
select is((select pnl_reason from core.finance_pnl('PKG', 'ytd')), 'report_not_cached', 'finance_pnl ytd: not cached');
reset role;

-- Last month's request (not this month), then the reports job's windows, then a disconnected connection's NEWER month row.
select pg_temp.put('PKG', '00000000-0000-4000-8000-000000004401', (pg_temp.mstart() - interval '1 month')::date, pg_temp.mstart() - 1, pg_temp.pl('999.00', '1.00'), now() - interval '40 days');
select pg_temp.put('PKG', '00000000-0000-4000-8000-000000004401', pg_temp.ystart(), pg_temp.today(), pg_temp.pl('5000.00', '1000.00'), now() - interval '3 hours');
select pg_temp.put('PKG', '00000000-0000-4000-8000-000000004401', pg_temp.wstart(), pg_temp.today(), pg_temp.pl('100.00', '40.00'), now() - interval '2 hours');
select pg_temp.put('PKG', '00000000-0000-4000-8000-000000004401', pg_temp.mstart(), pg_temp.today(), pg_temp.pl('1.00', '1.00'), now() - interval '4 hours');
select pg_temp.put('PKG', '00000000-0000-4000-8000-000000004401', pg_temp.mstart(), pg_temp.today(), pg_temp.pl('1000.00', '300.00'), now() - interval '1 hour');
-- an older nightly copy of the month that ended on the 1st (stale duplicate for the reports list)
select pg_temp.put('PKG', '00000000-0000-4000-8000-000000004401', pg_temp.mstart(), pg_temp.mstart(), pg_temp.pl('2.00', '2.00'), now() - interval '5 hours');
select pg_temp.put('PKG', '00000000-0000-4000-8000-000000004402', pg_temp.mstart(), pg_temp.today(), pg_temp.pl('777777.00', '1.00'), now() - interval '30 minutes');
select pg_temp.put('APK', '00000000-0000-4000-8000-000000004403', pg_temp.mstart(), pg_temp.today(), pg_temp.pl('888888.00', '1.00'), now() - interval '1 hour');
insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at)
select 'PKG', '00000000-0000-4000-8000-000000004401', 'ar_aging_summary', jsonb_build_object('report_date', to_char(pg_temp.today() - d, 'YYYY-MM-DD')),
       jsonb_build_object('Header', '{}'::jsonb, 'Columns', '{"Column": []}'::jsonb, 'Rows', '{"Row": []}'::jsonb), now() - interval '1 hour' - d * interval '1 day', now() - interval '1 hour' - d * interval '1 day'
from generate_series(0, 2) d;

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select pnl_reason is null and pnl_income = 1000.00 and pnl_expenses = 300.00 and pnl_net = 700.00 and pnl_start = pg_temp.mstart() and pnl_end = pg_temp.today() and pnl_method = 'accrual' and not pnl_partial
           from core.home_finance('PKG')), true, 'home_finance: net income month to date comes from a row shaped like the new request; newest copy wins; the disconnected connection''s newer row and the other lane''s row are ignored');
select is((select pnl_as_of > now() - interval '2 hours' from core.home_finance('PKG')), true, 'home_finance: pnl_as_of is the newest current-connection row''s as_of');
select is((select pnl_net from core.finance_pnl('PKG', 'mtd')), 700.00::numeric, 'finance_pnl mtd = 700.00: the disconnected connection''s newer row is ignored');
select is((select pnl_net from core.finance_pnl('PKG', 'mtd')), (select pnl_net from core.home_finance('PKG')), 'the two readers agree');
-- week and year: when the window shares its start date with the month (January; a Saturday that is the 1st) the newest row of either wins, so the check is skipped
select is((select case when pg_temp.wstart() in (pg_temp.mstart(), pg_temp.ystart()) then null else (select pnl_income || '/' || pnl_expenses || '/' || pnl_net from core.finance_pnl('PKG', 'week')) end),
          case when pg_temp.wstart() in (pg_temp.mstart(), pg_temp.ystart()) then null else '100.00/40.00/60.00' end, 'finance_pnl week: income, expenses, net (skipped when the week shares a start with the month or year)');
select is((select case when pg_temp.ystart() = pg_temp.mstart() then null else (select pnl_net from core.finance_pnl('PKG', 'ytd')) end),
          case when pg_temp.ystart() = pg_temp.mstart() then null else 4000.00::numeric end, 'finance_pnl ytd: 5000.00 - 1000.00 (skipped in January)');
select is((select window_start from core.finance_pnl('PKG', 'week')), pg_temp.wstart(), 'the week window starts on the most recent Saturday (New York)');
select is((select extract(dow from window_start)::int from core.finance_pnl('PKG', 'week')), 6, 'the week starts on a Saturday');
select is((select window_start || '..' || window_end from core.finance_pnl('PKG', 'mtd')), pg_temp.mstart() || '..' || pg_temp.today(), 'mtd window: first of the month to today');
select is((select window_start from core.finance_pnl('PKG', 'ytd')), pg_temp.ystart(), 'ytd window starts Jan 1 (calendar year)');
select is((select period from core.finance_pnl('PKG', 'week')), 'week', 'the period is echoed');
select is((select count(*)::int from core.finance_pnl('PKG', 'mtd')), 1, 'always exactly one row');
select ok((select as_of is not null and last_sync_at is not null and connection_status = 'active' from core.finance_pnl('PKG', 'mtd')), 'as_of, last sync and connection status are set');
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
-- report metadata: one entry per P&L start date (year, week, month, last month; they collapse when starts coincide) and ONE aging entry
-- (three nightly aging rows with different report dates), nothing from the disconnected connection or the other lane
select is((select count(*)::int from core.finance_overview('PKG') o, jsonb_array_elements(o.reports) e where coalesce(e ->> 'start_date', '9999') >= '2021'),
          (select count(*)::int from (select pg_temp.ystart() union select pg_temp.wstart() union select pg_temp.mstart() union select (pg_temp.mstart() - interval '1 month')::date) x) + 1,
          'reports: one entry per P&L start date and one aging entry (nightly duplicates do not pile up; the 2019/2020 fixtures are left out of the count)');
select is((select count(*)::int from core.finance_overview('PKG') o, jsonb_array_elements(o.reports) e where e ->> 'report' = 'ar_aging_summary'), 1, 'reports: one receivables aging entry');
select is((select e ->> 'report_date' from core.finance_overview('PKG') o, jsonb_array_elements(o.reports) e where e ->> 'report' = 'ar_aging_summary'), to_char(pg_temp.today(), 'YYYY-MM-DD'), 'reports: the newest aging report is the one listed');
select is((select count(*)::int from core.finance_overview('PKG') o, jsonb_array_elements(o.reports) e where e ->> 'report' = 'pnl' and e ->> 'start_date' = to_char(pg_temp.mstart(), 'YYYY-MM-DD')), 1, 'reports: one entry for the month (the older copy that ended on the 1st is not listed)');
select ok((select (e ->> 'as_of')::timestamptz < now() - interval '50 minutes' from core.finance_overview('PKG') o, jsonb_array_elements(o.reports) e
           where e ->> 'report' = 'pnl' and e ->> 'start_date' = to_char(pg_temp.mstart(), 'YYYY-MM-DD')), 'reports: the month entry is the current connection''s (the disconnected connection''s newer row is not listed)');
select is((select not exists (select 1 from jsonb_array_elements(reports) e where (select array_agg(k order by k) from jsonb_object_keys(e) k) <> array['as_of', 'class_filtered', 'end_date', 'method', 'report', 'report_date', 'start_date'])
           from core.finance_overview('PKG')), true, 'reports: metadata keys only');
select is((select reports::text !~ '(Rows|Sales|Software|Header|payload)' from core.finance_overview('PKG')), true, 'reports: no payload content');
reset role;

-- ---------------------------------------------------------------- cross-lane
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state from core.finance_pnl('APK', 'mtd')), 'no_access', 'another lane: finance_pnl is no_access');
select is((select pnl_net is null and pnl_income is null and window_start is null from core.finance_pnl('APK', 'mtd')), true, 'another lane: no figure');
select is((select state from core.finance_overview('APK')), 'no_access', 'another lane: finance_overview is no_access');
select is((select ar_total is null and reports = '[]'::jsonb and as_of is null from core.finance_overview('APK')), true, 'another lane: nothing at all');
select is((select count(*)::int from fin.report_cache where lane_id = 'APK'), 0, 'RLS: the owner sees no APK report rows');
select is((select pnl_net from core.finance_pnl('PKG', 'mtd')), 700.00::numeric, 'PKG never uses another lane''s month report');
reset role;
select is((select count(*)::int from fin.report_cache where lane_id = 'APK'), 2, 'fixture check: APK has report rows');

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
select throws_ok($$select * from core.finance_pnl_window('PKG', date '2020-03-01', date '2020-03-01', date '2020-03-31', null, '{}')$$, '42501', null, 'anon cannot call finance_pnl_window');
reset role;

select * from finish();
rollback;
