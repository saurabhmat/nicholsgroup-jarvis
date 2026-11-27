-- T-300, T-301: core.finance_receivables, core.finance_weekly, core.finance_week_detail (spec finance.md section 15).
-- Covered: privileges and security mode; the bucket totals EQUAL core.home_finance_detail's aging (same open set) and the figures are
-- right to the cent per customer; the exclusions (voided, deleted, zero balance, other entity, other currency, a disconnected
-- connection, another lane); the caps are stated; the QuickBooks AgedReceivables check line (comparable, withheld, older than the data,
-- not cached); the weeks (Saturday to Friday, New York): a Friday and a Saturday invoice, a Friday 23:30 New York payment (a Saturday
-- in UTC), one payment with two rows counted once with the sum of both rows, the current week to date (nothing after today), a week
-- outside the range; the week detail (invalid dates, caps); denial: another lane, AAL1, no finance view, anon, bad arguments.
-- Dates are relative to today (business date) and safe on any day of the week.
begin;
select plan(118);
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
-- The Saturday that starts the current business week.
create function pg_temp.cur() returns date language sql as $$ select pg_temp.today() - ((extract(dow from pg_temp.today())::int + 1) % 7) $$;
-- A QuickBooks TxnDate as the normalizer stores it: that date at 00:00 America/New_York.
create function pg_temp.at_ny(p date) returns timestamptz language sql as $$ select p::timestamp at time zone 'America/New_York' $$;

-- ---------------------------------------------------------------- privileges and security mode
select ok((select bool_and(has_function_privilege('authenticated', p, 'execute') and has_function_privilege('service_role', p, 'execute') and not has_function_privilege('anon', p, 'execute'))
           from unnest(array['core.finance_receivables(text)', 'core.finance_weekly(text, integer)', 'core.finance_week_detail(text, date, integer)']::regprocedure[]) p),
          'authenticated and service_role execute the three; anon none');
select ok((select bool_and(not prosecdef and proconfig = array['search_path=""'] and provolatile = 's')
           from pg_proc where oid in ('core.finance_receivables(text)'::regprocedure, 'core.finance_weekly(text, integer)'::regprocedure,
                                      'core.finance_week_detail(text, date, integer)'::regprocedure)),
          'the three are security invoker, stable, with an empty search_path');

select ok((select prosecdef and proconfig = array['search_path=""'] and provolatile = 's' and has_function_privilege('authenticated', oid, 'execute') and not has_function_privilege('anon', oid, 'execute')
            from pg_proc where oid = 'core.finance_report_weeks(text)'::regprocedure),
          'finance_report_weeks is the one definer: empty search_path, authenticated only');

-- ---------------------------------------------------------------- connections and mapping
insert into core.connections (id, lane_id, provider, external_account_id, status, last_sync_at) values
  ('00000000-0000-4000-8000-000000005102', 'PKG', 'quickbooks', '8800000000512', 'disconnected', now() - interval '3 days'),
  ('00000000-0000-4000-8000-000000005101', 'PKG', 'quickbooks', '8800000000511', 'active', now() - interval '1 hour'),
  ('00000000-0000-4000-8000-000000005103', 'APK', 'quickbooks', '8800000000513', 'active', now() - interval '1 hour');
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1,
  (config - 'qbo') || jsonb_build_object('entities', jsonb_build_object('own_entity', 'PKG',
    'by_entity', jsonb_build_object('PKG', jsonb_build_object('qbo_class_ids', '[]'::jsonb, 'qbo_customer_ids', '[]'::jsonb,
                                                              'stripe_product_ids', '[]'::jsonb, 'ghl_tags', '[]'::jsonb, 'ghl_products', '[]'::jsonb)),
    'bank_accounts', '[]'::jsonb))
from core.lane_config_current where lane_id = 'PKG';

-- Not connected yet / no data yet: the states, never a figure.
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state from core.finance_receivables('PKG')), 'no_data', 'receivables: the current connection has nothing yet (no_data)');
select is((select state from core.finance_weekly('PKG', 4)), 'no_data', 'weekly: no_data');
select is((select state from core.finance_week_detail('PKG', pg_temp.cur(), 4)), 'no_data', 'week detail: no_data');
reset role;
insert into fin.normalize_runs (lane_id, connection_id, class_tracking, class_fallback, counts, started_at, finished_at)
values ('PKG', '00000000-0000-4000-8000-000000005101', false, false, '{"dead_invoices_sensitive": 0}', now() - interval '61 minutes', now() - interval '1 hour');

-- ================================================================ aged AR
-- Open own-entity invoices (current connection): Alpha (C1) 100.10 at 95 days and 200.20 at 40 days; Beta (C2) 50.05 not yet due and
-- 10.00 with no due date issued 45 days ago (the issue date is used: 31-60); one with no customer 1.01 due today (current).
insert into fin.invoices (lane_id, connection_id, source_id, customer_id, customer_name, issue_date, due_date, total, balance, entity_code, voided, deleted, currency_code) values
  ('PKG', '00000000-0000-4000-8000-000000005101', 'a1', '101', 'Alpha Co', pg_temp.today() - 100, pg_temp.today() - 95, 100.10, 100.10, 'PKG', false, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000005101', 'a2', '101', 'Alpha Co', pg_temp.today() - 50, pg_temp.today() - 40, 200.20, 200.20, 'PKG', false, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000005101', 'a3', '102', 'Beta Co', pg_temp.today() - 10, pg_temp.today() + 5, 50.05, 50.05, 'PKG', false, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000005101', 'a4', '102', 'Beta Co', pg_temp.today() - 45, null, 10.00, 10.00, 'PKG', false, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000005101', 'a5', null, null, pg_temp.today() - 3, pg_temp.today(), 1.01, 1.01, 'PKG', false, false, 'USD'),
