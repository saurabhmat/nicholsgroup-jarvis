-- fin.report_cache_guard value checks (T-052; T-055 final security review M4): a string value with a letter and a run of
-- 5 or more digits is refused at any depth; a non-object payload raises from the guard itself; every refusal has a
-- constant message and no DETAIL/HINT; the depth limit is the reason the connector flattens rows; cross-lane denial and
-- the service_role statement timeout. The guard's earlier checks (top-level keys, forbidden keys) are in 130.
begin;
select plan(80);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
insert into core.connections (id, lane_id, provider, external_account_id, status) values
  ('00000000-0000-4000-8000-000000000621', 'PKG', 'quickbooks', 'realm-synthetic-62a', 'active'),
  ('00000000-0000-4000-8000-000000000622', 'APK', 'quickbooks', 'realm-synthetic-62b', 'active');

-- Runs a statement as service_role and returns {sqlstate, message, detail, hint, <stacked context has no row data>}.
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
-- An insert of one report with the payload text p (a literal), as the real writer would.
create function pg_temp.put(p text, p_as_of text default '2026-11-06T12:00:00Z') returns text
language sql as $$
  select format($f$insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at)
                   values ('PKG', '00000000-0000-4000-8000-000000000621', 'pnl', '{"method": "accrual"}', %L::jsonb, %L, now())$f$, p, p_as_of);
$$;
-- A report whose one data cell has the value v (JSON-escaped by to_jsonb).
create function pg_temp.cell(v text) returns text language sql immutable as $$
  select jsonb_build_object('Header', jsonb_build_object('ReportName', 'ProfitAndLoss'),
    'Rows', jsonb_build_object('Row', jsonb_build_array(jsonb_build_object('type', 'Data', 'ColData', jsonb_build_array(jsonb_build_object('value', v, 'id', '35'), jsonb_build_object('value', '100.00')))))
  )::text;
$$;
grant execute on function pg_temp.refusal(text), pg_temp.put(text, text), pg_temp.cell(text) to service_role;

-- ---------------------------------------------------------------- the guard function
select is((select prosecdef from pg_proc where oid = 'fin.report_cache_guard()'::regprocedure), true, 'the guard is still security definer (it calls the private raw functions)');
select ok(not has_function_privilege('authenticated', 'fin.report_cache_guard()', 'execute') and not has_function_privilege('anon', 'fin.report_cache_guard()', 'execute'),
          'neither authenticated nor anon executes the guard');
select is((select proconfig from pg_proc where oid = 'fin.report_cache_guard()'::regprocedure), array['search_path=""'], 'the guard pins an empty search_path');
select has_trigger('fin', 'report_cache', 'report_cache_b_guard', 'the guard is still attached before insert or update');

