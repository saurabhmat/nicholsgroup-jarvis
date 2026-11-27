-- T-302: fin.cash_book_balances, core.fin_cash_book_balances_put, core.fin_cash_account_ids and core.finance_cash (spec finance.md section 15.4).
-- Covered: the table (columns, standard RLS policy for the finance view, no write for authenticated, cross-lane denial, AAL1 and no finance view see nothing);
-- the writer (service_role only; upsert; the date's other rows are removed; the whole call is refused when ANY account is not a bank account of
-- the connection in this lane: a non-bank, a deleted one, one that is not in fin.accounts at all (payroll accounts never are), another lane's, another
-- connection's; unusable connection; date and as_of limits; item shape; retention of 26 weeks, only of the called connection); the bank account list; the
-- report: figures and changes to the cent, the total is null (never partial) when an account of the column is missing, per-column as_of, "read" counts,
-- the shared flag, the same accounts as "Cash by account", the states, a disconnected connection is not counted, denial (another lane, AAL1, no finance
-- view, anon), the weeks setting. Dates are relative to today (business date) and safe on any day of the week.
begin;
select plan(141);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code in ('APK');
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');

delete from fin.cash_book_balances where lane_id in ('PKG', 'APK');
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
create function pg_temp.cur() returns date language sql as $$ select pg_temp.today() - ((extract(dow from pg_temp.today())::int + 1) % 7) $$;
-- The Friday that ends the n-th completed business week (n = 1 is the newest).
create function pg_temp.fri(n int) returns date language sql as $$ select pg_temp.cur() - 7 * (n - 1) - 1 $$;
-- SQLSTATE of the first error of a statement, or 'ok'.
create function pg_temp.refusal(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlstate; end $$;

-- ---------------------------------------------------------------- the table
select has_table('fin', 'cash_book_balances', 'fin.cash_book_balances exists');
select col_type_is('fin', 'cash_book_balances', 'book_balance', 'numeric(18,2)', 'book_balance is numeric(18,2)');
select col_type_is('fin', 'cash_book_balances', 'as_of', 'timestamp with time zone', 'as_of is timestamptz');
select col_not_null('fin', 'cash_book_balances', 'lane_id', 'lane_id is required');
select pg_temp.has_standard_lane_policy('fin.cash_book_balances', 'finance');
select ok(has_table_privilege('service_role', 'fin.cash_book_balances', 'select, insert, update, delete'), 'service_role holds the privileges the writer needs');
select ok(not has_function_privilege('authenticated', 'core.fin_cash_book_balances_put(text, uuid, date, timestamptz, jsonb)', 'execute')
          and not has_function_privilege('anon', 'core.fin_cash_book_balances_put(text, uuid, date, timestamptz, jsonb)', 'execute')
          and has_function_privilege('service_role', 'core.fin_cash_book_balances_put(text, uuid, date, timestamptz, jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'core.fin_cash_account_ids(text, uuid)', 'execute')
          and not has_function_privilege('anon', 'core.fin_cash_account_ids(text, uuid)', 'execute')
          and has_function_privilege('service_role', 'core.fin_cash_account_ids(text, uuid)', 'execute'),
          'the writer and the account list are service_role only');
select ok((select bool_and(not prosecdef and proconfig = array['search_path=""']) from pg_proc
           where oid in ('core.fin_cash_book_balances_put(text, uuid, date, timestamptz, jsonb)'::regprocedure, 'core.fin_cash_account_ids(text, uuid)'::regprocedure, 'core.finance_cash(text, integer)'::regprocedure)),
          'the three new functions are security invoker with an empty search_path');
select ok((select provolatile = 's' and has_function_privilege('authenticated', oid, 'execute') and not has_function_privilege('anon', oid, 'execute')
           from pg_proc where oid = 'core.finance_cash(text, integer)'::regprocedure), 'finance_cash: stable; authenticated executes, anon does not');

-- ---------------------------------------------------------------- connections, accounts
insert into core.connections (id, lane_id, provider, external_account_id, status, last_sync_at) values
  ('00000000-0000-4000-8000-000000005202', 'PKG', 'quickbooks', '8800000000522', 'disconnected', now() - interval '3 days'),
  ('00000000-0000-4000-8000-000000005201', 'PKG', 'quickbooks', '8800000000521', 'active', now() - interval '1 hour'),
  ('00000000-0000-4000-8000-000000005203', 'APK', 'quickbooks', '8800000000523', 'active', now() - interval '1 hour');
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1,
  (config - 'qbo') || jsonb_build_object('entities', jsonb_build_object('own_entity', 'PKG',
    'by_entity', jsonb_build_object('PKG', jsonb_build_object('qbo_class_ids', '[]'::jsonb, 'qbo_customer_ids', '[]'::jsonb,
                                                              'stripe_product_ids', '[]'::jsonb, 'ghl_tags', '[]'::jsonb, 'ghl_products', '[]'::jsonb)),
    'bank_accounts', '[]'::jsonb))
  || jsonb_build_object('finance', coalesce(config -> 'finance', '{}'::jsonb)
       || jsonb_build_object('reports', coalesce(config #> '{finance,reports}', '{}'::jsonb) || '{"cash_history": true}'::jsonb))
from core.lane_config_current where lane_id = 'PKG';

select pg_temp.claims('owner@example.test', 'aal2');
select is((select state from core.finance_cash('PKG')), 'no_data', 'the current connection has nothing yet: no_data, no figure');
insert into fin.normalize_runs (lane_id, connection_id, class_tracking, class_fallback, counts, started_at, finished_at)
values ('PKG', '00000000-0000-4000-8000-000000005201', false, false, '{"dead_invoices_sensitive": 0}', now() - interval '61 minutes', now() - interval '1 hour');
select is((select state || '/' || reason from core.finance_cash('PKG')), 'ok/bank_mapping_missing', 'no bank accounts mapped in lane_config: a reason, no figures');

-- 11 Operating Checking (own), 12 Savings (own, also mapped to another entity: shared), 13 mapped to another entity only (not own),
-- 14 deleted, 15 not a bank account, 16 inactive; the disconnected connection has an account with the same QuickBooks id as 11; APK has its own bank account.
insert into fin.accounts (lane_id, connection_id, source_id, name, type, is_bank, entity_code, current_balance, active, deleted) values
  ('PKG', '00000000-0000-4000-8000-000000005201', '11', 'Operating Checking', 'Bank', true, 'PKG', 1000.50, true, false),
  ('PKG', '00000000-0000-4000-8000-000000005201', '12', 'Savings', 'Bank', true, 'PKG', 2000.25, true, false),
  ('PKG', '00000000-0000-4000-8000-000000005201', '13', 'Other Entity Bank', 'Bank', true, 'PKG', 7777.00, true, false),
  ('PKG', '00000000-0000-4000-8000-000000005201', '14', 'Closed Bank', 'Bank', true, 'PKG', 5.00, true, true),
  ('PKG', '00000000-0000-4000-8000-000000005201', '15', 'Accounts Receivable', 'Accounts Receivable', false, 'PKG', 9999.00, true, false),
  ('PKG', '00000000-0000-4000-8000-000000005201', '16', 'Dormant Bank', 'Bank', true, 'PKG', 6.00, false, false),
  ('PKG', '00000000-0000-4000-8000-000000005202', '11', 'Old File Checking', 'Bank', true, 'PKG', 55555.55, true, false),
  ('APK', '00000000-0000-4000-8000-000000005203', '21', 'Other Lane Bank', 'Bank', true, 'APK', 4242.42, true, false);
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{entities,bank_accounts}', jsonb_build_array(
  jsonb_build_object('qbo_account_id', '11', 'owner_entity', 'PKG'),
  jsonb_build_object('qbo_account_id', '12', 'owner_entity', 'PKG'),
  jsonb_build_object('qbo_account_id', '12', 'owner_entity', 'APK'),
  jsonb_build_object('qbo_account_id', '13', 'owner_entity', 'APK'),
  jsonb_build_object('qbo_account_id', '14', 'owner_entity', 'PKG'),
  jsonb_build_object('qbo_account_id', '16', 'owner_entity', 'PKG')))
from core.lane_config_current where lane_id = 'PKG';

-- ---------------------------------------------------------------- the bank account list (service role)
set local role service_role;
select is(core.fin_cash_account_ids('PKG', '00000000-0000-4000-8000-000000005201'), array['11', '12']::text[], 'cash accounts the job may ask about: bank, active, not deleted, mapped to the own entity (13 is mapped to another entity, 14 deleted, 15 not a bank account, 16 inactive)');
select is(pg_temp.refusal($$select core.fin_cash_account_ids('PKG', '00000000-0000-4000-8000-000000005202')$$), '42501', 'the list: a disconnected connection is refused');
select is(pg_temp.refusal($$select core.fin_cash_account_ids('APK', '00000000-0000-4000-8000-000000005201')$$), '42501', 'the list: another lane''s connection id is refused');
select is(pg_temp.refusal($$select core.fin_cash_account_ids(null, null)$$), '22004', 'the list: arguments are required');
reset role;

-- ---------------------------------------------------------------- the writer
set local role service_role;
select is(core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(1), now() - interval '2 hours',
  '[{"account_id": "11", "book_balance": "900.00"}, {"account_id": "12", "book_balance": "1900.25"}]'), 2, 'writes the two accounts of a date in one call');
select is(core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(2), now() - interval '3 hours',
  '[{"account_id": "11", "book_balance": "800.004"}]'), 1, 'a second date with one account (a figure with more decimals is rounded to cents)');
reset role;
select is((select count(*)::int from fin.cash_book_balances where lane_id = 'PKG'), 3, 'three rows stored');
select is((select book_balance from fin.cash_book_balances b join fin.accounts a on a.id = b.account_id where a.source_id = '11' and b.balance_date = pg_temp.fri(2)), 800.00::numeric, 'rounded to the cent: 800.004 is 800.00');

set local role service_role;
select is(core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(1), now() - interval '1 hour',
  '[{"account_id": "11", "book_balance": "901.00"}, {"account_id": "12", "book_balance": "1900.25"}]'), 2, 'a second write of the same date is an update, not new rows');
reset role;
select is((select count(*)::int from fin.cash_book_balances where lane_id = 'PKG' and balance_date = pg_temp.fri(1)), 2, 'still two rows for the date');
select is((select book_balance from fin.cash_book_balances b join fin.accounts a on a.id = b.account_id where a.source_id = '11' and b.balance_date = pg_temp.fri(1)), 901.00::numeric, 'a changed past balance is replaced (a back-dated entry)');

set local role service_role;
select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(1), now() - interval '1 hour', '[{"account_id": "11", "book_balance": "901.00"}]');
reset role;
select is((select count(*)::int from fin.cash_book_balances where lane_id = 'PKG' and balance_date = pg_temp.fri(1)), 1, 'an account not in tonight''s call is removed for that date (no stale figure kept)');
set local role service_role;
select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(1), now() - interval '1 hour',
  '[{"account_id": "11", "book_balance": "901.00"}, {"account_id": "12", "book_balance": "1900.25"}]');
