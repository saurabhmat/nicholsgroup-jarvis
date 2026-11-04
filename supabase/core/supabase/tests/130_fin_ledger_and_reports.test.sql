-- Finance normalized schema part 1 (T-055): column types, source refs and key/lane/provider consistency, forbidden
-- columns, the standard 'finance' lane policy, the role matrix (owner, finance_operator, viewer with and without the
-- named view, admin_technical, outsider, anon, AAL1), cross-lane denial and service_role-only writes.
begin;
select plan(213);
\ir helpers/lane_rls.psql

-- ---------------------------------------------------------------- schema and policies
select has_table('fin', t, 'fin.' || t || ' exists') from unnest(array['accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache']) t;
select pg_temp.has_standard_lane_policy(('fin.' || t)::regclass, 'finance') from unnest(array['accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache']) t;
select ok(not has_schema_privilege('anon', 'fin', 'usage') and has_schema_privilege('authenticated', 'fin', 'usage') and has_schema_privilege('service_role', 'fin', 'usage'),
          'schema fin: no anon usage; authenticated and service_role have usage');
select ok(has_table_privilege('service_role', ('fin.' || t)::regclass, 'select, insert, update, delete'), 'service_role writes fin.' || t)
from unnest(array['accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache']) t;
select ok(not has_table_privilege('service_role', ('fin.' || t)::regclass, 'truncate'), 'service_role cannot truncate fin.' || t)
from unnest(array['accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache']) t;

-- ---------------------------------------------------------------- column types (rule 11)
select is(
  (select array_agg(format('%s.%s', c.relname, a.attname) order by c.relname, a.attname)
   from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'fin' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
     and format_type(a.atttypid, a.atttypmod) = 'numeric(18,2)'),
  array['bills.balance', 'bills.total', 'invoices.balance', 'invoices.total', 'payments.amount', 'transactions.amount'],
  'money columns are exactly these, all numeric(18,2)'
);
select is(
  (select count(*)::int from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'fin' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
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
   where n.nspname = 'fin' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
     and a.attname ~ '(_at|_of)$' and a.atttypid <> 'timestamptz'::regtype),
  0, 'every *_at / as_of column is timestamptz');
select col_type_is('fin', t.tbl, t.col, 'timestamp with time zone', t.tbl || '.' || t.col || ' is timestamptz')
from (values ('transactions', 'posted_at'), ('payments', 'paid_at'), ('report_cache', 'as_of'), ('report_cache', 'fetched_at'),
             ('accounts', 'source_updated_at'), ('transactions', 'source_updated_at'), ('invoices', 'source_updated_at'),
             ('payments', 'source_updated_at'), ('bills', 'source_updated_at'), ('report_cache', 'source_updated_at')) t(tbl, col);

-- ---------------------------------------------------------------- columns the spec lists
select has_column('fin', t.tbl, c, t.tbl || ' has ' || c)
from (values ('accounts', array['lane_id', 'source_id', 'name', 'type', 'subtype', 'is_bank', 'entity_code', 'owner_entity_code', 'active']),
             ('transactions', array['lane_id', 'source_id', 'txn_type', 'txn_date', 'posted_at', 'account_id', 'class_id', 'entity_code', 'amount', 'is_uncategorized', 'voided']),
             ('invoices', array['source_id', 'customer_id', 'issue_date', 'due_date', 'total', 'balance', 'class_id', 'entity_code', 'voided']),
             ('payments', array['source_id', 'invoice_id', 'paid_at', 'amount', 'entity_code']),
             ('bills', array['source_id', 'vendor_id', 'issue_date', 'due_date', 'total', 'balance', 'class_id', 'entity_code', 'voided']),
             ('report_cache', array['lane_id', 'report', 'params', 'params_hash', 'payload', 'as_of', 'fetched_at'])) t(tbl, cols),
     unnest(t.cols) c;
