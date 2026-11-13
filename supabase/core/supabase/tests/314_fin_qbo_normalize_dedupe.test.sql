-- T-242: the normalizer after PKG's SQLSTATE 21000. Synthetic data only.
-- Covered: (a) the same QuickBooks entity twice in raw is impossible (unique per connection, type and id): a full load and later
-- incremental loads update the one row; (b) core.lane_config_current is one row per lane however many versions exist; the normalizer
-- runs on duplicate-prone shapes (one invoice paid by two payment lines, a line linking two invoices, a deposit of a payment, journal
-- lines, a full load then an incremental re-sync with newer versions) without a cardinality error, returns deduped_rows = 0 on clean
-- data, is idempotent, and its failure message names the step; grants unchanged.
begin;
select plan(13);

update core.lanes set enabled = true where code = 'PKG';
insert into core.connections (id, lane_id, provider, external_account_id, status)
values ('00000000-0000-4000-8000-0000000003e1', 'PKG', 'quickbooks', '9341450000000314', 'active');
-- Two more settings versions (like the realm and entity-mapping scripts): lane_config_current must still be one row.
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{qbo}', '{"realm_id": "9341450000000314", "entity_mapping_mode": "file"}') from core.lane_config_current where lane_id = 'PKG';
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{entities,own_entity}', '"PKG"') from core.lane_config_current where lane_id = 'PKG';

create temp table src (t text, id text, p jsonb) on commit drop;
insert into src values
 ('Account', '35', '{"Id":"35","Name":"Checking","AccountType":"Bank"}'),
 ('Account', '4', '{"Id":"4","Name":"Accounts Receivable","AccountType":"Accounts Receivable"}'),
 ('Account', '33', '{"Id":"33","Name":"Accounts Payable","AccountType":"Accounts Payable"}'),
 ('Customer', '1', '{"Id":"1","DisplayName":"Synthetic Bird Sanctuary"}'),
 ('Vendor', '41', '{"Id":"41","DisplayName":"Synthetic Hardware"}'),
 ('Invoice', '130', '{"Id":"130","TxnDate":"2026-10-01","DueDate":"2026-10-31","TotalAmt":100,"Balance":0,"CustomerRef":{"value":"1"},"Line":[{"Id":"1","Amount":100,"DetailType":"SalesItemLineDetail","SalesItemLineDetail":{}}]}'),
 ('Invoice', '131', '{"Id":"131","TxnDate":"2026-10-02","TotalAmt":50,"Balance":0,"CustomerRef":{"value":"1"},"Line":[]}'),
 -- one payment, two lines paying the SAME invoice, and one line linking two invoices
 ('Payment', '140', '{"Id":"140","TxnDate":"2026-10-05","TotalAmt":150,"UnappliedAmt":10,"CustomerRef":{"value":"1"},"DepositToAccountRef":{"value":"35"},"Line":[{"Amount":60,"LinkedTxn":[{"TxnId":"130","TxnType":"Invoice"}]},{"Amount":40,"LinkedTxn":[{"TxnId":"130","TxnType":"Invoice"}]},{"Amount":40,"LinkedTxn":[{"TxnId":"131","TxnType":"Invoice"},{"TxnId":"130","TxnType":"Invoice"}]}]}'),
 ('Bill', '150', '{"Id":"150","TxnDate":"2026-10-03","TotalAmt":75,"Balance":0,"VendorRef":{"value":"41"},"APAccountRef":{"value":"33"},"Line":[{"Id":"1","Amount":75,"DetailType":"AccountBasedExpenseLineDetail","AccountBasedExpenseLineDetail":{"AccountRef":{"value":"35"}}}]}'),
 -- the same Id under another type (QuickBooks ids are unique only per type)
 ('BillPayment', '150', '{"Id":"150","TxnDate":"2026-10-06","TotalAmt":75,"VendorRef":{"value":"41"},"CheckPayment":{"BankAccountRef":{"value":"35"}},"Line":[{"Amount":75,"LinkedTxn":[{"TxnId":"150","TxnType":"Bill"},{"TxnId":"150","TxnType":"Bill"}]}]}'),
 ('Deposit', '140', '{"Id":"140","TxnDate":"2026-10-07","TotalAmt":150,"DepositToAccountRef":{"value":"35"},"Line":[{"Amount":150,"LinkedTxn":[{"TxnId":"140","TxnType":"Payment"}]}]}'),
 ('JournalEntry', '140', '{"Id":"140","TxnDate":"2026-10-08","Line":[{"Id":"0","Amount":10,"JournalEntryLineDetail":{"PostingType":"Debit","AccountRef":{"value":"35"}}},{"Id":"0","Amount":10,"JournalEntryLineDetail":{"PostingType":"Credit","AccountRef":{"value":"4"}}}]}');