select is(core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(3), now() - interval '1 hour', '[{"account_id": "11", "book_balance": "5.00"}]'), 1, 'a third date with one account');
reset role;
select is((select count(*)::int from fin.cash_book_balances where lane_id = 'PKG' and balance_date = pg_temp.fri(3)), 1, 'the third date has its row');
set local role service_role;
select is(core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(3), now() - interval '1 hour', '[]'), 0, 'an EMPTY call is allowed (nothing could be read for that date)');
reset role;
select is((select count(*)::int from fin.cash_book_balances where lane_id = 'PKG' and balance_date = pg_temp.fri(3)), 0, 'an EMPTY call CLEARS that date''s rows for the connection');
select is((select count(*)::int from fin.cash_book_balances where lane_id = 'PKG'), 3, 'and removes nothing of other dates');

-- Refusals: all or nothing. Everything below leaves the rows as they are.
set local role service_role;
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(3), now(), '[{"account_id": "15", "book_balance": "1.00"}]')$$), '22023', 'refused: an account that is not a bank account');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(3), now(), '[{"account_id": "16", "book_balance": "1.00"}]')$$), '22023', 'refused: an inactive account');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(3), now(), '[{"account_id": "13", "book_balance": "1.00"}]')$$), '22023', 'refused: a bank account that Cash by account does not list (mapped to another entity)');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(3), now(), '[{"account_id": "14", "book_balance": "1.00"}]')$$), '22023', 'refused: a deleted account');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(3), now(), '[{"account_id": "60", "book_balance": "1.00"}]')$$), '22023', 'refused: an account the normalizer never kept (a payroll account is not in fin.accounts)');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(3), now(), '[{"account_id": "21", "book_balance": "1.00"}]')$$), '22023', 'refused: another lane''s account (its id is not a bank account of this connection)');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('APK', '00000000-0000-4000-8000-000000005203', pg_temp.fri(3), now(), '[{"account_id": "11", "book_balance": "1.00"}]')$$), '22023', 'refused: this lane''s account id in another lane''s connection');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005203', pg_temp.fri(3), now(), '[]')$$), '42501', 'refused: another lane''s connection with this lane code');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('APK', '00000000-0000-4000-8000-000000005201', pg_temp.fri(3), now(), '[]')$$), '42501', 'refused: this lane''s connection with another lane code');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005202', pg_temp.fri(3), now(), '[{"account_id": "11", "book_balance": "1.00"}]')$$), '42501', 'refused: a disconnected connection');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(3), now(), '[{"account_id": "11", "book_balance": "1.00"}, {"account_id": "15", "book_balance": "2.00"}]')$$), '22023', 'refused: one bad account refuses the whole call');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.today() + 1, now(), '[]')$$), '22023', 'refused: a date in the future');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.today() - 183, now(), '[]')$$), '22023', 'refused: a date older than 26 weeks');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(3), now() + interval '1 day', '[]')$$), '22023', 'refused: a read time in the future');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(3), now(), '[{"account_id": "11", "book_balance": 1.00}]')$$), '22023', 'refused: a number where a string figure is required');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(3), now(), '[{"account_id": "11", "book_balance": "1.00", "name": "x"}]')$$), '22023', 'refused: an extra key (nothing but id and balance is accepted)');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(3), now(), '[{"account_id": "Operating Checking", "book_balance": "1.00"}]')$$), '22023', 'refused: a label instead of an id');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(3), now(), '[{"account_id": "11", "book_balance": "12x"}]')$$), '22023', 'refused: a figure that is not a figure');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(3), now(), '[{"account_id": "11", "book_balance": "1.00"}, {"account_id": "11", "book_balance": "2.00"}]')$$), '22023', 'refused: the same account twice');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(3), now(), '{"account_id": "11"}')$$), '22023', 'refused: not an array');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('PKG', null, pg_temp.fri(3), now(), '[]')$$), '22004', 'refused: a missing argument');
reset role;
select is((select count(*)::int from fin.cash_book_balances where lane_id in ('PKG', 'APK')), 3, 'no refusal wrote a row');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.refusal($$select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(3), now(), '[]')$$), '42501', 'authenticated cannot call the writer');
select is(pg_temp.refusal($$insert into fin.cash_book_balances (lane_id, connection_id, account_id, balance_date, book_balance, as_of) select lane_id, connection_id, id, current_date, 1, now() from fin.accounts limit 1$$), '42501', 'authenticated cannot insert a row');
select is(pg_temp.refusal($$update fin.cash_book_balances set book_balance = 1 where true$$), '42501', 'authenticated cannot update a row');
select is(pg_temp.refusal($$delete from fin.cash_book_balances where true$$), '42501', 'authenticated cannot delete a row');
reset role;
set local role anon;
select is(pg_temp.refusal($$select core.fin_cash_account_ids('PKG', '00000000-0000-4000-8000-000000005201')$$), '42501', 'anon cannot call the account list');
reset role;

