-- Finance normalized schema part 1 (T-055): column types, source refs and key/lane/provider consistency, forbidden
-- columns, the standard 'finance' lane policy, the role matrix (owner, finance_operator, viewer with and without the
-- named view, admin_technical, outsider, anon, AAL1), cross-lane denial and service_role-only writes. Includes the
-- review fixes of migration 20261104130000 (currency, payment allocations, report guard, names, indexes, grants).
begin;
select plan(316);
\ir helpers/lane_rls.psql

-- ---------------------------------------------------------------- schema and policies
select has_table('fin', t, 'fin.' || t || ' exists') from unnest(array['accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache']) t;
select pg_temp.has_standard_lane_policy(('fin.' || t)::regclass, 'finance') from unnest(array['accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache']) t;
select ok(not has_schema_privilege('anon', 'fin', 'usage') and has_schema_privilege('authenticated', 'fin', 'usage') and has_schema_privilege('service_role', 'fin', 'usage'),
          'schema fin: no anon usage; authenticated and service_role have usage');
select ok(has_table_privilege('service_role', ('fin.' || t)::regclass, 'select, insert, update') and not has_table_privilege('service_role', ('fin.' || t)::regclass, 'delete'),
          'service_role reads, inserts and updates fin.' || t || ' but cannot delete (rows are tombstoned)')
from unnest(array['accounts', 'transactions', 'invoices', 'payments', 'bills']) t;
select ok(has_table_privilege('service_role', 'fin.report_cache', 'select, insert, update, delete'), 'service_role may delete cached reports (a cache)');
select ok(not has_table_privilege('service_role', ('fin.' || t)::regclass, 'truncate'), 'service_role cannot truncate fin.' || t)
from unnest(array['accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache']) t;

-- ---------------------------------------------------------------- column types (rule 11)
select is(
  (select array_agg(format('%s.%s', c.relname, a.attname) order by c.relname, a.attname)
   from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'fin' and c.relname in ('accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache')
     and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
     and format_type(a.atttypid, a.atttypmod) = 'numeric(18,2)'),
  array['bills.balance', 'bills.total', 'invoices.balance', 'invoices.total', 'payments.amount', 'transactions.amount'],
  'money columns are exactly these, all numeric(18,2)'
);
select is(
  (select count(*)::int from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'fin' and c.relname in ('accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache')
     and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
     and (format_type(a.atttypid, a.atttypmod) ~ '^(numeric$|numeric\(|real|double precision|money|timestamp without time zone|time )')
     and format_type(a.atttypid, a.atttypmod) <> 'numeric(18,2)'),
  0, 'no other numeric, float, money or timezone-less time columns');
select is(
  (select array_agg(a.attname::text order by a.attname) from pg_attribute a
   where a.attrelid = 'fin.transactions'::regclass and a.attnum > 0 and not a.attisdropped and a.atttypid = 'date'::regtype),
  array['txn_date'], 'transactions.txn_date is a date');
select is((select array_agg(a.attname::text order by a.attname) from pg_attribute a
           where a.attrelid in ('fin.invoices'::regclass, 'fin.bills'::regclass) and a.attnum > 0 and not a.attisdropped and a.atttypid = 'date'::regtype),
          array['due_date', 'due_date', 'issue_date', 'issue_date'], 'invoice and bill dates are date columns');
select is(
  (select count(*)::int from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'fin' and c.relname in ('accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache')
     and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
     and a.attname ~ '(_at|_of)$' and a.atttypid <> 'timestamptz'::regtype),
  0, 'every *_at / as_of column is timestamptz');
select col_type_is('fin', t.tbl, t.col, 'timestamp with time zone', t.tbl || '.' || t.col || ' is timestamptz')
from (values ('transactions', 'posted_at'), ('payments', 'paid_at'), ('report_cache', 'as_of'), ('report_cache', 'fetched_at'),
             ('accounts', 'source_updated_at'), ('transactions', 'source_updated_at'), ('invoices', 'source_updated_at'),
             ('payments', 'source_updated_at'), ('bills', 'source_updated_at'), ('report_cache', 'source_updated_at')) t(tbl, col);

-- ---------------------------------------------------------------- columns the spec lists
select has_column('fin', t.tbl, c, t.tbl || ' has ' || c)
from (values ('accounts', array['lane_id', 'source_id', 'name', 'type', 'subtype', 'is_bank', 'entity_code', 'owner_entity_code', 'active']),
             ('transactions', array['lane_id', 'source_id', 'txn_type', 'txn_date', 'posted_at', 'account_id', 'class_id', 'entity_code', 'amount', 'is_uncategorized', 'voided', 'deleted', 'currency_code']),
             ('invoices', array['source_id', 'customer_id', 'issue_date', 'due_date', 'total', 'balance', 'class_id', 'entity_code', 'voided', 'currency_code', 'customer_name', 'multi_class']),
             ('payments', array['source_id', 'invoice_id', 'paid_at', 'amount', 'entity_code', 'currency_code', 'alloc_no', 'customer_name']),
             ('bills', array['source_id', 'vendor_id', 'issue_date', 'due_date', 'total', 'balance', 'class_id', 'entity_code', 'voided', 'currency_code', 'vendor_name', 'multi_class']),
             ('report_cache', array['lane_id', 'report', 'params', 'params_hash', 'payload', 'as_of', 'fetched_at'])) t(tbl, cols),
     unnest(t.cols) c;
select has_column('fin', t, c, t || ' has source ref ' || c)
from unnest(array['accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache']) t,
     unnest(array['provider', 'connection_id', 'raw_record_id', 'source_updated_at']) c;

