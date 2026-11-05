-- T-055: finance normalized schema, part 1 (ledger and reports). docs/specs/finance.md §5 "Part 1", §4.4, §3.
-- Normalized QuickBooks rows (T-056 fills them from raw.source_records) plus the report cache (T-052). Subscription
-- tables are Part 2 (T-057). Stripe is the revenue source and GoHighLevel the subscriber source (rule 8): nothing here
-- is revenue, and nothing here has an account/routing number, a bank-feed balance or a document body (rules 6, 7).
--
-- Read: the 'finance' view (owner, finance_operator, and viewers who were given the named 'finance' view), AAL2, own lane
-- only: the standard lane policy. admin_technical has no 'finance' view, so it reads nothing here.
-- Write: service_role only (normalizer and report jobs). authenticated has no DML; AI output never writes these tables
-- (rule 7). Book balances: no column here is a balance of a bank account. `fin.accounts` has none on purpose (the cash
-- view reads the Balance Sheet report cache and shows it as "book balance"); `balance` on invoices/bills is the open
-- amount of that document. Nothing is named "bank balance".
--
-- Grain and keys (spec is silent; chosen conservatively):
--   * Every row belongs to one connection (a lane may hold several QuickBooks files, D-8), so source ids are unique per
--     (connection, ...), not per lane. The connection must be a QuickBooks connection of the same lane (composite FK).
--   * fin.transactions has one row per posting line: line_no 0 for a header-level row, 1.. for lines. Unique per
--     (connection, txn_type, source_id, line_no) because QuickBooks ids are only unique within an entity type.
--   * fin.payments has one row per (payment, invoice) allocation; invoice_id is null for an unapplied payment.
--   * raw_record_id points at the raw.source_records row the values came from (same connection; set null when the raw
--     row is purged by retention, the normalized row stays).
--   * entity_code is set by the normalizer from the lane_config mapping ('unmapped' when nothing matches). The code list
--     lives in lane_config, not here (rule 2): only its shape is checked.
--   * Voided and deleted records stay as rows (voided / deleted flags, set by the normalizer from the voided document or
--     the CDC deletion); every view must exclude them. They are never hard-deleted by the normalizer.

create schema fin;
revoke all on schema fin from public, anon;
grant usage on schema fin to authenticated, service_role;

-- Reference targets for composite foreign keys (lane/provider/connection consistency enforced by the database).
create unique index connections_id_lane_provider_key on core.connections (id, lane_id, provider);
create unique index source_records_id_connection_key on raw.source_records (id, connection_id);

-- Identity columns of a normalized row never change (a row cannot move to another lane, connection or source object).
-- Column names come from the trigger arguments.
create function fin.forbid_identity_change() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_col text;
begin
  foreach v_col in array tg_argv loop
    if pg_catalog.to_jsonb(new) -> v_col is distinct from pg_catalog.to_jsonb(old) -> v_col then
      raise exception 'fin.%: % cannot be changed', tg_table_name, v_col using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function fin.forbid_identity_change() from public, anon, authenticated;

-- ---------------------------------------------------------------- fin.accounts
-- No account or routing number columns, and no balance (see header). owner_entity_code is the legal owner from the
-- bank-account mapping in lane_config (D-18); entity_code is the entity the account's activity is attributed to.
create table fin.accounts (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  connection_id uuid not null,
  provider text not null default 'quickbooks' check (provider = 'quickbooks'),
  source_id text not null check (length(source_id) between 1 and 256),
  raw_record_id uuid,
  source_updated_at timestamptz,
  name text not null check (length(name) between 1 and 200),
  type text not null check (length(type) between 1 and 64),
  subtype text check (length(subtype) between 1 and 64),
  is_bank boolean not null default false,
  entity_code text not null default 'unmapped' check (entity_code ~ '^[A-Za-z0-9_]{1,32}$'),
  owner_entity_code text check (owner_entity_code ~ '^[A-Za-z0-9_]{1,32}$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, source_id),
  unique (id, connection_id),
  foreign key (connection_id, lane_id, provider) references core.connections (id, lane_id, provider)
    on update restrict on delete restrict,
  foreign key (raw_record_id, connection_id) references raw.source_records (id, connection_id)
    on update restrict on delete set null (raw_record_id)
);
comment on table fin.accounts is
  'QuickBooks chart of accounts (T-055). No balance and no account/routing numbers; cash is read from the Balance Sheet cache as "book balance".';
create index accounts_lane_id_idx on fin.accounts (lane_id);
create index accounts_lane_bank_idx on fin.accounts (lane_id, entity_code) where is_bank;

-- ---------------------------------------------------------------- fin.invoices
create table fin.invoices (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  connection_id uuid not null,
  provider text not null default 'quickbooks' check (provider = 'quickbooks'),
  source_id text not null check (length(source_id) between 1 and 256),
  raw_record_id uuid,
  source_updated_at timestamptz,
  customer_id text check (length(customer_id) between 1 and 256),
  issue_date date not null,
  due_date date,
  total numeric(18,2) not null,
  balance numeric(18,2) not null,
  class_id text check (length(class_id) between 1 and 256),
  entity_code text not null default 'unmapped' check (entity_code ~ '^[A-Za-z0-9_]{1,32}$'),
  voided boolean not null default false,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, source_id),
  unique (id, connection_id),
  foreign key (connection_id, lane_id, provider) references core.connections (id, lane_id, provider)
    on update restrict on delete restrict,
  foreign key (raw_record_id, connection_id) references raw.source_records (id, connection_id)
    on update restrict on delete set null (raw_record_id)
);
comment on table fin.invoices is 'QuickBooks invoices (T-055). balance = open amount of the invoice (AR), not a bank figure.';
create index invoices_lane_id_idx on fin.invoices (lane_id);
create index invoices_lane_entity_due_idx on fin.invoices (lane_id, entity_code, due_date) where balance <> 0 and not voided and not deleted;

