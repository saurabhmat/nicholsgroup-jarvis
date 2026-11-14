-- T-246: Home and Finance figures read only the lane's CURRENT QuickBooks connections (status <> 'disconnected').
-- Go-live scenario (H-061): the sandbox connection is disconnected but its invoices, bills and cached reports stay; the real company
-- is connected next. Before T-246, AR over 30 days, aging, the oldest invoices, bills due, the unmapped counts, the Finance AR total
-- and the "has data" test read every row of the lane, so the sandbox's figures were added to the real company's.
-- Covered: core.home_finance, core.home_finance_detail, core.finance_overview, core.finance_pnl (state); a disconnected connection's
-- rows are ignored; "no_data" until the current connection has data; the same rows count again if that connection is live (control);
-- privileges unchanged; denial for another lane and at AAL1. Dates are relative to today (business date) and safe on any date.
begin;
select plan(28);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code in ('APK');
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');

delete from fin.payments where lane_id in ('PKG', 'APK');
delete from fin.transactions where lane_id in ('PKG', 'APK');
delete from fin.invoices where lane_id in ('PKG', 'APK');
delete from fin.bills where lane_id in ('PKG', 'APK');
delete from fin.accounts where lane_id in ('PKG', 'APK');
delete from fin.report_cache where lane_id in ('PKG', 'APK');
delete from fin.normalize_runs where lane_id in ('PKG', 'APK');
delete from raw.source_records where lane_id in ('PKG', 'APK') and provider = 'quickbooks';
delete from core.sync_runs where connection_id in (select id from core.connections where lane_id in ('PKG', 'APK') and provider = 'quickbooks');
delete from core.connections where lane_id in ('PKG', 'APK') and provider = 'quickbooks';

create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'America/New_York')::date $$;

-- ---------------------------------------------------------------- privileges and security mode unchanged
select ok((select bool_and(has_function_privilege('authenticated', p, 'execute') and not has_function_privilege('anon', p, 'execute'))
           from unnest(array['core.home_finance(text)', 'core.home_finance_detail(text)', 'core.finance_overview(text)', 'core.finance_pnl(text, text)']::regprocedure[]) p),
          'authenticated executes the four; anon none');
select ok((select bool_and(not prosecdef and proconfig = array['search_path=""'] and provolatile = 's')
           from pg_proc where oid in ('core.home_finance(text)'::regprocedure, 'core.home_finance_detail(text)'::regprocedure,
                                      'core.finance_overview(text)'::regprocedure, 'core.finance_pnl(text, text)'::regprocedure)),
          'the four stay security invoker, stable, with an empty search_path');

-- ---------------------------------------------------------------- the sandbox (disconnected) with its rows; the real company connected
insert into core.connections (id, lane_id, provider, external_account_id, status, last_sync_at) values
  ('00000000-0000-4000-8000-000000004602', 'PKG', 'quickbooks', '8800000000462', 'disconnected', now() - interval '3 days'),
  ('00000000-0000-4000-8000-000000004601', 'PKG', 'quickbooks', '8800000000461', 'active', now() - interval '1 hour'),
  ('00000000-0000-4000-8000-000000004603', 'APK', 'quickbooks', '8800000000463', 'active', now() - interval '1 hour');
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1,
  (config - 'qbo') || jsonb_build_object('entities', jsonb_build_object('own_entity', 'PKG',
    'by_entity', jsonb_build_object('PKG', jsonb_build_object('qbo_class_ids', '[]'::jsonb, 'qbo_customer_ids', '[]'::jsonb,
                                                              'stripe_product_ids', '[]'::jsonb, 'ghl_tags', '[]'::jsonb, 'ghl_products', '[]'::jsonb)),
    'bank_accounts', '[]'::jsonb))
from core.lane_config_current where lane_id = 'PKG';

