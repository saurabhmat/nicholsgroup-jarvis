-- QuickBooks normalizer (T-056): core.fin_qbo_normalize turns raw.source_records into fin.* on synthetic data.
-- Covers: idempotency (a re-run changes nothing), money/date/time parsing in SQL, the sign convention and posted_at rule,
-- entity tagging from lane_config (class, customer, file mode, ambiguity, multi-class), the class-tracking fallback (QB-10),
-- voided / deleted / unseen-by-full-reload records, payroll defence in depth (D-25) and payments of excluded bills or
-- invoices (T-051 re-review M2), payments (unapplied, linked later in place, voided link refused, reallocations logged),
-- lost lines, currency, raw_record_id object types, the constant-message name trigger (no DETAIL), the masker, grants and
-- RLS with cross-lane denial.
begin;
select plan(208);
\ir helpers/lane_rls.psql

-- ---------------------------------------------------------------- helpers
create function pg_temp.refusal(p_sql text) returns text[] language plpgsql as $$
declare
  v_state text; v_msg text; v_detail text; v_hint text;
begin
  begin
    execute p_sql;
    return array['ok', '', '', ''];
  exception when others then
    get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    v_state := sqlstate;
    return array[v_state, v_msg, coalesce(v_detail, ''), coalesce(v_hint, '')];
  end;
end;
$$;
-- One raw record (as the sync would have stored it) for the PKG QuickBooks file.
create function pg_temp.raw(p_type text, p_id text, p_payload jsonb, p_deleted boolean default false,
                            p_synced timestamptz default '2026-11-06T10:00:00Z',
                            p_conn uuid default '00000000-0000-4000-8000-000000000661', p_lane text default 'PKG') returns void
language sql as $$
  insert into raw.source_records (lane_id, connection_id, provider, object_type, external_id, payload, payload_hash, source_updated_at, deleted, synced_at)
  values (p_lane, p_conn, 'quickbooks', p_type, p_id, p_payload, '', '2026-11-06T09:00:00Z', p_deleted, p_synced)
  on conflict (connection_id, object_type, external_id) do update
    set payload = excluded.payload, deleted = excluded.deleted, synced_at = excluded.synced_at
$$;
create function pg_temp.norm(p_lane text default 'PKG', p_conn uuid default '00000000-0000-4000-8000-000000000661') returns jsonb
language sql as $$ select core.fin_qbo_normalize(p_lane, p_conn) $$;
-- A digest of every fin ledger row of the PKG file, updated_at included: equal digests = no diff.
create function pg_temp.snap() returns text language sql as $$
  select md5(
    coalesce((select string_agg(t::text, '|' order by t.id) from fin.accounts t), '') ||
    coalesce((select string_agg(t::text, '|' order by t.id) from fin.invoices t), '') ||
    coalesce((select string_agg(t::text, '|' order by t.id) from fin.bills t), '') ||
    coalesce((select string_agg(t::text, '|' order by t.id) from fin.payments t), '') ||
    coalesce((select string_agg(t::text, '|' order by t.id) from fin.transactions t), ''))
$$;
create function pg_temp.inv(p_id text) returns fin.invoices language sql as $$
  select i from fin.invoices i where i.source_id = p_id and i.connection_id = '00000000-0000-4000-8000-000000000661' $$;
create function pg_temp.bill(p_id text) returns fin.bills language sql as $$
  select i from fin.bills i where i.source_id = p_id and i.connection_id = '00000000-0000-4000-8000-000000000661' $$;

-- ---------------------------------------------------------------- shape, grants, privileges
select has_function('core', 'fin_qbo_normalize', array['text', 'uuid'], 'core.fin_qbo_normalize(lane, connection) exists');
select is((select prosecdef from pg_proc where oid = 'core.fin_qbo_normalize(text, uuid)'::regprocedure), true, 'the normalizer is security definer (it reads the private raw table)');
select is((select proconfig from pg_proc where oid = 'core.fin_qbo_normalize(text, uuid)'::regprocedure), array['search_path=""'], 'the normalizer pins an empty search_path');
select ok(has_function_privilege('service_role', 'core.fin_qbo_normalize(text, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'core.fin_qbo_normalize(text, uuid)', 'execute')
          and not has_function_privilege('anon', 'core.fin_qbo_normalize(text, uuid)', 'execute'),
          'only service_role executes the normalizer');
select ok(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'fin' and p.proname in ('has_digit_run', 'mask_digit_runs', 'qbo_money', 'qbo_date', 'qbo_doc_classes', 'qbo_line_class',
        'qbo_account_refs', 'qbo_entity_refs', 'qbo_ids_ok', 'qbo_is_employee', 'qbo_resolve_entity', 'refuse_name_digit_runs', 'payments_invoice_link_guard')
    and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))),
  'no API role executes a normalizer helper or trigger function');
select pg_temp.has_standard_lane_policy('fin.normalize_runs'::regclass, 'health');
select has_column('fin', 'normalize_runs', 'lane_id', 'fin.normalize_runs has lane_id');
select has_column('fin', 'accounts', 'deleted', 'fin.accounts has a deleted flag');
select ok(not has_table_privilege('service_role', 'fin.normalize_runs', 'insert, update, delete'), 'service_role cannot write or delete fin.normalize_runs directly (only the definer function writes)');
select ok(not has_table_privilege('service_role', 'fin.invoices', 'delete'), 'service_role still has no DELETE on ledger tables');

-- ---------------------------------------------------------------- the masker and the digit-run test
select is(fin.mask_digit_runs(v), e, 'masked: ' || d)
from (values
  ('Operating Checking 123456789', 'Operating Checking [masked]', 'a 9-digit number'),
  ('Savings 1234', 'Savings 1234', 'a 4-digit number is kept'),
  ('Acct 12345', 'Acct [masked]', 'exactly 5 digits'),
  ('Checking １２３４５６', 'Checking [masked]', 'full-width digits (NFKC)'),
  ('Acct 123-456-789', 'Acct [masked]', 'dashes between digits'),
  ('Acct 1234 5678 9012 3456', 'Acct [masked]', 'a card-like number with spaces'),
  ('Acct 12.34.56', 'Acct [masked]', 'dots between digits'),
  ('Acct 12 - 34 - 56', 'Acct [masked]', 'spaced dashes (two separators)'),
  ('Konto ٠١٢٣٤٥', 'Konto [masked]', 'Arabic-Indic digits'),
  ('Konto ௧௨௩௪௫௬', 'Konto [masked]', 'Tamil digits'),
  ('Konto ១២៣៤៥៦', 'Konto [masked]', 'Khmer digits'),
  ('Acct 1234 ****6789', 'Acct 1234 ****6789', 'masked-by-star digits are kept (gaps over two characters)'),
  ('Plain name', 'Plain name', 'no digits')) v(v, e, d);
select is(fin.has_digit_run(fin.mask_digit_runs(v)), false, 'the masked form passes the check: ' || v)
from (values ('Operating Checking 123456789'), ('Acct 1234 5678 9012 3456'), ('Konto ٠١٢٣٤٥'), ('Checking １２３４５６'), ('a1b2c3d4e5f6g7h8')) v(v);
select is(fin.has_digit_run(v), e, 'digit-run test: ' || v)
from (values ('Savings 12345', true), ('Savings 1234', false), ('12-34-5', true), ('１２３４５', true), ('1 2 3 4', false), ('x1y2z3w4v5', false)) v(v, e);

-- ---------------------------------------------------------------- the money and date helpers
select is(fin.qbo_money('1234.565'::jsonb), 1234.57, 'money rounds half away from zero');
select is(fin.qbo_money('-0.005'::jsonb), -0.01, 'money rounds a negative half away from zero');
select is(fin.qbo_money('12'::jsonb), 12.00, 'an integer is money');
select is(fin.qbo_money('"12.00"'::jsonb), null, 'a string is not money');
select is(fin.qbo_money('1e16'::jsonb), null, 'beyond numeric(18,2) is refused');
select is(fin.qbo_money('null'::jsonb), null, 'null is not money');
select is(fin.qbo_date('2026-02-30'), null, 'an impossible date is null');
select is(fin.qbo_date('2026-10-01'), date '2026-10-01', 'a date is a date');
select is(fin.qbo_date('10/01/2026'), null, 'a non-ISO date is null (never guessed)');