-- ---------------------------------------------------------------- fin.bills
create table fin.bills (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  connection_id uuid not null,
  provider text not null default 'quickbooks' check (provider = 'quickbooks'),
  source_id text not null check (length(source_id) between 1 and 256),
  raw_record_id uuid,
  source_updated_at timestamptz,
  vendor_id text check (length(vendor_id) between 1 and 256),
  issue_date date not null,
  due_date date,
  total numeric(18,2) not null,
  balance numeric(18,2) not null,
  class_id text check (length(class_id) between 1 and 256),
  entity_code text not null default 'unmapped' check (entity_code ~ '^[A-Za-z0-9_]{1,32}$'),
  voided boolean not null default false,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, source_id),
  unique (id, connection_id),
  foreign key (connection_id, lane_id, provider) references core.connections (id, lane_id, provider)
    on update restrict on delete restrict,
  foreign key (raw_record_id, connection_id) references raw.source_records (id, connection_id)
    on update restrict on delete set null (raw_record_id)
);
comment on table fin.bills is 'QuickBooks bills (T-055). balance = open amount of the bill (AP), not a bank figure.';
create index bills_lane_id_idx on fin.bills (lane_id);
create index bills_lane_entity_due_idx on fin.bills (lane_id, entity_code, due_date) where balance <> 0 and not voided and not deleted;

-- ---------------------------------------------------------------- fin.payments
-- Customer payments received (QuickBooks Payment), one row per invoice allocation. Not revenue (rule 8): Stripe is.
create table fin.payments (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  connection_id uuid not null,
  provider text not null default 'quickbooks' check (provider = 'quickbooks'),
  source_id text not null check (length(source_id) between 1 and 256),
  raw_record_id uuid,
  source_updated_at timestamptz,
  invoice_id uuid,
  paid_at timestamptz not null,
  amount numeric(18,2) not null,
  entity_code text not null default 'unmapped' check (entity_code ~ '^[A-Za-z0-9_]{1,32}$'),
  voided boolean not null default false,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (connection_id, lane_id, provider) references core.connections (id, lane_id, provider)
    on update restrict on delete restrict,
  foreign key (raw_record_id, connection_id) references raw.source_records (id, connection_id)
    on update restrict on delete set null (raw_record_id),
  foreign key (invoice_id, connection_id) references fin.invoices (id, connection_id)
    on update restrict on delete restrict
);
comment on table fin.payments is
  'QuickBooks customer payments, one row per invoice allocation (T-055). Not a revenue source (Stripe is, rule 8).';
