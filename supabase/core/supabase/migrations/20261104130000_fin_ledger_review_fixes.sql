-- T-055 review fixes (db, security and code reviews of a7e4c3d). Append-only: the first migration stays as committed.
--   * currency_code on the money tables (spec §11: foreign currency is excluded and flagged; views must filter on it).
--   * fin.payments: allocation number in a plain unique key (ON CONFLICT can target it); invoice_id is a mutable value.
--   * raw_record_id and other lookup indexes; indexes for the planned query paths.
--   * report_cache: report allowlist, frozen cache key, payload guard (top-level keys and forbidden keys).
--   * name columns: customer_name / vendor_name, and no digit run of 5 or more in any name (account numbers).
--   * multi_class on invoices and bills; ledger rows are never hard-deleted (service_role loses DELETE).
--   * identity-freeze error is SQLSTATE Z0055, not 42501 (permission denied).

-- ---------------------------------------------------------------- currency (spec §11)
alter table fin.transactions add column currency_code text not null default 'USD' check (currency_code ~ '^[A-Z]{3}$');
alter table fin.invoices add column currency_code text not null default 'USD' check (currency_code ~ '^[A-Z]{3}$');
alter table fin.payments add column currency_code text not null default 'USD' check (currency_code ~ '^[A-Z]{3}$');
alter table fin.bills add column currency_code text not null default 'USD' check (currency_code ~ '^[A-Z]{3}$');
comment on column fin.transactions.currency_code is 'ISO 4217 code of amount. Views must filter currency_code = ''USD'': foreign currency is excluded and flagged (spec §11).';
comment on column fin.invoices.currency_code is 'ISO 4217 code of total and balance. Views must filter currency_code = ''USD'': foreign currency is excluded and flagged (spec §11).';
comment on column fin.payments.currency_code is 'ISO 4217 code of amount. Views must filter currency_code = ''USD'': foreign currency is excluded and flagged (spec §11).';
comment on column fin.bills.currency_code is 'ISO 4217 code of total and balance. Views must filter currency_code = ''USD'': foreign currency is excluded and flagged (spec §11).';

-- ---------------------------------------------------------------- payments: one row per (payment, allocation)
alter table fin.payments add column alloc_no integer not null default 0 check (alloc_no >= 0);
drop index fin.payments_source_alloc_key;
alter table fin.payments add constraint payments_connection_source_alloc_key unique (connection_id, source_id, alloc_no);
comment on column fin.payments.alloc_no is
  'Allocation number within the payment (0, 1, ...). invoice_id is a value, not part of the key: an unapplied payment (invoice_id null) is later linked in place, and two allocations to one invoice are two rows.';

-- ---------------------------------------------------------------- names (no account numbers)
alter table fin.invoices add column customer_name text constraint invoices_customer_name_check check (length(customer_name) between 1 and 200);
alter table fin.payments add column customer_name text constraint payments_customer_name_check check (length(customer_name) between 1 and 200);
alter table fin.bills add column vendor_name text constraint bills_vendor_name_check check (length(vendor_name) between 1 and 200);
alter table fin.accounts add constraint accounts_name_no_digit_run check (name !~ '[0-9]{5,}');
alter table fin.invoices add constraint invoices_customer_name_no_digit_run check (customer_name !~ '[0-9]{5,}');
alter table fin.payments add constraint payments_customer_name_no_digit_run check (customer_name !~ '[0-9]{5,}');
alter table fin.bills add constraint bills_vendor_name_no_digit_run check (vendor_name !~ '[0-9]{5,}');
comment on column fin.accounts.name is 'Display name only. A run of 5 or more digits (an account number) is refused; the normalizer masks digit runs before insert (T-056).';
comment on column fin.invoices.customer_name is 'Display name only; digit runs of 5 or more are refused (the normalizer masks them, T-056).';
comment on column fin.payments.customer_name is 'Display name only; digit runs of 5 or more are refused (the normalizer masks them, T-056).';
comment on column fin.bills.vendor_name is 'Display name only; digit runs of 5 or more are refused (the normalizer masks them, T-056).';

-- ---------------------------------------------------------------- multi-class documents
alter table fin.invoices add column multi_class boolean not null default false;
alter table fin.bills add column multi_class boolean not null default false;
comment on column fin.invoices.multi_class is
  'True when the invoice''s lines carry more than one QuickBooks class; class_id is then null. The Controls panel lists these for Sophie (T-080, T-081).';
comment on column fin.bills.multi_class is
  'True when the bill''s lines carry more than one QuickBooks class; class_id is then null. The Controls panel lists these for Sophie (T-080, T-081).';