-- left out: voided, deleted, nothing owed, another entity, another currency
  ('PKG', '00000000-0000-4000-8000-000000005101', 'x1', '103', 'Voided Co', pg_temp.today() - 40, pg_temp.today() - 30, 999.00, 999.00, 'PKG', true, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000005101', 'x2', '104', 'Deleted Co', pg_temp.today() - 40, pg_temp.today() - 30, 998.00, 998.00, 'PKG', false, true, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000005101', 'x3', '105', 'Paid Co', pg_temp.today() - 40, pg_temp.today() - 30, 997.00, 0, 'PKG', false, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000005101', 'x4', '106', 'Unmapped Co', pg_temp.today() - 40, pg_temp.today() - 30, 996.00, 996.00, 'unmapped', false, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000005101', 'x5', '107', 'Euro Co', pg_temp.today() - 40, pg_temp.today() - 30, 995.00, 995.00, 'PKG', false, false, 'EUR'),
-- the disconnected (sandbox) connection and another lane
  ('PKG', '00000000-0000-4000-8000-000000005102', 's1', '108', 'Sandbox Co', pg_temp.today() - 260, pg_temp.today() - 200, 5281.52, 5281.52, 'PKG', false, false, 'USD'),
  ('APK', '00000000-0000-4000-8000-000000005103', 'k1', '109', 'Other Lane Co', pg_temp.today() - 90, pg_temp.today() - 60, 777.00, 777.00, 'APK', false, false, 'USD');

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state from core.finance_receivables('PKG')), 'ok', 'receivables: ok');
select is((select total from core.finance_receivables('PKG')), 361.36::numeric, 'receivables: the open total is 361.36 to the cent (exclusions and the sandbox are not in it)');
select is((select invoice_count from core.finance_receivables('PKG')), 5, 'receivables: five open invoices');
select is((select jsonb_agg(b.j order by b.o) from core.finance_receivables('PKG'), jsonb_array_elements(buckets) with ordinality b(j, o)),
          (select jsonb_agg(a.j order by a.o) from core.home_finance_detail('PKG'), jsonb_array_elements(aging) with ordinality a(j, o)),
          'receivables: the bucket totals and counts EQUAL the Overview aging (home_finance_detail), bucket by bucket');
select is((select (select jsonb_agg((b.j ->> 'bucket') || '=' || (b.j ->> 'total') || '/' || (b.j ->> 'count') order by b.o) from jsonb_array_elements(buckets) with ordinality b(j, o)) from core.finance_receivables('PKG')),
          '["current=51.06/2", "1_30=0.00/0", "31_60=210.20/2", "61_90=0.00/0", "90_plus=100.10/1"]'::jsonb,
          'receivables: current (not yet due, due today, ...) 51.06, 31-60 210.20 (the no-due-date invoice by its issue date), 90+ 100.10');
select is((select total from core.finance_receivables('PKG')), (select ar_total from core.finance_overview('PKG')), 'receivables: the total equals the Finance overview AR total');
select is((select connection_status from core.finance_receivables('PKG')), 'active', 'receivables: the connection status of the current connection (for the page note)');
select is((select last_sync_at is not null from core.finance_receivables('PKG')), true, 'receivables: the last sync');
select is((select customer_count from core.finance_receivables('PKG')), 3, 'receivables: three customer rows');
select is((select (select jsonb_agg(c.j ->> 'name' order by c.o) from jsonb_array_elements(customers) with ordinality c(j, o)) from core.finance_receivables('PKG')),
          '["Alpha Co", "Beta Co", null]'::jsonb, 'receivables: customers by total descending; no stored name is null (the page says Unknown customer)');
select is((select (c.j ->> 'total')::numeric from core.finance_receivables('PKG'), jsonb_array_elements(customers) c(j) where c.j ->> 'name' = 'Alpha Co'), 300.30::numeric, 'receivables: Alpha total 300.30');
select is((select (c.j ->> '90_plus')::numeric from core.finance_receivables('PKG'), jsonb_array_elements(customers) c(j) where c.j ->> 'name' = 'Alpha Co'), 100.10::numeric, 'receivables: Alpha 90+ 100.10');
select is((select (c.j ->> '31_60')::numeric from core.finance_receivables('PKG'), jsonb_array_elements(customers) c(j) where c.j ->> 'name' = 'Alpha Co'), 200.20::numeric, 'receivables: Alpha 31-60 200.20');
select is((select (c.j ->> 'current')::numeric from core.finance_receivables('PKG'), jsonb_array_elements(customers) c(j) where c.j ->> 'name' = 'Beta Co'), 50.05::numeric, 'receivables: Beta current 50.05');
select is((select (c.j ->> '31_60')::numeric from core.finance_receivables('PKG'), jsonb_array_elements(customers) c(j) where c.j ->> 'name' = 'Beta Co'), 10.00::numeric, 'receivables: Beta 31-60 10.00');
select is((select (c.j ->> 'invoices')::int from core.finance_receivables('PKG'), jsonb_array_elements(customers) c(j) where c.j ->> 'name' = 'Alpha Co'), 2, 'receivables: Alpha has two open invoices');
select is((select (select jsonb_agg((d.j ->> 'days_overdue') || '/' || (d.j ->> 'balance') order by d.o) from jsonb_array_elements(c.j -> 'detail') with ordinality d(j, o))
           from core.finance_receivables('PKG'), jsonb_array_elements(customers) c(j) where c.j ->> 'name' = 'Alpha Co'),
          '["95/100.10", "40/200.20"]'::jsonb, 'receivables: Alpha detail oldest first with days overdue and balance');
select is((select (select jsonb_agg(d.j ->> 'days_overdue') from jsonb_array_elements(c.j -> 'detail') d(j))
           from core.finance_receivables('PKG'), jsonb_array_elements(customers) c(j) where c.j ->> 'name' = 'Beta Co'),
          '["45", "0"]'::jsonb, 'receivables: Beta detail: 45 days by the issue date, 0 for the not yet due invoice');
