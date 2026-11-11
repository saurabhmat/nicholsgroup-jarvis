-- Home finance reads (T-233): core.home_finance_context and core.home_finance.
-- Covered: privileges and security mode, states (not_connected, no_data, mapping_missing, ok, no_access), AR over 30 days
-- (boundary, voided/deleted/zero/foreign-currency/other-entity/unmapped invoices, no due date), cash book balance per bank
-- account owned by the lane's own entity (D-18: other owners left out, unmapped counted not summed, shared flagged,
-- class-filtered balance sheet refused, latest report wins), P&L month to date (YTD report is not MTD, class split
-- required, group sums, payroll-partial flag, unreadable figure), the "book balance" key names, and denial: another lane
-- (rows exist, caller is not a member), AAL1, admin_technical (no finance view), outsider, anon.
begin;
select plan(64);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code in ('APK', 'NC');
-- The owner is a member of APK in the seed; drop that so APK is a lane the owner may NOT see (cross-lane denial).
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');

-- Start from no QuickBooks data in PKG, APK and NC (a developer's own synced rows are removed inside this transaction only).
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
select ok(has_function_privilege('authenticated', 'core.home_finance(text)', 'execute')
          and has_function_privilege('authenticated', 'core.home_finance_context(text)', 'execute'), 'authenticated executes both');
select ok(not has_function_privilege('anon', 'core.home_finance(text)', 'execute')
          and not has_function_privilege('anon', 'core.home_finance_context(text)', 'execute'), 'anon executes neither');
select ok((select not prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = 'core.home_finance(text)'::regprocedure),
          'home_finance is security invoker with an empty search_path');
select ok((select prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = 'core.home_finance_context(text)'::regprocedure),
          'home_finance_context is security definer with an empty search_path');
select ok(not exists (select 1 from unnest((select proargnames from pg_proc where oid = 'core.home_finance(text)'::regprocedure)) n where n ~* 'bank'),
          'no output column is named like a bank balance (cash is "book balance": cash_total / book_balance)');

-- ---------------------------------------------------------------- not connected (NC: owner sees it, no QuickBooks connection)
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state from core.home_finance('NC')), 'not_connected', 'a lane without a QuickBooks connection is not_connected');
select is((select cash_total is null and ar_over_30 is null and pnl_net is null from core.home_finance('NC')), true, 'not_connected: no figures');
select is((select count(*)::int from core.home_finance('NC')), 1, 'always exactly one row');
select throws_ok($$select * from core.home_finance(null)$$, '22004', null, 'a lane is required');
reset role;

-- ---------------------------------------------------------------- connected, nothing synced yet
insert into core.connections (id, lane_id, provider, external_account_id, status, last_sync_at) values
  ('00000000-0000-4000-8000-000000003001', 'PKG', 'quickbooks', '8800000000231', 'active', now() - interval '2 hours'),
  ('00000000-0000-4000-8000-000000003002', 'APK', 'quickbooks', '8800000000232', 'active', now() - interval '1 hour');

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state from core.home_finance('PKG')), 'no_data', 'connected but nothing synced: no_data');
select is((select connection_status from core.home_finance('PKG')), 'active', 'the connection status is reported');
select ok((select as_of is not null and as_of = last_sync_at from core.home_finance('PKG')), 'no_data: as_of is the last sync');
reset role;

-- ---------------------------------------------------------------- mapping missing: no entities in the lane config
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, config - 'entities' from core.lane_config_current where lane_id = 'PKG';
insert into fin.normalize_runs (lane_id, connection_id, class_tracking, class_fallback, counts, started_at, finished_at)
values ('PKG', '00000000-0000-4000-8000-000000003001', true, false, '{}', now() - interval '3 hours', now() - interval '2 hours 59 minutes');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state from core.home_finance('PKG')), 'mapping_missing', 'no entity mapping in the lane config: mapping_missing');
reset role;

-- The mapping is back: own entity PKG, class split, four bank accounts (one listed under two owners = shared).
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1,
  config || jsonb_build_object('entities', jsonb_build_object(
    'own_entity', 'PKG',
    'by_entity', jsonb_build_object('PKG', jsonb_build_object('qbo_class_ids', jsonb_build_array('class-synthetic-pkg'), 'qbo_customer_ids', '[]'::jsonb,
                                                              'stripe_product_ids', '[]'::jsonb, 'ghl_tags', '[]'::jsonb, 'ghl_products', '[]'::jsonb)),
    'bank_accounts', jsonb_build_array(
      jsonb_build_object('qbo_account_id', 'bank-synthetic-1', 'owner_entity', 'PKG'),
      jsonb_build_object('qbo_account_id', 'bank-synthetic-2', 'owner_entity', 'APK'),
      jsonb_build_object('qbo_account_id', 'bank-synthetic-3', 'owner_entity', 'PKG'),
      jsonb_build_object('qbo_account_id', 'bank-synthetic-4', 'owner_entity', 'PKG'),
      jsonb_build_object('qbo_account_id', 'bank-synthetic-4', 'owner_entity', 'APK'))))