select has_column('fin', t, c, t || ' has source ref ' || c)
from unnest(array['accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache']) t,
     unnest(array['provider', 'connection_id', 'raw_record_id', 'source_updated_at']) c;

-- ---------------------------------------------------------------- forbidden columns (rules 6, 7)
select is(
  (select array_agg(format('%s.%s', c.relname, a.attname) order by 1) from pg_attribute a
   join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'fin' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
     and regexp_replace(lower(a.attname), '[^a-z0-9]', '', 'g') ~
         '(acctnum|accountnum|accountno|acctno|routing|iban|swift|ssn|taxid|password|secret|token|apikey|bankbalance|bankbal|body|memo|snippet|attachment|content|description|notes)'),
  null, 'no account/routing number, credential, bank balance or body/narrative column in fin');
select hasnt_column('fin', 'accounts', 'balance', 'fin.accounts stores no balance (cash comes from the Balance Sheet cache as book balance)');
select hasnt_column('fin', 'accounts', 'book_balance', 'fin.accounts has no book_balance either');

-- ---------------------------------------------------------------- triggers
select has_trigger('fin', t, t || '_set_updated_at', t || ' maintains updated_at') from unnest(array['accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache']) t;
select has_trigger('fin', t, t || '_identity', t || ' freezes its identity columns') from unnest(array['accounts', 'transactions', 'invoices', 'payments', 'bills', 'report_cache']) t;
select ok(not has_function_privilege('authenticated', 'fin.forbid_identity_change()', 'execute')
          and not has_function_privilege('anon', 'fin.forbid_identity_change()', 'execute')
          and not has_function_privilege('authenticated', 'fin.report_cache_set_hash()', 'execute')
          and not has_function_privilege('anon', 'fin.report_cache_set_hash()', 'execute'),
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
  insert into fin.payments (id, lane_id, connection_id, source_id, invoice_id, paid_at, amount, entity_code) values
    ('55000000-0000-4000-8000-000000000031', 'PKG', '00000000-0000-4000-8000-000000000551', 'pay-1', '55000000-0000-4000-8000-000000000011', '2026-10-20T15:00:00Z', 60.00, 'PKG'),
    ('55000000-0000-4000-8000-000000000032', 'PKG', '00000000-0000-4000-8000-000000000551', 'pay-1', null, '2026-10-20T15:00:00Z', 5.00, 'PKG'),
    ('55000000-0000-4000-8000-000000000033', 'APK', '00000000-0000-4000-8000-000000000553', 'pay-1', '55000000-0000-4000-8000-000000000012', '2026-10-21T15:00:00Z', 1.00, 'APK')$$,
  'payments are written, one row per allocation (an unapplied payment has no invoice)');
select lives_ok($$
  insert into fin.transactions (id, lane_id, connection_id, source_id, txn_type, line_no, txn_date, posted_at, account_id, class_id, entity_code, amount, is_uncategorized) values
    ('55000000-0000-4000-8000-000000000041', 'PKG', '00000000-0000-4000-8000-000000000551', 'txn-1', 'Purchase', 0, '2026-10-15', '2026-10-15T04:00:00Z', '55000000-0000-4000-8000-000000000001', 'class-1', 'PKG', -12.34, false),
    ('55000000-0000-4000-8000-000000000042', 'PKG', '00000000-0000-4000-8000-000000000551', 'txn-1', 'Deposit', 0, '2026-10-15', null, null, null, 'unmapped', 20.00, true),
    ('55000000-0000-4000-8000-000000000043', 'APK', '00000000-0000-4000-8000-000000000553', 'txn-1', 'Purchase', 0, '2026-10-15', '2026-10-15T04:00:00Z', '55000000-0000-4000-8000-000000000004', null, 'APK', -1.00, false)$$,
  'transactions are written (ids are unique per type; account and class are optional)');