-- ---------------------------------------------------------------- forbidden columns (rules 6, 7)
-- The word lists are raw's (one list governs both guards), plus the bank-balance and narrative words of this schema.
select is(
  (select array_agg(format('%s.%s', c.relname, a.attname) order by 1) from pg_attribute a
   join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'fin' and c.relname in ('accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache')
     and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
     and (raw.payload_has_forbidden_field(jsonb_build_object(a.attname, 1))
          or raw.payload_has_body_field(jsonb_build_object(a.attname, 1))
          or regexp_replace(lower(a.attname), '[^a-z0-9]', '', 'g') ~ 'bankbal')),
  null, 'no account/routing number, credential, compensation, tax id, bank balance or body/narrative column in fin');
select is(
  (select array_agg(format('%s.%s', c.relname, a.attname) order by 1) from pg_attribute a
   join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'fin' and c.relname in ('accounts', 'report_cache', 'transactions', 'payments')
     and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped and a.attname ~* 'balance'),
  null, 'only invoices and bills carry a balance column (the open document amount)');
select hasnt_column('fin', 'accounts', 'balance', 'fin.accounts stores no balance (cash comes from the Balance Sheet cache as book balance)');
select hasnt_column('fin', 'accounts', 'book_balance', 'fin.accounts has no book_balance either');

-- ---------------------------------------------------------------- triggers
select has_trigger('fin', t, t || '_set_updated_at', t || ' maintains updated_at') from unnest(array['accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache']) t;
select has_trigger('fin', t, t || '_identity', t || ' freezes its identity columns') from unnest(array['accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache']) t;
select has_trigger('fin', 'report_cache', 'report_cache_b_guard', 'report_cache guards its payload');
select ok(not has_function_privilege('authenticated', 'fin.forbid_identity_change()', 'execute')
          and not has_function_privilege('anon', 'fin.forbid_identity_change()', 'execute')
          and not has_function_privilege('authenticated', 'fin.report_cache_set_hash()', 'execute')
          and not has_function_privilege('anon', 'fin.report_cache_set_hash()', 'execute')
          and not has_function_privilege('authenticated', 'fin.report_cache_guard()', 'execute')
          and not has_function_privilege('anon', 'fin.report_cache_guard()', 'execute'),
          'trigger functions are not callable by API roles');

-- ---------------------------------------------------------------- fixtures (service_role is the real writer)
update core.lanes set enabled = true where code = 'APK';
insert into core.connections (id, lane_id, provider, external_account_id, status) values
  ('00000000-0000-4000-8000-000000000551', 'PKG', 'quickbooks', 'realm-synthetic-55', 'active'),
  ('00000000-0000-4000-8000-000000000552', 'PKG', 'quickbooks', 'realm-synthetic-55b', 'active'),
  ('00000000-0000-4000-8000-000000000553', 'APK', 'quickbooks', 'realm-synthetic-55c', 'active'),
  ('00000000-0000-4000-8000-000000000554', 'PKG', 'stripe', 'acct-synthetic-55', 'active');
set local role service_role;
select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000551',
  '[{"object_type": "Invoice", "external_id": "inv-1", "payload": {"Id": "inv-1"}, "synced_at": "2026-11-04T10:00:00Z"}]');
select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000552',
  '[{"object_type": "Invoice", "external_id": "inv-9", "payload": {"Id": "inv-9"}, "synced_at": "2026-11-04T10:00:00Z"}]');
reset role;
create temp table raw_ids on commit drop as
  select (select id from raw.source_records where connection_id = '00000000-0000-4000-8000-000000000551') as own,
         (select id from raw.source_records where connection_id = '00000000-0000-4000-8000-000000000552') as other_connection;
grant select on raw_ids to service_role;

set local role service_role;
select lives_ok($$
  insert into fin.accounts (id, lane_id, connection_id, source_id, raw_record_id, source_updated_at, name, type, subtype, is_bank, entity_code, owner_entity_code)
  values ('55000000-0000-4000-8000-000000000001', 'PKG', '00000000-0000-4000-8000-000000000551', 'acct-1',
          (select own from raw_ids), '2026-11-03T10:00:00Z', 'Synthetic Checking', 'Bank', 'Checking', true, 'PKG', 'PKG')$$,
  'service_role writes an account with a raw record ref');
select lives_ok($$
  insert into fin.accounts (id, lane_id, connection_id, source_id, name, type) values
    ('55000000-0000-4000-8000-000000000002', 'PKG', '00000000-0000-4000-8000-000000000551', 'acct-2', 'Synthetic Income', 'Income'),
    ('55000000-0000-4000-8000-000000000003', 'PKG', '00000000-0000-4000-8000-000000000552', 'acct-1', 'Synthetic Other File', 'Income'),
    ('55000000-0000-4000-8000-000000000004', 'APK', '00000000-0000-4000-8000-000000000553', 'acct-1', 'Synthetic APK Checking', 'Bank')$$,
  'accounts in another file of the lane and in another lane are written (source ids are per connection)');
select lives_ok($$
  insert into fin.invoices (id, lane_id, connection_id, source_id, customer_id, issue_date, due_date, total, balance, class_id, entity_code) values
    ('55000000-0000-4000-8000-000000000011', 'PKG', '00000000-0000-4000-8000-000000000551', 'inv-1', 'cust-1', '2026-10-01', '2026-10-31', 100.00, 40.00, 'class-1', 'PKG'),
    ('55000000-0000-4000-8000-000000000012', 'APK', '00000000-0000-4000-8000-000000000553', 'inv-1', 'cust-1', '2026-10-01', '2026-10-31', 70.00, 70.00, 'class-2', 'APK')$$,
  'invoices are written');
select lives_ok($$
  insert into fin.bills (id, lane_id, connection_id, source_id, vendor_id, issue_date, due_date, total, balance, class_id, entity_code) values
    ('55000000-0000-4000-8000-000000000021', 'PKG', '00000000-0000-4000-8000-000000000551', 'bill-1', 'vend-1', '2026-10-05', '2026-11-10', 55.50, 55.50, 'class-1', 'PKG'),
    ('55000000-0000-4000-8000-000000000022', 'APK', '00000000-0000-4000-8000-000000000553', 'bill-1', 'vend-1', '2026-10-05', '2026-11-10', 9.00, 9.00, null, 'unmapped')$$,
  'bills are written');