-- Retention and the switch: core.fin_cash_book_balances_purge (its own call, never part of a write).
insert into fin.cash_book_balances (lane_id, connection_id, account_id, balance_date, book_balance, as_of)
select a.lane_id, a.connection_id, a.id, pg_temp.today() - 200, 5.00, now() - interval '200 days' from fin.accounts a where a.source_id in ('11', '21') and a.connection_id in ('00000000-0000-4000-8000-000000005201', '00000000-0000-4000-8000-000000005203');
-- a row of the disconnected connection (a recent date)
insert into fin.cash_book_balances (lane_id, connection_id, account_id, balance_date, book_balance, as_of)
select a.lane_id, a.connection_id, a.id, pg_temp.fri(1), 55555.55, now() from fin.accounts a where a.connection_id = '00000000-0000-4000-8000-000000005202' and a.source_id = '11';
select is((select count(*)::int from fin.cash_book_balances where balance_date = pg_temp.today() - 200), 2, 'two old rows seeded (this lane and another lane)');
set local role service_role;
select is(core.fin_cash_book_balances_purge('PKG', '00000000-0000-4000-8000-000000005201', false), 2, 'purge (switch on): the old row and the disconnected connection''s row are removed');
reset role;
select is((select string_agg(lane_id, ',') from fin.cash_book_balances where balance_date = pg_temp.today() - 200), 'APK', 'the old row of this lane is gone; another lane''s is untouched');
select is((select count(*)::int from fin.cash_book_balances where connection_id = '00000000-0000-4000-8000-000000005202'), 0, 'rows of a disconnected connection are removed');
select is((select count(*)::int from fin.cash_book_balances where lane_id = 'PKG'), 3, 'the live connection''s recent rows stay when the switch is on');
set local role service_role;
select is(core.fin_cash_book_balances_purge('PKG', '00000000-0000-4000-8000-000000005201', true), 3, 'purge with the switch off removes every row of the connection');
reset role;
select is((select count(*)::int from fin.cash_book_balances where lane_id = 'PKG'), 0, 'nothing of the lane is left');
select is((select count(*)::int from fin.cash_book_balances where lane_id = 'APK'), 1, 'another lane''s rows are untouched');
set local role service_role;
select is(pg_temp.refusal($$select core.fin_cash_book_balances_purge('APK', '00000000-0000-4000-8000-000000005201', true)$$), '42501', 'purge: this lane''s connection with another lane code is refused');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_purge('PKG', '00000000-0000-4000-8000-000000005203', true)$$), '42501', 'purge: another lane''s connection is refused');
select is(pg_temp.refusal($$select core.fin_cash_book_balances_purge('PKG', null, true)$$), '22004', 'purge: arguments are required');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.refusal($$select core.fin_cash_book_balances_purge('PKG', '00000000-0000-4000-8000-000000005201', true)$$), '42501', 'authenticated cannot purge');
reset role;
-- put the live rows back for the figures below
set local role service_role;
select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(1), now() - interval '1 hour', '[{"account_id": "11", "book_balance": "901.00"}, {"account_id": "12", "book_balance": "1900.25"}]');
select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(2), now() - interval '3 hours', '[{"account_id": "11", "book_balance": "800.00"}]');
reset role;