select lives_ok($$
  insert into fin.report_cache (id, lane_id, connection_id, report, params, payload, as_of, fetched_at) values
    ('55000000-0000-4000-8000-000000000051', 'PKG', '00000000-0000-4000-8000-000000000551', 'balance_sheet', '{"method": "accrual", "class": "class-1"}', '{"rows": []}', '2026-11-03T05:00:00Z', '2026-11-04T10:00:00Z'),
    ('55000000-0000-4000-8000-000000000052', 'APK', '00000000-0000-4000-8000-000000000553', 'balance_sheet', '{}', '{"rows": []}', '2026-11-03T05:00:00Z', '2026-11-04T10:00:00Z')$$,
  'report cache rows are written');
reset role;

-- ---------------------------------------------------------------- value behaviour
select is((select params_hash from fin.report_cache where id = '55000000-0000-4000-8000-000000000051'),
          encode(sha256(convert_to('{"class": "class-1", "method": "accrual"}', 'UTF8')), 'hex'),
          'params_hash is the SHA-256 of the canonical params text, set by the database');
set local role service_role;
select lives_ok($$update fin.report_cache set params_hash = repeat('0', 64), params = '{"method": "cash"}' where id = '55000000-0000-4000-8000-000000000051'$$,
                'a caller-supplied hash is overridden when params change');
reset role;
select is((select params_hash from fin.report_cache where id = '55000000-0000-4000-8000-000000000051'),
          encode(sha256(convert_to('{"method": "cash"}', 'UTF8')), 'hex'), 'the hash follows params');
set local role service_role;
select lives_ok($$update fin.transactions set amount = 10.005 where id = '55000000-0000-4000-8000-000000000041'$$, 'amount accepts three decimals');
reset role;
select is((select amount from fin.transactions where id = '55000000-0000-4000-8000-000000000041'), 10.01::numeric(18,2), 'money is stored to the cent');
select is((select count(*)::int from fin.accounts where is_bank and entity_code = owner_entity_code), 1, 'a bank account carries its owner entity');
select is((select entity_code from fin.invoices where id = '55000000-0000-4000-8000-000000000011'), 'PKG', 'entity_code is stored as given');
select is((select entity_code from fin.accounts where id = '55000000-0000-4000-8000-000000000002'), 'unmapped', 'entity_code defaults to unmapped');
select is((select voided or deleted from fin.invoices where id = '55000000-0000-4000-8000-000000000011'), false, 'voided and deleted default to false');

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
select throws_ok($$insert into fin.payments (lane_id, connection_id, source_id, invoice_id, paid_at, amount) values ('PKG', '00000000-0000-4000-8000-000000000551', 'pay-1', null, now(), 1)$$,
                 '23505', null, 'an unapplied payment row is unique per payment');
select throws_ok($$insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000551', 'balance_sheet', '{"method": "cash"}', '{}', '2026-11-03T05:00:00Z', now())$$,
                 '23505', null, 'report cache key is (lane, connection, report, params hash, as_of)');
select throws_ok($$insert into fin.accounts (lane_id, connection_id, source_id, name, type, entity_code) values ('PKG', '00000000-0000-4000-8000-000000000551', 'e1', 'n', 't', 'bad code!')$$,
                 '23514', null, 'entity_code must have the code shape');
select throws_ok($$insert into fin.accounts (lane_id, connection_id, source_id, name, type, owner_entity_code) values ('PKG', '00000000-0000-4000-8000-000000000551', 'e2', 'n', 't', '')$$,
                 '23514', null, 'owner_entity_code must have the code shape');
