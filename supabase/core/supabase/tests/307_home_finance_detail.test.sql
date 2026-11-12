-- Home finance detail (T-237 part A): core.home_finance_detail.
-- Covered: privileges and security mode, states (not_connected, no_data, mapping_missing, ok, no_access), bills due in 14 days
-- (window edges today / +14 / +15 / yesterday, voided / deleted / zero / other entity / unmapped), AR aging bucket boundaries
-- (0, 1, 30, 31, 60, 61, 90, 91 days, null due date, not yet due), exclusions, oldest three (order, ties, limit, no ids,
-- null customer), and denial: another lane (rows exist, caller is not a member), AAL1, no finance view, outsider, anon.
begin;
select plan(53);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code in ('APK', 'NC');
-- The owner is a member of APK in the seed; drop that so APK is a lane the owner may NOT see (cross-lane denial).
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
select ok(has_function_privilege('authenticated', 'core.home_finance_detail(text)', 'execute'), 'authenticated executes it');
select ok(not has_function_privilege('anon', 'core.home_finance_detail(text)', 'execute'), 'anon does not');
select ok((select not prosecdef and proconfig = array['search_path=""'] and provolatile = 's' from pg_proc where oid = 'core.home_finance_detail(text)'::regprocedure),
          'security invoker, stable, empty search_path');

-- ---------------------------------------------------------------- not connected
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state from core.home_finance_detail('NC')), 'not_connected', 'a lane without a QuickBooks connection is not_connected');
select is((select bills_due_14_total is null and bills_due_14_count is null and aging = '[]'::jsonb and oldest = '[]'::jsonb from core.home_finance_detail('NC')), true, 'not_connected: no figures');
select is((select count(*)::int from core.home_finance_detail('NC')), 1, 'always exactly one row');
select throws_ok($$select * from core.home_finance_detail(null)$$, '22004', null, 'a lane is required');
reset role;

-- ---------------------------------------------------------------- connected, nothing synced
insert into core.connections (id, lane_id, provider, external_account_id, status, last_sync_at) values
  ('00000000-0000-4000-8000-000000003701', 'PKG', 'quickbooks', '8800000000371', 'active', now() - interval '2 hours'),
  ('00000000-0000-4000-8000-000000003702', 'APK', 'quickbooks', '8800000000372', 'active', now() - interval '1 hour');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state from core.home_finance_detail('PKG')), 'no_data', 'connected but nothing synced: no_data');
select ok((select as_of is not null and aging = '[]'::jsonb and bills_due_14_total is null from core.home_finance_detail('PKG')), 'no_data: as_of is set, no figures');
reset role;

-- mapping missing
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, config - 'entities' from core.lane_config_current where lane_id = 'PKG';
insert into fin.normalize_runs (lane_id, connection_id, class_tracking, class_fallback, counts, started_at, finished_at)
values ('PKG', '00000000-0000-4000-8000-000000003701', true, false, '{}', now() - interval '3 hours', now() - interval '2 hours 59 minutes');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state from core.home_finance_detail('PKG')), 'mapping_missing', 'no entity mapping: mapping_missing');
select is((select bills_due_14_total is null and oldest = '[]'::jsonb from core.home_finance_detail('PKG')), true, 'mapping_missing: no figures');
reset role;

insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1,
  config || jsonb_build_object('entities', jsonb_build_object('own_entity', 'PKG',
    'by_entity', jsonb_build_object('PKG', jsonb_build_object('qbo_class_ids', jsonb_build_array('class-synthetic-pkg'), 'qbo_customer_ids', '[]'::jsonb,
                                                              'stripe_product_ids', '[]'::jsonb, 'ghl_tags', '[]'::jsonb, 'ghl_products', '[]'::jsonb)),
    'bank_accounts', '[]'::jsonb))
from core.lane_config_current where lane_id = 'PKG';

-- ---------------------------------------------------------------- fixtures
create function pg_temp.d(p_days int) returns date language sql as $$ select ((now() at time zone 'America/New_York')::date - p_days) $$;
create function pg_temp.iid(p_n int) returns uuid language sql as $$ select ('00000000-0000-4000-8000-0000000037' || lpad(p_n::text, 2, '0'))::uuid $$;