-- ---------------------------------------------------------------- RLS on the table: cross-lane denial
insert into fin.cash_book_balances (lane_id, connection_id, account_id, balance_date, book_balance, as_of)
select a.lane_id, a.connection_id, a.id, pg_temp.fri(1), 4242.42, now() - interval '1 hour' from fin.accounts a where a.source_id = '21';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from fin.cash_book_balances where lane_id = 'PKG'), 3, 'the owner at AAL2 reads the lane''s rows');
select is((select count(*)::int from fin.cash_book_balances where lane_id = 'APK'), 0, 'cross-lane: the owner of PKG reads none of APK''s rows');
reset role;
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from fin.cash_book_balances), 0, 'AAL1: no rows');
reset role;
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from fin.cash_book_balances), 0, 'a user without the finance view: no rows');
reset role;

-- ---------------------------------------------------------------- finance_cash: figures
-- Stored: Friday 1: 11 = 901.00, 12 = 1900.25 (as_of 1 hour ago); Friday 2: 11 = 800.00 only (12 missing, as_of 3 hours ago); Fridays 3 and 4: nothing.
select pg_temp.claims('owner@example.test', 'aal2');
create temp table fc on commit drop as select * from core.finance_cash('PKG', 4);
select is((select state || '/' || coalesce(reason, 'null') || '/' || weeks from fc), 'ok/null/4', 'state ok, no reason, four weeks');
select is((select jsonb_array_length(columns) from fc), 5, 'five columns: today and four week ends');
select is((select string_agg(c ->> 'kind', ',' order by o) from fc, jsonb_array_elements(columns) with ordinality t(c, o)), 'today,week_end,week_end,week_end,week_end', 'column kinds, today first');
select is((select (columns -> 1 ->> 'date')::date from fc), pg_temp.fri(1), 'the first week column is the Friday of the last completed week');
select is((select (columns -> 4 ->> 'date')::date from fc), pg_temp.fri(4), 'the oldest column is the fourth Friday back');
select is((select (columns -> 0 ->> 'date')::date from fc), pg_temp.today(), 'today''s column is dated today (New York)');
select is((select jsonb_array_length(accounts) from fc), 2, 'two accounts: the own ones (the other entity''s, deleted, inactive, non-bank and disconnected-file ones are not listed)');
select is((select string_agg(a ->> 'name', ',' order by o) from fc, jsonb_array_elements(accounts) with ordinality t(a, o)), 'Operating Checking,Savings', 'sorted by name');
select is((select (accounts -> 0 ->> 'shared')::boolean::text || '/' || (accounts -> 1 ->> 'shared')::boolean::text from fc), 'false/true', 'the account also mapped to another entity is flagged shared');
select is((select string_agg(coalesce(c ->> 'book_balance', 'null'), '|' order by o) from fc, jsonb_array_elements(accounts -> 0 -> 'cells') with ordinality t(c, o)), '1000.50|901.00|800.00|null|null', 'Operating Checking: today (the stored current balance), then the week ends; missing is null, never 0');
select is((select string_agg(coalesce(c ->> 'change', 'null'), '|' order by o) from fc, jsonb_array_elements(accounts -> 0 -> 'cells') with ordinality t(c, o)), '99.50|101.00|null|null|null', 'Operating Checking: the change from the next older column to the cent; null when either side is missing');
select is((select string_agg(coalesce(c ->> 'book_balance', 'null'), '|' order by o) from fc, jsonb_array_elements(accounts -> 1 -> 'cells') with ordinality t(c, o)), '2000.25|1900.25|null|null|null', 'Savings: no balance stored for the second Friday');
select is((select string_agg(coalesce(c ->> 'change', 'null'), '|' order by o) from fc, jsonb_array_elements(accounts -> 1 -> 'cells') with ordinality t(c, o)), '100.00|null|null|null|null', 'Savings: changes');
select is((select string_agg(coalesce(c ->> 'book_balance', 'null'), '|' order by o) from fc, jsonb_array_elements(totals) with ordinality t(c, o)), '3000.75|2801.25|null|null|null', 'totals: a column with a missing account has a null total, not a partial sum');
select is((select string_agg(coalesce(c ->> 'change', 'null'), '|' order by o) from fc, jsonb_array_elements(totals) with ordinality t(c, o)), '199.50|null|null|null|null', 'total changes are null when either total is missing');
select is((select string_agg(c ->> 'missing', '|' order by o) from fc, jsonb_array_elements(totals) with ordinality t(c, o)), '0|0|1|2|2', 'the number of accounts missing per column');
select is((select string_agg(c ->> 'read', '|' order by o) from fc, jsonb_array_elements(columns) with ordinality t(c, o)), '2|2|1|0|0', 'accounts read per column (0 = not read yet)');
select is((select (columns -> 1 ->> 'as_of')::timestamptz <= now() - interval '59 minutes' and (columns -> 1 ->> 'as_of')::timestamptz >= now() - interval '61 minutes' from fc), true, 'the as_of of a week column is when QuickBooks was read');
select is((select (columns -> 2 ->> 'as_of')::timestamptz <= now() - interval '179 minutes' and (columns -> 2 ->> 'as_of')::timestamptz >= now() - interval '181 minutes' from fc), true, 'each column has its own as_of (3 hours for the second week)');
select is((select columns -> 3 ->> 'as_of' is null and columns -> 4 ->> 'as_of' is null from fc), true, 'a column with nothing stored has no as_of ("not read yet")');
select is((select (columns -> 0 ->> 'as_of') is not null from fc), true, 'today''s column has the books-sync time');