from core.lane_config_current where lane_id = 'PKG';

-- Invoices (today's New York date is the business date). PKG own entity: 100.00 (45 d), 50.25 (31 d), 10.00 (no due date, issued 40 d ago).
-- Not counted: exactly 30 d, zero balance, voided, deleted, CAD, other entity, unmapped (counted separately).
create function pg_temp.d(p_days int) returns date language sql as $$ select ((now() at time zone 'America/New_York')::date - p_days) $$;
insert into fin.invoices (lane_id, connection_id, source_id, issue_date, due_date, total, balance, entity_code, voided, deleted, currency_code) values
  ('PKG', '00000000-0000-4000-8000-000000003001', 'i-a', pg_temp.d(90), pg_temp.d(45), 100.00, 100.00, 'PKG', false, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000003001', 'i-b', pg_temp.d(90), pg_temp.d(31), 80.00, 50.25, 'PKG', false, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000003001', 'i-c', pg_temp.d(90), pg_temp.d(30), 70.00, 70.00, 'PKG', false, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000003001', 'i-d', pg_temp.d(120), pg_temp.d(90), 90.00, 0.00, 'PKG', false, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000003001', 'i-e', pg_temp.d(120), pg_temp.d(90), 500.00, 500.00, 'PKG', true, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000003001', 'i-f', pg_temp.d(120), pg_temp.d(90), 600.00, 600.00, 'PKG', false, true, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000003001', 'i-g', pg_temp.d(120), pg_temp.d(90), 900.00, 900.00, 'PKG', false, false, 'CAD'),
  ('PKG', '00000000-0000-4000-8000-000000003001', 'i-h', pg_temp.d(40), null, 10.00, 10.00, 'PKG', false, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000003001', 'i-i', pg_temp.d(120), pg_temp.d(90), 33.00, 33.00, 'unmapped', false, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000003001', 'i-j', pg_temp.d(120), pg_temp.d(90), 1000.00, 1000.00, 'APK', false, false, 'USD'),
  ('APK', '00000000-0000-4000-8000-000000003002', 'a-1', pg_temp.d(120), pg_temp.d(90), 7777.00, 7777.00, 'PKG', false, false, 'USD');

-- Bank accounts: account 4's ledger activity is attributed to APK elsewhere? No: 3 is attributed to APK (shared by activity).
insert into fin.accounts (lane_id, connection_id, source_id, name, type, is_bank, entity_code, owner_entity_code) values
  ('PKG', '00000000-0000-4000-8000-000000003001', 'bank-synthetic-1', 'Operating', 'Bank', true, 'PKG', 'PKG'),
  ('PKG', '00000000-0000-4000-8000-000000003001', 'bank-synthetic-3', 'Reserve', 'Bank', true, 'APK', 'PKG');

-- Balance sheets. An older PKG report with other figures (must not be used), the current one, and APK's.
create function pg_temp.bs(p_rows jsonb) returns jsonb language sql as $$
  select jsonb_build_object('Header', jsonb_build_object('ReportName', 'BalanceSheet', 'TotalsWithheld', 'false'),
    'Columns', jsonb_build_object('Column', '[]'::jsonb), 'Rows', jsonb_build_object('Row', p_rows))
$$;
create function pg_temp.bank(p_id text, p_name text, p_value text) returns jsonb language sql as $$
  select jsonb_build_object('type', 'Data', 'level', 2, 'group', 'BankAccounts',
    'ColData', jsonb_build_array(jsonb_build_object('value', p_name, 'id', p_id), jsonb_build_object('value', p_value)))
$$;
insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at) values
  ('PKG', '00000000-0000-4000-8000-000000003001', 'balance_sheet', '{"start_date":"2026-01-01","end_date":"2026-11-01"}',
   pg_temp.bs(jsonb_build_array(pg_temp.bank('bank-synthetic-1', 'Operating', '1.00'))), now() - interval '3 days', now() - interval '3 days'),
  ('PKG', '00000000-0000-4000-8000-000000003001', 'balance_sheet', '{"start_date":"2026-01-01","end_date":"2026-11-10"}',
   pg_temp.bs(jsonb_build_array(
     pg_temp.bank('bank-synthetic-1', 'Operating', '1234.56'),
     pg_temp.bank('bank-synthetic-2', 'Other company account', '999.00'),
     pg_temp.bank('bank-synthetic-3', 'Reserve', '-20.00'),
     pg_temp.bank('bank-synthetic-4', 'Shared account', '100.10'),
     pg_temp.bank('bank-synthetic-9', 'Not in any mapping', '5.00'),
     jsonb_build_object('type', 'Data', 'level', 2, 'group', 'OtherCurrentAssets',
       'ColData', jsonb_build_array(jsonb_build_object('value', 'Not a bank account', 'id', 'bank-synthetic-1'), jsonb_build_object('value', '88888.00'))))),
   now() - interval '1 day', now() - interval '1 day'),
  ('APK', '00000000-0000-4000-8000-000000003002', 'balance_sheet', '{"start_date":"2026-01-01","end_date":"2026-11-10"}',
   pg_temp.bs(jsonb_build_array(pg_temp.bank('bank-synthetic-1', 'Operating', '5555555.00'))), now(), now());