-- ---------------------------------------------------------------- fixtures: connections and lane_config
update core.lanes set enabled = true where code = 'APK';
insert into core.connections (id, lane_id, provider, external_account_id, status, features) values
  ('00000000-0000-4000-8000-000000000661', 'PKG', 'quickbooks', 'realm-synthetic-66a', 'active', '{"class_tracking": true}'),
  ('00000000-0000-4000-8000-000000000662', 'APK', 'quickbooks', 'realm-synthetic-66b', 'active', '{"class_tracking": true}'),
  ('00000000-0000-4000-8000-000000000663', 'PKG', 'stripe', 'acct-synthetic-66c', 'active', '{}'),
  ('00000000-0000-4000-8000-000000000664', 'PKG', 'quickbooks', 'realm-synthetic-66d', 'reconnect_required', '{}');
insert into core.lane_config (lane_id, version, config)
select 'PKG', c.version + 1,
       jsonb_set(jsonb_set(jsonb_set(c.config,
         '{entities,by_entity,PKG,qbo_customer_ids}', '["cust-pkg"]'),
         '{entities,bank_accounts}', '[{"qbo_account_id": "10", "owner_entity": "PKG"}, {"qbo_account_id": "11", "owner_entity": "APK"}]'),
         '{finance}', '{"payroll": {"account_ids": ["900"], "excluded_entity_ids": ["777"]}}')
from core.lane_config_current c where c.lane_id = 'PKG';
-- An ambiguous class id (listed under two entities) and a second lane with a file-mode mapping.