-- The same accounts as Cash by account lists on the Overview, and today's total equals its total.
select is((select (select string_agg(j ->> 'name', ',' order by j ->> 'name') from jsonb_array_elements(cash_accounts) j) from core.home_finance('PKG')),
          (select string_agg(a ->> 'name', ',' order by a ->> 'name') from fc, jsonb_array_elements(accounts) a), 'the rows are exactly the accounts of the Overview''s Cash by account');
select is((select cash_total from core.home_finance('PKG')), (select (totals -> 0 ->> 'book_balance')::numeric from fc), 'today''s total equals the Overview''s cash total');

-- A disconnected connection's balances are not counted, even for the same QuickBooks id.
insert into fin.cash_book_balances (lane_id, connection_id, account_id, balance_date, book_balance, as_of)
select a.lane_id, a.connection_id, a.id, pg_temp.fri(3), 55555.55, now() from fin.accounts a where a.connection_id = '00000000-0000-4000-8000-000000005202' and a.source_id = '11';
select is((select count(*)::int from core.finance_cash('PKG', 4) f, jsonb_array_elements(f.accounts -> 0 -> 'cells') c where c ->> 'book_balance' = '55555.55'), 0, 'a disconnected connection''s balance is not shown');
select is((select (totals -> 3 ->> 'book_balance') is null from core.finance_cash('PKG', 4)), true, 'and does not complete a column');