-- ---------------------------------------------------------------- owner, aal2, own lane: ok
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;

select is((select state from core.home_finance('PKG')), 'ok', 'connected, mapped and synced: ok');
select ok((select as_of is not null and as_of < now() - interval '2 hours 50 minutes' and as_of > now() - interval '3 hours 10 minutes' from core.home_finance('PKG')),
          'as_of is the last normalizer run');
select is((select business_date from core.home_finance('PKG')), (now() at time zone 'America/New_York')::date, 'the business date is the New York date');

-- AR over 30 days
select is((select ar_over_30 from core.home_finance('PKG')), 160.25::numeric, 'AR > 30: 100.00 + 50.25 + 10.00 (exactly 30 days, zero, voided, deleted, CAD, other entity and unmapped left out)');
select is((select ar_invoices from core.home_finance('PKG')), 3, 'AR > 30: three invoices');
select is((select ar_unmapped from core.home_finance('PKG')), 1, 'AR > 30: one overdue invoice has no entity and is counted, not summed');
select is((select ar_reason from core.home_finance('PKG')), null, 'AR > 30: no reason when present');

-- Cash
select is((select cash_total from core.home_finance('PKG')), 1314.66::numeric, 'cash: own-entity accounts 1234.56 - 20.00 + 100.10 (other owner and unmapped left out, older report ignored)');
select is((select jsonb_array_length(cash_accounts) from core.home_finance('PKG')), 3, 'cash: three accounts listed, each in full');
select is((select (cash_accounts -> 0 ->> 'name') || ':' || (cash_accounts -> 0 ->> 'book_balance') from core.home_finance('PKG')), 'Operating:1234.56', 'cash: per-account book balance, ordered by name');
select is((select (select a ->> 'shared' from jsonb_array_elements(cash_accounts) a where a ->> 'name' = 'Shared account') from core.home_finance('PKG')), 'true',
          'cash: an account listed under two owners is flagged shared');
select is((select (select a ->> 'shared' from jsonb_array_elements(cash_accounts) a where a ->> 'name' = 'Reserve') from core.home_finance('PKG')), 'true',
          'cash: an account whose ledger activity is attributed to another entity is flagged shared');
select is((select (select a ->> 'shared' from jsonb_array_elements(cash_accounts) a where a ->> 'name' = 'Operating') from core.home_finance('PKG')), 'false', 'cash: a plain account is not shared');
select is((select cash_unmapped from core.home_finance('PKG')), 1, 'cash: a bank account in no mapping is counted, never allocated');
select ok((select cash_as_of > now() - interval '1 day 1 hour' and cash_as_of < now() - interval '23 hours' from core.home_finance('PKG')), 'cash: as_of is the balance sheet''s');
select is((select cash_accounts::text !~ '88888' from core.home_finance('PKG')), true, 'cash: rows outside the Bank Accounts group are not read');

-- P&L month to date: nothing cached for the month yet
select is((select pnl_reason from core.home_finance('PKG')), 'month_report_not_cached', 'P&L: no month report cached, nothing is derived');
select is((select pnl_net is null and pnl_income is null from core.home_finance('PKG')), true, 'P&L: no figures without a month report');
reset role;

-- A year-to-date report is not month to date; a month report without the class split is refused (file_class mode).
create function pg_temp.pl(p_rows jsonb, p_withheld text default 'false') returns jsonb language sql as $$
  select jsonb_build_object('Header', jsonb_build_object('ReportName', 'ProfitAndLoss', 'TotalsWithheld', p_withheld),
    'Columns', jsonb_build_object('Column', '[]'::jsonb), 'Rows', jsonb_build_object('Row', p_rows))