select is((select check_reason from core.finance_receivables('PKG')), 'not_cached', 'check line: no cached QuickBooks report says not_cached');
reset role;

-- The check line: the cached AgedReceivables TOTAL (the last column of the TOTAL row), today's report.
insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at)
values ('PKG', '00000000-0000-4000-8000-000000005101', 'ar_aging_summary', jsonb_build_object('report_date', to_char(pg_temp.today(), 'YYYY-MM-DD')),
        '{"Header": {"TotalsWithheld": "false"}, "Rows": {"Row": [{"type": "Data", "level": 0, "ColData": [{"value": ""}, {"value": "300.00"}]},
          {"type": "Summary", "level": 0, "ColData": [{"value": "TOTAL"}, {"value": "351.36"}, {"value": "10.00"}, {"value": "361.36"}]}]}}',
        now() - interval '2 hours', now() - interval '2 hours');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select check_total from core.finance_receivables('PKG')), 361.36::numeric, 'check line: the QuickBooks total is the last column of the TOTAL row');
select is((select check_difference from core.finance_receivables('PKG')), 0.00::numeric, 'check line: no difference');
select is((select check_report_date from core.finance_receivables('PKG')), pg_temp.today(), 'check line: the report date');
reset role;
update fin.report_cache set payload = jsonb_set(payload, '{Rows,Row,1,ColData,3,value}', '"360.00"') where lane_id = 'PKG' and report = 'ar_aging_summary';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select check_difference from core.finance_receivables('PKG')), 1.36::numeric, 'check line: the difference (computed minus QuickBooks) is computed in SQL');
reset role;
update fin.report_cache set payload = jsonb_set(payload, '{Header,TotalsWithheld}', '"true"') where lane_id = 'PKG' and report = 'ar_aging_summary';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select check_reason || '/' || coalesce(check_total::text, 'null') from core.finance_receivables('PKG')), 'withheld/null', 'check line: a withheld total is not shown');
reset role;
update fin.report_cache set payload = jsonb_set(jsonb_set(payload, '{Header,TotalsWithheld}', '"false"'), '{Rows,Row,1,ColData,3,value}', '"n/a"') where lane_id = 'PKG' and report = 'ar_aging_summary';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select check_reason from core.finance_receivables('PKG')), 'unreadable', 'check line: an unreadable figure is not shown');
reset role;
delete from fin.report_cache where lane_id = 'PKG' and report = 'ar_aging_summary';
insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at)
values ('PKG', '00000000-0000-4000-8000-000000005101', 'ar_aging_summary', jsonb_build_object('report_date', to_char(pg_temp.today() - 5, 'YYYY-MM-DD')),
        '{"Header": {}, "Rows": {"Row": [{"type": "Summary", "ColData": [{"value": "TOTAL"}, {"value": "5.00"}]}]}}', now() - interval '2 hours', now() - interval '2 hours');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select check_reason || '/' || coalesce(check_total::text, 'null') from core.finance_receivables('PKG')), 'older_than_data/null',
          'check line: a report older than the last data processing is not compared');
reset role;

-- Fail closed (D-25): QuickBooks' total includes invoices the normalizer dropped for a payroll, employee or excluded-entity reason.
-- The total is shown only when the LATEST normalize run of EVERY current connection has dead_invoices_sensitive = 0.
create function pg_temp.today_report(p_total text, p_date text default null) returns void language sql as $$
  delete from fin.report_cache where lane_id = 'PKG' and report = 'ar_aging_summary';
  insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at)
  values ('PKG', '00000000-0000-4000-8000-000000005101', 'ar_aging_summary', jsonb_build_object('report_date', coalesce(p_date, to_char(pg_temp.today(), 'YYYY-MM-DD'))),
          jsonb_build_object('Header', '{}'::jsonb, 'Rows', jsonb_build_object('Row', jsonb_build_array(jsonb_build_object('type', 'Summary', 'ColData', jsonb_build_array(jsonb_build_object('value', 'TOTAL'), jsonb_build_object('value', p_total)))))),
          now() - interval '2 hours', now() - interval '2 hours');
$$;
select pg_temp.today_report('361.36');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select check_total from core.finance_receivables('PKG')), 361.36::numeric, 'sensitive: the latest run counted none: the total is shown');
select is(core.finance_ar_total_readable('PKG'), true, 'sensitive: finance_ar_total_readable is true');
reset role;
insert into fin.normalize_runs (lane_id, connection_id, class_tracking, class_fallback, counts, started_at, finished_at)
values ('PKG', '00000000-0000-4000-8000-000000005101', false, false, '{}', now() - interval '51 minutes', now() - interval '50 minutes');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select check_reason || '/' || coalesce(check_total::text, 'null') || '/' || coalesce(check_difference::text, 'null') || '/' || coalesce(check_report_date::text, 'null') from core.finance_receivables('PKG')), 'withheld/null/null/null',
          'sensitive: the latest run has no dead_invoices_sensitive key (a run from before): withheld, no total, no difference, no date');
reset role;
insert into fin.normalize_runs (lane_id, connection_id, class_tracking, class_fallback, counts, started_at, finished_at)
values ('PKG', '00000000-0000-4000-8000-000000005101', false, false, '{"dead_invoices_sensitive": 2}', now() - interval '41 minutes', now() - interval '40 minutes');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select check_reason || '/' || coalesce(check_total::text, 'null') from core.finance_receivables('PKG')), 'withheld/null', 'sensitive: the latest run dropped 2 invoices: withheld');
reset role;
insert into fin.normalize_runs (lane_id, connection_id, class_tracking, class_fallback, counts, started_at, finished_at)
values ('PKG', '00000000-0000-4000-8000-000000005101', false, false, '{"dead_invoices_sensitive": 0}', now() - interval '31 minutes', now() - interval '30 minutes');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select check_total from core.finance_receivables('PKG')), 361.36::numeric, 'sensitive: only the LATEST run counts: a later run with 0 shows the total again');
reset role;