-- Accounts. 900 is configured payroll; 910 is caught by its name, 911 is its sub-account; 50 by its subtype.
select pg_temp.raw('Account', '10', '{"Id": "10", "Name": "Operating Checking 123456789", "FullyQualifiedName": "Operating Checking 123456789", "AccountType": "Bank", "AccountSubType": "Checking", "Active": true}');
select pg_temp.raw('Account', '11', '{"Id": "11", "Name": "Savings", "AccountType": "Bank", "AccountSubType": "Savings"}');
select pg_temp.raw('Account', '20', '{"Id": "20", "Name": "Office Supplies", "AccountType": "Expense", "AccountSubType": "OfficeGeneralAdministrativeExpenses"}');
select pg_temp.raw('Account', '21', '{"Id": "21", "Name": "Uncategorized Expense", "AccountType": "Expense", "AccountSubType": "OtherMiscellaneousServiceCost"}');
select pg_temp.raw('Account', '30', '{"Id": "30", "Name": "Accounts Payable (A/P)", "AccountType": "Accounts Payable"}');
select pg_temp.raw('Account', '40', '{"Id": "40", "Name": "Sales", "AccountType": "Income", "Active": false}');
select pg_temp.raw('Account', '900', '{"Id": "900", "Name": "Staff Costs", "AccountType": "Expense"}');
select pg_temp.raw('Account', '910', '{"Id": "910", "Name": "Payroll Clearing Acct", "AccountType": "Other Current Liability"}');
select pg_temp.raw('Account', '911', '{"Id": "911", "Name": "Clearing Child", "AccountType": "Other Current Liability", "ParentRef": {"value": "910"}}');
select pg_temp.raw('Account', '50', '{"Id": "50", "Name": "Taxes X", "AccountType": "Expense", "AccountSubType": "PayrollTaxExpenses"}');
-- Customers and vendors.
select pg_temp.raw('Customer', 'cust-pkg', '{"Id": "cust-pkg", "DisplayName": "Acme Corp 1234567"}');
select pg_temp.raw('Customer', 'cust-apk', '{"Id": "cust-apk", "DisplayName": "Beta Ltd"}');
select pg_temp.raw('Customer', 'c3', '{"Id": "c3", "DisplayName": "Gamma"}');
select pg_temp.raw('Customer', '777', '{"Id": "777", "DisplayName": "Contractor Person"}');
select pg_temp.raw('Vendor', 'v1', '{"Id": "v1", "DisplayName": "Vendor One 98765"}');
select pg_temp.raw('Vendor', '777', '{"Id": "777", "DisplayName": "Contractor Person"}');
-- Invoices.
select pg_temp.raw('Invoice', 'I1', '{"Id": "I1", "TxnDate": "2026-10-01", "DueDate": "2026-10-31", "TotalAmt": 1000, "Balance": 400.5, "CustomerRef": {"value": "cust-pkg"}, "ClassRef": {"value": "class-synthetic-pkg"}}');
select pg_temp.raw('Invoice', 'I2', '{"Id": "I2", "TxnDate": "2026-10-02", "TotalAmt": 200, "Balance": 200, "CustomerRef": {"value": "cust-pkg"}, "Line": [{"Id": "1", "Amount": 200, "SalesItemLineDetail": {"ClassRef": {"value": "class-synthetic-apk"}}}]}');
select pg_temp.raw('Invoice', 'I3', '{"Id": "I3", "TxnDate": "2026-10-03", "TotalAmt": 300, "Balance": 300, "CustomerRef": {"value": "cust-pkg"}, "Line": [{"Id": "1", "Amount": 100, "SalesItemLineDetail": {"ClassRef": {"value": "class-synthetic-pkg"}}}, {"Id": "2", "Amount": 200, "SalesItemLineDetail": {"ClassRef": {"value": "class-synthetic-apk"}}}]}');
select pg_temp.raw('Invoice', 'I4', '{"Id": "I4", "TxnDate": "2026-10-04", "TotalAmt": 40, "Balance": 40, "CustomerRef": {"value": "cust-pkg"}}');
select pg_temp.raw('Invoice', 'I5', '{"Id": "I5", "TxnDate": "2026-10-05", "TotalAmt": 50, "Balance": 50, "CustomerRef": {"value": "c3"}}');
select pg_temp.raw('Invoice', 'I6', '{"Id": "I6", "TxnDate": "2026-10-06", "TotalAmt": 0, "Balance": 0, "CustomerRef": {"value": "cust-pkg"}, "Voided": true}');
select pg_temp.raw('Invoice', 'I7', '{"Id": "I7", "TxnDate": "2026-10-07", "TotalAmt": 70, "Balance": 70, "CustomerRef": {"value": "cust-pkg"}}');
select pg_temp.raw('Invoice', 'I8', '{"Id": "I8", "TxnDate": "2026-10-08", "TotalAmt": 80, "Balance": 80, "CustomerRef": {"value": "cust-pkg"}, "CurrencyRef": {"value": "EUR"}}');
select pg_temp.raw('Invoice', 'I9', '{"Id": "I9", "TxnDate": "2026-13-45", "TotalAmt": 90, "Balance": 90, "CustomerRef": {"value": "cust-pkg"}}');
select pg_temp.raw('Invoice', 'I10', '{"Id": "I10", "TxnDate": "2026-10-10", "TotalAmt": 1234.565, "Balance": -0.005, "CustomerRef": {"value": "cust-pkg"}, "ClassRef": {"value": "class-unknown"}}');
select pg_temp.raw('Invoice', 'I-dead', '{"Id": "I-dead"}', true);
-- Bills.
select pg_temp.raw('Bill', 'B1', '{"Id": "B1", "TxnDate": "2026-10-05", "DueDate": "2026-11-10", "TotalAmt": 250, "Balance": 250, "VendorRef": {"value": "v1"}, "APAccountRef": {"value": "30"}, "ClassRef": {"value": "class-synthetic-pkg"}, "Line": [{"Id": "1", "Amount": 250, "DetailType": "AccountBasedExpenseLineDetail", "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "20"}, "ClassRef": {"value": "class-synthetic-pkg"}}}]}');
select pg_temp.raw('Bill', 'B-pay', '{"Id": "B-pay", "TxnDate": "2026-10-09", "TotalAmt": 5000, "Balance": 5000, "VendorRef": {"value": "v1"}, "APAccountRef": {"value": "30"}, "Line": [{"Id": "1", "Amount": 5000, "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "900"}}}]}');
select pg_temp.raw('Bill', 'B-gone', '{"Id": "B-gone"}', true);
-- Payments (customer payments).
select pg_temp.raw('Payment', 'P1', '{"Id": "P1", "TxnDate": "2026-10-10", "TotalAmt": 600, "UnappliedAmt": 0, "CustomerRef": {"value": "cust-pkg"}, "DepositToAccountRef": {"value": "10"}, "Line": [{"Amount": 600, "LinkedTxn": [{"TxnId": "I1", "TxnType": "Invoice"}]}]}');
select pg_temp.raw('Payment', 'P2', '{"Id": "P2", "TxnDate": "2026-10-11", "TotalAmt": 50, "CustomerRef": {"value": "cust-pkg"}, "Line": [{"Amount": 50, "LinkedTxn": [{"TxnId": "I-later", "TxnType": "Invoice"}]}]}');
select pg_temp.raw('Payment', 'P3', '{"Id": "P3", "TxnDate": "2026-10-12", "TotalAmt": 30, "CustomerRef": {"value": "cust-pkg"}, "Line": [{"Amount": 30, "LinkedTxn": [{"TxnId": "I6", "TxnType": "Invoice"}]}]}');
select pg_temp.raw('Payment', 'P4', '{"Id": "P4", "TxnDate": "2026-10-13", "TotalAmt": 175, "UnappliedAmt": 25, "CustomerRef": {"value": "cust-pkg"}, "Line": [{"Amount": 100, "LinkedTxn": [{"TxnId": "I1", "TxnType": "Invoice"}]}, {"Amount": 50, "LinkedTxn": [{"TxnId": "I4", "TxnType": "Invoice"}]}, {"Amount": 9, "LinkedTxn": [{"TxnId": "CM1", "TxnType": "CreditMemo"}]}]}');
select pg_temp.raw('Payment', 'P5', '{"Id": "P5", "TxnDate": "2026-10-14", "TotalAmt": 70, "CustomerRef": {"value": "cust-pkg"}, "Line": [{"Amount": 70, "LinkedTxn": [{"TxnId": "I-dead", "TxnType": "Invoice"}]}]}');
select pg_temp.raw('Payment', 'P8', '{"Id": "P8", "TxnDate": "2026-10-16", "TotalAmt": 12, "CustomerRef": {"value": "cust-pkg"}, "Line": [{"Amount": 12, "LinkedTxn": [{"TxnId": "I9", "TxnType": "Invoice"}]}]}');
select pg_temp.raw('Payment', 'P7', '{"Id": "P7", "TxnDate": "2026-10-15", "TotalAmt": 70, "CustomerRef": {"value": "cust-pkg"}, "Line": [{"Amount": 70, "LinkedTxn": [{"TxnId": "I7", "TxnType": "Invoice"}]}]}');
select pg_temp.raw('BillPayment', 'BP1', '{"Id": "BP1", "TxnDate": "2026-10-20", "TotalAmt": 250, "VendorRef": {"value": "v1"}, "CheckPayment": {"BankAccountRef": {"value": "10"}}, "Line": [{"Amount": 250, "LinkedTxn": [{"TxnId": "B1", "TxnType": "Bill"}]}]}');
select pg_temp.raw('BillPayment', 'BP2', '{"Id": "BP2", "TxnDate": "2026-10-21", "TotalAmt": 5000, "VendorRef": {"value": "v1"}, "CheckPayment": {"BankAccountRef": {"value": "10"}}, "Line": [{"Amount": 5000, "LinkedTxn": [{"TxnId": "B-gone", "TxnType": "Bill"}]}]}');
-- Other transactions.
select pg_temp.raw('Purchase', 'PU1', '{"Id": "PU1", "TxnDate": "2026-10-22", "TotalAmt": 50, "AccountRef": {"value": "10"}, "EntityRef": {"value": "v1", "type": "Vendor"}, "Line": [{"Id": "1", "Amount": 30, "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "20"}, "ClassRef": {"value": "class-synthetic-pkg"}}}, {"Id": "2", "Amount": 20, "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "21"}, "ClassRef": {"value": "class-synthetic-pkg"}}}]}');
select pg_temp.raw('Purchase', 'PU-pay', '{"Id": "PU-pay", "TxnDate": "2026-10-22", "TotalAmt": 900, "AccountRef": {"value": "10"}, "Line": [{"Id": "1", "Amount": 900, "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "900"}}}]}');
select pg_temp.raw('Purchase', 'PU-ent', '{"Id": "PU-ent", "TxnDate": "2026-10-23", "TotalAmt": 60, "AccountRef": {"value": "10"}, "EntityRef": {"value": "777", "type": "Vendor"}, "Line": [{"Id": "1", "Amount": 60, "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "20"}}}]}');
select pg_temp.raw('Deposit', 'D1', '{"Id": "D1", "TxnDate": "2026-10-24", "TotalAmt": 100, "DepositToAccountRef": {"value": "10"}, "Line": [{"Id": "1", "Amount": 100, "DepositLineDetail": {"AccountRef": {"value": "40"}}}, {"Id": "2", "Amount": 5, "LinkedTxn": [{"TxnId": "P1", "TxnType": "Payment"}]}]}');
select pg_temp.raw('JournalEntry', 'J1', '{"Id": "J1", "TxnDate": "2026-10-25", "TotalAmt": 75, "Line": [{"Id": "0", "Amount": 75, "JournalEntryLineDetail": {"PostingType": "Debit", "AccountRef": {"value": "20"}, "ClassRef": {"value": "class-synthetic-apk"}}}, {"Id": "1", "Amount": 75, "JournalEntryLineDetail": {"PostingType": "Credit", "AccountRef": {"value": "10"}}}, {"Id": "2", "Amount": 1, "JournalEntryLineDetail": {"PostingType": "Odd", "AccountRef": {"value": "10"}}}, {"Id": "3", "Amount": 9, "DetailType": "SubTotalLineDetail"}]}');
select pg_temp.raw('Purchase', 'PU-cr', '{"Id": "PU-cr", "TxnDate": "2026-10-27", "TotalAmt": 40, "Credit": true, "AccountRef": {"value": "10"}, "Line": [{"Id": "1", "Amount": 40, "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "20"}}}, {"Id": "2", "Amount": 5, "ItemBasedExpenseLineDetail": {"ItemRef": {"value": "i1"}}}]}');
select pg_temp.raw('Purchase', 'PU-emp', '{"Id": "PU-emp", "TxnDate": "2026-10-27", "TotalAmt": 33, "AccountRef": {"value": "10"}, "EntityRef": {"value": "88", "type": "Employee"}, "Line": [{"Id": "1", "Amount": 33, "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "20"}}}]}');
select pg_temp.raw('JournalEntry', 'J-emp', '{"Id": "J-emp", "TxnDate": "2026-10-27", "TotalAmt": 9, "Line": [{"Id": "0", "Amount": 9, "JournalEntryLineDetail": {"PostingType": "Debit", "AccountRef": {"value": "20"}, "Entity": {"Type": "employee", "EntityRef": {"value": "88"}}}}]}');
select pg_temp.raw('Purchase', 'PU-eur', '{"Id": "PU-eur", "TxnDate": "2026-10-26", "TotalAmt": 10, "AccountRef": {"value": "10"}, "CurrencyRef": {"value": "EUR"}}');
-- Records of other connections must never be read.
select pg_temp.raw('Invoice', 'X1', '{"Id": "X1", "TxnDate": "2026-10-01", "TotalAmt": 1, "Balance": 1}', false, '2026-11-06T10:00:00Z', '00000000-0000-4000-8000-000000000662', 'APK');

-- ---------------------------------------------------------------- refusals before any work
select is((pg_temp.refusal($$select core.fin_qbo_normalize('PKG', '00000000-0000-4000-8000-000000000662')$$))[1:2],
          array['42501', 'fin.qbo_normalize: usable QuickBooks connection not found in this lane'], 'another lane''s connection is refused');