-- Completing the data: every account stored for Friday 2: the total appears and changes follow.
reset role;
set local role service_role;
select core.fin_cash_book_balances_put('PKG', '00000000-0000-4000-8000-000000005201', pg_temp.fri(2), now() - interval '3 hours',
  '[{"account_id": "11", "book_balance": "800.00"}, {"account_id": "12", "book_balance": "1850.00"}]');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
select is((select string_agg(coalesce(c ->> 'book_balance', 'null') || '/' || coalesce(c ->> 'change', 'null'), '|' order by o) from core.finance_cash('PKG', 4) f, jsonb_array_elements(f.totals) with ordinality t(c, o)),
          '3000.75/199.50|2801.25/151.25|2650.00/null|null/null|null/null', 'a complete column has its total, and the change from a column with a missing total stays null');
select is((select string_agg(coalesce(c ->> 'change', 'null'), '|' order by o) from core.finance_cash('PKG', 4) f, jsonb_array_elements(f.accounts -> 1 -> 'cells') with ordinality t(c, o)), '100.00|50.25|null|null|null', 'Savings changes follow');

-- ---------------------------------------------------------------- the weeks setting, mapping reasons
select is((select jsonb_array_length(columns) from core.finance_cash('PKG', 2)), 3, 'an explicit number of weeks: today and two week ends');
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, config || jsonb_build_object('finance', coalesce(config -> 'finance', '{}'::jsonb)
  || jsonb_build_object('reports', coalesce(config #> '{finance,reports}', '{}'::jsonb) || jsonb_build_object('weeks', 2)))
from core.lane_config_current where lane_id = 'PKG';
select is((select jsonb_array_length(columns) from core.finance_cash('PKG')), 3, 'the configured weeks (lane_config finance.reports.weeks) are used');
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{entities,bank_accounts}', jsonb_build_array(jsonb_build_object('qbo_account_id', '13', 'owner_entity', 'APK')))
from core.lane_config_current where lane_id = 'PKG';
select is((select state || '/' || reason || '/' || jsonb_array_length(accounts) from core.finance_cash('PKG')), 'ok/no_own_bank_accounts/0', 'bank accounts mapped only to another entity: a reason, no rows');

-- ---------------------------------------------------------------- denial
set local role authenticated;
select is((select state || '/' || jsonb_array_length(columns) from core.finance_cash('APK', 4)), 'no_access/0', 'cross-lane: another lane''s cash is not readable');
reset role;
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select state || '/' || jsonb_array_length(accounts) from core.finance_cash('PKG', 4)), 'no_access/0', 'AAL1: no_access and no figure');
reset role;
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select state from core.finance_cash('PKG', 4)), 'no_access', 'a user without the finance view: no_access');
reset role;
set local role anon;
select is(pg_temp.refusal($$select * from core.finance_cash('PKG', 4)$$), '42501', 'anon cannot call finance_cash');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.refusal($$select * from core.finance_cash(null)$$), '22004', 'a lane is required');
select is(pg_temp.refusal($$select * from core.finance_cash('PKG', 0)$$), '22023', 'weeks below 1 are refused');
select is(pg_temp.refusal($$select * from core.finance_cash('PKG', 14)$$), '22023', 'weeks above 13 are refused');
reset role;
-- A user who holds the finance view in BOTH lanes asks for PKG and gets none of APK's figures.
insert into core.memberships (user_id, lane_id, role) values (pg_temp.uid('owner@example.test'), 'APK', 'owner');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.finance_cash('PKG', 4) f, jsonb_array_elements(f.accounts) a where a ->> 'name' = 'Other Lane Bank'), 0, 'two lanes: PKG''s cash lists none of APK''s accounts');
select is((select count(*)::int from core.finance_cash('PKG', 4) f, jsonb_array_elements(f.accounts -> 0 -> 'cells') c where c ->> 'book_balance' = '4242.42'), 0, 'two lanes: nor APK''s balance');
reset role;
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');