select lives_ok($$
  insert into fin.payments (id, lane_id, connection_id, source_id, alloc_no, invoice_id, paid_at, amount, entity_code) values
    ('55000000-0000-4000-8000-000000000031', 'PKG', '00000000-0000-4000-8000-000000000551', 'pay-1', 0, '55000000-0000-4000-8000-000000000011', '2026-10-20T15:00:00Z', 60.00, 'PKG'),
    ('55000000-0000-4000-8000-000000000032', 'PKG', '00000000-0000-4000-8000-000000000551', 'pay-1', 1, null, '2026-10-20T15:00:00Z', 5.00, 'PKG'),
    ('55000000-0000-4000-8000-000000000033', 'APK', '00000000-0000-4000-8000-000000000553', 'pay-1', 0, '55000000-0000-4000-8000-000000000012', '2026-10-21T15:00:00Z', 1.00, 'APK')$$,
  'payments are written, one row per allocation (an unapplied payment has no invoice)');
select lives_ok($$
  insert into fin.transactions (id, lane_id, connection_id, source_id, txn_type, line_no, txn_date, posted_at, account_id, class_id, entity_code, amount, is_uncategorized) values
    ('55000000-0000-4000-8000-000000000041', 'PKG', '00000000-0000-4000-8000-000000000551', 'txn-1', 'Purchase', 0, '2026-10-15', '2026-10-15T04:00:00Z', '55000000-0000-4000-8000-000000000001', 'class-1', 'PKG', -12.34, false),
    ('55000000-0000-4000-8000-000000000042', 'PKG', '00000000-0000-4000-8000-000000000551', 'txn-1', 'Deposit', 0, '2026-10-15', null, null, null, 'unmapped', 20.00, true),
    ('55000000-0000-4000-8000-000000000043', 'APK', '00000000-0000-4000-8000-000000000553', 'txn-1', 'Purchase', 0, '2026-10-15', '2026-10-15T04:00:00Z', '55000000-0000-4000-8000-000000000004', null, 'APK', -1.00, false)$$,
  'transactions are written (ids are unique per type; account and class are optional)');
select lives_ok($$
  insert into fin.report_cache (id, lane_id, connection_id, report, params, payload, as_of, fetched_at) values
    ('55000000-0000-4000-8000-000000000051', 'PKG', '00000000-0000-4000-8000-000000000551', 'balance_sheet', '{"method": "accrual", "class": "class-1"}', '{"Header": {"ReportName": "BalanceSheet"}, "Rows": {"Row": []}}', '2026-11-03T05:00:00Z', '2026-11-04T10:00:00Z'),
    ('55000000-0000-4000-8000-000000000052', 'APK', '00000000-0000-4000-8000-000000000553', 'balance_sheet', '{}', '{"Rows": {"Row": []}}', '2026-11-03T05:00:00Z', '2026-11-04T10:00:00Z')$$,
  'report cache rows are written');
reset role;

-- ---------------------------------------------------------------- value behaviour
select is((select params_hash from fin.report_cache where id = '55000000-0000-4000-8000-000000000051'),
          encode(sha256(convert_to('{"class": "class-1", "method": "accrual"}', 'UTF8')), 'hex'),
          'params_hash is the SHA-256 of the canonical params text, set by the database');
set local role service_role;
select lives_ok($$update fin.report_cache set params_hash = repeat('0', 64) where id = '55000000-0000-4000-8000-000000000051'$$,
                'a caller-supplied hash on UPDATE does not raise (it is overwritten before the freeze check)');
select lives_ok($$insert into fin.report_cache (id, lane_id, connection_id, report, params, params_hash, payload, as_of, fetched_at) values
  ('55000000-0000-4000-8000-000000000053', 'PKG', '00000000-0000-4000-8000-000000000551', 'cash_flow', '{"method": "cash"}', repeat('f', 64), '{}', '2026-11-03T05:00:00Z', now())$$,
                'a caller-supplied hash on INSERT is accepted and overwritten');
reset role;
select is((select params_hash from fin.report_cache where id = '55000000-0000-4000-8000-000000000051'),
          encode(sha256(convert_to('{"class": "class-1", "method": "accrual"}', 'UTF8')), 'hex'), 'the hash is still the hash of params after a caller-supplied value on UPDATE');
select is((select params_hash from fin.report_cache where id = '55000000-0000-4000-8000-000000000053'),
          encode(sha256(convert_to('{"method": "cash"}', 'UTF8')), 'hex'), 'a caller-supplied hash on INSERT is overwritten with the SHA-256 of params');
select is((select count(*)::int from fin.report_cache where id = '55000000-0000-4000-8000-000000000053' and params_hash = repeat('f', 64)), 0, 'the supplied INSERT hash is not stored');
set local role service_role;
select lives_ok($$delete from fin.report_cache where id = '55000000-0000-4000-8000-000000000053'$$, 'service_role deletes a cached report (cache rows are disposable)');
reset role;
set local role service_role;
select lives_ok($$update fin.transactions set amount = 10.005 where id = '55000000-0000-4000-8000-000000000041'$$, 'amount accepts three decimals');
reset role;
select is((select amount from fin.transactions where id = '55000000-0000-4000-8000-000000000041'), 10.01::numeric(18,2), 'money is stored to the cent');
select is((select count(*)::int from fin.accounts where is_bank and entity_code = owner_entity_code), 1, 'a bank account carries its owner entity');
select is((select entity_code from fin.invoices where id = '55000000-0000-4000-8000-000000000011'), 'PKG', 'entity_code is stored as given');
select is((select entity_code from fin.accounts where id = '55000000-0000-4000-8000-000000000002'), 'unmapped', 'entity_code defaults to unmapped');
select is((select voided or deleted from fin.invoices where id = '55000000-0000-4000-8000-000000000011'), false, 'voided and deleted default to false');
select is((select array_agg(distinct deleted) from (select deleted from fin.transactions union all select deleted from fin.payments union all select deleted from fin.bills) x), array[false], 'deleted defaults to false on transactions, payments and bills');
select is((select array_agg(distinct currency_code) from (select currency_code from fin.transactions union all select currency_code from fin.invoices union all select currency_code from fin.payments union all select currency_code from fin.bills) x), array['USD'], 'currency_code defaults to USD');
select is((select array_agg(distinct m) from (select multi_class m from fin.invoices union all select multi_class from fin.bills) x), array[false], 'multi_class defaults to false');
select is((select count(*)::int from fin.payments where alloc_no = 0), 2, 'alloc_no defaults to 0 (the APK payment) and is set explicitly otherwise');