select is((pg_temp.refusal($$select core.fin_qbo_normalize('PKG', '00000000-0000-4000-8000-000000000663')$$))[1], '42501', 'a non-QuickBooks connection is refused');
select is((pg_temp.refusal($$select core.fin_qbo_normalize('PKG', '00000000-0000-4000-8000-000000000664')$$))[1], '42501', 'a connection that needs reconnecting is refused');
select is((pg_temp.refusal($$select core.fin_qbo_normalize('PKG', '00000000-0000-4000-8000-0000000006ff')$$))[1], '42501', 'a missing connection is refused');
select is((pg_temp.refusal($$select core.fin_qbo_normalize(null, '00000000-0000-4000-8000-000000000661')$$))[1], '22004', 'a null lane is refused');
update core.lanes set enabled = false where code = 'APK';
select is((pg_temp.refusal($$select core.fin_qbo_normalize('APK', '00000000-0000-4000-8000-000000000662')$$))[1], '42501', 'a disabled lane is refused');
update core.lanes set enabled = true where code = 'APK';
select is((pg_temp.refusal($$select core.fin_qbo_normalize('APK', '00000000-0000-4000-8000-000000000662')$$))[1:4],
          array['22023', 'fin.qbo_normalize: lane_config has no QuickBooks entity mapping', '', ''], 'a lane without a QuickBooks entity mapping in lane_config is refused with a clear constant message');
insert into core.lane_config (lane_id, version, config) values
  ('APK', 2, '{"qbo": {"realm_id": "1002", "entity_mapping_mode": "file"}, "entities": {"own_entity": "APK", "by_entity": {"APK": {"qbo_class_ids": [], "qbo_customer_ids": [], "stripe_product_ids": [], "ghl_tags": [], "ghl_products": []}}}}');
select is((select count(*)::int from fin.invoices) + (select count(*)::int from fin.normalize_runs), 0, 'refusals wrote nothing');

-- ---------------------------------------------------------------- first run (as service_role, the real caller)
set local role service_role;
create temp table run1 on commit drop as select core.fin_qbo_normalize('PKG', '00000000-0000-4000-8000-000000000661') as r;
reset role;
grant select on run1 to service_role;

select is((select r -> 'accounts' from run1), '{"inserted": 6, "updated": 0, "tombstoned": 0}'::jsonb, 'accounts: 6 live inserted (10, 11, 20, 21, 30, 40); payroll accounts 900, 910, 911 and 50 were never written');
select is((select count(*)::int from fin.accounts where source_id in ('900', '910', '911', '50')), 0, 'payroll accounts (configured id, name net, sub-account, subtype) are not stored');
select is((select name from fin.accounts where source_id = '10'), 'Operating Checking [masked]', 'the account name is masked before insert');
select is((select array[is_bank::text, entity_code, owner_entity_code] from fin.accounts where source_id = '10'), array['true', 'PKG', 'PKG'], 'a bank account takes its owner from the bank-account mapping');
select is((select array[entity_code, owner_entity_code] from fin.accounts where source_id = '11'), array['APK', 'APK'], 'a bank account owned by another entity is shown under it');
select is((select array[entity_code, coalesce(owner_entity_code, 'none')] from fin.accounts where source_id = '20'), array['unmapped', 'none'], 'a non-bank account is unmapped in file_class mode');
select is((select active from fin.accounts where source_id = '40'), false, 'an inactive account is stored inactive');
select is((select r -> 'dead_payroll' from run1), '6'::jsonb, 'dead by payroll: 4 accounts + B-pay + PU-pay');
select is((select r -> 'dead_entity' from run1), '3'::jsonb, 'dead by excluded entity: customer 777, vendor 777, purchase PU-ent');
select is((select r -> 'dead_deleted' from run1), '2'::jsonb, 'dead by deletion: I-dead and B-gone');
select is((select r -> 'dead_linked' from run1), '2'::jsonb, 'dead by link: P5 (deleted invoice) and BP2 (deleted/excluded bill)');

-- invoices
select is((select count(*)::int from fin.invoices), 9, '9 invoices: I1-I8 and I10 (I9 has an invalid date, I-dead is dead)');
select is((select r -> 'invoices' from run1), '{"inserted": 9, "updated": 0, "tombstoned": 0, "invalid": 1}'::jsonb, 'invoice counts, with the invalid one counted');
select is((select array[total::text, balance::text] from fin.invoices where source_id = 'I1'), array['1000.00', '400.50'], 'invoice money is numeric(18,2)');
select is((select array[total::text, balance::text] from fin.invoices where source_id = 'I10'), array['1234.57', '-0.01'], 'money is rounded once, half away from zero');
select is((select array[issue_date::text, due_date::text] from fin.invoices where source_id = 'I1'), array['2026-10-01', '2026-10-31'], 'dates are dates');
select is((select customer_name from fin.invoices where source_id = 'I1'), 'Acme Corp [masked]', 'customer_name is masked');
select is((select array[class_id, entity_code, multi_class::text] from fin.invoices where source_id = 'I1'), array['class-synthetic-pkg', 'PKG', 'false'], 'header class maps to PKG');
select is((select array[class_id, entity_code, multi_class::text] from fin.invoices where source_id = 'I2'), array['class-synthetic-apk', 'APK', 'false'], 'a line class maps to APK (APK rows are stored, PKG views exclude them)');
select is((select array[class_id, entity_code, multi_class::text] from fin.invoices where source_id = 'I3'), array[null, 'unmapped', 'true'], 'two classes that disagree: multi_class, no class, unmapped (never allocated)');
select is((select array[class_id, entity_code] from fin.invoices where source_id = 'I4'), array[null, 'PKG'], 'no class: the customer mapping applies');
select is((select entity_code from fin.invoices where source_id = 'I5'), 'unmapped', 'no class and an unmapped customer: unmapped');
select is((select entity_code from fin.invoices where source_id = 'I10'), 'PKG', 'an unmapped class falls back to the customer mapping');
select is((select array[voided::text, total::text] from fin.invoices where source_id = 'I6'), array['true', '0.00'], 'a voided invoice is stored with the voided flag');
select is((select currency_code from fin.invoices where source_id = 'I8'), 'EUR', 'currency_code comes from CurrencyRef');
select is((select r ->> 'non_usd_invoices' from run1), '1', 'non-USD invoices are counted');
select is((select r ->> 'multi_class_invoices' from run1), '1', 'multi-class invoices are counted');
select is((select currency_code from fin.invoices where source_id = 'I1'), 'USD', 'USD is the default currency');
select is((select count(*)::int from fin.invoices where source_id in ('I9', 'I-dead')), 0, 'an invalid or dead invoice creates no row');

-- bills
select is((select count(*)::int from fin.bills), 1, 'one bill: B1 (B-pay is payroll, B-gone is deleted)');
select is((select array[vendor_name, class_id, entity_code, total::text, balance::text] from fin.bills where source_id = 'B1'), array['Vendor One [masked]', 'class-synthetic-pkg', 'PKG', '250.00', '250.00'], 'bill fields, masked vendor name and class entity');

-- payments
select is((select count(*)::int from fin.payments), 8, '8 payment rows: P1, P2, P3, P4 x3 (two allocations + the unapplied remainder), P7, P8 (P5 is dead)');
select is((select array[(p.invoice_id = i.id)::text, p.amount::text, p.paid_at::text, p.entity_code, p.customer_name] from fin.payments p join fin.invoices i on i.source_id = 'I1' where p.source_id = 'P1'),
          array['true', '600.00', '2026-10-10 04:00:00+00', 'PKG', 'Acme Corp [masked]'], 'P1 is applied to I1; paid_at is local midnight in America/New_York');