-- ---------------------------------------------------------------- the history switch (finance.reports.cash_history, default off)
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{entities,bank_accounts}', jsonb_build_array(
  jsonb_build_object('qbo_account_id', '11', 'owner_entity', 'PKG'), jsonb_build_object('qbo_account_id', '12', 'owner_entity', 'PKG')))
from core.lane_config_current where lane_id = 'PKG';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(core.fin_cash_history_enabled('PKG'), true, 'the switch is on in this lane''s config: true');
select is((select history_enabled from core.finance_cash('PKG', 2)), true, 'finance_cash says the history is on');
reset role;
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{finance,reports,cash_history}', 'false') from core.lane_config_current where lane_id = 'PKG';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(core.fin_cash_history_enabled('PKG'), false, 'switched off: false');
select is((select history_enabled || '/' || jsonb_array_length(columns) || '/' || (columns -> 0 ->> 'kind') from core.finance_cash('PKG', 4)), 'false/1/today', 'switched off: the Today column only, even though history rows exist');
select is((select (totals -> 0 ->> 'book_balance') from core.finance_cash('PKG', 4)), '3000.75', 'switched off: today''s total is still shown');
reset role;
-- absent key = off (the default); a string "true" is not true
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, config #- '{finance,reports,cash_history}' from core.lane_config_current where lane_id = 'PKG';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(core.fin_cash_history_enabled('PKG'), false, 'no key in the config: off');
reset role;
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{finance,reports,cash_history}', '"true"') from core.lane_config_current where lane_id = 'PKG';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(core.fin_cash_history_enabled('PKG'), false, 'the string "true" is not on');
reset role;
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{finance,reports,cash_history}', 'true') from core.lane_config_current where lane_id = 'PKG';
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is(core.fin_cash_history_enabled('PKG'), false, 'AAL1: false');
reset role;
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is(core.fin_cash_history_enabled('PKG'), false, 'no finance view: false');
select is(core.fin_cash_history_enabled('APK'), false, 'another lane: false');
reset role;
set local role anon;
select is(pg_temp.refusal($$select core.fin_cash_history_enabled('PKG')$$), '42501', 'anon cannot call it');
reset role;
select ok((select prosecdef and proconfig = array['search_path=""'] and provolatile = 's' from pg_proc where oid = 'core.fin_cash_history_enabled(text)'::regprocedure), 'fin_cash_history_enabled: the one definer, stable, empty search_path');
select ok((select bool_and(not prosecdef and proconfig = array['search_path=""'] and has_function_privilege('service_role', oid, 'execute') and not has_function_privilege('authenticated', oid, 'execute') and not has_function_privilege('anon', oid, 'execute'))
           from pg_proc where oid in ('core.fin_cash_accounts(text, uuid)'::regprocedure, 'core.fin_cash_book_balances_purge(text, uuid, boolean)'::regprocedure)),
          'fin_cash_accounts and the purge: invoker, empty search_path, service_role only');