-- Several current QuickBooks connections: the computed total covers all of them, a report covers one: no comparison. And the sensitive
-- rule needs EVERY current connection's latest run to be clean.
insert into core.connections (id, lane_id, provider, external_account_id, status, last_sync_at)
values ('00000000-0000-4000-8000-000000005104', 'PKG', 'quickbooks', '8800000000514', 'active', now() - interval '1 hour');
insert into fin.normalize_runs (lane_id, connection_id, class_tracking, class_fallback, counts, started_at, finished_at)
values ('PKG', '00000000-0000-4000-8000-000000005104', false, false, '{"dead_invoices_sensitive": 1}', now() - interval '21 minutes', now() - interval '20 minutes');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(core.finance_ar_total_readable('PKG'), false, 'sensitive: two connections, one with a dropped invoice: not readable');
select is((select check_reason || '/' || coalesce(check_total::text, 'null') from core.finance_receivables('PKG')), 'several_connections/null', 'several connections: no comparison, no total');
reset role;
insert into fin.normalize_runs (lane_id, connection_id, class_tracking, class_fallback, counts, started_at, finished_at)
values ('PKG', '00000000-0000-4000-8000-000000005104', false, false, '{"dead_invoices_sensitive": 0}', now() - interval '11 minutes', now() - interval '10 minutes');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(core.finance_ar_total_readable('PKG'), true, 'sensitive: both connections clean: readable');
select is((select check_reason from core.finance_receivables('PKG')), 'several_connections', 'several connections: still no comparison');
reset role;
update core.connections set status = 'disconnected' where id = '00000000-0000-4000-8000-000000005104';
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is(core.finance_ar_total_readable('PKG'), false, 'sensitive: a user without the finance view gets false');
reset role;
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is(core.finance_ar_total_readable('PKG'), false, 'sensitive: AAL1 gets false');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(core.finance_ar_total_readable('APK'), false, 'sensitive: another lane gets false');
reset role;
set local role anon;
select throws_ok($$select core.finance_ar_total_readable('PKG')$$, '42501', null, 'anon cannot call finance_ar_total_readable');
reset role;

-- Unreadable, never an error: an impossible date or a figure too big for numeric(18,2) passes the pattern but not the cast.
select pg_temp.today_report('361.36', '2026-13-45');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select check_reason from core.finance_receivables('PKG')), 'unreadable', 'check line: an impossible report date is unreadable (the page still answers)');
select is((select total from core.finance_receivables('PKG')), 361.36::numeric, 'check line: and the figures are still there');
reset role;
select pg_temp.today_report('99999999999999999999999.00');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select check_reason from core.finance_receivables('PKG')), 'unreadable', 'check line: a figure that overflows numeric(18,2) is unreadable');
reset role;
select pg_temp.today_report('361.36');

-- The caps are stated: 52 more customers with one small invoice each, 27 more invoices for one customer.
insert into fin.invoices (lane_id, connection_id, source_id, customer_id, customer_name, issue_date, due_date, total, balance, entity_code)
select 'PKG', '00000000-0000-4000-8000-000000005101', 'cap-' || g, 'cap' || g, 'Cap ' || g, pg_temp.today() - 10, pg_temp.today() + 1, 0.01, 0.01, 'PKG' from generate_series(1, 52) g;
insert into fin.invoices (lane_id, connection_id, source_id, customer_id, customer_name, issue_date, due_date, total, balance, entity_code)
select 'PKG', '00000000-0000-4000-8000-000000005101', 'many-' || g, '101', 'Alpha Co', pg_temp.today() - 10, pg_temp.today() + 1, 1.00, 1.00, 'PKG' from generate_series(1, 27) g;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select customer_count from core.finance_receivables('PKG')), 55, 'caps: 55 customers in all');
select is((select customers_shown from core.finance_receivables('PKG')), 50, 'caps: 50 shown, and the count says so');
select is((select jsonb_array_length(customers) from core.finance_receivables('PKG')), 50, 'caps: 50 customer rows returned');
select is((select (c.j ->> 'invoices')::int || '/' || jsonb_array_length(c.j -> 'detail') || '/' || (c.j ->> 'detail_shown')
           from core.finance_receivables('PKG'), jsonb_array_elements(customers) c(j) where c.j ->> 'name' = 'Alpha Co'), '29/25/25', 'caps: 29 invoices, 25 listed, the count says so');
select is((select (b.j ->> 'total')::numeric from core.finance_receivables('PKG'), jsonb_array_elements(buckets) b(j) where b.j ->> 'bucket' = 'current'), 51.06 + 0.52 + 27.00,
          'caps: the buckets and the total still count every invoice (nothing is dropped from a figure)');
reset role;

-- A user who holds the finance view in BOTH lanes asks for PKG and gets none of APK's figures: the lane predicate itself, not only RLS.
insert into core.memberships (user_id, lane_id, role) values (pg_temp.uid('owner@example.test'), 'APK', 'owner');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select total from core.finance_receivables('PKG')), 388.88::numeric, 'two lanes: PKG receivables hold none of APK''s 777.00');
select is((select customer_count from core.finance_receivables('PKG')), 55, 'two lanes: PKG''s 55 customers, not APK''s');
reset role;
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(core.finance_report_weeks('APK'), null::int, 'a PKG-only user: finance_report_weeks(APK) is null');
reset role;