select is((select array[invoice_id::text, amount::text, alloc_no::text] from fin.payments where source_id = 'P2'), array[null, '50.00', '0'], 'a payment whose invoice is unknown is stored unapplied');
select is((select array[invoice_id::text, amount::text] from fin.payments where source_id = 'P3'), array[null, '30.00'], 'a link to a voided invoice is refused (unapplied)');
select is((select r -> 'payments' ->> 'links_refused_voided_invoice' from run1), '1', 'the refused link is counted');
select is((select r -> 'payments' ->> 'unapplied_unknown_invoice' from run1), '2', 'the unknown invoice (P2) and the one skipped as invalid (P8 -> I9) are counted');
select is((select array[invoice_id::text, amount::text] from fin.payments where source_id = 'P8'), array[null, '12.00'], 'a payment against an invoice that was skipped as invalid is stored unapplied');
select is((select array_agg(alloc_no || ':' || amount || ':' || (invoice_id is not null) order by alloc_no) from fin.payments where source_id = 'P4'),
          array['0:100.00:true', '1:50.00:true', '2:25.00:false'], 'P4: two invoice allocations (the credit-memo line is not one) and the unapplied remainder');
select is((select count(*)::int from fin.payments where source_id in ('P5')), 0, 'a payment of a deleted invoice has no rows (P5)');
select is((select count(*)::int from fin.transactions where txn_type in ('BillPayment') and source_id = 'BP2'), 0, 'a BillPayment of a deleted/excluded bill has no ledger rows (T-051 M2)');

-- transactions: sign convention (debit positive), header and lines, posted_at, entity, uncategorized
select is((select array_agg(line_no || ':' || amount order by line_no) from fin.transactions where txn_type = 'Purchase' and source_id = 'PU1'),
          array['0:-50.00', '1:30.00', '2:20.00'], 'Purchase: the paying account is credited (negative), expense lines debit (positive)');
select is((select array_agg(line_no || ':' || amount order by line_no) from fin.transactions where txn_type = 'Deposit' and source_id = 'D1'),
          array['0:100.00', '1:-100.00'], 'Deposit: the bank account is debited, the source line credits; a linked-payment line without detail is skipped');
select is((select array_agg(line_no || ':' || amount || ':' || entity_code order by line_no) from fin.transactions where txn_type = 'JournalEntry' and source_id = 'J1'),
          array['1:75.00:APK', '2:-75.00:unmapped'], 'JournalEntry: Debit positive, Credit negative; the line class sets the entity; unknown PostingType and subtotal lines are skipped');
select is((select array_agg(line_no || ':' || amount order by line_no) from fin.transactions where txn_type = 'Bill' and source_id = 'B1'), array['0:-250.00', '1:250.00'], 'Bill: the A/P account is credited, expense lines debit');
select is((select amount from fin.transactions where txn_type = 'BillPayment' and source_id = 'BP1'), -250.00, 'BillPayment: the paying account is credited');
select is((select entity_code from fin.transactions where txn_type = 'BillPayment' and source_id = 'BP1'), 'PKG', 'a BillPayment takes the entity of the bill it pays');
select is((select array_agg(line_no || ':' || amount order by line_no) from fin.transactions where txn_type = 'Purchase' and source_id = 'PU-cr'),
          array['0:40.00', '1:-40.00', '2:-5.00'], 'a Purchase with Credit = true flips every sign (header debit, lines credit); an item line is kept with its sign');
select is((select account_id from fin.transactions where txn_type = 'Purchase' and source_id = 'PU-cr' and line_no = 2), null, 'an item-based line has no account');
select is((select r ->> 'null_account_lines' from run1), '1', 'lines without an account are counted');
select is((select amount from fin.transactions where txn_type = 'Payment' and source_id = 'P1'), 600.00, 'Payment: the deposit account is debited');
select is((select posted_at from fin.transactions where txn_type = 'Deposit' and source_id = 'D1' and line_no = 0), '2026-10-24T04:00:00Z'::timestamptz, 'posted_at is the transaction date at 00:00 America/New_York (EDT)');
select is((select array[a.source_id, t.is_uncategorized::text] from fin.transactions t join fin.accounts a on a.id = t.account_id where t.txn_type = 'Purchase' and t.source_id = 'PU1' and t.line_no = 2),
          array['21', 'true'], 'a line on an "Uncategorized ..." account is flagged');
select is((select count(*)::int from fin.transactions where is_uncategorized), 1, 'only that line is uncategorized');
select is((select array[class_id, entity_code] from fin.transactions where txn_type = 'Purchase' and source_id = 'PU1' and line_no = 1), array['class-synthetic-pkg', 'PKG'], 'a transaction line carries its class and entity');
select is((select entity_code from fin.transactions where txn_type = 'Purchase' and source_id = 'PU1' and line_no = 0), 'PKG', 'the header row takes the document''s single class entity');
select is((select count(*)::int from fin.transactions where source_id in ('PU-emp', 'J-emp')), 0, 'legacy raw transactions naming an Employee (EntityRef type, Entity Type in any case) are dead and not stored');
select is((select count(*)::int from fin.transactions where source_id in ('PU-pay', 'PU-ent', 'B-pay')), 0, 'transactions on a payroll account or naming an excluded entity are not stored');
select is((select array[currency_code, amount::text] from fin.transactions where source_id = 'PU-eur'), array['EUR', '-10.00'], 'a non-USD transaction is stored with its currency');
select is((select r ->> 'non_usd_transactions' from run1), '1', 'non-USD transactions are counted');
select is((select count(*)::int from fin.transactions where account_id is not null and account_id not in (select id from fin.accounts)), 0, 'every account_id exists');
select is((select r -> 'transactions' ->> 'invalid' from run1), '0', 'no invalid transaction rows in the fixtures');

-- raw_record_id comes only from the matching object type
select is((select count(*)::int from fin.accounts a join raw.source_records r on r.id = a.raw_record_id where r.object_type <> 'Account'), 0, 'accounts point at Account raw records');
select is((select count(*)::int from fin.invoices a join raw.source_records r on r.id = a.raw_record_id where r.object_type <> 'Invoice'), 0, 'invoices point at Invoice raw records');
select is((select count(*)::int from fin.bills a join raw.source_records r on r.id = a.raw_record_id where r.object_type <> 'Bill'), 0, 'bills point at Bill raw records');
select is((select count(*)::int from fin.payments a join raw.source_records r on r.id = a.raw_record_id where r.object_type <> 'Payment'), 0, 'payments point at Payment raw records');
select is((select count(*)::int from fin.transactions a join raw.source_records r on r.id = a.raw_record_id where r.object_type <> a.txn_type or r.external_id <> a.source_id), 0, 'transactions point at the raw record of their own type and id');
select is((select count(*)::int from fin.invoices where raw_record_id is null) + (select count(*)::int from fin.transactions where raw_record_id is null), 0, 'every row has its raw record');

-- another file's or lane's records are never read
select is((select count(*)::int from fin.invoices where lane_id = 'APK' or source_id = 'X1'), 0, 'records of another connection were not read');

-- run row: class tracking on, no fallback
select is((select array[class_tracking::text, class_fallback::text, mapping_mode, reallocation_count::text] from fin.normalize_runs), array['true', 'false', 'file_class', '0'], 'the run row records class tracking on and no fallback');
select is((select unseen_cutoff from fin.normalize_runs), null, 'no successful full run: no unseen cutoff');

-- ---------------------------------------------------------------- idempotent: a second run changes nothing
create temp table snap1 on commit drop as select pg_temp.snap() as s;
create temp table run2 on commit drop as select pg_temp.norm() as r;
select is(pg_temp.snap(), (select s from snap1), 'a re-run over unchanged raw data produces no diff at all (updated_at included)');
select is((select array[(r -> t ->> 'inserted')::int, (r -> t ->> 'updated')::int, (r -> t ->> 'tombstoned')::int] from run2), array[0, 0, 0], 'a re-run writes nothing: ' || t)
from unnest(array['accounts', 'invoices', 'bills', 'payments', 'transactions']) t;
select is((select count(*)::int from fin.normalize_runs), 2, 'each run is recorded');