create unique index payments_source_alloc_key
  on fin.payments (connection_id, source_id, coalesce(invoice_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index payments_lane_id_idx on fin.payments (lane_id);
create index payments_invoice_idx on fin.payments (invoice_id) where invoice_id is not null;

-- ---------------------------------------------------------------- fin.transactions
-- One row per posting line. amount is the signed posted amount on account_id; the sign convention is fixed by the
-- normalizer (T-056) and documented there. posted_at is the posting instant (txn_date at 00:00 America/New_York when the
-- source has only a date).
create table fin.transactions (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  connection_id uuid not null,
  provider text not null default 'quickbooks' check (provider = 'quickbooks'),
  source_id text not null check (length(source_id) between 1 and 256),
  raw_record_id uuid,
  source_updated_at timestamptz,
  txn_type text not null check (length(txn_type) between 1 and 64),
  line_no integer not null default 0 check (line_no >= 0),
  txn_date date not null,
  posted_at timestamptz,
  account_id uuid,
  class_id text check (length(class_id) between 1 and 256),
  entity_code text not null default 'unmapped' check (entity_code ~ '^[A-Za-z0-9_]{1,32}$'),
  amount numeric(18,2) not null,
  is_uncategorized boolean not null default false,
  voided boolean not null default false,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, txn_type, source_id, line_no),
  foreign key (connection_id, lane_id, provider) references core.connections (id, lane_id, provider)
    on update restrict on delete restrict,
  foreign key (raw_record_id, connection_id) references raw.source_records (id, connection_id)
    on update restrict on delete set null (raw_record_id),
  foreign key (account_id, connection_id) references fin.accounts (id, connection_id)
    on update restrict on delete restrict
);
comment on table fin.transactions is 'QuickBooks posting lines (T-055): one row per (txn_type, source_id, line_no).';
create index transactions_lane_id_idx on fin.transactions (lane_id);
create index transactions_lane_account_date_idx on fin.transactions (lane_id, account_id, txn_date);
create index transactions_account_idx on fin.transactions (account_id) where account_id is not null;
create index transactions_lane_uncategorized_idx on fin.transactions (lane_id, entity_code, txn_date)
  where is_uncategorized and not voided and not deleted;

-- ---------------------------------------------------------------- fin.report_cache
-- Reports fetched from QuickBooks (pnl, balance_sheet, cash_flow, ar_aging_summary, ap_aging_summary, ...), as returned
-- after the connector's allowlist projection. params holds the request (range, accounting method, class filter);
-- params_hash is set by a trigger from params (SHA-256 of the jsonb text) so a caller cannot supply a wrong one.
-- Unique per (connection, report, params_hash, as_of): the spec's key plus the connection, as a lane may hold several files.
create table fin.report_cache (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  connection_id uuid not null,
  provider text not null default 'quickbooks' check (provider = 'quickbooks'),
  raw_record_id uuid,
  source_updated_at timestamptz,
  report text not null check (report ~ '^[a-z][a-z0-9_]{1,63}$'),
  params jsonb not null default '{}' check (pg_catalog.jsonb_typeof(params) = 'object' and pg_catalog.octet_length(params::text) <= 4096),
  params_hash text not null default '' check (params_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null check (pg_catalog.jsonb_typeof(payload) = 'object' and pg_catalog.octet_length(payload::text) <= 4194304),
  as_of timestamptz not null,
  fetched_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lane_id, connection_id, report, params_hash, as_of),
  foreign key (connection_id, lane_id, provider) references core.connections (id, lane_id, provider)
    on update restrict on delete restrict,
  foreign key (raw_record_id, connection_id) references raw.source_records (id, connection_id)
    on update restrict on delete set null (raw_record_id)
);
comment on table fin.report_cache is
  'QuickBooks report payloads (T-055). Balance Sheet entries are the source of "book balance" figures; payloads are projected by the connector, never raw.';
create index report_cache_lane_id_idx on fin.report_cache (lane_id);
create index report_cache_lane_report_asof_idx on fin.report_cache (lane_id, report, as_of desc);

create function fin.report_cache_set_hash() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.params_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(new.params::text, 'UTF8')), 'hex');
  return new;
end;
$$;
revoke all on function fin.report_cache_set_hash() from public, anon, authenticated;
-- Name sorts before the identity trigger so the hash is set first (triggers fire in name order).
create trigger report_cache_a_set_hash before insert or update on fin.report_cache
  for each row execute function fin.report_cache_set_hash();

-- ---------------------------------------------------------------- triggers, RLS, grants (all six tables)
do $$
declare
  v_table text;
  v_identity text[];
begin
  foreach v_table in array array['accounts', 'invoices', 'bills', 'payments', 'transactions', 'report_cache'] loop
    v_identity := case v_table
      when 'transactions' then array['lane_id', 'connection_id', 'provider', 'source_id', 'txn_type', 'line_no']
      when 'report_cache' then array['lane_id', 'connection_id', 'provider', 'report', 'as_of']
      when 'payments' then array['lane_id', 'connection_id', 'provider', 'source_id', 'invoice_id']
      else array['lane_id', 'connection_id', 'provider', 'source_id']
    end;
    execute format('create trigger %I before update on fin.%I for each row execute function core.set_updated_at()',
                   v_table || '_set_updated_at', v_table);
    execute format('create trigger %I before update on fin.%I for each row execute function fin.forbid_identity_change(%s)',
                   v_table || '_identity', v_table, (select string_agg(quote_literal(c), ', ') from unnest(v_identity) c));
    execute format('alter table fin.%I enable row level security', v_table);
    -- The standard lane policy (architecture §5.4); the catalog test checks this exact shape.
    execute format($p$create policy %I on fin.%I for select to authenticated using (
      (select auth.jwt() ->> 'aal') = 'aal2'
      and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'finance'))::text[]))$p$,
      v_table || '_select', v_table);
    execute format('revoke all on fin.%I from public, anon, authenticated', v_table);
    execute format('grant select on fin.%I to authenticated', v_table);
    execute format('grant select, insert, update, delete on fin.%I to service_role', v_table);
  end loop;
end;
$$;
revoke all on all sequences in schema fin from public, anon, authenticated;