-- Own-entity (PKG) open USD invoices. Bucket by days past due: current = 0, null, not yet due; 1_30 = 1, 30; 31_60 = 31, 60;
-- 61_90 = 61, 90; 90_plus = 91, 200 and the three 300-day ties.
insert into fin.invoices (id, lane_id, connection_id, source_id, customer_name, issue_date, due_date, total, balance, entity_code, voided, deleted, currency_code) values
  (pg_temp.iid(1),  'PKG', '00000000-0000-4000-8000-000000003701', 'i-01', 'Synthetic Co 01', pg_temp.d(100), pg_temp.d(0),    1.00,     1.00,     'PKG', false, false, 'USD'),
  (pg_temp.iid(2),  'PKG', '00000000-0000-4000-8000-000000003701', 'i-02', 'Synthetic Co 02', pg_temp.d(100), null,            2.00,     2.00,     'PKG', false, false, 'USD'),
  (pg_temp.iid(3),  'PKG', '00000000-0000-4000-8000-000000003701', 'i-03', 'Synthetic Co 03', pg_temp.d(100), pg_temp.d(-5),   4.00,     4.00,     'PKG', false, false, 'USD'),
  (pg_temp.iid(4),  'PKG', '00000000-0000-4000-8000-000000003701', 'i-04', 'Synthetic Co 04', pg_temp.d(100), pg_temp.d(1),    10.00,    10.00,    'PKG', false, false, 'USD'),
  (pg_temp.iid(5),  'PKG', '00000000-0000-4000-8000-000000003701', 'i-05', 'Synthetic Co 05', pg_temp.d(100), pg_temp.d(30),   20.00,    20.00,    'PKG', false, false, 'USD'),
  (pg_temp.iid(6),  'PKG', '00000000-0000-4000-8000-000000003701', 'i-06', 'Synthetic Co 06', pg_temp.d(100), pg_temp.d(31),   100.00,   100.00,   'PKG', false, false, 'USD'),
  (pg_temp.iid(7),  'PKG', '00000000-0000-4000-8000-000000003701', 'i-07', 'Synthetic Co 07', pg_temp.d(100), pg_temp.d(60),   200.00,   200.00,   'PKG', false, false, 'USD'),
  (pg_temp.iid(8),  'PKG', '00000000-0000-4000-8000-000000003701', 'i-08', 'Synthetic Co 08', pg_temp.d(100), pg_temp.d(61),   1000.00,  1000.00,  'PKG', false, false, 'USD'),
  (pg_temp.iid(9),  'PKG', '00000000-0000-4000-8000-000000003701', 'i-09', 'Synthetic Co 09', pg_temp.d(100), pg_temp.d(90),   2000.00,  2000.00,  'PKG', false, false, 'USD'),
  (pg_temp.iid(10), 'PKG', '00000000-0000-4000-8000-000000003701', 'i-10', 'Synthetic Co 10', pg_temp.d(150), pg_temp.d(91),   10000.00, 10000.00, 'PKG', false, false, 'USD'),
  (pg_temp.iid(11), 'PKG', '00000000-0000-4000-8000-000000003701', 'i-11', 'Synthetic Co 11', pg_temp.d(250), pg_temp.d(200),  20000.00, 20000.00, 'PKG', false, false, 'USD'),
  (pg_temp.iid(12), 'PKG', '00000000-0000-4000-8000-000000003701', 'i-12', 'Tie B',           pg_temp.d(350), pg_temp.d(300),  7.00,     7.00,     'PKG', false, false, 'USD'),
  (pg_temp.iid(13), 'PKG', '00000000-0000-4000-8000-000000003701', 'i-13', 'Tie A',           pg_temp.d(350), pg_temp.d(300),  7.00,     7.00,     'PKG', false, false, 'USD'),
  (pg_temp.iid(14), 'PKG', '00000000-0000-4000-8000-000000003701', 'i-14', null,              pg_temp.d(350), pg_temp.d(300),  9.00,     9.00,     'PKG', false, false, 'USD'),
  -- Not counted: voided, deleted, zero balance, CAD, other entity.
  (pg_temp.iid(20), 'PKG', '00000000-0000-4000-8000-000000003701', 'i-20', 'Excluded', pg_temp.d(500), pg_temp.d(400), 99999.00, 99999.00, 'PKG', true,  false, 'USD'),
  (pg_temp.iid(21), 'PKG', '00000000-0000-4000-8000-000000003701', 'i-21', 'Excluded', pg_temp.d(500), pg_temp.d(400), 99999.00, 99999.00, 'PKG', false, true,  'USD'),
  (pg_temp.iid(22), 'PKG', '00000000-0000-4000-8000-000000003701', 'i-22', 'Excluded', pg_temp.d(500), pg_temp.d(400), 99999.00, 0.00,     'PKG', false, false, 'USD'),
  (pg_temp.iid(23), 'PKG', '00000000-0000-4000-8000-000000003701', 'i-23', 'Excluded', pg_temp.d(500), pg_temp.d(400), 99999.00, 99999.00, 'PKG', false, false, 'CAD'),
  (pg_temp.iid(24), 'PKG', '00000000-0000-4000-8000-000000003701', 'i-24', 'Excluded', pg_temp.d(500), pg_temp.d(400), 99999.00, 99999.00, 'APK', false, false, 'USD'),
  -- Unmapped: counted once (the voided one does not count), never summed.
  (pg_temp.iid(25), 'PKG', '00000000-0000-4000-8000-000000003701', 'i-25', 'Unmapped', pg_temp.d(500), pg_temp.d(400), 99999.00, 99999.00, 'unmapped', false, false, 'USD'),
  (pg_temp.iid(26), 'PKG', '00000000-0000-4000-8000-000000003701', 'i-26', 'Unmapped', pg_temp.d(500), pg_temp.d(400), 99999.00, 99999.00, 'unmapped', true,  false, 'USD'),
  -- Another lane, entity PKG: must never reach PKG's figures.
  (pg_temp.iid(30), 'APK', '00000000-0000-4000-8000-000000003702', 'a-30', 'Other lane', pg_temp.d(500), pg_temp.d(400), 7777.00, 7777.00, 'PKG', false, false, 'USD');