-- ---------------------------------------------------------------- changes: lost lines, a link moves, a payment is linked later, deleted invoice
select pg_temp.raw('Purchase', 'PU1', '{"Id": "PU1", "TxnDate": "2026-10-22", "TotalAmt": 30, "AccountRef": {"value": "10"}, "Line": [{"Id": "1", "Amount": 30, "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "20"}, "ClassRef": {"value": "class-synthetic-pkg"}}}]}');
select pg_temp.raw('Invoice', 'I-later', '{"Id": "I-later", "TxnDate": "2026-10-11", "TotalAmt": 50, "Balance": 0, "CustomerRef": {"value": "cust-pkg"}}');
-- P1 moves from I1 to I4 (a reallocation); I7 is deleted (its payment P7 becomes dead).
select pg_temp.raw('Payment', 'P1', '{"Id": "P1", "TxnDate": "2026-10-10", "TotalAmt": 600, "UnappliedAmt": 0, "CustomerRef": {"value": "cust-pkg"}, "DepositToAccountRef": {"value": "10"}, "Line": [{"Amount": 600, "LinkedTxn": [{"TxnId": "I4", "TxnType": "Invoice"}]}]}');
select pg_temp.raw('Invoice', 'I7', '{"Id": "I7"}', true);
create temp table ids_before on commit drop as
  select (select id from fin.payments where source_id = 'P2') as p2_row, (select id from fin.payments where source_id = 'P1') as p1_row,
         (select id from fin.invoices where source_id = 'I1') as i1, (select id from fin.invoices where source_id = 'I4') as i4,
         (select id from fin.invoices where source_id = 'I7') as i7;
create temp table run3 on commit drop as select pg_temp.norm() as r;

select is((select array[deleted::text, amount::text] from fin.transactions where txn_type = 'Purchase' and source_id = 'PU1' and line_no = 2), array['true', '20.00'], 'a line the document lost is tombstoned (deleted = true), not removed');
select is((select array[deleted::text, amount::text] from fin.transactions where txn_type = 'Purchase' and source_id = 'PU1' and line_no = 1), array['false', '30.00'], 'the remaining line is live');
select is((select r -> 'transactions' ->> 'stale_lines' from run3), '1', 'one stale line counted');
select is((select count(*)::int from fin.transactions where txn_type = 'Purchase' and source_id = 'PU1'), 3, 'the stale line is still a row');
select is((select invoice_id from fin.payments where source_id = 'P2'), (select id from fin.invoices where source_id = 'I-later'), 'P2 is linked in place when its invoice arrives');
select is((select id from fin.payments where source_id = 'P2'), (select p2_row from ids_before), 'the P2 row keeps its id (linked in place on connection, source_id, alloc_no)');
select is((select invoice_id from fin.payments where source_id = 'P1'), (select i4 from ids_before), 'P1 now points at I4');
select is((select r -> 'payments' ->> 'reallocated' from run3), '1', 'one reallocation counted');
select is((select (reallocations -> 0) from fin.normalize_runs where reallocation_count = 1),
          (select jsonb_build_object('payment_row', b.p1_row, 'from_invoice', b.i1, 'to_invoice', b.i4) from ids_before b),
          'the reallocation is logged with ids only (payment row, old invoice, new invoice)');
select is((select array_agg(k order by k) from (select jsonb_object_keys((reallocations -> 0)) k from fin.normalize_runs where reallocation_count = 1) s), array['from_invoice', 'payment_row', 'to_invoice'], 'nothing but ids in a reallocation entry');
select is((select array[deleted::text, total::text, balance::text, coalesce(customer_id, 'none'), coalesce(customer_name, 'none')] from fin.invoices where source_id = 'I7'),
          array['true', '0.00', '0.00', 'none', 'none'], 'a deleted invoice keeps its row, flagged deleted, with its values scrubbed');
select is((select array[deleted::text, amount::text, coalesce(invoice_id::text, 'none'), coalesce(customer_name, 'none')] from fin.payments where source_id = 'P7'),
          array['true', '0.00', 'none', 'none'], 'the payment of the deleted invoice is dead too and scrubbed');
select is((select r -> 'invoices' ->> 'tombstoned' from run3), '1', 'one invoice tombstoned');
select is((select count(*)::int from fin.invoices where source_id = 'I7'), 1, 'never hard-deleted');

-- a restored record comes back live (a newer raw version)
select pg_temp.raw('Invoice', 'I7', '{"Id": "I7", "TxnDate": "2026-10-07", "TotalAmt": 71, "Balance": 71, "CustomerRef": {"value": "cust-pkg"}}', false);
select pg_temp.norm();
select is((select array[deleted::text, total::text] from fin.invoices where source_id = 'I7'), array['false', '71.00'], 'a restored invoice is live again');
select pg_temp.raw('Invoice', 'I7', '{"Id": "I7"}', true);
select pg_temp.norm();

-- ---------------------------------------------------------------- the full-reload deletion gap (T-051 M3)
-- Everything the reload saw has synced_at 12:00:00; I2 and the bill B1 were not seen (deleted while the cursor was stale).
update raw.source_records set synced_at = '2026-11-06T12:00:00Z' where connection_id = '00000000-0000-4000-8000-000000000661' and external_id not in ('I2', 'B1');
update raw.source_records set synced_at = '2026-11-06T09:00:00Z' where connection_id = '00000000-0000-4000-8000-000000000661' and external_id in ('I2', 'B1');
insert into core.sync_runs (lane_id, connection_id, kind, trigger, status, started_at, finished_at, error)
values ('PKG', '00000000-0000-4000-8000-000000000661', 'full', 'schedule', 'failed', '2026-11-06T13:00:00Z', '2026-11-06T13:05:00Z',
        '{"disposition": "fail", "endpoint": null, "http_status": null, "kind": "provider_error", "message": "x", "provider_error_code": null, "provider_tid": null, "retry_after_seconds": null}');
insert into core.sync_runs (lane_id, connection_id, kind, trigger, status, started_at, finished_at)
values ('PKG', '00000000-0000-4000-8000-000000000661', 'incremental', 'schedule', 'succeeded', '2026-11-06T14:00:00Z', '2026-11-06T14:01:00Z');
select pg_temp.norm();
select is((select unseen_cutoff from fin.normalize_runs order by finished_at desc, id limit 1), null, 'a failed full run and an incremental run do not define a cutoff');
select is((select deleted from fin.invoices where source_id = 'I2'), false, 'without a successful full run nothing is treated as unseen');
insert into core.sync_runs (lane_id, connection_id, kind, trigger, status, started_at, finished_at)
values ('PKG', '00000000-0000-4000-8000-000000000661', 'full', 'schedule', 'succeeded', '2026-11-06T12:00:00Z', '2026-11-06T12:05:00Z');
create temp table snap_before_unseen on commit drop as select count(*) as n from raw.source_records where connection_id = '00000000-0000-4000-8000-000000000661' and not deleted;
create temp table run4 on commit drop as select pg_temp.norm() as r;
select is((select unseen_cutoff from fin.normalize_runs order by finished_at desc, id limit 1), '2026-11-06T11:45:00Z'::timestamptz, 'the cutoff is the latest successful full run''s start minus 15 minutes');
select is((select array[deleted::text, total::text] from fin.invoices where source_id = 'I2'), array['true', '0.00'], 'an invoice the full reload did not see is treated as deleted');
select is((select array[deleted::text, total::text] from fin.bills where source_id = 'B1'), array['true', '0.00'], 'a bill the full reload did not see is treated as deleted');
select is((select count(*)::int from fin.transactions where txn_type = 'Bill' and source_id = 'B1' and deleted and amount = 0), 2, 'and so are its posting rows');
select is((select r ->> 'dead_unseen' from run4), '2', 'unseen records are counted');
select is((select count(*)::int from raw.source_records where connection_id = '00000000-0000-4000-8000-000000000661' and not deleted), (select n::int from snap_before_unseen), 'raw is not modified by the normalizer');
select is((select array[deleted::text] from fin.invoices where source_id = 'I1'), array['false'], 'a record the reload did see stays live');
-- If sync_runs rows were ever trimmed, the earlier cutoff stays in force: nothing dead comes back to life.
delete from core.sync_runs where connection_id = '00000000-0000-4000-8000-000000000661';
select pg_temp.norm();
select is((select array[unseen_cutoff::text, (select deleted::text from fin.bills where source_id = 'B1')] from fin.normalize_runs order by finished_at desc, id limit 1),
          array['2026-11-06 11:45:00+00', 'true'], 'with the sync_runs rows gone, the previous cutoff still applies (a dead record is not resurrected)');