insert into raw.source_records (lane_id, connection_id, provider, object_type, external_id, payload, payload_hash, source_updated_at, deleted, synced_at)
select 'PKG', '00000000-0000-4000-8000-0000000003e1', 'quickbooks', t, id, p, md5(p::text), now() - interval '1 hour', false, now() from src;

-- ---------------------------------------------------------------- (a) and (b)
select throws_ok($$insert into raw.source_records (lane_id, connection_id, provider, object_type, external_id, payload, payload_hash, source_updated_at, deleted, synced_at)
                   values ('PKG', '00000000-0000-4000-8000-0000000003e1', 'quickbooks', 'Invoice', '130', '{"Id":"130"}', 'x', now(), false, now())$$,
                 '23505', null, '(a) the same entity id twice for one connection and type is refused: raw holds one row per entity');
select is((select count(*)::int from core.lane_config_current where lane_id = 'PKG'), 1, '(b) lane_config_current is one row per lane after extra versions');

-- ---------------------------------------------------------------- the run
set local role service_role;
create temp table r1 on commit drop as select core.fin_qbo_normalize('PKG', '00000000-0000-4000-8000-0000000003e1') as out;
reset role;
select is((select (out ->> 'deduped_rows')::int from r1), 0, 'a full load of duplicate-prone shapes normalizes; nothing needed deduping');
select is((select count(*)::int from fin.payments where connection_id = '00000000-0000-4000-8000-0000000003e1'), 4,
          'three allocation rows plus the unapplied rest for one payment (no collision on (payment, allocation))');
select is((select count(*)::int from fin.payments where connection_id = '00000000-0000-4000-8000-0000000003e1' and invoice_id is not null), 3,
          'all three allocations are linked to their invoice (two lines to the same invoice are kept apart)');
select is((select count(*)::int from fin.transactions where connection_id = '00000000-0000-4000-8000-0000000003e1' and source_id = '140'), 4,
          'the same Id under three types (payment, deposit, journal) gives separate posting rows');
select is((select count(*)::int from fin.transactions where connection_id = '00000000-0000-4000-8000-0000000003e1' and txn_type = 'JournalEntry'), 2,
          'journal lines with the same Line.Id are numbered by position (no collision)');

-- An incremental re-sync: newer versions of some entities replace their raw rows (one row per entity), then normalize again.
update raw.source_records set payload = jsonb_set(payload, '{TotalAmt}', '160'), payload_hash = 'v2', source_updated_at = now(), synced_at = now()
where connection_id = '00000000-0000-4000-8000-0000000003e1' and object_type = 'Payment' and external_id = '140';
set local role service_role;
create temp table r2 on commit drop as select core.fin_qbo_normalize('PKG', '00000000-0000-4000-8000-0000000003e1') as out;
create temp table r3 on commit drop as select core.fin_qbo_normalize('PKG', '00000000-0000-4000-8000-0000000003e1') as out;
reset role;
select is((select (out ->> 'deduped_rows')::int from r2), 0, 'after an incremental re-sync: still one row per key');
select is((select (out #>> '{transactions,inserted}')::int + (out #>> '{transactions,updated}')::int from r3), 0, 'a third run changes nothing (idempotent)');

-- ---------------------------------------------------------------- the step in the error, grants
select ok((select prosrc like '%step %%' and prosrc like '%v_step := ''payments''%' and prosrc like '%v_step := ''transactions''%'
           from pg_proc where oid = 'core.fin_qbo_normalize(text, uuid)'::regprocedure), 'the failure message names the step that was running');
select ok((select prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = 'core.fin_qbo_normalize(text, uuid)'::regprocedure),
          'still security definer with an empty search_path');
select ok(has_function_privilege('service_role', 'core.fin_qbo_normalize(text, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'core.fin_qbo_normalize(text, uuid)', 'execute')
          and not has_function_privilege('anon', 'core.fin_qbo_normalize(text, uuid)', 'execute'), 'service_role only');
select throws_ok($$select core.fin_qbo_normalize('APK', '00000000-0000-4000-8000-0000000003e1')$$, '42501', null,
                 'another lane is refused (the connection is PKG''s)');

select * from finish();
rollback;