select throws_ok($$insert into fin.report_cache (lane_id, connection_id, report, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000551', 'Bad Report', '{}', now(), now())$$,
                 '23514', null, 'report names are snake_case identifiers');
select throws_ok($$insert into fin.report_cache (lane_id, connection_id, report, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000551', 'pnl', '[]', now(), now())$$,
                 '23514', null, 'a report payload is a JSON object');
select throws_ok($$insert into fin.invoices (lane_id, connection_id, source_id, issue_date, total, balance) values ('PKG', '00000000-0000-4000-8000-000000000551', '', '2026-10-01', 1, 1)$$,
                 '23514', null, 'an empty source id is refused');
select throws_ok($$delete from fin.invoices where id = '55000000-0000-4000-8000-000000000011'$$,
                 '23503', null, 'an invoice with payments cannot be deleted');
-- identity columns are frozen
select throws_ok($$update fin.accounts set source_id = 'moved' where id = '55000000-0000-4000-8000-000000000001'$$, '42501', null, 'an account''s source id cannot change');
select throws_ok($$update fin.invoices set lane_id = 'APK' where id = '55000000-0000-4000-8000-000000000011'$$, '42501', null, 'an invoice cannot move to another lane');
select throws_ok($$update fin.bills set connection_id = '00000000-0000-4000-8000-000000000552' where id = '55000000-0000-4000-8000-000000000021'$$, '42501', null, 'a bill cannot move to another connection');
select throws_ok($$update fin.payments set invoice_id = null where id = '55000000-0000-4000-8000-000000000031'$$, '42501', null, 'a payment allocation cannot be re-pointed');
select throws_ok($$update fin.transactions set txn_type = 'Deposit' where id = '55000000-0000-4000-8000-000000000041'$$, '42501', null, 'a transaction''s type cannot change');
select throws_ok($$update fin.report_cache set report = 'pnl' where id = '55000000-0000-4000-8000-000000000051'$$, '42501', null, 'a report row''s report name cannot change');
select lives_ok($$update fin.invoices set balance = 0, voided = true where id = '55000000-0000-4000-8000-000000000011'$$, 'values (balance, voided) can change');
reset role;

-- A purged raw record leaves the normalized row in place, unlinked.
delete from raw.source_records where id = (select own from raw_ids);
select is((select raw_record_id from fin.accounts where id = '55000000-0000-4000-8000-000000000001'), null, 'purging the raw record nulls the ref and keeps the row');

-- ---------------------------------------------------------------- RLS: who reads what
-- Rows: PKG has 3 accounts, 1 invoice, 1 bill, 2 payments, 2 transactions, 1 report; APK has 1 of each (2 payments? no: 1).
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
select is(pg_temp.visible(), '{"accounts": 3, "invoices": 1, "bills": 1, "payments": 2, "transactions": 2, "report_cache": 1}'::jsonb, 'finance_operator reads all six PKG tables');
select is(pg_temp.visible_lanes(), array['PKG'], 'finance_operator reads only PKG rows (APK rows are denied)');
reset role;

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible(), '{"accounts": 4, "invoices": 2, "bills": 2, "payments": 3, "transactions": 3, "report_cache": 2}'::jsonb, 'owner reads every enabled lane (PKG and APK)');
select is(pg_temp.visible_lanes(), array['APK', 'PKG'], 'owner sees both lanes');
reset role;
update core.lanes set enabled = false where code = 'APK';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible_lanes(), array['PKG'], 'a disabled lane is not readable even by the owner');
reset role;
update core.lanes set enabled = true where code = 'APK';

select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible(), '{"accounts": 3, "invoices": 1, "bills": 1, "payments": 2, "transactions": 2, "report_cache": 1}'::jsonb, 'a viewer with the named finance view reads PKG finance tables');
reset role;
update core.memberships set views = '{}' where user_id = pg_temp.uid('viewer@example.test');
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible(), '{"accounts": 0, "invoices": 0, "bills": 0, "payments": 0, "transactions": 0, "report_cache": 0}'::jsonb, 'a viewer without the finance view reads nothing');
reset role;
update core.memberships set views = '{briefing,projects,calendar,commitments}' where user_id = pg_temp.uid('viewer@example.test');
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible_lanes(), array[]::text[], 'a viewer with every other named view still reads no finance rows');
reset role;

select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible(), '{"accounts": 0, "invoices": 0, "bills": 0, "payments": 0, "transactions": 0, "report_cache": 0}'::jsonb, 'admin_technical has no finance content access');
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

select * from finish();
rollback;