-- BP1 paid the (now unseen) bill B1: a payment of a dead bill gets no ledger rows from now on.
select is((select deleted from fin.transactions where txn_type = 'BillPayment' and source_id = 'BP1'), true, 'a BillPayment of a bill that is now dead is tombstoned too');
-- CDC brings it back with a newer synced_at.
select pg_temp.raw('Invoice', 'I2', '{"Id": "I2", "TxnDate": "2026-10-02", "TotalAmt": 200, "Balance": 200, "CustomerRef": {"value": "cust-pkg"}, "Line": [{"Id": "1", "Amount": 200, "SalesItemLineDetail": {"ClassRef": {"value": "class-synthetic-apk"}}}]}', false, '2026-11-06T15:00:00Z');
select pg_temp.norm();
select is((select array[deleted::text, total::text] from fin.invoices where source_id = 'I2'), array['false', '200.00'], 'a record changed after the reload is live again');

-- ---------------------------------------------------------------- class tracking off (QB-10): customer mapping or unmapped, and the run says so
update core.connections set features = '{"class_tracking": false}' where id = '00000000-0000-4000-8000-000000000661';
create temp table run5 on commit drop as select pg_temp.norm() as r;
select is((select array[class_tracking::text, class_fallback::text] from fin.normalize_runs order by finished_at desc, id limit 1), array['false', 'true'], 'the run records the class fallback');
select is((select r ->> 'class_fallback' from run5), 'true', 'the result says the fallback was used');
select ok((select (r ->> 'class_fallback_rows')::int > 0 from run5), 'and how many rows went through it');
select is((select entity_code from fin.invoices where source_id = 'I1'), 'PKG', 'class off: I1 still maps through its customer');
select is((select entity_code from fin.invoices where source_id = 'I2'), 'PKG', 'class off: the APK class is ignored, the customer mapping decides (PKG)');
select is((select entity_code from fin.invoices where source_id = 'I5'), 'unmapped', 'class off: an unmapped customer is unmapped');
select is((select multi_class from fin.invoices where source_id = 'I3'), true, 'multi_class is still recorded');
update core.connections set features = '{"class_tracking": true}' where id = '00000000-0000-4000-8000-000000000661';
select pg_temp.norm();
select is((select entity_code from fin.invoices where source_id = 'I2'), 'APK', 'class tracking back on: the class maps to APK again');

-- ---------------------------------------------------------------- file mode (the whole file is the entity) and ambiguity
insert into core.lane_config (lane_id, version, config)
select 'PKG', c.version + 1, jsonb_set(c.config, '{qbo,entity_mapping_mode}', '"file"') from core.lane_config_current c where c.lane_id = 'PKG';
select pg_temp.norm();
select is((select array_agg(distinct entity_code order by entity_code) from fin.invoices where not deleted), array['PKG'], 'file mode: every live invoice is the lane''s own entity');
select is((select entity_code from fin.accounts where source_id = '20'), 'PKG', 'file mode: accounts are the own entity too');
select is((select class_fallback from fin.normalize_runs order by finished_at desc, id limit 1), false, 'file mode never needs classes, so there is no fallback');
insert into core.lane_config (lane_id, version, config)
select 'PKG', c.version + 1, jsonb_set(jsonb_set(c.config, '{qbo,entity_mapping_mode}', '"file_class"'), '{entities,by_entity,PKI,qbo_class_ids}', '["class-synthetic-pkg"]')
from core.lane_config_current c where c.lane_id = 'PKG';
select pg_temp.norm();
select is((select entity_code from fin.invoices where source_id = 'I1'), 'unmapped', 'an ambiguous class id (under PKG and PKI) is never guessed: unmapped, even though the customer maps to PKG');
select is((select entity_code from fin.invoices where source_id = 'I10'), 'PKG', 'a class that is in no list still falls back to the customer mapping');
select is((select entity_code from fin.invoices where source_id = 'I3'), 'unmapped', 'and a multi-class document with an ambiguous class stays unmapped');
select is((select entity_code from fin.transactions where txn_type = 'Purchase' and source_id = 'PU1' and line_no = 1), 'unmapped', 'an ambiguous class on a line is unmapped');

-- ---------------------------------------------------------------- payroll defence in depth (T-051 re-review M1)
-- A transaction stored earlier against an account that is later classified as payroll is dead on the next run.
select pg_temp.raw('Purchase', 'PU-late', '{"Id": "PU-late", "TxnDate": "2026-10-28", "TotalAmt": 15, "AccountRef": {"value": "10"}, "Line": [{"Id": "1", "Amount": 15, "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "20"}}}]}', false, '2026-11-06T16:00:00Z');
select pg_temp.norm();
select is((select count(*)::int from fin.transactions where source_id = 'PU-late' and not deleted), 2, 'PU-late is stored while account 20 is an ordinary expense account');
insert into core.lane_config (lane_id, version, config)
select 'PKG', c.version + 1, jsonb_set(c.config, '{finance,payroll,account_ids}', '["900", "20"]') from core.lane_config_current c where c.lane_id = 'PKG';
select pg_temp.norm();
select is((select array_agg(deleted::text || ':' || amount order by line_no) from fin.transactions where source_id = 'PU-late'), array['true:0.00', 'true:0.00'], 'when account 20 becomes payroll, the stored transaction is tombstoned and scrubbed');
select is((select array[deleted::text, name] from fin.accounts where source_id = '20'), array['true', '(deleted account)'], 'and the account is scrubbed');
select is((select count(*)::int from fin.transactions where not deleted and amount <> 0 and account_id = (select id from fin.accounts where source_id = '20')), 0, 'no live amount remains on the payroll account');

-- T-051 tombstones an account that became payroll by subtype or name; transactions stored earlier against it must die too.
select pg_temp.raw('Account', '22', '{"Id": "22", "Name": "Travel", "AccountType": "Expense"}', false, '2026-11-06T16:00:00Z');
select pg_temp.raw('Purchase', 'PU-tomb', '{"Id": "PU-tomb", "TxnDate": "2026-10-29", "TotalAmt": 8, "AccountRef": {"value": "10"}, "Line": [{"Id": "1", "Amount": 8, "AccountBasedExpenseLineDetail": {"AccountRef": {"value": "22"}}}]}', false, '2026-11-06T16:00:00Z');
select pg_temp.norm();
select is((select count(*)::int from fin.transactions where source_id = 'PU-tomb' and not deleted), 2, 'PU-tomb is stored while account 22 is ordinary');
select pg_temp.raw('Account', '22', '{"Id": "22"}', true, '2026-11-06T16:00:00Z');
select pg_temp.norm();
select is((select array_agg(deleted::text || ':' || amount order by line_no) from fin.transactions where source_id = 'PU-tomb'), array['true:0.00', 'true:0.00'],
          'when account 22 is re-synced as a tombstone (T-051 payroll exclusion), the transactions that reference it are tombstoned and scrubbed');

-- A BillPayment does not take the entity of a voided bill.
select pg_temp.raw('Bill', 'B-void', '{"Id": "B-void", "TxnDate": "2026-10-30", "TotalAmt": 0, "Balance": 0, "VendorRef": {"value": "v1"}, "Voided": true, "ClassRef": {"value": "class-synthetic-apk"}}', false, '2026-11-06T16:00:00Z');
select pg_temp.raw('BillPayment', 'BP-void', '{"Id": "BP-void", "TxnDate": "2026-10-30", "TotalAmt": 5, "CheckPayment": {"BankAccountRef": {"value": "10"}}, "Line": [{"Amount": 5, "LinkedTxn": [{"TxnId": "B-void", "TxnType": "Bill"}]}]}', false, '2026-11-06T16:00:00Z');
select pg_temp.norm();
select is((select entity_code from fin.transactions where source_id = 'BP-void'), 'unmapped', 'a BillPayment of a voided bill takes no entity from it');