-- Sandbox rows: own-entity AR far overdue, an unmapped invoice, bills due soon (own and unmapped), a cached report.
insert into fin.invoices (lane_id, connection_id, source_id, customer_name, issue_date, due_date, total, balance, entity_code) values
  ('PKG', '00000000-0000-4000-8000-000000004602', 's-1', 'Sandbox Customer', pg_temp.today() - 260, pg_temp.today() - 200, 5281.52, 5281.52, 'PKG'),
  ('PKG', '00000000-0000-4000-8000-000000004602', 's-2', 'Sandbox Unmapped', pg_temp.today() - 100, pg_temp.today() - 60, 70.00, 70.00, 'unmapped');
insert into fin.bills (lane_id, connection_id, source_id, issue_date, due_date, total, balance, entity_code) values
  ('PKG', '00000000-0000-4000-8000-000000004602', 'sb-1', pg_temp.today() - 10, pg_temp.today() + 3, 900.00, 900.00, 'PKG'),
  ('PKG', '00000000-0000-4000-8000-000000004602', 'sb-2', pg_temp.today() - 10, pg_temp.today() + 3, 40.00, 40.00, 'unmapped');
insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at)
values ('PKG', '00000000-0000-4000-8000-000000004602', 'ar_aging_summary', jsonb_build_object('report_date', to_char(pg_temp.today() - 3, 'YYYY-MM-DD')),
        '{"Header": {}, "Rows": {"Row": []}}', now() - interval '3 days', now() - interval '3 days');
insert into fin.normalize_runs (lane_id, connection_id, class_tracking, class_fallback, counts, started_at, finished_at)
values ('PKG', '00000000-0000-4000-8000-000000004602', false, false, '{}', now() - interval '3 days 1 minute', now() - interval '3 days');

-- ================================================================ real company connected, nothing loaded yet: no_data, not the sandbox's figures
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state from core.home_finance('PKG')), 'no_data', 'home_finance: the sandbox''s rows do not count as data for the new connection');
select is((select state from core.home_finance_detail('PKG')), 'no_data', 'home_finance_detail: no_data');
select is((select state from core.finance_overview('PKG')), 'no_data', 'finance_overview: no_data');
select is((select state from core.finance_pnl('PKG', 'mtd')), 'no_data', 'finance_pnl: no_data');
reset role;

-- ================================================================ the real company normalized, no invoices yet (the sandbox has some)
insert into fin.normalize_runs (lane_id, connection_id, class_tracking, class_fallback, counts, started_at, finished_at)
values ('PKG', '00000000-0000-4000-8000-000000004601', false, false, '{}', now() - interval '61 minutes', now() - interval '1 hour');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state || '/' || ar_reason from core.home_finance('PKG')), 'ok/no_invoices',
          'home_finance: the current connection has no invoices; the sandbox''s invoices do not count (no_invoices)');
reset role;

-- ================================================================ the real company's rows arrive
insert into fin.invoices (lane_id, connection_id, source_id, customer_name, issue_date, due_date, total, balance, entity_code) values
  ('PKG', '00000000-0000-4000-8000-000000004601', 'r-1', 'Real Current', pg_temp.today() - 20, pg_temp.today() + 5, 10.50, 10.50, 'PKG'),
  ('PKG', '00000000-0000-4000-8000-000000004601', 'r-2', 'Real Overdue', pg_temp.today() - 75, pg_temp.today() - 45, 200.25, 200.25, 'PKG');
insert into fin.bills (lane_id, connection_id, source_id, issue_date, due_date, total, balance, entity_code) values
  ('PKG', '00000000-0000-4000-8000-000000004601', 'rb-1', pg_temp.today() - 5, pg_temp.today() + 7, 50.00, 50.00, 'PKG');