-- Bills: window edges today (1.00), +14 (2.00), +3 (16.00) are in; +15 (4.00), yesterday (8.00), no due date are out.
insert into fin.bills (id, lane_id, connection_id, source_id, issue_date, due_date, total, balance, entity_code, voided, deleted) values
  (pg_temp.iid(40), 'PKG', '00000000-0000-4000-8000-000000003701', 'b-40', pg_temp.d(30), pg_temp.d(0),    1.00,  1.00,  'PKG', false, false),
  (pg_temp.iid(41), 'PKG', '00000000-0000-4000-8000-000000003701', 'b-41', pg_temp.d(30), pg_temp.d(-14),  2.00,  2.00,  'PKG', false, false),
  (pg_temp.iid(42), 'PKG', '00000000-0000-4000-8000-000000003701', 'b-42', pg_temp.d(30), pg_temp.d(-3),   16.00, 16.00, 'PKG', false, false),
  (pg_temp.iid(43), 'PKG', '00000000-0000-4000-8000-000000003701', 'b-43', pg_temp.d(30), pg_temp.d(-15),  4.00,  4.00,  'PKG', false, false),
  (pg_temp.iid(44), 'PKG', '00000000-0000-4000-8000-000000003701', 'b-44', pg_temp.d(30), pg_temp.d(1),    8.00,  8.00,  'PKG', false, false),
  (pg_temp.iid(45), 'PKG', '00000000-0000-4000-8000-000000003701', 'b-45', pg_temp.d(30), null,            32.00, 32.00, 'PKG', false, false),
  -- Not counted: voided, deleted, zero balance, other entity.
  (pg_temp.iid(46), 'PKG', '00000000-0000-4000-8000-000000003701', 'b-46', pg_temp.d(30), pg_temp.d(-2), 5000.00, 5000.00, 'PKG', true,  false),
  (pg_temp.iid(47), 'PKG', '00000000-0000-4000-8000-000000003701', 'b-47', pg_temp.d(30), pg_temp.d(-2), 5000.00, 5000.00, 'PKG', false, true),
  (pg_temp.iid(48), 'PKG', '00000000-0000-4000-8000-000000003701', 'b-48', pg_temp.d(30), pg_temp.d(-2), 5000.00, 0.00,    'PKG', false, false),
  (pg_temp.iid(49), 'PKG', '00000000-0000-4000-8000-000000003701', 'b-49', pg_temp.d(30), pg_temp.d(-2), 5000.00, 5000.00, 'APK', false, false),
  -- Unmapped: one open (counted, not summed), one voided (not counted).
  (pg_temp.iid(50), 'PKG', '00000000-0000-4000-8000-000000003701', 'b-50', pg_temp.d(30), pg_temp.d(-2), 5000.00, 5000.00, 'unmapped', false, false),
  (pg_temp.iid(51), 'PKG', '00000000-0000-4000-8000-000000003701', 'b-51', pg_temp.d(30), pg_temp.d(-2), 5000.00, 5000.00, 'unmapped', true,  false),
  -- Unmapped but overdue (outside the window): not counted in unmapped_bills.
  (pg_temp.iid(53), 'PKG', '00000000-0000-4000-8000-000000003701', 'b-53', pg_temp.d(30), pg_temp.d(1), 5000.00, 5000.00, 'unmapped', false, false),
  -- Another lane, entity PKG, due in the window.
  (pg_temp.iid(52), 'APK', '00000000-0000-4000-8000-000000003702', 'b-52', pg_temp.d(30), pg_temp.d(-2), 5555.00, 5555.00, 'PKG', false, false);