-- The aging boundaries: due exactly 30, 31, 60, 61, 90 and 91 days ago, yesterday, today and tomorrow (distinct amounts: a bucket that
-- changes <= to < changes a total).
delete from fin.invoices where lane_id in ('PKG', 'APK');
insert into fin.invoices (lane_id, connection_id, source_id, customer_id, customer_name, issue_date, due_date, total, balance, entity_code)
select 'PKG', '00000000-0000-4000-8000-000000005101', 'b-' || d.days, 'b' || d.days, 'Boundary ' || d.days, pg_temp.today() - 200, pg_temp.today() - d.days, d.amt, d.amt, 'PKG'
from (values (-1, 128.00), (0, 64.00), (1, 256.00), (30, 1.00), (31, 2.00), (60, 4.00), (61, 8.00), (90, 16.00), (91, 32.00)) d(days, amt);
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select jsonb_agg((b.j ->> 'bucket') || '=' || (b.j ->> 'total') || '/' || (b.j ->> 'count') order by b.o) from core.finance_receivables('PKG'), jsonb_array_elements(buckets) with ordinality b(j, o)),
          '["current=192.00/2", "1_30=257.00/2", "31_60=6.00/2", "61_90=24.00/2", "90_plus=32.00/1"]'::jsonb,
          'boundaries: tomorrow and today are current; yesterday and 30 days are 1-30; 31 and 60 are 31-60; 61 and 90 are 61-90; 91 is 90+');
select is((select jsonb_agg(b.j order by b.o) from core.finance_receivables('PKG'), jsonb_array_elements(buckets) with ordinality b(j, o)),
          (select jsonb_agg(a.j order by a.o) from core.home_finance_detail('PKG'), jsonb_array_elements(aging) with ordinality a(j, o)),
          'boundaries: and the Overview aging agrees on every one');
reset role;

-- ================================================================ denial (receivables)
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state from core.finance_receivables('APK')), 'no_access', 'cross-lane: another lane is not readable');
select is((select total from core.finance_receivables('APK')), null::numeric, 'cross-lane: no figure');
reset role;
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select state || '/' || coalesce(total::text, 'null') from core.finance_receivables('PKG')), 'no_access/null', 'AAL1: no_access and no figure');
reset role;
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select state from core.finance_receivables('PKG')), 'no_access', 'a user without the finance view: no_access');
reset role;
set local role anon;
select throws_ok($$select * from core.finance_receivables('PKG')$$, '42501', null, 'anon cannot call finance_receivables');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select * from core.finance_receivables(null)$$, '22004', null, 'a lane is required');
reset role;