-- APK (another lane) with its own overdue invoice.
insert into fin.invoices (lane_id, connection_id, source_id, customer_name, issue_date, due_date, total, balance, entity_code) values
  ('APK', '00000000-0000-4000-8000-000000004603', 'a-1', 'Other Lane', pg_temp.today() - 90, pg_temp.today() - 60, 777.00, 777.00, 'APK');

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state from core.home_finance('PKG')), 'ok', 'home_finance: ok once the current connection has data');
select is((select ar_over_30 from core.home_finance('PKG')), 200.25::numeric, 'home_finance: AR over 30 days is the real company''s only (not + 5,281.52 from the sandbox)');
select is((select ar_invoices from core.home_finance('PKG')), 1, 'home_finance: one invoice over 30 days');
select is((select ar_unmapped from core.home_finance('PKG')), 0, 'home_finance: the sandbox''s unmapped invoice is not counted');
select is((select bills_due_14_total from core.home_finance_detail('PKG')), 50.00::numeric, 'detail: bills due in 14 days are the real company''s only');
select is((select bills_due_14_count from core.home_finance_detail('PKG')), 1, 'detail: one bill due');
select is((select unmapped_bills from core.home_finance_detail('PKG')), 0, 'detail: the sandbox''s unmapped bill is not counted');
select is((select unmapped_invoices from core.home_finance_detail('PKG')), 0, 'detail: the sandbox''s unmapped invoice is not counted');
select is((select (select sum((a.j ->> 'total')::numeric) from jsonb_array_elements(aging) a(j)) from core.home_finance_detail('PKG')), 210.75::numeric,
          'detail: the aging buckets add up to the real company''s open AR');
select is((select (select (a.j ->> 'total')::numeric from jsonb_array_elements(aging) a(j) where a.j ->> 'bucket' = '90_plus') from core.home_finance_detail('PKG')), 0.00::numeric,
          'detail: nothing in 90+ (the sandbox''s 200-day invoice is gone)');
select is((select jsonb_agg(o.j ->> 'customer') from core.home_finance_detail('PKG'), jsonb_array_elements(oldest) o(j)), '["Real Overdue"]'::jsonb,
          'detail: the oldest invoices are the real company''s');
select is((select ar_total from core.finance_overview('PKG')), 210.75::numeric, 'finance_overview: the AR total is the real company''s and equals the aging total');
select is((select ar_invoices from core.finance_overview('PKG')), 2, 'finance_overview: two open invoices');
select is((select unmapped_bills_open from core.finance_overview('PKG')), 0, 'finance_overview: the sandbox''s unmapped bill is not counted');
select is((select jsonb_array_length(reports) from core.finance_overview('PKG')), 0, 'finance_overview: the sandbox''s cached report is not listed');
reset role;

-- ================================================================ denial: another lane, AAL1
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state from core.home_finance_detail('APK')), 'no_access', 'cross-lane: another lane''s detail is not readable');
select is((select ar_total from core.finance_overview('APK')), null::numeric, 'cross-lane: no AR total for another lane');
reset role;
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select state from core.home_finance_detail('PKG')), 'no_access', 'AAL1: no detail');
select is((select ar_over_30 from core.home_finance('PKG')), null::numeric, 'AAL1: no AR figure');
reset role;

-- ================================================================ control: the filter is the connection status, not the rows
-- Any status other than disconnected counts as current: a sandbox left in reconnect_required (not disconnected) would add its AR.
-- That is why golive-0 must reach 'disconnected' (and golive-1 refuses otherwise).
update core.connections set status = 'reconnect_required' where id = '00000000-0000-4000-8000-000000004602';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select ar_over_30 from core.home_finance('PKG')), 5481.77::numeric, 'control: a sandbox in reconnect_required still counts (it must be disconnected)');
reset role;
-- Every QuickBooks connection disconnected: not_connected, no figures from anyone's rows.
update core.connections set status = 'disconnected' where lane_id = 'PKG' and provider = 'quickbooks';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state || '/' || coalesce(ar_over_30::text, 'null') from core.home_finance('PKG')), 'not_connected/null', 'all disconnected: not_connected and no AR figure');
reset role;

select * from finish();
rollback;