-- ---------------------------------------------------------------- ok
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state from core.home_finance_detail('PKG')), 'ok', 'connected, mapped and synced: ok');
select is((select count(*)::int from core.home_finance_detail('PKG')), 1, 'one row');
select ok((select as_of < now() - interval '2 hours 50 minutes' and as_of > now() - interval '3 hours 10 minutes' from core.home_finance_detail('PKG')), 'as_of is the last normalizer run');

-- bills
select is((select bills_due_14_total from core.home_finance_detail('PKG')), 19.00::numeric, 'bills due: today 1.00 + day 14 2.00 + day 3 16.00 (day 15, yesterday and no due date left out)');
select is((select bills_due_14_count from core.home_finance_detail('PKG')), 3, 'bills due: three bills');
select is((select unmapped_bills from core.home_finance_detail('PKG')), 1, 'bills: one open unmapped bill due in the window counted (the voided and the overdue ones are not)');

-- aging order and keys
select is((select jsonb_array_length(aging) from core.home_finance_detail('PKG')), 5, 'aging: five buckets');
select is((select array(select e ->> 'bucket' from jsonb_array_elements(aging) e)::text from core.home_finance_detail('PKG')),
          '{current,1_30,31_60,61_90,90_plus}', 'aging: bucket order');
select is((select not exists (select 1 from jsonb_array_elements(aging) e where (select array_agg(k order by k) from jsonb_object_keys(e) k) <> array['bucket', 'count', 'total'])
           from core.home_finance_detail('PKG')), true, 'aging: keys are bucket, total, count only');
select is((select (aging -> 0 ->> 'total') || '/' || (aging -> 0 ->> 'count') from core.home_finance_detail('PKG')), '5.00/2', 'aging current: 0 days and not yet due (the no-due-date invoice issued 100 days ago is not current)');
select is((select (aging -> 1 ->> 'total') || '/' || (aging -> 1 ->> 'count') from core.home_finance_detail('PKG')), '30.00/2', 'aging 1_30: 1 and 30 days');
select is((select (aging -> 2 ->> 'total') || '/' || (aging -> 2 ->> 'count') from core.home_finance_detail('PKG')), '300.00/2', 'aging 31_60: 31 and 60 days');
select is((select (aging -> 3 ->> 'total') || '/' || (aging -> 3 ->> 'count') from core.home_finance_detail('PKG')), '3000.00/2', 'aging 61_90: 61 and 90 days');
select is((select (aging -> 4 ->> 'total') || '/' || (aging -> 4 ->> 'count') from core.home_finance_detail('PKG')), '30025.00/6', 'aging 90_plus: 91, 200, the three 300-day invoices and the no-due-date invoice issued 100 days ago (issue date is used)');
select is((select jsonb_typeof(aging -> 0 -> 'total') from core.home_finance_detail('PKG')), 'number', 'aging: total is a JSON number');
select is((select (select sum((e ->> 'total')::numeric) from jsonb_array_elements(aging) e where e ->> 'bucket' in ('31_60', '61_90', '90_plus'))
           from core.home_finance_detail('PKG')), (select ar_over_30 from core.home_finance('PKG')), '31_60 + 61_90 + 90_plus equals home_finance ar_over_30 (same date rule, same boundary)');
select is((select unmapped_invoices from core.home_finance_detail('PKG')), 1, 'invoices: one open unmapped invoice counted, the voided one is not');