-- ================================================================ weeks
delete from fin.invoices where lane_id in ('PKG', 'APK');
delete from fin.report_cache where lane_id = 'PKG';
-- Invoices (balance 0 so that they are not receivables). Week 0 = the current week (Saturday = cur), week n starts cur - 7n.
-- Week 0: one on the Saturday, one today (the same day on a Saturday), one tomorrow (never counted: nothing after today).
-- Week 1: the Friday (cur - 1) and the Saturday (cur - 7). Week 2: its Friday (cur - 8). Week 4: its Saturday (cur - 28). Week 5: outside.
insert into fin.invoices (lane_id, connection_id, source_id, customer_id, customer_name, issue_date, due_date, total, balance, entity_code, voided, deleted, currency_code) values
  ('PKG', '00000000-0000-4000-8000-000000005101', 'w0a', '201', 'Gamma Co', pg_temp.cur(), null, 1000.00, 0, 'PKG', false, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000005101', 'w0b', '202', 'Delta Co', pg_temp.today(), null, 0.50, 0, 'PKG', false, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000005101', 'w0c', '202', 'Delta Co', pg_temp.today() + 1, null, 7.00, 0, 'PKG', false, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000005101', 'w1a', '201', 'Gamma Co', pg_temp.cur() - 1, null, 200.00, 0, 'PKG', false, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000005101', 'w1b', '203', 'Eps Co', pg_temp.cur() - 7, null, 300.00, 0, 'PKG', false, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000005101', 'w2a', '203', 'Eps Co', pg_temp.cur() - 8, null, 40.00, 0, 'PKG', false, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000005101', 'w4a', '204', 'Zeta Co', pg_temp.cur() - 28, null, 5.55, 0, 'PKG', false, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000005101', 'w5a', '204', 'Zeta Co', pg_temp.cur() - 29, null, 99.00, 0, 'PKG', false, false, 'USD'),
-- left out: voided, deleted, another currency, another entity, the disconnected connection, another lane
  ('PKG', '00000000-0000-4000-8000-000000005101', 'v1', '205', 'V Co', pg_temp.cur(), null, 11.00, 0, 'PKG', true, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000005101', 'v2', '205', 'V Co', pg_temp.cur(), null, 12.00, 0, 'PKG', false, true, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000005101', 'v3', '205', 'V Co', pg_temp.cur(), null, 14.00, 0, 'PKG', false, false, 'EUR'),
  ('PKG', '00000000-0000-4000-8000-000000005101', 'v4', '205', 'V Co', pg_temp.cur(), null, 15.00, 0, 'unmapped', false, false, 'USD'),
  ('PKG', '00000000-0000-4000-8000-000000005102', 'v5', '205', 'V Co', pg_temp.cur(), null, 13.00, 0, 'PKG', false, false, 'USD'),
  ('APK', '00000000-0000-4000-8000-000000005103', 'v6', '205', 'V Co', pg_temp.cur(), null, 17.00, 0, 'APK', false, false, 'USD');

-- Payments (the stored shape: paid_at = the TxnDate at 00:00 New York; one row per allocation).
-- Week 0: p1 on the Saturday with TWO rows (60.00 allocated to an invoice, 40.00 unapplied) = one payment of 100.00.
-- Week 1: p2 on the Friday 25.25; p3 on the Saturday 74.75; p11 on the Friday at 23:30 New York (a Saturday in UTC) 0.01.
insert into fin.payments (lane_id, connection_id, source_id, alloc_no, invoice_id, paid_at, amount, entity_code, voided, deleted, currency_code, customer_name)
select 'PKG', '00000000-0000-4000-8000-000000005101'::uuid, 'p1', 0, (select id from fin.invoices where source_id = 'w1b' and lane_id = 'PKG'), pg_temp.at_ny(pg_temp.cur()), 60.00, 'PKG', false, false, 'USD', 'Gamma Co'
union all select 'PKG', '00000000-0000-4000-8000-000000005101', 'p1', 1, null, pg_temp.at_ny(pg_temp.cur()), 40.00, 'PKG', false, false, 'USD', 'Gamma Co'
union all select 'PKG', '00000000-0000-4000-8000-000000005101', 'p2', 0, null, pg_temp.at_ny(pg_temp.cur() - 1), 25.25, 'PKG', false, false, 'USD', 'Eps Co'
union all select 'PKG', '00000000-0000-4000-8000-000000005101', 'p3', 0, null, pg_temp.at_ny(pg_temp.cur() - 7), 74.75, 'PKG', false, false, 'USD', 'Delta Co'
union all select 'PKG', '00000000-0000-4000-8000-000000005101', 'p11', 0, null, pg_temp.at_ny(pg_temp.cur() - 1) + interval '23 hours 30 minutes', 0.01, 'PKG', false, false, 'USD', 'Eps Co'
-- outside the weeks or left out
union all select 'PKG', '00000000-0000-4000-8000-000000005101', 'p4', 0, null, pg_temp.at_ny(pg_temp.cur() - 29), 500.00, 'PKG', false, false, 'USD', 'Zeta Co'
union all select 'PKG', '00000000-0000-4000-8000-000000005101', 'p5', 0, null, pg_temp.at_ny(pg_temp.cur()), 11.00, 'PKG', true, false, 'USD', 'V Co'
union all select 'PKG', '00000000-0000-4000-8000-000000005101', 'p6', 0, null, pg_temp.at_ny(pg_temp.cur()), 12.00, 'PKG', false, true, 'USD', 'V Co'
union all select 'PKG', '00000000-0000-4000-8000-000000005101', 'p7', 0, null, pg_temp.at_ny(pg_temp.cur()), 14.00, 'PKG', false, false, 'EUR', 'V Co'
union all select 'PKG', '00000000-0000-4000-8000-000000005101', 'p8', 0, null, pg_temp.at_ny(pg_temp.cur()), 15.00, 'unmapped', false, false, 'USD', 'V Co'
union all select 'PKG', '00000000-0000-4000-8000-000000005102', 'p9', 0, null, pg_temp.at_ny(pg_temp.cur()), 13.00, 'PKG', false, false, 'USD', 'V Co'
union all select 'APK', '00000000-0000-4000-8000-000000005103', 'p10', 0, null, pg_temp.at_ny(pg_temp.cur()), 17.00, 'APK', false, false, 'USD', 'V Co'
union all select 'PKG', '00000000-0000-4000-8000-000000005101', 'p12', 0, null, pg_temp.at_ny(pg_temp.today() + 1), 18.00, 'PKG', false, false, 'USD', 'V Co';

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state from core.finance_weekly('PKG', 4)), 'ok', 'weekly: ok');
select is((select jsonb_array_length(weeks) from core.finance_weekly('PKG', 4)), 5, 'weekly: the current week plus four completed weeks');
select is((select connection_status from core.finance_weekly('PKG', 4)), 'active', 'weekly: the connection status (for the page note)');
select is((select jsonb_array_length(weeks) from core.finance_weekly('PKG', 13)), 14, 'weekly: 13 weeks asked, 14 rows');
select is((select (select jsonb_agg(w.j ->> 'start' order by w.o) from jsonb_array_elements(weeks) with ordinality w(j, o)) from core.finance_weekly('PKG', 4)),
          (select jsonb_agg(to_char(pg_temp.cur() - 7 * n, 'YYYY-MM-DD') order by n) from generate_series(0, 4) n),
          'weekly: newest first, every row starts on a Saturday, seven days apart');
select is((select (select jsonb_agg(w.j ->> 'end' order by w.o) from jsonb_array_elements(weeks) with ordinality w(j, o)) from core.finance_weekly('PKG', 4)),
          (select jsonb_agg(to_char(pg_temp.cur() - 7 * n + 6, 'YYYY-MM-DD') order by n) from generate_series(0, 4) n),
          'weekly: every row ends on the Friday');
select is((select bool_and(extract(dow from (w.j ->> 'start')::date) = 6 and (w.j ->> 'end')::date - (w.j ->> 'start')::date = 6) from core.finance_weekly('PKG', 4), jsonb_array_elements(weeks) w(j)),
          true, 'weekly: every returned week starts on a Saturday (dow 6) and ends six days later, checked on the rows themselves');
select is((select bool_and((w.j ->> 'start')::date - (n.next ->> 'start')::date = 7) from core.finance_weekly('PKG', 4) f, jsonb_array_elements(f.weeks) with ordinality w(j, o)
           join (select a.j as next, a.o from core.finance_weekly('PKG', 4) g, jsonb_array_elements(g.weeks) with ordinality a(j, o)) n on n.o = w.o + 1),
          true, 'weekly: consecutive rows are exactly seven days apart');
select is((select (w.j ->> 'start')::date <= (now() at time zone 'America/New_York')::date and (now() at time zone 'America/New_York')::date <= (w.j ->> 'end')::date
           from core.finance_weekly('PKG', 4), jsonb_array_elements(weeks) with ordinality w(j, o) where o = 1), true, 'weekly: the first row contains today');
select is((select (w.j ->> 'invoiced_count') || '/' || (w.j ->> 'invoiced_amount') from core.finance_weekly('PKG', 4), jsonb_array_elements(weeks) w(j) where (w.j ->> 'is_current')::boolean),
          '2/1000.50', 'week 0: Saturday and today counted, tomorrow is not, exclusions are not');