-- ---------------------------------------------------------------- indexes
-- Raw purge: ON DELETE SET NULL (raw_record_id) looks up the referencing rows of every fin table.
create index accounts_raw_record_idx on fin.accounts (raw_record_id) where raw_record_id is not null;
create index transactions_raw_record_idx on fin.transactions (raw_record_id) where raw_record_id is not null;
create index invoices_raw_record_idx on fin.invoices (raw_record_id) where raw_record_id is not null;
create index payments_raw_record_idx on fin.payments (raw_record_id) where raw_record_id is not null;
create index bills_raw_record_idx on fin.bills (raw_record_id) where raw_record_id is not null;
create index report_cache_raw_record_idx on fin.report_cache (raw_record_id) where raw_record_id is not null;
-- Connection FK checks on report_cache (the unique key starts with lane_id).
create index report_cache_connection_idx on fin.report_cache (connection_id);
drop index fin.report_cache_lane_report_asof_idx;
create index report_cache_lane_conn_report_asof_idx on fin.report_cache (lane_id, connection_id, report, as_of desc);
-- Query paths (T-081).
create index invoices_lane_customer_idx on fin.invoices (lane_id, customer_id);
create index invoices_lane_issue_date_idx on fin.invoices (lane_id, issue_date);
create index bills_lane_vendor_idx on fin.bills (lane_id, vendor_id);
create index payments_lane_paid_at_idx on fin.payments (lane_id, paid_at);
create index transactions_lane_entity_date_idx on fin.transactions (lane_id, entity_code, txn_date);
-- (lane_id) is a prefix of (lane_id, account_id, txn_date).
drop index fin.transactions_lane_id_idx;

-- ---------------------------------------------------------------- identity freeze: dedicated SQLSTATE
create or replace function fin.forbid_identity_change() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_col text;
  v_new jsonb := pg_catalog.to_jsonb(new);
  v_old jsonb := pg_catalog.to_jsonb(old);
begin
  foreach v_col in array tg_argv loop
    if v_new -> v_col is distinct from v_old -> v_col then
      raise exception 'fin.%: % cannot be changed', tg_table_name, v_col using errcode = 'Z0055';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function fin.forbid_identity_change() from public, anon, authenticated;

do $$
declare
  v_table text;
  v_identity text[];
begin
  foreach v_table in array array['accounts', 'invoices', 'bills', 'payments', 'transactions', 'report_cache'] loop
    v_identity := case v_table
      when 'transactions' then array['id', 'lane_id', 'connection_id', 'provider', 'source_id', 'txn_type', 'line_no']
      when 'report_cache' then array['id', 'lane_id', 'connection_id', 'provider', 'report', 'as_of', 'params', 'params_hash']
      when 'payments' then array['id', 'lane_id', 'connection_id', 'provider', 'source_id', 'alloc_no']
      else array['id', 'lane_id', 'connection_id', 'provider', 'source_id']
    end;
    execute format('drop trigger %I on fin.%I', v_table || '_identity', v_table);
    execute format('create trigger %I before update on fin.%I for each row execute function fin.forbid_identity_change(%s)',
                   v_table || '_identity', v_table, (select string_agg(quote_literal(c), ', ') from unnest(v_identity) c));
  end loop;
end;
$$;

-- ---------------------------------------------------------------- report_cache guard
-- Only the summary reports are cached (no detail reports with memos, descriptions or payee names). Names match
-- docs/specs/finance.md §5: pnl, balance_sheet, cash_flow, ar_aging_summary, ap_aging_summary.
alter table fin.report_cache drop constraint report_cache_report_check;
alter table fin.report_cache add constraint report_cache_report_check
  check (report in ('pnl', 'balance_sheet', 'cash_flow', 'ar_aging_summary', 'ap_aging_summary'));
comment on column fin.report_cache.params is
  'Request that produced the payload (range, accounting method, class filter). Part of the cache key, so frozen; a new fetch is a new row. T-052 puts the method and class markers here.';

-- The payload is an object whose top-level keys are QuickBooks'' report sections (Header, Columns, Rows), and no key at
-- any depth may be a forbidden one (raw.payload_scan: tokens, account/routing numbers, compensation words). Values are
-- not inspected: the connector projects reports to an allowlist (T-052). Security definer only to call the private raw
-- functions; it reads and writes nothing. An unchanged payload is not re-scanned. Errors never echo the payload.
create function fin.report_cache_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_catalog.jsonb_typeof(new.payload) is distinct from 'object' then
    return new; -- the table check refuses it
  end if;
  if tg_op = 'UPDATE' and new.payload is not distinct from old.payload then
    return new;
  end if;
  if exists (select 1 from pg_catalog.jsonb_object_keys(new.payload) k where k <> all (array['Header', 'Columns', 'Rows'])) then
    raise exception 'fin.report_cache: payload has a top-level key that is not allowed' using errcode = '23514';
  end if;
  if (raw.payload_scan(new.payload, 'quickbooks', false)).has_forbidden then
    raise exception 'fin.report_cache: payload contains a field that must not be stored' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function fin.report_cache_guard() from public, anon, authenticated;
create trigger report_cache_b_guard before insert or update on fin.report_cache
  for each row execute function fin.report_cache_guard();

-- ---------------------------------------------------------------- hardening
-- Ledger rows are tombstoned (deleted = true), never hard-deleted. report_cache is a cache and keeps DELETE.
revoke delete on fin.accounts, fin.transactions, fin.invoices, fin.payments, fin.bills from service_role;
-- Requested hardening for future fin functions. Postgres adds schema-level default privileges to the global ones, so this
-- cannot remove the built-in PUBLIC EXECUTE default (only a global revoke could, which would change every schema). The
-- real net stays the catalog test (050): any app function callable by authenticated and not reviewed fails it.
alter default privileges in schema fin revoke execute on functions from public;