$$;
create function pg_temp.line(p_group text, p_type text, p_name text, p_value text) returns jsonb language sql as $$
  select jsonb_build_object('type', p_type, 'level', 1, 'group', p_group,
    'ColData', jsonb_build_array(jsonb_build_object('value', p_name), jsonb_build_object('value', p_value)))
$$;
create function pg_temp.mstart() returns text language sql as $$ select to_char(date_trunc('month', now() at time zone 'America/New_York'), 'YYYY-MM-DD') $$;
create function pg_temp.today() returns text language sql as $$ select to_char(now() at time zone 'America/New_York', 'YYYY-MM-DD') $$;

insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at) values
  ('PKG', '00000000-0000-4000-8000-000000003001', 'pnl', jsonb_build_object('start_date', to_char(date_trunc('year', now() at time zone 'America/New_York'), 'YYYY-MM-DD'), 'end_date', pg_temp.today(), 'method', 'accrual', 'class', 'class-synthetic-pkg'),
   pg_temp.pl(jsonb_build_array(pg_temp.line('Income', 'Data', 'Sales', '90000.00'))), now() - interval '1 hour', now() - interval '1 hour'),
  ('PKG', '00000000-0000-4000-8000-000000003001', 'pnl', jsonb_build_object('start_date', pg_temp.mstart(), 'end_date', pg_temp.today(), 'method', 'accrual'),
   pg_temp.pl(jsonb_build_array(pg_temp.line('Income', 'Data', 'Sales', '77777.00'))), now() - interval '50 minutes', now() - interval '50 minutes');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select pnl_reason from core.home_finance('PKG')), 'report_not_split_by_class', 'P&L: a month report that is not class-filtered is refused when entities split by class');
reset role;

insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at) values
  ('PKG', '00000000-0000-4000-8000-000000003001', 'pnl', jsonb_build_object('start_date', pg_temp.mstart(), 'end_date', pg_temp.today(), 'method', 'accrual', 'class', 'class-synthetic-pkg'),
   pg_temp.pl(jsonb_build_array(
     pg_temp.line('Income', 'Data', 'Subscriptions', '1000.00'),
     pg_temp.line('Income', 'Data', 'Services', '250.50'),
     pg_temp.line('Income', 'Summary', 'Total Income', '9999.00'),
     pg_temp.line('OtherIncome', 'Data', 'Interest', '10.00'),
     pg_temp.line('COGS', 'Data', 'Hosting', '100.00'),
     pg_temp.line('Expenses', 'Data', 'Software', '400.25'),
     pg_temp.line('OtherExpenses', 'Data', 'Fees', '5.00'),
     pg_temp.line('Expenses', 'Summary', 'Total Expenses', '8888.00'))), now() - interval '10 minutes', now() - interval '10 minutes');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select pnl_reason from core.home_finance('PKG')), null, 'P&L: present with a class-filtered month report');
select is((select pnl_income from core.home_finance('PKG')), 1260.50::numeric, 'P&L: income = Income + OtherIncome leaf rows (Summary rows ignored)');
select is((select pnl_expenses from core.home_finance('PKG')), 505.25::numeric, 'P&L: expenses = COGS + Expenses + OtherExpenses leaf rows');
select is((select pnl_net from core.home_finance('PKG')), 755.25::numeric, 'P&L: net = income - expenses');
select is((select pnl_start from core.home_finance('PKG')), (pg_temp.mstart())::date, 'P&L: starts on the 1st of the business month');
select is((select pnl_method from core.home_finance('PKG')), 'accrual', 'P&L: accounting method is reported');
select is((select pnl_partial from core.home_finance('PKG')), false, 'P&L: not partial when totals were not withheld');
reset role;

insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at) values
  ('PKG', '00000000-0000-4000-8000-000000003001', 'pnl', jsonb_build_object('start_date', pg_temp.mstart(), 'end_date', pg_temp.today(), 'method', 'cash', 'class', 'class-synthetic-pkg'),
   pg_temp.pl(jsonb_build_array(pg_temp.line('Income', 'Data', 'Subscriptions', '10.00')), 'true'), now() - interval '5 minutes', now() - interval '5 minutes');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select pnl_partial from core.home_finance('PKG')), true, 'P&L: partial (payroll withheld, D-25) is flagged');
select is((select pnl_method || ':' || pnl_net::text from core.home_finance('PKG')), 'cash:10.00', 'P&L: the newest month report wins');
reset role;

insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at) values
  ('PKG', '00000000-0000-4000-8000-000000003001', 'pnl', jsonb_build_object('start_date', pg_temp.mstart(), 'end_date', pg_temp.today(), 'method', 'cash', 'class', 'class-synthetic-pkg', 'x', '1'),
   pg_temp.pl(jsonb_build_array(pg_temp.line('Income', 'Data', 'Subscriptions', 'n/a'))), now() - interval '1 minute', now() - interval '1 minute');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select pnl_reason from core.home_finance('PKG')), 'figure_unreadable', 'P&L: an unreadable figure gives a reason, not a guess');
reset role;

-- A class-filtered balance sheet is not a book balance: refused.
insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at) values
  ('PKG', '00000000-0000-4000-8000-000000003001', 'balance_sheet', '{"start_date":"2026-01-01","end_date":"2026-11-11","class":"class-synthetic-pkg"}',
   pg_temp.bs(jsonb_build_array(pg_temp.bank('bank-synthetic-1', 'Operating', '42.00'))), now(), now());
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select cash_reason from core.home_finance('PKG')), 'balance_sheet_class_filtered', 'cash: a class-filtered balance sheet is refused');
select is((select cash_total is null and jsonb_array_length(cash_accounts) = 0 from core.home_finance('PKG')), true, 'cash: refused means no figure and no accounts');
reset role;
delete from fin.report_cache where lane_id = 'PKG' and report = 'balance_sheet' and params ? 'class';

-- No bank-account mapping: cash is not guessed.
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{entities,bank_accounts}', '[]'::jsonb) from core.lane_config_current where lane_id = 'PKG';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select cash_reason from core.home_finance('PKG')), 'bank_mapping_missing', 'cash: no bank-account mapping gives a reason');
select is((select ar_over_30 from core.home_finance('PKG')), 160.25::numeric, 'the other figures are unaffected');
reset role;

-- ---------------------------------------------------------------- other roles in the lane
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select state from core.home_finance('PKG')), 'ok', 'a viewer with the finance view reads the figures (config and connections read through the definer helper)');
select is((select ar_over_30 from core.home_finance('PKG')), 160.25::numeric, 'viewer: AR > 30');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select ar_over_30 from core.home_finance('PKG')), 160.25::numeric, 'finance_operator: AR > 30');
reset role;

-- ---------------------------------------------------------------- cross-lane: APK rows exist, the owner is not an APK member
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state from core.home_finance('APK')), 'no_access', 'another lane: no_access');
select is((select cash_total is null and ar_over_30 is null and pnl_net is null and jsonb_array_length(cash_accounts) = 0 and as_of is null and connection_status is null
           from core.home_finance('APK')), true, 'another lane: no figure, no as_of, nothing about its connection');
select is((select allowed from core.home_finance_context('APK')), false, 'another lane: the context helper says not allowed');
select is((select connected is false and own_entity is null and bank_accounts = '[]'::jsonb from core.home_finance_context('APK')), true, 'another lane: the context helper returns nothing of the lane');
select is((select ar_over_30 from core.home_finance('PKG')), 160.25::numeric, 'PKG''s figures never include the other lane''s 7777.00 invoice');
select is((select cash_total from core.home_finance('PKG')) is null, true, 'PKG cash (mapping removed above) never shows the other lane''s balance sheet');
reset role;
-- The APK fixture is real: without RLS it is there.
select is((select sum(balance) from fin.invoices where lane_id = 'APK'), 7777.00::numeric, 'fixture check: APK has an overdue invoice');
select is((select count(*)::int from fin.report_cache where lane_id = 'APK' and report = 'balance_sheet'), 1, 'fixture check: APK has a balance sheet');

-- ---------------------------------------------------------------- AAL1, admin_technical, outsider, anon
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select state from core.home_finance('PKG')), 'no_access', 'AAL1: no_access even for the owner');
select is((select ar_over_30 is null from core.home_finance('PKG')), true, 'AAL1: no figures');
reset role;

select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select state from core.home_finance('PKG')), 'no_access', 'admin_technical (no finance view): no_access');
select is((select allowed from core.home_finance_context('PKG')), false, 'admin_technical: the context helper says not allowed');
reset role;

select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select state from core.home_finance('PKG')), 'no_access', 'an outsider: no_access');
reset role;

set local role anon;
select throws_ok($$select * from core.home_finance('PKG')$$, '42501', null, 'anon cannot call home_finance');
select throws_ok($$select * from core.home_finance_context('PKG')$$, '42501', null, 'anon cannot call home_finance_context');
reset role;

select * from finish();
rollback;