-- ---------------------------------------------------------------- consistency (lane, provider, connection)
set local role service_role;
select throws_ok($$insert into fin.accounts (lane_id, connection_id, source_id, name, type) values ('APK', '00000000-0000-4000-8000-000000000551', 'x', 'n', 't')$$,
                 '23503', null, 'cross-lane: a row cannot sit in another lane than its connection');
select throws_ok($$insert into fin.invoices (lane_id, connection_id, source_id, issue_date, total, balance) values ('PKG', '00000000-0000-4000-8000-000000000553', 'x', '2026-10-01', 1, 1)$$,
                 '23503', null, 'cross-lane: an invoice cannot use another lane''s connection');
select throws_ok($$insert into fin.bills (lane_id, connection_id, source_id, issue_date, total, balance) values ('PKG', '00000000-0000-4000-8000-000000000554', 'x', '2026-10-01', 1, 1)$$,
                 '23503', null, 'the connection must be a QuickBooks connection (a Stripe connection is refused)');
select throws_ok($$insert into fin.accounts (lane_id, connection_id, provider, source_id, name, type) values ('PKG', '00000000-0000-4000-8000-000000000554', 'stripe', 'x', 'n', 't')$$,
                 '23514', null, 'part 1 stores QuickBooks rows only (provider check)');