-- oldest: 300 days (9.00, then the two 7.00 ties by id) beat the 200-day one; limit 3
select is((select jsonb_array_length(oldest) from core.home_finance_detail('PKG')), 3, 'oldest: limited to three');
select is((select oldest -> 0 ->> 'days_overdue' from core.home_finance_detail('PKG')), '300', 'oldest: days overdue');
select is((select oldest -> 0 ->> 'balance' from core.home_finance_detail('PKG')), '9.00', 'oldest: larger balance first among equal days');
select is((select jsonb_typeof(oldest -> 0 -> 'customer') from core.home_finance_detail('PKG')), 'null', 'oldest: a missing customer name stays null');
select is((select (oldest -> 1 ->> 'customer') || ',' || (oldest -> 2 ->> 'customer') from core.home_finance_detail('PKG')), 'Tie B,Tie A', 'oldest: equal days and balance break by id (id 12 before id 13)');
select is((select not exists (select 1 from jsonb_array_elements(oldest) e where (select array_agg(k order by k) from jsonb_object_keys(e) k) <> array['balance', 'customer', 'days_overdue'])
           from core.home_finance_detail('PKG')), true, 'oldest: keys are customer, balance, days_overdue only (no ids)');
select is((select oldest::text !~ '[0-9a-f]{8}-[0-9a-f]{4}-' and aging::text !~ '[0-9a-f]{8}-[0-9a-f]{4}-' from core.home_finance_detail('PKG')), true, 'no uuid appears in the output');
reset role;

-- oldest, next three once the 300-day ones are paid: 200, 91, 90 days (a not-yet-due or current invoice never appears)
update fin.invoices set balance = 0 where id in (pg_temp.iid(12), pg_temp.iid(13), pg_temp.iid(14));
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select array(select (e ->> 'days_overdue') || ':' || (e ->> 'balance') from jsonb_array_elements(oldest) e)::text from core.home_finance_detail('PKG')),
          '{200:20000.00,100:2.00,91:10000.00}', 'oldest: next by days overdue; paid invoices drop out');
reset role;
update fin.invoices set balance = 0 where id <> pg_temp.iid(1) and lane_id = 'PKG' and customer_name like 'Synthetic Co%' and id <> pg_temp.iid(3);
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select oldest from core.home_finance_detail('PKG')), '[]'::jsonb, 'oldest: nothing overdue gives an empty array (due today and not yet due are not overdue)');
select is((select (aging -> 4 ->> 'total') || '/' || (aging -> 4 ->> 'count') from core.home_finance_detail('PKG')), '0.00/0', 'an empty bucket is present with 0.00 and 0');
reset role;

-- ---------------------------------------------------------------- other roles in the lane
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select bills_due_14_total from core.home_finance_detail('PKG')), 19.00::numeric, 'a viewer with the finance view reads the figures');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select bills_due_14_count from core.home_finance_detail('PKG')), 3, 'finance_operator reads the figures');
reset role;

-- ---------------------------------------------------------------- cross-lane
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select state from core.home_finance_detail('APK')), 'no_access', 'another lane: no_access');
select is((select count(*)::int from fin.invoices where lane_id = 'APK'), 0, 'RLS: the owner sees no APK invoices');
select is((select count(*)::int from fin.bills where lane_id = 'APK'), 0, 'RLS: the owner sees no APK bills');
select is((select bills_due_14_total is null and bills_due_14_count is null and aging = '[]'::jsonb and oldest = '[]'::jsonb and as_of is null
                  and unmapped_invoices = 0 and unmapped_bills = 0 from core.home_finance_detail('APK')), true, 'another lane: nothing at all');
select is((select bills_due_14_total from core.home_finance_detail('PKG')), 19.00::numeric, 'PKG never includes the other lane''s 5555.00 bill');
select is((select (aging -> 4 ->> 'total') from core.home_finance_detail('PKG')), '0.00', 'PKG aging never includes the other lane''s 7777.00 invoice');
reset role;
select is((select sum(balance) from fin.invoices where lane_id = 'APK'), 7777.00::numeric, 'fixture check: APK has an overdue invoice');
select is((select sum(balance) from fin.bills where lane_id = 'APK'), 5555.00::numeric, 'fixture check: APK has a bill due in the window');

-- ---------------------------------------------------------------- AAL1, no finance view, outsider, anon
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select state from core.home_finance_detail('PKG')), 'no_access', 'AAL1: no_access even for the owner');
select is((select bills_due_14_total is null and aging = '[]'::jsonb from core.home_finance_detail('PKG')), true, 'AAL1: no figures');
reset role;

select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select state from core.home_finance_detail('PKG')), 'no_access', 'admin_technical (no finance view): no_access');
reset role;

select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select state from core.home_finance_detail('PKG')), 'no_access', 'an outsider: no_access');
reset role;

set local role anon;
select throws_ok($$select * from core.home_finance_detail('PKG')$$, '42501', null, 'anon cannot call home_finance_detail');
reset role;

select * from finish();
rollback;