-- ---------------------------------------------------------------- non-object payloads raise from the guard
set local role service_role;
select is((pg_temp.refusal(format($f$insert into fin.report_cache (lane_id, connection_id, report, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000621', 'pnl', %L::jsonb, '2026-11-06T12:00:01Z', now())$f$, p)))[1:2],
          array['23514', 'fin.report_cache: payload must be a JSON object'], 'a ' || d || ' payload is refused by the guard with a constant message')
from (values ('[]', 'array'), ('"Operating Checking 123456789"', 'string'), ('12345678', 'number'), ('null', 'JSON null'), ('true', 'boolean')) v(p, d);
select is((pg_temp.refusal(pg_temp.put('"Operating Checking 123456789"')))[3:4], array['', ''], 'the non-object refusal carries no DETAIL or HINT (no table data is echoed)');
select is((pg_temp.refusal($$insert into fin.report_cache (lane_id, connection_id, report, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000621', 'pnl', null, now(), now())$$))[1:3], array['23514', 'fin.report_cache: payload must be a JSON object', ''], 'an SQL NULL payload is refused by the guard too');
select is((pg_temp.refusal($$update fin.report_cache set payload = '[1]'::jsonb where lane_id = 'PKG'$$))[1], 'ok', 'an UPDATE with no rows is a no-op (control for the next checks)');

-- ---------------------------------------------------------------- string values: a letter and a run of 5+ digits
select is((pg_temp.refusal(pg_temp.put(pg_temp.cell(v))))[1:2], array['22023', 'fin.report_cache: payload contains a text value that looks like an account number'],
          'refused: ' || d)
from (values
  ('Operating Checking 123456789', 'a label with a 9-digit account number'),
  ('Savings 12345', 'a label with exactly 5 digits'),
  ('12345 Savings', 'digits first'),
  ('ab12345cd', 'digits inside letters'),
  ('Acct #00012345', 'leading zeros after a hash'),
  (E'Checking\n123456', 'digits on a new line after a letter'),
  ('Checking １２３４５６', 'full-width digits (NFKC)'),
  ('é12345', 'a non-ASCII letter'),
  ('Konto ٠١٢٣٤ 12345', 'a non-ASCII word with digits'),
  ('x1234567890123456', 'a 16-digit card-like run'),
  ('2026-11-06T10:00:00.123456Z', 'a date-time with 6 fractional digits (the connector normalises Header.Time first)')) v(v, d);
select is((pg_temp.refusal(pg_temp.put(pg_temp.cell(v), '2026-11-07T00:00:0' || n || 'Z')))[1], 'ok', 'accepted: ' || d)
from (values
  (1, '2026-11-06T10:00:00-08:00', 'an ISO date-time (runs of 4 at most)'),
  (2, '1234567.89', 'an amount with 7 digits (no letter)'),
  (3, '-12345.67', 'a negative amount'),
  (4, '123456', 'a 6-digit account id (no letter)'),
  (5, 'Checking 1234', 'a label with a 4-digit run'),
  (6, 'Checking ****6789', 'a masked number'),
  (7, 'Total Income', 'a plain label'),
  (8, 'INV-1234 / 5678', 'document numbers with short runs')) v(n, v, d);

-- ---------------------------------------------------------------- depth: values and keys at any level
select is((pg_temp.refusal(pg_temp.put('{"Rows": {"Row": [{"type": "Data", "ColData": [{"value": "ok"}, {"id": "9", "value": "Reserve 99999"}]}]}}')))[1], '22023', 'a bad value deep in the rows is refused');
select is((pg_temp.refusal(pg_temp.put('{"Columns": {"Column": [{"ColTitle": "Mar 20260", "ColType": "Money"}]}}')))[1], '22023', 'a bad value in Columns is refused');
select is((pg_temp.refusal(pg_temp.put('{"Header": {"Option": [{"Name": "NoReceipt", "Value": "x12345"}]}}')))[1], '22023', 'a bad value in an array inside the Header is refused');
select is((pg_temp.refusal(pg_temp.put('{"Header": {"Time": "2026-11-06T10:00:00-08:00", "Currency": "USD"}, "Columns": {"Column": [{"ColTitle": "", "ColType": "Account"}, {"ColTitle": "Total", "ColType": "Money"}]}, "Rows": {"Row": [{"type": "Data", "level": 1, "ColData": [{"value": "Checking", "id": "35"}, {"value": "1234567.89"}]}]}}', '2026-11-06T12:00:02Z')))[1], 'ok', 'a realistic flat report is accepted');
-- A nested real-QuickBooks shape (section inside section) is over the 16-level limit: why the connector flattens.
select is((pg_temp.refusal(pg_temp.put('{"Rows": {"Row": [' || repeat('{"type": "Section", "Rows": {"Row": [', 6) || '{"type": "Data"}' || repeat(']}}', 6) || ']}}')))[1], '22023', 'six nested sections (21 levels) are refused by the depth limit');
select is((pg_temp.refusal(pg_temp.put('{"Rows": {"Row": [' || repeat('{"type": "Section", "Rows": {"Row": [', 2) || '{"type": "Data"}' || repeat(']}}', 2) || ']}}', '2026-11-06T12:00:03Z')))[1], 'ok', 'two nested sections are fine');
select is((pg_temp.refusal(pg_temp.put('{"Rows": {"Row": [{"type": "Data", "ColData": [{"value": "a"}]}]}, "Memo": "note"}')))[1:2], array['23514', 'fin.report_cache: payload has a top-level key that is not allowed'], 'the key checks still run first');
select is((pg_temp.refusal(pg_temp.put('{"Rows": {"Row": [{"routingNumber": "x"}]}}')))[1:2], array['22023', 'fin.report_cache: payload contains a field that must not be stored'], 'a forbidden key is still refused with its own constant message');

-- ---------------------------------------------------------------- no data in any refusal
select is(array_agg(distinct r[3] || '|' || r[4]), array['|'], 'every refusal above has an empty DETAIL and HINT')
from (select pg_temp.refusal(pg_temp.put(p, '2026-11-06T13:00:00Z')) r from (values
  ('[]'), ('{"Memo": 1}'), ('{"Rows": {"Row": [{"salary": "9"}]}}'), (pg_temp.cell('Operating Checking 123456789')), (pg_temp.cell('Savings 12345'))) v(p)) x;
select is((select count(*)::int from (select pg_temp.refusal(pg_temp.put(pg_temp.cell('Operating Checking 123456789'), '2026-11-06T13:00:01Z')) r) x where r[2] like '%1234%' or r[3] like '%1234%' or r[4] like '%1234%'), 0, 'the refused value is not in the message, detail or hint');

-- ---------------------------------------------------------------- UPDATE
select lives_ok(pg_temp.put(pg_temp.cell('Savings 1234'), '2026-11-06T14:00:00Z'), 'a row with a short run is stored');
select is((pg_temp.refusal($$update fin.report_cache set payload = pg_temp.cell('Savings 12345')::jsonb where as_of = '2026-11-06T14:00:00Z'$$))[1:2],
          array['22023', 'fin.report_cache: payload contains a text value that looks like an account number'], 'the value check also runs on UPDATE');
select is((pg_temp.refusal($$update fin.report_cache set payload = '"x"'::jsonb where as_of = '2026-11-06T14:00:00Z'$$))[1], '23514', 'an UPDATE to a non-object payload is refused');
select is((pg_temp.refusal($$update fin.report_cache set fetched_at = now() where as_of = '2026-11-06T14:00:00Z'$$))[1], 'ok', 'an UPDATE that leaves the payload unchanged is not re-scanned');
select is((pg_temp.refusal($$update fin.report_cache set payload = pg_temp.cell('Savings 1235')::jsonb where as_of = '2026-11-06T14:00:00Z'$$))[1], 'ok', 'an UPDATE to a clean payload is accepted');
reset role;

-- ---------------------------------------------------------------- cross-lane denial
set local role service_role;
select is((pg_temp.refusal(format($f$insert into fin.report_cache (lane_id, connection_id, report, payload, as_of, fetched_at) values ('APK', '00000000-0000-4000-8000-000000000621', 'pnl', %L::jsonb, '2026-11-06T15:00:00Z', now())$f$, pg_temp.cell('Total Income'))))[1], '23503',
          'cross-lane: a PKG connection cannot hold an APK report');
select is((pg_temp.refusal(format($f$insert into fin.report_cache (lane_id, connection_id, report, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000622', 'pnl', %L::jsonb, '2026-11-06T15:00:01Z', now())$f$, pg_temp.cell('Total Income'))))[1], '23503',
          'cross-lane: an APK connection cannot hold a PKG report');
select lives_ok(format($f$insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at) values ('APK', '00000000-0000-4000-8000-000000000622', 'balance_sheet', '{}', %L::jsonb, '2026-11-06T15:00:02Z', now())$f$, pg_temp.cell('Total Assets')), 'an APK report is stored for the APK connection');
reset role;

create function pg_temp.visible_lanes() returns text[] language sql as $$ select array(select distinct lane_id from fin.report_cache order by 1); $$;
grant execute on function pg_temp.visible_lanes() to authenticated, anon;

select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible_lanes(), array['PKG'], 'a PKG finance_operator reads PKG reports and not the APK report');
select is((select count(*)::int from fin.report_cache where lane_id = 'APK'), 0, 'the APK report is invisible to the PKG finance_operator');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from fin.report_cache), 0, 'the finance_operator at AAL1 reads no report');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from fin.report_cache), 0, 'admin_technical reads no report');
reset role;
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from fin.report_cache), 0, 'a user without a membership reads no report');
reset role;
set local role anon;
select throws_ok('select count(*) from fin.report_cache', '42501', null, 'anon cannot read reports');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$insert into fin.report_cache (lane_id, connection_id, report, payload, as_of, fetched_at) values ('PKG', '00000000-0000-4000-8000-000000000621', 'pnl', '{}', now(), now())$$, '42501', null, 'the owner cannot write a report (service_role only)');
reset role;

-- ---------------------------------------------------------------- core.fin_report_cache_put (the jobs' write path)
insert into core.connections (id, lane_id, provider, external_account_id, status) values
  ('00000000-0000-4000-8000-000000000623', 'PKG', 'stripe', 'acct-synthetic-62c', 'active'),
  ('00000000-0000-4000-8000-000000000624', 'PKG', 'quickbooks', 'realm-synthetic-62d', 'reconnect_required');
select ok(has_function_privilege('service_role', 'core.fin_report_cache_put(text, uuid, text, jsonb, jsonb, timestamptz, timestamptz)', 'execute')
          and not has_function_privilege('authenticated', 'core.fin_report_cache_put(text, uuid, text, jsonb, jsonb, timestamptz, timestamptz)', 'execute')
          and not has_function_privilege('anon', 'core.fin_report_cache_put(text, uuid, text, jsonb, jsonb, timestamptz, timestamptz)', 'execute'),
          'only service_role executes the report writer');
select is((select prosecdef from pg_proc where oid = 'core.fin_report_cache_put(text, uuid, text, jsonb, jsonb, timestamptz, timestamptz)'::regprocedure), false, 'the report writer is security invoker (service_role already holds the table grants)');
select is((select proconfig from pg_proc where oid = 'core.fin_report_cache_put(text, uuid, text, jsonb, jsonb, timestamptz, timestamptz)'::regprocedure), array['search_path=""'], 'the report writer pins an empty search_path');
set local role service_role;
create temp table put_ids (n int, id uuid) on commit drop;
grant all on put_ids to service_role;
insert into put_ids select 1, core.fin_report_cache_put('PKG', '00000000-0000-4000-8000-000000000621', 'balance_sheet', '{"method": "accrual", "end_date": "2026-11-06"}', pg_temp.cell('Checking')::jsonb, '2026-11-06T16:00:00Z', '2026-11-06T16:00:05Z');
select isnt((select id from put_ids where n = 1), null, 'put stores a report and returns its id');
insert into put_ids select 2, core.fin_report_cache_put('PKG', '00000000-0000-4000-8000-000000000621', 'balance_sheet', '{"end_date": "2026-11-06", "method": "accrual"}', pg_temp.cell('Savings')::jsonb, '2026-11-06T16:00:00Z', '2026-11-06T16:00:09Z');
select is((select id from put_ids where n = 2), (select id from put_ids where n = 1), 'the same key (params in any key order, same as_of) updates the same row');
reset role;
select is((select count(*)::int from fin.report_cache where as_of = '2026-11-06T16:00:00Z' and report = 'balance_sheet'), 1, 'one row per key');
select is((select payload #>> '{Rows,Row,0,ColData,0,value}' from fin.report_cache where as_of = '2026-11-06T16:00:00Z' and report = 'balance_sheet'), 'Savings', 'the second put replaced the payload');
select is((select fetched_at from fin.report_cache where as_of = '2026-11-06T16:00:00Z' and report = 'balance_sheet'), '2026-11-06T16:00:09Z'::timestamptz, 'and fetched_at');
select is((select params_hash from fin.report_cache where as_of = '2026-11-06T16:00:00Z' and report = 'balance_sheet'), encode(sha256(convert_to('{"method": "accrual", "end_date": "2026-11-06"}'::jsonb::text, 'UTF8')), 'hex'), 'params_hash comes from the database');
set local role service_role;
select lives_ok($$select core.fin_report_cache_put('PKG', '00000000-0000-4000-8000-000000000621', 'balance_sheet', '{"method": "accrual", "end_date": "2026-11-06"}', pg_temp.cell('Savings')::jsonb, '2026-11-06T17:00:00Z', now())$$, 'a later as_of is a new row');
reset role;
select is((select count(*)::int from fin.report_cache where report = 'balance_sheet' and lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000000621'), 2, 'history keeps both as_of values');
set local role service_role;
select is((pg_temp.refusal($$select core.fin_report_cache_put('PKG', '00000000-0000-4000-8000-000000000621', 'pnl', '{}', pg_temp.cell('Operating Checking 123456789')::jsonb, '2026-11-06T18:00:00Z', now())$$))[1:4],
          array['22023', 'fin.report_cache: payload contains a text value that looks like an account number', '', ''], 'the writer cannot get around the value guard (constant message, no detail)');
select is((pg_temp.refusal($$select core.fin_report_cache_put('PKG', '00000000-0000-4000-8000-000000000621', 'general_ledger', '{}', '{}', '2026-11-06T18:00:00Z', now())$$))[1], '23514', 'the writer cannot cache a report outside the allowlist');
select is((pg_temp.refusal($$select core.fin_report_cache_put('APK', '00000000-0000-4000-8000-000000000621', 'pnl', '{}', '{}', '2026-11-06T19:00:00Z', now())$$))[1], '42501', 'cross-lane: another lane''s id with this connection is refused');
select is((pg_temp.refusal($$select core.fin_report_cache_put('PKG', '00000000-0000-4000-8000-000000000622', 'pnl', '{}', '{}', '2026-11-06T19:00:00Z', now())$$))[1], '42501', 'cross-lane: this lane''s id with another lane''s connection is refused');
select is((pg_temp.refusal($$select core.fin_report_cache_put('PKG', '00000000-0000-4000-8000-000000000623', 'pnl', '{}', '{}', '2026-11-06T19:00:00Z', now())$$))[1], '42501', 'a Stripe connection cannot hold a QuickBooks report');
select is((pg_temp.refusal($$select core.fin_report_cache_put('PKG', '00000000-0000-4000-8000-000000000624', 'pnl', '{}', '{}', '2026-11-06T19:00:00Z', now())$$))[1], '42501', 'a connection in reconnect_required is refused');
select is((pg_temp.refusal($$select core.fin_report_cache_put('PKG', null, 'pnl', '{}', '{}', '2026-11-06T19:00:00Z', now())$$))[1], '22004', 'a missing argument is refused');
select lives_ok($$select core.fin_report_cache_put('APK', '00000000-0000-4000-8000-000000000622', 'pnl', '{}', pg_temp.cell('Total Income')::jsonb, '2026-11-06T19:00:00Z', now())$$, 'an APK report is stored for the APK connection');
reset role;
update core.lanes set enabled = false where code = 'APK';
set local role service_role;
select is((pg_temp.refusal($$select core.fin_report_cache_put('APK', '00000000-0000-4000-8000-000000000622', 'pnl', '{}', '{}', '2026-11-06T20:00:00Z', now())$$))[1], '42501', 'a disabled lane is refused');
reset role;
update core.lanes set enabled = true where code = 'APK';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select core.fin_report_cache_put('PKG', '00000000-0000-4000-8000-000000000621', 'pnl', '{}', '{}', now(), now())$$, '42501', null, 'authenticated cannot call the writer');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from fin.report_cache where lane_id = 'APK'), 0, 'the PKG finance_operator still cannot read the APK reports the writer stored');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select ok((select count(*) from fin.report_cache where lane_id = 'APK') >= 1 and (select count(*) from fin.report_cache where lane_id = 'PKG') >= 1, 'the owner reads both lanes');
reset role;

-- No stored report (above, from either write path) has a value the guard would refuse today.
select is((select count(*)::int from fin.report_cache c where exists (
             select 1 from jsonb_path_query(c.payload, 'strict $.**') v
             where jsonb_typeof(v) = 'string' and normalize(v #>> '{}', NFKC) ~ '[[:alpha:]]|[^\x01-\x7f]' and normalize(v #>> '{}', NFKC) ~ '[0-9]{5}')),
          0, 'no stored report holds a text value with a letter and a run of 5 digits');

select * from finish();
rollback;