-- ---------------------------------------------------------------- the business week (the same fixed instants and Fridays as cashHistoryDates in
-- packages/connectors/src/quickbooks/bank-balances.test.ts: keep the two lists equal)
create function pg_temp.fridays(p_at timestamptz, p_n int) returns text language sql as $$
  select string_agg((core.business_week_start((p_at at time zone 'America/New_York')::date) - 7 * (k - 1) - 1)::text, ',' order by k) from generate_series(1, p_n) k $$;
select is(core.business_week_start('2026-11-27'), '2026-11-21'::date, 'a Friday belongs to the week that started the Saturday before');
select is(core.business_week_start('2026-11-28'), '2026-11-28'::date, 'a Saturday starts its own week');
select is(core.business_week_start('2026-11-29'), '2026-11-28'::date, 'a Sunday belongs to the week that began the day before');
select is(core.business_week_start('2027-01-01'), '2026-12-26'::date, 'across a year end');
select is(pg_temp.fridays('2026-11-27T17:00:00Z', 4), '2026-11-20,2026-11-13,2026-11-06,2026-10-30', 'on a Friday the running week is not complete');
select is(pg_temp.fridays('2026-11-28T17:00:00Z', 4), '2026-11-27,2026-11-20,2026-11-13,2026-11-06', 'on a Saturday the week that ended yesterday is complete');
select is(pg_temp.fridays('2026-11-29T17:00:00Z', 2), '2026-11-27,2026-11-20', 'on a Sunday');
select is(pg_temp.fridays('2026-11-28T03:30:00Z', 2), '2026-11-20,2026-11-13', '22:30 Friday New York is already Saturday in UTC: the New York date wins');
select is(pg_temp.fridays('2026-11-28T05:30:00Z', 2), '2026-11-27,2026-11-20', '00:30 Saturday New York');
select is(pg_temp.fridays('2027-01-02T07:30:00Z', 4), '2027-01-01,2026-12-25,2026-12-18,2026-12-11', 'across a year end (Saturday)');
select is(pg_temp.fridays('2027-01-06T07:30:00Z', 3), '2027-01-01,2026-12-25,2026-12-18', 'across a year end (mid-week)');
select is(pg_temp.fridays('2026-12-31T20:00:00Z', 2), '2026-12-25,2026-12-18', 'the last day of the year');
select is(pg_temp.fridays('2026-11-01T05:30:00Z', 4), '2026-10-30,2026-10-23,2026-10-16,2026-10-09', 'fall-back night, first 01:30');
select is(pg_temp.fridays('2026-11-01T06:30:00Z', 4), '2026-10-30,2026-10-23,2026-10-16,2026-10-09', 'fall-back night, second 01:30');
select is(pg_temp.fridays('2026-03-08T07:30:00Z', 4), '2026-03-06,2026-02-27,2026-02-20,2026-02-13', 'spring-forward day');
select ok((select provolatile = 'i' and proconfig = array['search_path=""'] and has_function_privilege('authenticated', oid, 'execute') and not has_function_privilege('anon', oid, 'execute') from pg_proc where oid = 'core.business_week_start(date)'::regprocedure), 'business_week_start: immutable, empty search_path, not for anon');

-- ---------------------------------------------------------------- naming: never "bank balance" in a name (spec section 3)
select is((select count(*)::int from (
  select table_name as n from information_schema.tables where table_schema in ('fin', 'core')
  union all select column_name from information_schema.columns where table_schema in ('fin', 'core')
  union all select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname in ('fin', 'core')
  union all select proargnames::text from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname in ('fin', 'core') and proargnames is not null
) x where n ~* 'bank[_ ]?balance'), 0, 'no table, column, function or argument in fin or core is named like "bank balance"');

-- ---------------------------------------------------------------- every connection disconnected: not_connected, no figure
update core.connections set status = 'disconnected' where id = '00000000-0000-4000-8000-000000005201';
select pg_temp.claims('owner@example.test', 'aal2');
select is((select state || '/' || jsonb_array_length(accounts) from core.finance_cash('PKG', 4)), 'not_connected/0', 'every connection disconnected: not_connected, no rows');

select * from finish();
rollback;