-- ---------------------------------------------------------------- poison records and the failure handler
-- A record whose ids do not fit the fin columns is invalid (skipped, counted), never a run-wide failure.
select pg_temp.raw('Invoice', 'I-long', jsonb_build_object('Id', 'I-long', 'TxnDate', '2026-10-09', 'TotalAmt', 1, 'Balance', 1, 'ClassRef', jsonb_build_object('value', repeat('c', 300))), false, '2026-11-06T16:00:00Z');
create temp table run6 on commit drop as select pg_temp.norm() as r;
select is((select count(*)::int from fin.invoices where source_id = 'I-long'), 0, 'an invoice with an over-long class id is skipped');
select is((select r -> 'invoices' ->> 'invalid' from run6), '2', 'and counted as invalid (with I9)');
-- Any other database failure inside the run is re-raised with a constant message: no row data, no DETAIL (the Postgres log
-- and the job never see a failing row), only the SQLSTATE and the table and constraint names.
alter table fin.invoices add constraint tmp_poison check (customer_id is distinct from 'poison-cust');
select pg_temp.raw('Invoice', 'I-poison', '{"Id": "I-poison", "TxnDate": "2026-10-09", "TotalAmt": 1, "Balance": 1, "CustomerRef": {"value": "poison-cust"}}', false, '2026-11-06T16:00:00Z');
create temp table runs_before on commit drop as select count(*) as n from fin.normalize_runs;
select is(pg_temp.refusal($$select pg_temp.norm()$$), array['23514', 'fin.qbo_normalize failed: SQLSTATE 23514, table invoices, constraint tmp_poison', '', ''],
          'a constraint failure inside the run has a constant message and no DETAIL or HINT (the failing row is not echoed)');
select is((select count(*)::int from fin.normalize_runs), (select n::int from runs_before), 'and the failed run left no run row (the call rolled back)');
alter table fin.invoices drop constraint tmp_poison;
select pg_temp.raw('Invoice', 'I-poison', '{"Id": "I-poison"}', true, '2026-11-06T16:00:00Z');

-- ---------------------------------------------------------------- names: constant message, no DETAIL
select is((pg_temp.refusal($$insert into fin.accounts (lane_id, connection_id, source_id, name, type) values ('PKG', '00000000-0000-4000-8000-000000000661', 'n1', 'Savings 12345678', 't')$$)),
          array['23514', 'fin: a name contains a run of digits (possible account number)', '', ''], 'an account name with a digit run is refused with a constant message and no DETAIL or HINT');
select is((pg_temp.refusal($$update fin.invoices set customer_name = 'Acme 9876 5432 1' where source_id = 'I1'$$)),
          array['23514', 'fin: a name contains a run of digits (possible account number)', '', ''], 'a separated number in customer_name is refused the same way');
select is((pg_temp.refusal($$update fin.bills set vendor_name = 'Vendor １２３４５６' where source_id = 'B1'$$)),
          array['23514', 'fin: a name contains a run of digits (possible account number)', '', ''], 'a full-width number in vendor_name is refused the same way');
select is((pg_temp.refusal($$update fin.payments set customer_name = 'Acme 12345' where source_id = 'P1'$$)),
          array['23514', 'fin: a name contains a run of digits (possible account number)', '', ''], 'a payment customer_name is guarded too');
select is((pg_temp.refusal($$insert into fin.accounts (lane_id, connection_id, source_id, name, type) values ('PKG', '00000000-0000-4000-8000-000000000661', 'n2', 'Checking 1234 ****6789', 't')$$))[1], 'ok', 'a 4-digit run and star-masked digits are accepted');
select is((pg_temp.refusal($$update fin.accounts set type = 'Zero' where source_id = '11'$$))[1], 'ok', 'an update that does not touch a name still works');
-- Other check violations on these tables would echo the row in DETAIL; the normalizer never sends such a row, and the name guard fires first.
select is((pg_temp.refusal($$insert into fin.accounts (lane_id, connection_id, source_id, name, type, subtype) values ('PKG', '00000000-0000-4000-8000-000000000661', 'n3', 'Account 99999', 't', '')$$))[3], '', 'the name guard fires before any check constraint, so the refused name is not echoed in DETAIL');

-- ---------------------------------------------------------------- the payment link guard (database backstop)
select is((pg_temp.refusal($$update fin.payments set invoice_id = (select id from fin.invoices where source_id = 'I6') where source_id = 'P3'$$))[1:2],
          array['23514', 'fin.payments: a payment cannot be linked to a voided or deleted invoice'], 'the database refuses a link to a voided invoice');
select is((pg_temp.refusal($$update fin.payments set invoice_id = (select id from fin.invoices where source_id = 'I7') where source_id = 'P3'$$))[1], '23514', 'and to a deleted invoice');
select is((pg_temp.refusal($$update fin.payments set invoice_id = (select id from fin.invoices where source_id = 'I4') where source_id = 'P3'$$))[1], 'ok', 'but a live invoice is fine');

-- ---------------------------------------------------------------- RLS and cross-lane denial
update core.lanes set enabled = true where code = 'APK';
select pg_temp.raw('Invoice', 'A1', '{"Id": "A1", "TxnDate": "2026-10-01", "TotalAmt": 5, "Balance": 5}', false, '2026-11-06T16:00:00Z', '00000000-0000-4000-8000-000000000662', 'APK');
select pg_temp.norm('APK', '00000000-0000-4000-8000-000000000662');
select is((select count(*)::int from fin.invoices where lane_id = 'APK'), 2, 'the APK lane normalized its own file (X1 and A1)');
select is((select count(*)::int from fin.invoices where lane_id = 'PKG' and source_id = 'A1'), 0, 'and wrote nothing into PKG');
select is((select count(*)::int from fin.normalize_runs where lane_id = 'APK'), 1, 'APK has its own run row');

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select array_agg(distinct lane_id order by lane_id) from fin.normalize_runs), array['APK', 'PKG'], 'the owner reads the run rows of both lanes');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select array_agg(distinct lane_id) from fin.normalize_runs), array['PKG'], 'admin_technical (health view) reads only PKG run rows: APK is another lane');
select is((select count(*)::int from fin.invoices), 0, 'admin_technical reads no finance content');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from fin.normalize_runs), 0, 'finance_operator has no health view, so no run rows');
select ok((select count(*) > 0 from fin.invoices), 'finance_operator reads the PKG invoices');
select is((select count(*)::int from fin.invoices where lane_id = 'APK'), 0, 'finance_operator cannot read the APK lane');
reset role;
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from fin.normalize_runs), 0, 'an outsider reads no run rows');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from fin.normalize_runs), 0, 'AAL1 reads no run rows');
reset role;
set local role anon;
select is((pg_temp.refusal($$select count(*) from fin.normalize_runs$$))[1], '42501', 'anon cannot read run rows');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((pg_temp.refusal($$select core.fin_qbo_normalize('PKG', '00000000-0000-4000-8000-000000000661')$$))[1], '42501', 'a signed-in owner cannot call the normalizer');
select is((pg_temp.refusal($$insert into fin.normalize_runs (lane_id, connection_id, class_tracking, class_fallback, counts, started_at, finished_at) values ('PKG', '00000000-0000-4000-8000-000000000661', true, false, '{}', now(), now())$$))[1], '42501', 'nor write a run row');
reset role;
set local role service_role;
select is((pg_temp.refusal($$insert into fin.normalize_runs (lane_id, connection_id, class_tracking, class_fallback, counts, started_at, finished_at) values ('PKG', '00000000-0000-4000-8000-000000000661', true, false, '{}', now(), now())$$))[1], '42501', 'service_role cannot forge a run row either');
select is((pg_temp.refusal($$select core.fin_qbo_normalize('PKG', '00000000-0000-4000-8000-000000000662')$$))[1], '42501', 'service_role is lane-checked: PKG with the APK connection is refused');
reset role;

select * from finish();
rollback;