select throws_ok($$insert into fin.report_cache (lane_id, connection_id, report, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000553', 'pnl', '{}', now(), now())$$,
                 '23503', null, 'cross-lane: a report cannot use another lane''s connection');
select throws_ok($$insert into fin.transactions (lane_id, connection_id, source_id, txn_type, txn_date, amount, account_id) values ('PKG', '00000000-0000-4000-8000-000000000551', 'y', 'Purchase', '2026-10-01', 1, '55000000-0000-4000-8000-000000000003')$$,
                 '23503', null, 'a transaction cannot point at an account of another connection');
select throws_ok($$insert into fin.transactions (lane_id, connection_id, source_id, txn_type, txn_date, amount, account_id) values ('PKG', '00000000-0000-4000-8000-000000000551', 'y', 'Purchase', '2026-10-01', 1, '55000000-0000-4000-8000-000000000004')$$,
                 '23503', null, 'cross-lane: a transaction cannot point at another lane''s account');
select throws_ok($$insert into fin.payments (lane_id, connection_id, source_id, invoice_id, paid_at, amount) values ('PKG', '00000000-0000-4000-8000-000000000551', 'z', '55000000-0000-4000-8000-000000000012', now(), 1)$$,
                 '23503', null, 'cross-lane: a payment cannot point at another lane''s invoice');
select throws_ok(format($$insert into fin.accounts (lane_id, connection_id, source_id, name, type, raw_record_id) values ('PKG', '00000000-0000-4000-8000-000000000551', 'w', 'n', 't', %L)$$, (select other_connection from raw_ids)),
                 '23503', null, 'a raw record of another connection is refused');
select throws_ok($$insert into fin.accounts (lane_id, connection_id, source_id, name, type) values ('PKG', '00000000-0000-4000-8000-000000000551', 'acct-1', 'dup', 't')$$,
                 '23505', null, 'source id is unique per connection');
select throws_ok($$insert into fin.transactions (lane_id, connection_id, source_id, txn_type, line_no, txn_date, amount) values ('PKG', '00000000-0000-4000-8000-000000000551', 'txn-1', 'Purchase', 0, '2026-10-01', 1)$$,
                 '23505', null, 'transaction key is (connection, type, source id, line)');
select throws_ok($$insert into fin.payments (lane_id, connection_id, source_id, alloc_no, invoice_id, paid_at, amount) values ('PKG', '00000000-0000-4000-8000-000000000551', 'pay-1', 1, null, now(), 1)$$,
                 '23505', null, 'a payment allocation is unique per (connection, payment, alloc_no)');
select throws_ok($$insert into fin.payments (lane_id, connection_id, source_id, alloc_no, paid_at, amount) values ('PKG', '00000000-0000-4000-8000-000000000551', 'z', -1, now(), 1)$$,
                 '23514', null, 'alloc_no must not be negative');
select throws_ok($$insert into fin.transactions (lane_id, connection_id, source_id, txn_type, line_no, txn_date, amount) values ('PKG', '00000000-0000-4000-8000-000000000551', 'ln', 'Purchase', -1, '2026-10-01', 1)$$,
                 '23514', null, 'line_no must not be negative');
-- a payment cannot point at an invoice of another connection of the same lane
select lives_ok($$insert into fin.invoices (id, lane_id, connection_id, source_id, issue_date, total, balance) values
  ('55000000-0000-4000-8000-000000000013', 'PKG', '00000000-0000-4000-8000-000000000552', 'inv-other-file', '2026-10-01', 5, 5)$$, 'an invoice in the lane''s second file is written');
select throws_ok($$insert into fin.payments (lane_id, connection_id, source_id, invoice_id, paid_at, amount) values ('PKG', '00000000-0000-4000-8000-000000000551', 'zz', '55000000-0000-4000-8000-000000000013', now(), 1)$$,
                 '23503', null, 'a payment cannot point at an invoice of another connection in the same lane');
-- idempotent upsert targets the plain key
select lives_ok($$insert into fin.payments (lane_id, connection_id, source_id, alloc_no, invoice_id, paid_at, amount) values
  ('PKG', '00000000-0000-4000-8000-000000000551', 'pay-up', 0, null, '2026-10-22T15:00:00Z', 10.00)
  on conflict (connection_id, source_id, alloc_no) do update set amount = excluded.amount, invoice_id = excluded.invoice_id$$, 'upsert on (connection_id, source_id, alloc_no): insert');
select lives_ok($$insert into fin.payments (lane_id, connection_id, source_id, alloc_no, invoice_id, paid_at, amount) values
  ('PKG', '00000000-0000-4000-8000-000000000551', 'pay-up', 0, null, '2026-10-22T15:00:00Z', 10.00)
  on conflict (connection_id, source_id, alloc_no) do update set amount = excluded.amount, invoice_id = excluded.invoice_id$$, 'upsert on (connection_id, source_id, alloc_no): re-run');
select lives_ok($$insert into fin.payments (lane_id, connection_id, source_id, alloc_no, invoice_id, paid_at, amount) values
  ('PKG', '00000000-0000-4000-8000-000000000551', 'pay-up', 0, '55000000-0000-4000-8000-000000000011', '2026-10-22T15:00:00Z', 10.00)
  on conflict (connection_id, source_id, alloc_no) do update set amount = excluded.amount, invoice_id = excluded.invoice_id$$, 'upsert: an unapplied payment becomes applied in place');
select is((select count(*)::int from fin.payments where source_id = 'pay-up'), 1, 'the upsert kept one row');
select is((select invoice_id from fin.payments where source_id = 'pay-up'), '55000000-0000-4000-8000-000000000011'::uuid, 'the payment is linked to its invoice');
select lives_ok($$insert into fin.payments (lane_id, connection_id, source_id, alloc_no, invoice_id, paid_at, amount) values
  ('PKG', '00000000-0000-4000-8000-000000000551', 'pay-up', 1, '55000000-0000-4000-8000-000000000011', '2026-10-22T15:00:00Z', 4.00)$$, 'two allocations of one payment to the same invoice');
select is((select count(*)::int from fin.payments where source_id = 'pay-up' and invoice_id = '55000000-0000-4000-8000-000000000011'), 2, 'both allocations are kept');
select throws_ok($$insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000551', 'balance_sheet', '{"method": "accrual", "class": "class-1"}', '{}', '2026-11-03T05:00:00Z', now())$$,
                 '23505', null, 'report cache key is (lane, connection, report, params hash, as_of)');
select throws_ok($$insert into fin.accounts (lane_id, connection_id, source_id, name, type, entity_code) values ('PKG', '00000000-0000-4000-8000-000000000551', 'e1', 'n', 't', 'bad code!')$$,
                 '23514', null, 'entity_code must have the code shape');
select throws_ok($$insert into fin.accounts (lane_id, connection_id, source_id, name, type, owner_entity_code) values ('PKG', '00000000-0000-4000-8000-000000000551', 'e2', 'n', 't', '')$$,
                 '23514', null, 'owner_entity_code must have the code shape');
select throws_ok($$insert into fin.report_cache (lane_id, connection_id, report, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000551', 'Bad Report', '{}', now(), now())$$,
                 '23514', null, 'report names come from the fixed list');
select throws_ok(format($$insert into fin.report_cache (lane_id, connection_id, report, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000551', %L, '{}', now(), now())$$, r),
                 '23514', null, 'detail report ' || r || ' is not cached')
from unnest(array['general_ledger', 'transaction_list', 'profit_and_loss_detail', 'journal']) r;
select lives_ok(format($$insert into fin.report_cache (lane_id, connection_id, report, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000551', %L, '{}', '2026-01-01', now())$$, r),
                'summary report ' || r || ' is cached')
from unnest(array['pnl', 'balance_sheet', 'cash_flow', 'ar_aging_summary', 'ap_aging_summary']) r;
select throws_ok($$insert into fin.report_cache (lane_id, connection_id, report, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000551', 'pnl', '{"Memo": []}', now(), now())$$,
                 '23514', null, 'an unknown top-level payload key is refused');
select throws_ok($$insert into fin.report_cache (lane_id, connection_id, report, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000551', 'pnl', '{"Rows": {"Row": [{"ColData": [{"value": "x", "routingNumber": "1"}]}]}}', now(), now())$$,
                 '22023', null, 'a forbidden key at depth is refused');
select throws_ok($$insert into fin.report_cache (lane_id, connection_id, report, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000551', 'pnl', '{"Header": {"accessToken": "x"}}', now(), now())$$,
                 '22023', null, 'a token key in the header is refused');
select lives_ok($$insert into fin.report_cache (lane_id, connection_id, report, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000551', 'pnl', '{"Header": {"Time": "t"}, "Columns": {"Column": []}, "Rows": {"Row": [{"ColData": [{"value": "Income", "id": "1"}]}]}}', '2026-01-02', now())$$,
                'a Header/Columns/Rows payload is accepted');
select throws_ok($$update fin.report_cache set payload = '{"Rows": {"Row": [{"salary": 1}]}}' where id = '55000000-0000-4000-8000-000000000051'$$,
                 '22023', null, 'the guard also runs on UPDATE');
select throws_ok($$insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000551', 'pnl', jsonb_build_object('k', repeat('x', 5000)), '{}', '2026-01-03', now())$$,
                 '23514', null, 'params larger than 4096 bytes are refused');
select throws_ok($$insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000551', 'pnl', '[]', '{}', '2026-01-04', now())$$,
                 '23514', null, 'params must be a JSON object');
select throws_ok($$insert into fin.report_cache (lane_id, connection_id, report, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000551', 'pnl', jsonb_build_object('Rows', repeat('x', 4194400)), '2026-01-05', now())$$,
                 '23514', null, 'a payload larger than 4 MB is refused');
select throws_ok($$insert into fin.report_cache (lane_id, connection_id, report, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000551', 'pnl', '[]', now(), now())$$,
                 '23514', null, 'a report payload is a JSON object');
select throws_ok($$insert into fin.invoices (lane_id, connection_id, source_id, issue_date, total, balance) values ('PKG', '00000000-0000-4000-8000-000000000551', '', '2026-10-01', 1, 1)$$,
                 '23514', null, 'an empty source id is refused');
select throws_ok(format($$delete from fin.%I where id = '55000000-0000-4000-8000-000000000011'$$, t), '42501', null, 'service_role cannot hard-delete from fin.' || t)
from unnest(array['accounts', 'transactions', 'invoices', 'payments', 'bills']) t;
-- currency
select throws_ok($$update fin.invoices set currency_code = 'usd' where id = '55000000-0000-4000-8000-000000000011'$$, '23514', null, 'currency_code must be three capital letters');
select throws_ok($$update fin.bills set currency_code = 'US' where id = '55000000-0000-4000-8000-000000000021'$$, '23514', null, 'a two-letter currency is refused');
select throws_ok($$update fin.payments set currency_code = '' where id = '55000000-0000-4000-8000-000000000031'$$, '23514', null, 'an empty currency is refused');
select throws_ok($$update fin.transactions set currency_code = 'EURO' where id = '55000000-0000-4000-8000-000000000041'$$, '23514', null, 'a four-letter currency is refused');
select lives_ok($$update fin.invoices set currency_code = 'EUR' where id = '55000000-0000-4000-8000-000000000011'$$, 'a foreign currency can be stored (and excluded by views)');
select lives_ok($$update fin.invoices set currency_code = 'USD' where id = '55000000-0000-4000-8000-000000000011'$$, 'and set back');
-- names: no digit run of 5 or more
select throws_ok($$insert into fin.accounts (lane_id, connection_id, source_id, name, type) values ('PKG', '00000000-0000-4000-8000-000000000551', 'n1', 'Checking 000123456789', 't')$$, '23514', null, 'an account name with a 12-digit number is refused');
select throws_ok($$insert into fin.accounts (lane_id, connection_id, source_id, name, type) values ('PKG', '00000000-0000-4000-8000-000000000551', 'n2', 'Savings 12345', 't')$$, '23514', null, 'an account name with a 5-digit run is refused');
select lives_ok($$insert into fin.accounts (lane_id, connection_id, source_id, name, type) values ('PKG', '00000000-0000-4000-8000-000000000551', 'n3', 'Checking 1234 ****6789', 't')$$, 'a 4-digit run and masked digits are accepted');
select throws_ok($$update fin.invoices set customer_name = 'Acme 98765432' where id = '55000000-0000-4000-8000-000000000011'$$, '23514', null, 'a customer name with a digit run is refused (invoices)');
select throws_ok($$update fin.payments set customer_name = 'Acme 98765' where id = '55000000-0000-4000-8000-000000000031'$$, '23514', null, 'a customer name with a digit run is refused (payments)');
select throws_ok($$update fin.bills set vendor_name = 'Vendor 55555' where id = '55000000-0000-4000-8000-000000000021'$$, '23514', null, 'a vendor name with a digit run is refused');
select throws_ok($$update fin.bills set vendor_name = '' where id = '55000000-0000-4000-8000-000000000021'$$, '23514', null, 'an empty vendor name is refused');
select lives_ok($$update fin.invoices set customer_name = 'Synthetic Customer 1234' where id = '55000000-0000-4000-8000-000000000011'$$, 'a customer name is stored (invoices)');
select lives_ok($$update fin.payments set customer_name = 'Synthetic Customer' where id = '55000000-0000-4000-8000-000000000031'$$, 'a customer name is stored (payments)');
select lives_ok($$update fin.bills set vendor_name = 'Synthetic Vendor' where id = '55000000-0000-4000-8000-000000000021'$$, 'a vendor name is stored');
-- multi-class documents
select lives_ok($$update fin.invoices set class_id = null, multi_class = true where id = '55000000-0000-4000-8000-000000000011'$$, 'a multi-class invoice has no class_id and multi_class = true');
select lives_ok($$update fin.bills set class_id = null, multi_class = true where id = '55000000-0000-4000-8000-000000000021'$$, 'a multi-class bill has no class_id and multi_class = true');
select throws_ok($$update fin.invoices set multi_class = null where id = '55000000-0000-4000-8000-000000000011'$$, '23502', null, 'multi_class is not nullable');
select lives_ok($$update fin.invoices set class_id = 'class-1', multi_class = false where id = '55000000-0000-4000-8000-000000000011'$$, 'invoice restored to single-class');
select lives_ok($$update fin.bills set class_id = 'class-1', multi_class = false where id = '55000000-0000-4000-8000-000000000021'$$, 'bill restored to single-class');
-- identity columns are frozen
select throws_ok($$update fin.accounts set source_id = 'moved' where id = '55000000-0000-4000-8000-000000000001'$$, 'Z0055', null, 'an account''s source id cannot change');
select throws_ok($$update fin.invoices set lane_id = 'APK' where id = '55000000-0000-4000-8000-000000000011'$$, 'Z0055', null, 'an invoice cannot move to another lane');
select throws_ok($$update fin.bills set connection_id = '00000000-0000-4000-8000-000000000552' where id = '55000000-0000-4000-8000-000000000021'$$, 'Z0055', null, 'a bill cannot move to another connection');
select lives_ok($$update fin.payments set invoice_id = null where id = '55000000-0000-4000-8000-000000000031'$$, 'a payment allocation can be unlinked (invoice_id is a value)');
select lives_ok($$update fin.payments set invoice_id = '55000000-0000-4000-8000-000000000011' where id = '55000000-0000-4000-8000-000000000031'$$, 'and linked again');
select throws_ok($$update fin.payments set alloc_no = 5 where id = '55000000-0000-4000-8000-000000000031'$$, 'Z0055', null, 'a payment''s allocation number cannot change');
select throws_ok(format($$update fin.%I set id = gen_random_uuid() where id = %L$$, t.tbl, t.id), 'Z0055', null, t.tbl || '.id cannot change')
from (values ('accounts', '55000000-0000-4000-8000-000000000001'), ('invoices', '55000000-0000-4000-8000-000000000011'), ('bills', '55000000-0000-4000-8000-000000000021'),
             ('payments', '55000000-0000-4000-8000-000000000031'), ('transactions', '55000000-0000-4000-8000-000000000041'), ('report_cache', '55000000-0000-4000-8000-000000000051')) t(tbl, id);
select throws_ok($$update fin.report_cache set params = '{"method": "cash"}' where id = '55000000-0000-4000-8000-000000000051'$$, 'Z0055', null, 'report_cache.params cannot change (it is the cache key)');
select throws_ok($$update fin.transactions set line_no = 3 where id = '55000000-0000-4000-8000-000000000041'$$, 'Z0055', null, 'a transaction''s line number cannot change');
select throws_ok($$update fin.transactions set txn_type = 'Deposit' where id = '55000000-0000-4000-8000-000000000041'$$, 'Z0055', null, 'a transaction''s type cannot change');
select throws_ok($$update fin.report_cache set report = 'cash_flow' where id = '55000000-0000-4000-8000-000000000051'$$, 'Z0055', null, 'a report row''s report name cannot change');
select lives_ok($$update fin.invoices set balance = 0, voided = true where id = '55000000-0000-4000-8000-000000000011'$$, 'values (balance, voided) can change');
select lives_ok($$delete from fin.report_cache where as_of < '2026-02-01'$$, 'test-only report rows are removed (service_role may delete cache rows)');
reset role;

-- A purged raw record leaves the normalized row in place, unlinked.
delete from raw.source_records where id = (select own from raw_ids);
select is((select raw_record_id from fin.accounts where id = '55000000-0000-4000-8000-000000000001'), null, 'purging the raw record nulls the ref and keeps the row');

-- ---------------------------------------------------------------- RLS: who reads what
-- Rows by lane (the second PKG file and the extra fixtures above are PKG rows):
--   PKG: 4 accounts, 2 invoices, 1 bill, 4 payments, 2 transactions, 1 report
--   APK: 1 of each
create function pg_temp.visible() returns jsonb language sql as $$
  select jsonb_build_object(
    'accounts', (select count(*) from fin.accounts), 'invoices', (select count(*) from fin.invoices),
    'bills', (select count(*) from fin.bills), 'payments', (select count(*) from fin.payments),
    'transactions', (select count(*) from fin.transactions), 'report_cache', (select count(*) from fin.report_cache));
$$;
create function pg_temp.visible_lanes() returns text[] language sql as $$
  select array(select distinct lane_id from (
    select lane_id from fin.accounts union all select lane_id from fin.invoices union all select lane_id from fin.bills
    union all select lane_id from fin.payments union all select lane_id from fin.transactions union all select lane_id from fin.report_cache) x order by 1);
$$;
grant execute on function pg_temp.visible(), pg_temp.visible_lanes() to authenticated, anon;

select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible(), '{"accounts": 4, "invoices": 2, "bills": 1, "payments": 4, "transactions": 2, "report_cache": 1}'::jsonb, 'finance_operator reads all six PKG tables');
select is(pg_temp.visible_lanes(), array['PKG'], 'finance_operator reads only PKG rows (APK rows are denied)');
reset role;

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible(), '{"accounts": 5, "invoices": 3, "bills": 2, "payments": 5, "transactions": 3, "report_cache": 2}'::jsonb, 'owner reads every enabled lane (PKG and APK)');
select is(pg_temp.visible_lanes(), array['APK', 'PKG'], 'owner sees both lanes');
reset role;
update core.lanes set enabled = false where code = 'APK';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible_lanes(), array['PKG'], 'a disabled lane is not readable even by the owner');
reset role;
update core.lanes set enabled = true where code = 'APK';

create temp table viewer_views on commit drop as
  select views from core.memberships where user_id = pg_temp.uid('viewer@example.test');
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible(), '{"accounts": 4, "invoices": 2, "bills": 1, "payments": 4, "transactions": 2, "report_cache": 1}'::jsonb, 'a viewer with the named finance view reads PKG finance tables');
reset role;
update core.memberships set views = '{}' where user_id = pg_temp.uid('viewer@example.test');
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible(), '{"accounts": 0, "invoices": 0, "bills": 0, "payments": 0, "transactions": 0, "report_cache": 0}'::jsonb, 'a viewer without the finance view reads nothing');
reset role;
-- A viewer holding every view name except finance still reads nothing.
update core.memberships set views = array(select v from unnest(core.viewer_view_names()) v where v <> 'finance') where user_id = pg_temp.uid('viewer@example.test');
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible_lanes(), array[]::text[], 'a viewer with every other named view still reads no finance rows');
reset role;
update core.memberships set views = (select views from viewer_views) where user_id = pg_temp.uid('viewer@example.test');
select pg_temp.claims('viewer@example.test', 'aal1');
set local role authenticated;
select is(pg_temp.visible(), '{"accounts": 0, "invoices": 0, "bills": 0, "payments": 0, "transactions": 0, "report_cache": 0}'::jsonb, 'a viewer with the finance view at AAL1 reads nothing');
reset role;

select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible(), '{"accounts": 0, "invoices": 0, "bills": 0, "payments": 0, "transactions": 0, "report_cache": 0}'::jsonb, 'admin_technical has no finance content access');
reset role;

select pg_temp.claims('admin-technical@example.test', 'aal1');
set local role authenticated;
select is(pg_temp.visible(), '{"accounts": 0, "invoices": 0, "bills": 0, "payments": 0, "transactions": 0, "report_cache": 0}'::jsonb, 'admin_technical at AAL1 reads nothing');
reset role;

select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible(), '{"accounts": 0, "invoices": 0, "bills": 0, "payments": 0, "transactions": 0, "report_cache": 0}'::jsonb, 'an authenticated user without a membership reads nothing');
reset role;

select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is(pg_temp.visible(), '{"accounts": 0, "invoices": 0, "bills": 0, "payments": 0, "transactions": 0, "report_cache": 0}'::jsonb, 'the owner at AAL1 reads nothing');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal1');
set local role authenticated;
select is(pg_temp.visible(), '{"accounts": 0, "invoices": 0, "bills": 0, "payments": 0, "transactions": 0, "report_cache": 0}'::jsonb, 'the finance_operator at AAL1 reads nothing');
reset role;

update core.lanes set enabled = false where code = 'PKG';
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible(), '{"accounts": 0, "invoices": 0, "bills": 0, "payments": 0, "transactions": 0, "report_cache": 0}'::jsonb, 'a finance_operator reads nothing in a disabled lane');
reset role;
update core.lanes set enabled = true where code = 'PKG';

set local role anon;
select throws_ok(format('select count(*) from fin.%I', t), '42501', null, 'anon cannot read fin.' || t)
from unnest(array['accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache']) t;
reset role;

-- ---------------------------------------------------------------- writes: service_role only
select pg_temp.claims(p, 'aal2') from unnest(array['owner@example.test']) p;
set local role authenticated;
select throws_ok($$insert into fin.accounts (lane_id, connection_id, source_id, name, type) values ('PKG', '00000000-0000-4000-8000-000000000551', 'u1', 'n', 't')$$, '42501', null, 'the owner cannot insert accounts');
select throws_ok($$insert into fin.transactions (lane_id, connection_id, source_id, txn_type, txn_date, amount) values ('PKG', '00000000-0000-4000-8000-000000000551', 'u1', 'Purchase', '2026-10-01', 1)$$, '42501', null, 'the owner cannot insert transactions');
select throws_ok($$insert into fin.invoices (lane_id, connection_id, source_id, issue_date, total, balance) values ('PKG', '00000000-0000-4000-8000-000000000551', 'u1', '2026-10-01', 1, 1)$$, '42501', null, 'the owner cannot insert invoices');
select throws_ok($$insert into fin.payments (lane_id, connection_id, source_id, paid_at, amount) values ('PKG', '00000000-0000-4000-8000-000000000551', 'u1', now(), 1)$$, '42501', null, 'the owner cannot insert payments');
select throws_ok($$insert into fin.bills (lane_id, connection_id, source_id, issue_date, total, balance) values ('PKG', '00000000-0000-4000-8000-000000000551', 'u1', '2026-10-01', 1, 1)$$, '42501', null, 'the owner cannot insert bills');
select throws_ok($$insert into fin.report_cache (lane_id, connection_id, report, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000551', 'pnl', '{}', now(), now())$$, '42501', null, 'the owner cannot insert reports');
select throws_ok(format('update fin.%I set updated_at = now()', t), '42501', null, 'the owner cannot update fin.' || t)
from unnest(array['accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache']) t;
select throws_ok(format('delete from fin.%I', t), '42501', null, 'the owner cannot delete from fin.' || t)
from unnest(array['accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache']) t;
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select throws_ok($$update fin.invoices set balance = 0$$, '42501', null, 'the finance_operator cannot change an invoice');
select throws_ok($$update fin.transactions set amount = 0$$, '42501', null, 'the finance_operator cannot change a transaction');
select throws_ok($$delete from fin.report_cache$$, '42501', null, 'the finance_operator cannot delete cached reports');
reset role;
set local role anon;
select throws_ok($$insert into fin.invoices (lane_id, connection_id, source_id, issue_date, total, balance) values ('PKG', '00000000-0000-4000-8000-000000000551', 'a1', '2026-10-01', 1, 1)$$, '42501', null, 'anon cannot insert');
reset role;

-- ---------------------------------------------------------------- indexes and keys
-- (Default function privileges: a schema-level revoke cannot remove PUBLIC EXECUTE; the 050 catalog test is the net.)
select ok(exists (select 1 from pg_indexes where schemaname = 'fin' and tablename = t and indexdef ~ '\(raw_record_id\) WHERE'), t || ' has a raw_record_id index')
from unnest(array['accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache']) t;
select ok(exists (select 1 from pg_indexes where schemaname = 'fin' and indexname = i), 'index ' || i || ' exists')
from unnest(array['report_cache_connection_idx', 'report_cache_lane_conn_report_asof_idx', 'invoices_lane_customer_idx', 'invoices_lane_issue_date_idx',
                  'bills_lane_vendor_idx', 'payments_lane_paid_at_idx', 'transactions_lane_entity_date_idx']) i;
select ok(not exists (select 1 from pg_indexes where schemaname = 'fin' and indexname = 'transactions_lane_id_idx'), 'the redundant transactions lane_id index is gone');
select ok(exists (select 1 from pg_constraint where conrelid = 'fin.payments'::regclass and contype = 'u' and conname = 'payments_connection_source_alloc_key'
                  and (select array_agg(attname::text order by a.ord) from unnest(conkey) with ordinality a(attnum, ord) join pg_attribute at on at.attrelid = conrelid and at.attnum = a.attnum)
                      = array['connection_id', 'source_id', 'alloc_no']),
          'the payment key is a plain unique constraint (connection_id, source_id, alloc_no)');

select * from finish();
rollback;