select is((select (w.j ->> 'received_count') || '/' || (w.j ->> 'received_amount') from core.finance_weekly('PKG', 4), jsonb_array_elements(weeks) w(j) where (w.j ->> 'is_current')::boolean),
          '1/100.00', 'week 0: the payment with two rows counts once, 100.00 (60.00 + 40.00); tomorrow''s payment is not counted');
select is((select (w.j ->> 'invoiced_count') || '/' || (w.j ->> 'invoiced_amount') from core.finance_weekly('PKG', 4), jsonb_array_elements(weeks) w(j) where w.j ->> 'start' = to_char(pg_temp.cur() - 7, 'YYYY-MM-DD')),
          '2/500.00', 'week 1: the Friday (cur - 1) and the Saturday (cur - 7) invoices both belong to week 1');
select is((select (w.j ->> 'received_count') || '/' || (w.j ->> 'received_amount') from core.finance_weekly('PKG', 4), jsonb_array_elements(weeks) w(j) where w.j ->> 'start' = to_char(pg_temp.cur() - 7, 'YYYY-MM-DD')),
          '3/100.01', 'week 1: Friday, Saturday and the Friday 23:30 New York payment (a Saturday in UTC) are week 1''s; nothing leaks into week 0');
select is((select (w.j ->> 'invoiced_count') || '/' || (w.j ->> 'invoiced_amount') || '/' || (w.j ->> 'received_count') || '/' || (w.j ->> 'received_amount')
           from core.finance_weekly('PKG', 4), jsonb_array_elements(weeks) w(j) where w.j ->> 'start' = to_char(pg_temp.cur() - 14, 'YYYY-MM-DD')),
          '1/40.00/0/0.00', 'week 2: the Friday invoice (cur - 8); no payments');
select is((select (w.j ->> 'invoiced_count') || '/' || (w.j ->> 'invoiced_amount') || '/' || (w.j ->> 'received_count') || '/' || (w.j ->> 'received_amount')
           from core.finance_weekly('PKG', 4), jsonb_array_elements(weeks) w(j) where w.j ->> 'start' = to_char(pg_temp.cur() - 21, 'YYYY-MM-DD')),
          '0/0.00/0/0.00', 'week 3: an empty week is a row of zeros');
select is((select (w.j ->> 'invoiced_amount') from core.finance_weekly('PKG', 4), jsonb_array_elements(weeks) w(j) where w.j ->> 'start' = to_char(pg_temp.cur() - 28, 'YYYY-MM-DD')),
          '5.55', 'week 4: the last shown week (its Saturday)');
select is((select (select sum((w.j ->> 'invoiced_amount')::numeric) from jsonb_array_elements(weeks) w(j)) from core.finance_weekly('PKG', 4)),
          1000.50 + 500.00 + 40.00 + 5.55, 'weekly: the invoice from the week before the range (99.00) is in no row');
select is((select (select sum((w.j ->> 'received_amount')::numeric) from jsonb_array_elements(weeks) w(j)) from core.finance_weekly('PKG', 4)),
          100.00 + 100.01, 'weekly: the payment from the week before the range (500.00) is in no row');
select is((select (select sum((w.j ->> 'invoiced_count')::int) from jsonb_array_elements(weeks) w(j))::int from core.finance_weekly('PKG', 1)), 4, 'weekly: asking for one week shows the current week and one completed week');
select is((select (w.j ->> 'is_current')::boolean from core.finance_weekly('PKG', 4), jsonb_array_elements(weeks) with ordinality w(j, o) where o = 1), true, 'weekly: the first row is the current week');
reset role;

-- Both lanes held by one user: PKG's weeks hold none of APK's invoice (17.00) and payment (17.00) of the same Saturday.
insert into core.memberships (user_id, lane_id, role) values (pg_temp.uid('owner@example.test'), 'APK', 'owner');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select (w.j ->> 'invoiced_count') || '/' || (w.j ->> 'invoiced_amount') || '/' || (w.j ->> 'received_count') || '/' || (w.j ->> 'received_amount')
           from core.finance_weekly('PKG', 4), jsonb_array_elements(weeks) w(j) where (w.j ->> 'is_current')::boolean), '2/1000.50/1/100.00', 'two lanes: PKG''s current week holds none of APK''s figures');
select is((select invoice_count || '/' || payment_count from core.finance_week_detail('PKG', pg_temp.cur(), 4)), '2/1', 'two lanes: PKG''s week detail lists none of APK''s rows');
select is((select (select count(*) from jsonb_array_elements(payments) p(j) where (p.j ->> 'amount')::numeric = 17.00) from core.finance_week_detail('PKG', pg_temp.cur(), 4)), 0::bigint, 'two lanes: no 17.00 payment in PKG''s list');
reset role;
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');

-- ================================================================ week detail
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select week_valid::text || '/' || invoice_count || '/' || payment_count from core.finance_week_detail('PKG', pg_temp.cur() - 7, 4)), 'true/2/3', 'detail: week 1 has two invoices and three payments');
select is((select (select jsonb_agg(i.j ->> 'customer' || '/' || (i.j ->> 'total') || '/' || (i.j ->> 'open_balance') order by i.o) from jsonb_array_elements(invoices) with ordinality i(j, o)) from core.finance_week_detail('PKG', pg_temp.cur() - 7, 4)),
          '["Eps Co/300.00/0.00", "Gamma Co/200.00/0.00"]'::jsonb, 'detail: invoices by date (customer, total, open balance)');
select is((select (select jsonb_agg(p.j ->> 'customer' || '/' || (p.j ->> 'amount') order by p.o) from jsonb_array_elements(payments) with ordinality p(j, o)) from core.finance_week_detail('PKG', pg_temp.cur() - 7, 4)),
          '["Delta Co/74.75", "Eps Co/0.01", "Eps Co/25.25"]'::jsonb, 'detail: payments by date (customer, amount)');
select is((select payments -> 0 ->> 'amount' from core.finance_week_detail('PKG', pg_temp.cur(), 4)), '100.00', 'detail: the two-row payment is one line of 100.00');
select is((select payment_count from core.finance_week_detail('PKG', pg_temp.cur(), 4)), 1, 'detail: and counts once');
select is((select week_valid from core.finance_week_detail('PKG', pg_temp.cur() - 6, 4)), false, 'detail: a Sunday is no week');
select is((select week_valid from core.finance_week_detail('PKG', pg_temp.cur() - 35, 4)), false, 'detail: a Saturday outside the shown range is no week');
select is((select week_valid from core.finance_week_detail('PKG', pg_temp.cur() + 7, 4)), false, 'detail: next week is no week');
select is((select week_valid from core.finance_week_detail('PKG', null, 4)), false, 'detail: no date is no week');
select is((select invoice_count + payment_count from core.finance_week_detail('PKG', pg_temp.cur() - 35, 4)), 0, 'detail: an invalid week lists nothing');
select throws_ok($$select * from core.finance_weekly('PKG', 0)$$, '22023', null, 'weeks below 1 are refused');
select throws_ok($$select * from core.finance_weekly('PKG', 14)$$, '22023', null, 'weeks above 13 are refused');
select throws_ok($$select * from core.finance_week_detail('PKG', null, 14)$$, '22023', null, 'weeks above 13 are refused (detail)');
select is((select jsonb_array_length(weeks) from core.finance_weekly('PKG')), 5, 'weeks from lane_config: not set, the default of 4 completed weeks (5 rows)');
select is(core.finance_report_weeks('PKG'), 4, 'finance_report_weeks: the default is 4');
reset role;

-- caps on the detail: 55 invoices and 52 payments in week 3
insert into fin.invoices (lane_id, connection_id, source_id, customer_id, customer_name, issue_date, total, balance, entity_code)
select 'PKG', '00000000-0000-4000-8000-000000005101', 'c-' || g, 'c' || g, 'Cap ' || g, pg_temp.cur() - 21, 1.00, 0, 'PKG' from generate_series(1, 55) g;
insert into fin.payments (lane_id, connection_id, source_id, alloc_no, paid_at, amount, entity_code, customer_name)
select 'PKG', '00000000-0000-4000-8000-000000005101', 'cp-' || g, 0, pg_temp.at_ny(pg_temp.cur() - 21), 1.00, 'PKG', 'Cap ' || g from generate_series(1, 52) g;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select invoice_count || '/' || jsonb_array_length(invoices) || '/' || payment_count || '/' || jsonb_array_length(payments) || '/' || row_cap from core.finance_week_detail('PKG', pg_temp.cur() - 21, 4)),
          '55/50/52/50/50', 'caps: 55 invoices and 52 payments counted, 50 of each listed, the cap returned');

-- ================================================================ denial (weeks)
select is((select state from core.finance_weekly('APK', 4)), 'no_access', 'cross-lane: another lane''s weeks are not readable');
select is((select state from core.finance_week_detail('APK', pg_temp.cur(), 4)), 'no_access', 'cross-lane: nor its week detail');
reset role;
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select state || '/' || jsonb_array_length(weeks) from core.finance_weekly('PKG', 4)), 'no_access/0', 'AAL1: no weeks');
select is((select state from core.finance_week_detail('PKG', pg_temp.cur(), 4)), 'no_access', 'AAL1: no week detail');
reset role;
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select state from core.finance_weekly('PKG', 4)), 'no_access', 'a user without the finance view: no weeks');
reset role;

-- ================================================================ lane_config finance.reports.weeks
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1,
  config || jsonb_build_object('finance', coalesce(config -> 'finance', '{}'::jsonb)
    || jsonb_build_object('reports', coalesce(config #> '{finance,reports}', '{}'::jsonb) || jsonb_build_object('weeks', 2)))
from core.lane_config_current where lane_id = 'PKG';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(core.finance_report_weeks('PKG'), 2, 'finance_report_weeks: the configured 2');
select is((select jsonb_array_length(weeks) from core.finance_weekly('PKG')), 3, 'weekly: the configured 2 completed weeks plus the current week');
select is((select week_valid from core.finance_week_detail('PKG', pg_temp.cur() - 14)), true, 'detail: the configured range is the valid range (the last shown week)');
select is((select week_valid from core.finance_week_detail('PKG', pg_temp.cur() - 21)), false, 'detail: a week beyond the configured range is no week');
select is((select jsonb_array_length(weeks) from core.finance_weekly('PKG', 6)), 7, 'weekly: an explicit number overrides the configuration');
reset role;
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is(core.finance_report_weeks('PKG'), null::int, 'finance_report_weeks: nothing for a user without the finance view');
reset role;
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is(core.finance_report_weeks('PKG'), null::int, 'finance_report_weeks: nothing at AAL1');
reset role;
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{finance,reports,weeks}', '99')
from core.lane_config_current where lane_id = 'PKG';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(core.finance_report_weeks('PKG'), 4, 'finance_report_weeks: a value outside 1 to 13 in the config falls back to 4');
reset role;

-- ================================================================ every connection disconnected: not_connected, no figure
update core.connections set status = 'disconnected' where lane_id = 'PKG' and provider = 'quickbooks';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state || '/' || coalesce(total::text, 'null') from core.finance_receivables('PKG')), 'not_connected/null', 'all disconnected: receivables are not_connected');
select is((select state || '/' || jsonb_array_length(weeks) from core.finance_weekly('PKG', 4)), 'not_connected/0', 'all disconnected: no weeks');
reset role;

select * from finish();
rollback;
