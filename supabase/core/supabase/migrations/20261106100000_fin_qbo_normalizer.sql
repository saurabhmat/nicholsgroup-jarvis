-- T-056: QuickBooks normalizer, raw.source_records -> fin.* (docs/specs/finance.md section 5 "Part 1").
-- One security-definer function, core.fin_qbo_normalize(lane, connection), reads the private raw rows of ONE connection and
-- upserts fin.accounts, fin.invoices, fin.bills, fin.payments and fin.transactions. Figures are parsed in SQL (rule 7):
-- JSON numbers become numeric(18,2) (rounded once, half away from zero), dates become date, instants timestamptz. AI output
-- never reaches these tables; the only caller is the job (service_role). Nothing here calls a provider.
--
-- Contract (tests pin each point; the same text is in the function comment):
--   * Idempotent: a second run over unchanged raw data changes nothing (no row written, updated_at untouched). Upserts only
--     write rows whose values differ.
--   * Order: accounts, then invoices and bills, then payments, then transactions. A payment whose invoice is not in raw is
--     stored unapplied (invoice_id null) and linked later in place on (connection_id, source_id, alloc_no).
--   * Never hard-delete (service_role has no DELETE on ledger tables, and this function never deletes). A raw record that is
--     deleted, not re-seen by the latest successful FULL load, or excluded (payroll, excluded entities) is a dead record:
--     its fin rows get deleted = true and their values are scrubbed (amounts 0, no account, no class, no customer/vendor or names; an
--     account keeps its type and entity but loses its name and subtype), because a raw
--     tombstone carries only the Id and cannot say whether it was a deletion or a D-25 exclusion. A dead record never
--     creates a row. A live record that comes back (a newer raw version) clears the flag.
--   * Full-reload deletion gap (T-051 M3): QuickBooks CDC cannot report a deletion that happened while the cursor was
--     stale, and a full reload does not delete what it does not see. The latest SUCCEEDED full sync run of the connection
--     (core.sync_runs, kind = 'full') defines a cutoff = its start minus 15 minutes (clock-skew margin); any entity record
--     whose synced_at is older was not re-seen by that load and is treated as deleted here. Raw is not modified. A record
--     changed later by CDC has a newer synced_at and is live again. No successful full run -> no cutoff.
--   * Payroll (D-25): T-051 excludes payroll in raw, so none is expected. Defence in depth for T-051 re-review M1: payroll
--     accounts are re-classified here from lane_config.finance.payroll (ids, subtypes, name net, sub-accounts, the same
--     rule as the connector), and any transaction referencing one, or an excluded customer/vendor, is dead. T-051 re-review
--     M2: a Payment or BillPayment whose LinkedTxn (Invoice or Bill) points at a dead record gets no ledger rows (a
--     tombstone cannot say if its target was a payroll bill, so any dead target counts).
--   * Entity (lane_config.entities / qbo.entity_mapping_mode): mode 'file' tags every row with entities.own_entity;
--     'file_class' resolves the document's classes through entities.by_entity.*.qbo_class_ids (only while the connection's
--     class-tracking flag is on), then the customer mapping (qbo_customer_ids), else 'unmapped'. A class listed under two
--     entities (a config error) is never guessed: the row is 'unmapped' whatever the customer says; a class in no list falls back
--     to the customer mapping. A document whose lines carry several classes sets multi_class, has a
--     null class_id, and takes an entity only when all its classes agree (otherwise 'unmapped': never allocated). With the
--     flag off in 'file_class' mode every row falls back to the customer mapping or 'unmapped' and the run row records
--     class_fallback = true (QB-10). APK/PKI rows are stored with their own code; PKG views filter on entity_code.
--   * fin.transactions: one row per posting line. Sign convention: amount = debit minus credit on account_id (debit
--     positive). line_no 0 is the header row (the account that pays or receives: Purchase paying account credit, Deposit
--     account debit, Payment deposit account debit, BillPayment paying account credit, Bill A/P account credit); lines 1..n
--     are the document's lines in order. Purchase and Bill expense lines debit (their AccountRef, or null for item lines); a Purchase with Credit = true (a card credit or refund)
--     flips every sign;
--     Deposit lines credit; JournalEntry lines follow their PostingType; lines without a recognised detail are skipped.
--     Invoice posts only to fin.invoices (its item accounts are not in raw). posted_at = txn_date 00:00 America/New_York.
--     Stripe is the revenue source (rule 8): no row here is revenue.
--   * Lost lines (a document that now has fewer lines) and lost payment allocations are tombstoned (deleted = true).
--   * A customer or vendor that is dead (deleted, not re-seen, excluded) gives its documents no name: customer_name / vendor_name are
--     null until the record is seen again (the documents themselves stay live unless they reference an excluded entity).
--   * Names (account name, customer_name, vendor_name) are NFKC-normalised and every run of 5 or more digits (up to three
--     separator characters between digits) is replaced by '[masked]' before insert; a BEFORE trigger refuses any value that
--     still has such a run, with a constant message and no DETAIL (replaces the T-055 CHECK constraints, whose error text
--     would echo the refused row).
--   * Payments: a link to a voided invoice is refused (invoice_id null, counted); a link to a dead invoice makes the whole
--     payment dead (above). A BEFORE trigger on fin.payments backs this up. A changed link on an existing allocation row
--     is a reallocation: logged on the run row with ids only.
--   * currency_code comes from CurrencyRef (USD when absent); non-USD rows are stored and counted (views exclude them).
--   * raw_record_id is set only from the matching object type (Invoice->invoices, Bill->bills and Bill transactions, ...).
--   * The run is recorded in fin.normalize_runs (counts, class-tracking state, fallback, cutoff, reallocations).
-- Failures abort the whole call (one transaction); every message is constant and carries no record data.

-- ---------------------------------------------------------------- accounts: a deleted flag like the other ledger tables
alter table fin.accounts add column deleted boolean not null default false;
comment on column fin.accounts.deleted is
  'True when the QuickBooks account was deleted, not re-seen by a full reload, or excluded as payroll (D-25); name and subtype are scrubbed then. Views must filter on it.';
drop index fin.accounts_lane_bank_idx;
create index accounts_lane_bank_idx on fin.accounts (lane_id, entity_code) where is_bank and not deleted;

-- ---------------------------------------------------------------- pure helpers
-- The digit class: ASCII plus the Unicode decimal-digit scripts most likely in a pasted number. NFKC maps full-width and
-- other compatibility digits to ASCII first. (The connector masks with \p{Nd}; this is the database's own net.)
create function fin.has_digit_run(p_text text) returns boolean
language sql immutable strict parallel safe set search_path = ''
as $$
  select normalize(p_text, NFKC) ~
    '[0-9\u0660-\u0669\u06F0-\u06F9\u07C0-\u07C9\u0966-\u096F\u09E6-\u09EF\u0A66-\u0A6F\u0AE6-\u0AEF\u0B66-\u0B6F\u0BE6-\u0BEF\u0C66-\u0C6F\u0CE6-\u0CEF\u0D66-\u0D6F\u0E50-\u0E59\u0ED0-\u0ED9\u0F20-\u0F29\u1040-\u1049\u17E0-\u17E9\u1810-\u1819](?:[^[:alpha:]0-9\u0660-\u0669\u06F0-\u06F9\u07C0-\u07C9\u0966-\u096F\u09E6-\u09EF\u0A66-\u0A6F\u0AE6-\u0AEF\u0B66-\u0B6F\u0BE6-\u0BEF\u0C66-\u0C6F\u0CE6-\u0CEF\u0D66-\u0D6F\u0E50-\u0E59\u0ED0-\u0ED9\u0F20-\u0F29\u1040-\u1049\u17E0-\u17E9\u1810-\u1819]{0,3}[0-9\u0660-\u0669\u06F0-\u06F9\u07C0-\u07C9\u0966-\u096F\u09E6-\u09EF\u0A66-\u0A6F\u0AE6-\u0AEF\u0B66-\u0B6F\u0BE6-\u0BEF\u0C66-\u0C6F\u0CE6-\u0CEF\u0D66-\u0D6F\u0E50-\u0E59\u0ED0-\u0ED9\u0F20-\u0F29\u1040-\u1049\u17E0-\u17E9\u1810-\u1819]){4,}'
$$;
comment on function fin.has_digit_run(text) is
  'True when the NFKC-normalised text has 5 or more digits in a row, allowing up to three non-letter separators between digits (an account number). T-056.';

create function fin.mask_digit_runs(p_text text) returns text
language sql immutable strict parallel safe set search_path = ''
as $$
  select regexp_replace(normalize(p_text, NFKC),
    '[0-9\u0660-\u0669\u06F0-\u06F9\u07C0-\u07C9\u0966-\u096F\u09E6-\u09EF\u0A66-\u0A6F\u0AE6-\u0AEF\u0B66-\u0B6F\u0BE6-\u0BEF\u0C66-\u0C6F\u0CE6-\u0CEF\u0D66-\u0D6F\u0E50-\u0E59\u0ED0-\u0ED9\u0F20-\u0F29\u1040-\u1049\u17E0-\u17E9\u1810-\u1819](?:[^[:alpha:]0-9\u0660-\u0669\u06F0-\u06F9\u07C0-\u07C9\u0966-\u096F\u09E6-\u09EF\u0A66-\u0A6F\u0AE6-\u0AEF\u0B66-\u0B6F\u0BE6-\u0BEF\u0C66-\u0C6F\u0CE6-\u0CEF\u0D66-\u0D6F\u0E50-\u0E59\u0ED0-\u0ED9\u0F20-\u0F29\u1040-\u1049\u17E0-\u17E9\u1810-\u1819]{0,3}[0-9\u0660-\u0669\u06F0-\u06F9\u07C0-\u07C9\u0966-\u096F\u09E6-\u09EF\u0A66-\u0A6F\u0AE6-\u0AEF\u0B66-\u0B6F\u0BE6-\u0BEF\u0C66-\u0C6F\u0CE6-\u0CEF\u0D66-\u0D6F\u0E50-\u0E59\u0ED0-\u0ED9\u0F20-\u0F29\u1040-\u1049\u17E0-\u17E9\u1810-\u1819]){4,}',
    '[masked]', 'g')
$$;
comment on function fin.mask_digit_runs(text) is
  'NFKC-normalises the text and replaces every digit run that fin.has_digit_run refuses with [masked]. Idempotent. T-056.';

-- JSON number -> numeric rounded once to 2 places (half away from zero); null for anything else or out of numeric(18,2) range.
create function fin.qbo_money(p jsonb) returns numeric
language sql immutable parallel safe set search_path = ''
as $$
  select case
    when p is null or pg_catalog.jsonb_typeof(p) is distinct from 'number' then null
    when abs((p #>> '{}')::numeric) >= 10000000000000000 then null
    else round((p #>> '{}')::numeric, 2)
  end
$$;
comment on function fin.qbo_money(jsonb) is 'JSON number to numeric rounded half away from zero to 2 places; null when not a number or beyond numeric(18,2). T-056.';

-- yyyy-mm-dd -> date (1970..2100); null for anything else (never guessed).
create function fin.qbo_date(p text) returns date
language plpgsql immutable parallel safe set search_path = ''
as $$
declare
  v date;
begin
  if p is null or p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return null;
  end if;
  v := p::date;
  if v < date '1970-01-01' or v > date '2100-12-31' then
    return null;
  end if;
  return v;
exception when others then
  return null;
end;
$$;
comment on function fin.qbo_date(text) is 'yyyy-mm-dd to date (1970..2100); null otherwise. T-056.';

-- Distinct class ids of a document: the header ClassRef and every line detail's ClassRef.
create function fin.qbo_doc_classes(p jsonb) returns text[]
language sql immutable parallel safe set search_path = ''
as $$
  select coalesce(array_agg(distinct v order by v), '{}'::text[]) from (
    select jsonb_path_query(p, 'lax $.ClassRef.value') #>> '{}' as v
    union all
    select jsonb_path_query(p, 'lax $.Line[*].*.ClassRef.value') #>> '{}'
  ) x where v is not null and v <> ''
$$;

-- The class id of one line (its detail block's ClassRef), or null.
create function fin.qbo_line_class(p jsonb) returns text
language sql immutable parallel safe set search_path = ''
as $$
  select min(v) from (select jsonb_path_query(p, 'lax $.*.ClassRef.value') #>> '{}' as v) x where v is not null and v <> ''
$$;

-- An id or class list that fits the fin columns (1..256 characters): a longer one marks the record invalid instead of
-- failing the whole run on a CHECK constraint (whose error would also carry the row).
create function fin.qbo_ids_ok(p_ids text[]) returns boolean
language sql immutable parallel safe set search_path = ''
as $$ select coalesce(bool_and(length(c) between 1 and 256), true) from unnest(p_ids) c $$;

-- Every Id referenced by a key that ends in AccountRef (header or line, any depth), as in the connector's exclusion scan.
create function fin.qbo_account_refs(p jsonb) returns text[]
language sql immutable parallel safe set search_path = ''
as $$
  select coalesce(array_agg(distinct e.value #>> '{value}'), '{}'::text[])
  from jsonb_path_query(p, 'lax $.**') n
  cross join lateral jsonb_each(case when jsonb_typeof(n) = 'object' then n else '{}'::jsonb end) e
  where e.key ~* 'AccountRef$' and jsonb_typeof(e.value) = 'object' and jsonb_typeof(e.value -> 'value') = 'string'
$$;

-- Every Id referenced by EntityRef / VendorRef / CustomerRef (any depth).
create function fin.qbo_entity_refs(p jsonb) returns text[]
language sql immutable parallel safe set search_path = ''
as $$
  select coalesce(array_agg(distinct e.value #>> '{value}'), '{}'::text[])
  from jsonb_path_query(p, 'lax $.**') n
  cross join lateral jsonb_each(case when jsonb_typeof(n) = 'object' then n else '{}'::jsonb end) e
  where e.key ~ '^(Entity|Vendor|Customer)Ref$' and jsonb_typeof(e.value) = 'object' and jsonb_typeof(e.value -> 'value') = 'string'
$$;

-- T-051's employee rule (entities.ts exclusionReason), as a backstop on raw rows stored before the rule existed: any `type`/`Type`
-- equal to Employee (case-insensitive), any key starting with Employee, or an Entity/EntityRef whose type is not Customer or Vendor.
create function fin.qbo_is_employee(p jsonb) returns boolean
language sql immutable parallel safe set search_path = ''
as $$
  select exists (
    select 1
    from jsonb_path_query(p, 'lax $.**') n
    cross join lateral jsonb_each(case when jsonb_typeof(n) = 'object' then n else '{}'::jsonb end) e
    where (e.key in ('type', 'Type') and jsonb_typeof(e.value) = 'string' and lower(e.value #>> '{}') = 'employee')
       or e.key ~* '^employee'
       or (e.key in ('Entity', 'EntityRef') and jsonb_typeof(e.value) = 'object'
           and jsonb_typeof(coalesce(e.value -> 'type', e.value -> 'Type')) = 'string'
           and lower(coalesce(e.value -> 'type', e.value -> 'Type') #>> '{}') not in ('customer', 'vendor'))
  )
$$;

-- The entity of a row (see the contract above). p_class_map / p_customer_map: {id: entity_code}; '' = ambiguous.
create function fin.qbo_resolve_entity(p_mode text, p_own text, p_tracking boolean, p_classes text[], p_customer text,
                                       p_class_map jsonb, p_customer_map jsonb) returns text
language plpgsql immutable parallel safe set search_path = ''
as $$
declare
  v_ents text[];
  v_cust text;
begin
  if p_mode = 'file' then
    return coalesce(p_own, 'unmapped');
  elsif p_mode is distinct from 'file_class' then
    return 'unmapped';
  end if;
  if p_tracking and coalesce(cardinality(p_classes), 0) > 0 then
    -- A class listed under two entities (config error) is never guessed: unmapped, whatever the customer says.
    if exists (select 1 from unnest(p_classes) c where p_class_map ->> c = '') then
      return 'unmapped';
    end if;
    select array_agg(distinct coalesce(p_class_map ->> c, '?')) into v_ents from unnest(p_classes) c;
    if cardinality(v_ents) = 1 and v_ents[1] <> '?' then
      return v_ents[1];
    end if;
    if cardinality(p_classes) > 1 then
      return 'unmapped'; -- several classes that disagree or are unknown: never allocated
    end if;
    -- one class that is in no list: the customer mapping decides
  end if;
  v_cust := p_customer_map ->> p_customer;
  return case when v_cust is null or v_cust = '' then 'unmapped' else v_cust end;
end;
$$;
comment on function fin.qbo_resolve_entity(text, text, boolean, text[], text, jsonb, jsonb) is
  'Entity code of a QuickBooks row from the lane_config mapping (T-056): file mode = own entity; file_class = class, then customer, else unmapped.';

-- ---------------------------------------------------------------- names: constant-message BEFORE trigger
-- Replaces the T-055 CHECK constraints. A failed CHECK reports "Failing row contains (...)" in DETAIL, which would copy a
-- refused account number into the Postgres log and job logs. BEFORE triggers run before any constraint check, so a refused
-- value never reaches one. Message and SQLSTATE are constant; no DETAIL, HINT or value.
create function fin.refuse_name_digit_runs() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_name text := pg_catalog.to_jsonb(new) ->> tg_argv[0];
begin
  if v_name is not null and fin.has_digit_run(v_name) then
    raise exception 'fin: a name contains a run of digits (possible account number)' using errcode = '23514', schema = tg_table_schema, table = tg_table_name;
  end if;
  return new;
end;
$$;
revoke all on function fin.refuse_name_digit_runs() from public, anon, authenticated;

alter table fin.accounts drop constraint accounts_name_no_digit_run;
alter table fin.invoices drop constraint invoices_customer_name_no_digit_run;
alter table fin.payments drop constraint payments_customer_name_no_digit_run;
alter table fin.bills drop constraint bills_vendor_name_no_digit_run;
create trigger accounts_a_name_guard before insert or update on fin.accounts
  for each row execute function fin.refuse_name_digit_runs('name');
create trigger invoices_a_name_guard before insert or update on fin.invoices
  for each row execute function fin.refuse_name_digit_runs('customer_name');
create trigger payments_a_name_guard before insert or update on fin.payments
  for each row execute function fin.refuse_name_digit_runs('customer_name');
create trigger bills_a_name_guard before insert or update on fin.bills
  for each row execute function fin.refuse_name_digit_runs('vendor_name');

comment on column fin.accounts.name is 'Display name only. A run of 5 or more digits (an account number) is refused by a BEFORE trigger; the normalizer masks digit runs first (T-056).';
comment on column fin.invoices.customer_name is 'Display name only; digit runs of 5 or more are refused by a BEFORE trigger (the normalizer masks them, T-056).';
comment on column fin.payments.customer_name is 'Display name only; digit runs of 5 or more are refused by a BEFORE trigger (the normalizer masks them, T-056).';
comment on column fin.bills.vendor_name is 'Display name only; digit runs of 5 or more are refused by a BEFORE trigger (the normalizer masks them, T-056).';

-- ---------------------------------------------------------------- payments: no new link to a voided or deleted invoice
create function fin.payments_invoice_link_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.invoice_id is not null and exists (
    select 1 from fin.invoices i where i.id = new.invoice_id and (i.voided or i.deleted)
  ) then
    raise exception 'fin.payments: a payment cannot be linked to a voided or deleted invoice' using errcode = '23514', schema = tg_table_schema, table = tg_table_name;
  end if;
  return new;
end;
$$;
revoke all on function fin.payments_invoice_link_guard() from public, anon, authenticated;
create trigger payments_b_invoice_link_guard before insert or update of invoice_id on fin.payments
  for each row execute function fin.payments_invoice_link_guard();

-- Triggers run with the writer's rights: service_role needs to call the helpers they use.
grant execute on function fin.has_digit_run(text), fin.mask_digit_runs(text), fin.qbo_money(jsonb), fin.qbo_date(text),
  fin.qbo_doc_classes(jsonb), fin.qbo_line_class(jsonb), fin.qbo_account_refs(jsonb), fin.qbo_entity_refs(jsonb), fin.qbo_ids_ok(text[]), fin.qbo_is_employee(jsonb),
  fin.qbo_resolve_entity(text, text, boolean, text[], text, jsonb, jsonb) to service_role;
revoke all on function fin.has_digit_run(text), fin.mask_digit_runs(text), fin.qbo_money(jsonb), fin.qbo_date(text),
  fin.qbo_doc_classes(jsonb), fin.qbo_line_class(jsonb), fin.qbo_account_refs(jsonb), fin.qbo_entity_refs(jsonb), fin.qbo_ids_ok(text[]), fin.qbo_is_employee(jsonb),
  fin.qbo_resolve_entity(text, text, boolean, text[], text, jsonb, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- fin.normalize_runs
-- One row per successful normalizer call (a failed call rolls back and leaves no row; the job logs the failure).
-- Counts only; reallocations hold ids (payment row, old invoice, new invoice) and nothing else.
create table fin.normalize_runs (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  connection_id uuid not null,
  mapping_mode text check (mapping_mode in ('file', 'file_class')),
  class_tracking boolean not null,
  -- True when the mapping mode needs classes but the connection's class-tracking flag is off (QB-10): rows fell back to
  -- the customer mapping or 'unmapped'.
  class_fallback boolean not null,
  -- Records of the entity types with synced_at before this instant were not re-seen by the latest full load.
  unseen_cutoff timestamptz,
  counts jsonb not null check (pg_catalog.jsonb_typeof(counts) = 'object' and pg_catalog.octet_length(counts::text) <= 8192),
  reallocation_count integer not null default 0 check (reallocation_count >= 0),
  reallocations jsonb not null default '[]' check (pg_catalog.jsonb_typeof(reallocations) = 'array' and pg_catalog.jsonb_array_length(reallocations) <= 200
                                                    and pg_catalog.octet_length(reallocations::text) <= 65536),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (connection_id, lane_id) references core.connections (id, lane_id) on update restrict on delete restrict,
  check (finished_at >= started_at)
);
comment on table fin.normalize_runs is
  'One row per successful QuickBooks normalizer call (T-056): counts, class-tracking state and fallback (QB-10), full-reload cutoff, reallocations (ids only).';
comment on column fin.normalize_runs.reallocations is
  'Ids only: {payment_row, from_invoice, to_invoice} per changed allocation, at most 200 entries; reallocation_count is the full number.';
create index normalize_runs_lane_id_idx on fin.normalize_runs (lane_id);
create index normalize_runs_connection_started_idx on fin.normalize_runs (connection_id, started_at desc);

alter table fin.normalize_runs enable row level security;
-- Counts and flags only (no finance content): the 'health' view, like core.sync_runs.
create policy normalize_runs_select on fin.normalize_runs for select to authenticated using (
  (select auth.jwt() ->> 'aal') = 'aal2'
  and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'health'))::text[]));
revoke all on fin.normalize_runs from public, anon, authenticated;
grant select on fin.normalize_runs to authenticated;
-- service_role reads (the job); rows are written only by the definer function. A retention task adds DELETE when it exists.
grant select on fin.normalize_runs to service_role;

-- ---------------------------------------------------------------- the normalizer
create function core.fin_qbo_normalize(p_lane text, p_connection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_features jsonb;
  v_cfg jsonb;
  v_mode text;
  v_own text;
  v_tracking boolean;
  v_fallback boolean;
  v_class_map jsonb;
  v_cust_map jsonb;
  v_bank_map jsonb;
  v_pay_ids text[];
  v_pay_subtypes text[];
  v_excl text[];
  v_cutoff timestamptz;
  v_full_started timestamptz;
  v_ins integer;
  v_upd integer;
  v_tomb integer;
  v_stale integer;
  v_counts jsonb := '{}'::jsonb;
  v_invalid integer;
  v_realloc_n integer;
  v_realloc jsonb;
  v_dead_deleted integer;
  v_dead_unseen integer;
  v_dead_payroll integer;
  v_dead_entity integer;
  v_dead_linked integer;
  v_refused_voided integer;
  v_unknown_invoice integer;
  v_non_usd integer;
  v_multi integer;
  v_fallback_rows integer := 0;
  v_unmapped integer;
  v_null_account integer;
  v_err_table text;
  v_err_constraint text;
  v_entity_types constant text[] := array['Account', 'Customer', 'Vendor', 'Invoice', 'Bill', 'Payment', 'BillPayment', 'Purchase', 'Deposit', 'JournalEntry'];
  v_code_re constant text := '^[A-Za-z0-9_]{1,32}$';
  v_payroll_re constant text := '(payroll|salar(y|ies)|\ywages?\y|compensation)';
begin
  if p_lane is null or p_connection_id is null then
    raise exception 'fin.qbo_normalize: a lane and a connection are required' using errcode = '22004';
  end if;
  select c.features into v_features
  from core.connections c
  join core.lanes l on l.code = c.lane_id and l.enabled
  where c.id = p_connection_id and c.lane_id = p_lane and c.provider = 'quickbooks' and c.status in ('active', 'degraded');
  if not found then
    raise exception 'fin.qbo_normalize: usable QuickBooks connection not found in this lane' using errcode = '42501';
  end if;
  -- One normalizer per connection at a time (the second call waits, then finds nothing to change).
  perform pg_advisory_xact_lock(hashtextextended('fin_qbo_normalize:' || p_connection_id::text, 0));

  select c.config into v_cfg from core.lane_config_current c where c.lane_id = p_lane;
  v_mode := v_cfg #>> '{qbo,entity_mapping_mode}';
  if v_mode is null or v_mode not in ('file', 'file_class') then
    raise exception 'fin.qbo_normalize: lane_config has no QuickBooks entity mapping' using errcode = '22023';
  end if;

  -- Everything below runs in one block whose handler re-raises a constant message: a constraint violation would otherwise carry
  -- the failing row (names, amounts) in DETAIL to the caller and the Postgres log. Only the SQLSTATE and the table and
  -- constraint NAMES are kept (schema objects, never data). The checks above stay outside, with their own messages.
  begin
  -- ------------------------------------------------------------ lane_config (rule 2: nothing company-specific in code)
  v_own := v_cfg #>> '{entities,own_entity}';
  if v_own !~ v_code_re then v_own := null; end if;
  v_tracking := coalesce((v_features -> 'class_tracking') = 'true'::jsonb, false);
  v_fallback := v_mode = 'file_class' and not v_tracking;

  select coalesce(jsonb_object_agg(m.id, m.ent), '{}'::jsonb) into v_class_map from (
    select c.id, case when count(distinct e.key) = 1 then min(e.key) else '' end as ent
    from jsonb_each(case when jsonb_typeof(v_cfg #> '{entities,by_entity}') = 'object' then v_cfg #> '{entities,by_entity}' else '{}'::jsonb end) e
    cross join lateral jsonb_array_elements_text(case when jsonb_typeof(e.value -> 'qbo_class_ids') = 'array' then e.value -> 'qbo_class_ids' else '[]'::jsonb end) c(id)
    where e.key ~ v_code_re
    group by c.id) m;
  select coalesce(jsonb_object_agg(m.id, m.ent), '{}'::jsonb) into v_cust_map from (
    select c.id, case when count(distinct e.key) = 1 then min(e.key) else '' end as ent
    from jsonb_each(case when jsonb_typeof(v_cfg #> '{entities,by_entity}') = 'object' then v_cfg #> '{entities,by_entity}' else '{}'::jsonb end) e
    cross join lateral jsonb_array_elements_text(case when jsonb_typeof(e.value -> 'qbo_customer_ids') = 'array' then e.value -> 'qbo_customer_ids' else '[]'::jsonb end) c(id)
    where e.key ~ v_code_re
    group by c.id) m;
  select coalesce(jsonb_object_agg(b ->> 'qbo_account_id', b ->> 'owner_entity'), '{}'::jsonb) into v_bank_map
  from jsonb_array_elements(case when jsonb_typeof(v_cfg #> '{entities,bank_accounts}') = 'array' then v_cfg #> '{entities,bank_accounts}' else '[]'::jsonb end) b
  where jsonb_typeof(b -> 'qbo_account_id') = 'string' and (b ->> 'owner_entity') ~ v_code_re;

  v_pay_ids := coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(v_cfg #> '{finance,payroll,account_ids}') = 'array' then v_cfg #> '{finance,payroll,account_ids}' else '[]'::jsonb end)), '{}');
  -- Same default as QBO_PAYROLL_SUBTYPES in packages/core/src/lane-config (a test pins the two lists together).
  v_pay_subtypes := case when jsonb_typeof(v_cfg #> '{finance,payroll,account_subtypes}') = 'array'
    then array(select lower(x) from jsonb_array_elements_text(v_cfg #> '{finance,payroll,account_subtypes}') x)
    else array['payrollexpenses', 'payrolltaxexpenses', 'payrollclearing', 'payrolltaxpayable', 'payrollwagepayable', 'directdepositpayable', 'costoflabor'] end;
  v_excl := coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(v_cfg #> '{finance,payroll,excluded_entity_ids}') = 'array' then v_cfg #> '{finance,payroll,excluded_entity_ids}' else '[]'::jsonb end)), '{}');

  -- ------------------------------------------------------------ full-reload deletion gap
  select max(r.started_at) into v_full_started
  from core.sync_runs r
  where r.connection_id = p_connection_id and r.lane_id = p_lane and r.kind = 'full' and r.status = 'succeeded';
  v_cutoff := v_full_started - interval '15 minutes';
  -- Never move back: if sync_runs rows were ever trimmed, the cutoff of an earlier run stays in force (a dead record must not
  -- come back to life as a ledger row).
  select greatest(v_cutoff, max(r.unseen_cutoff)) into v_cutoff from fin.normalize_runs r where r.connection_id = p_connection_id;

  -- ------------------------------------------------------------ working tables (dropped at the end)
  drop table if exists pg_temp.q_payroll, pg_temp.q_eff, pg_temp.q_cust, pg_temp.q_vend, pg_temp.q_inv, pg_temp.q_bill,
    pg_temp.q_pay, pg_temp.q_alloc, pg_temp.q_prow, pg_temp.q_txn, pg_temp.q_bpent, pg_temp.q_realloc;

  create temp table pg_temp.q_payroll (id text primary key) on commit drop;
  with recursive acct as (
    select r.external_id as id, r.payload #>> '{ParentRef,value}' as parent,
           (lower(coalesce(r.payload ->> 'AccountSubType', '')) = any (v_pay_subtypes)
            or coalesce(r.payload ->> 'Name', '') ~* v_payroll_re
            or coalesce(r.payload ->> 'FullyQualifiedName', '') ~* v_payroll_re) as hit
    from raw.source_records r
    where r.connection_id = p_connection_id and r.lane_id = p_lane and r.provider = 'quickbooks' and r.object_type = 'Account' and not r.deleted
  ), p as (
    select a.id from acct a where a.hit or a.id = any (v_pay_ids)
    union
    select a.id from acct a join p on a.parent = p.id
  )
  insert into pg_temp.q_payroll
  select id from p union select unnest(v_pay_ids)
  -- A raw Account tombstone: T-051 tombstones an account that became payroll (by subtype or name) and QuickBooks does not
  -- delete accounts that have transactions, so a transaction that references a deleted account is treated as payroll (fail closed).
  union select r.external_id from raw.source_records r
        where r.connection_id = p_connection_id and r.lane_id = p_lane and r.provider = 'quickbooks' and r.object_type = 'Account' and r.deleted;

  -- Effective records: every entity record of the connection with why = null when live, else the reason it is dead.
  create temp table pg_temp.q_eff on commit drop as
  select r.id as raw_id, r.object_type, r.external_id, r.payload, r.source_updated_at,
         case
           when r.deleted then 'deleted'
           when v_cutoff is not null and r.synced_at < v_cutoff then 'unseen'
           when r.object_type = 'Account' and r.external_id in (select id from pg_temp.q_payroll) then 'payroll'
           when r.object_type in ('Customer', 'Vendor') and r.external_id = any (v_excl) then 'entity'
           when r.object_type <> all (array['Account', 'Customer', 'Vendor'])
                and fin.qbo_account_refs(r.payload) && (select coalesce(array_agg(id), '{}') from pg_temp.q_payroll) then 'payroll'
           when r.object_type <> all (array['Account', 'Customer', 'Vendor']) and fin.qbo_is_employee(r.payload) then 'employee'
           when r.object_type <> all (array['Account', 'Customer', 'Vendor'])
                and fin.qbo_entity_refs(r.payload) && v_excl then 'entity'
         end as why
  from raw.source_records r
  where r.connection_id = p_connection_id and r.lane_id = p_lane and r.provider = 'quickbooks' and r.object_type = any (v_entity_types);
  create unique index on pg_temp.q_eff (object_type, external_id);

  -- T-051 re-review M2: a payment of a dead (deleted, unseen or excluded) invoice or bill gets no ledger rows.
  update pg_temp.q_eff p set why = 'linked'
  where p.why is null and p.object_type in ('Payment', 'BillPayment')
    and exists (
      select 1
      from jsonb_array_elements(case when jsonb_typeof(p.payload -> 'Line') = 'array' then p.payload -> 'Line' else '[]'::jsonb end) l
      cross join lateral jsonb_array_elements(case when jsonb_typeof(l -> 'LinkedTxn') = 'array' then l -> 'LinkedTxn' else '[]'::jsonb end) lt
      join pg_temp.q_eff t on t.object_type = lt ->> 'TxnType' and t.external_id = lt ->> 'TxnId'
      where (lt ->> 'TxnType') in ('Invoice', 'Bill') and t.why is not null);

  select count(*) filter (where why = 'deleted'), count(*) filter (where why = 'unseen'), count(*) filter (where why = 'payroll'),
         count(*) filter (where why = 'entity'), count(*) filter (where why = 'linked')
    into v_dead_deleted, v_dead_unseen, v_dead_payroll, v_dead_entity, v_dead_linked
  from pg_temp.q_eff;
  v_counts := v_counts || jsonb_build_object('dead_deleted', v_dead_deleted, 'dead_unseen', v_dead_unseen, 'dead_payroll', v_dead_payroll,
                                            'dead_entity', v_dead_entity, 'dead_linked', v_dead_linked);

  -- Names for customers and vendors (masked once, here).
  create temp table pg_temp.q_cust on commit drop as
  select e.external_id as id, left(fin.mask_digit_runs(e.payload ->> 'DisplayName'), 200) as name
  from pg_temp.q_eff e where e.object_type = 'Customer' and e.why is null and nullif(e.payload ->> 'DisplayName', '') is not null;
  create temp table pg_temp.q_vend on commit drop as
  select e.external_id as id, left(fin.mask_digit_runs(e.payload ->> 'DisplayName'), 200) as name
  from pg_temp.q_eff e where e.object_type = 'Vendor' and e.why is null and nullif(e.payload ->> 'DisplayName', '') is not null;

  -- ============================================================ accounts
  with w as (
    insert into fin.accounts as t (lane_id, connection_id, source_id, raw_record_id, source_updated_at, name, type, subtype,
                                   is_bank, entity_code, owner_entity_code, active, deleted)
    select p_lane, p_connection_id, e.external_id, e.raw_id, e.source_updated_at,
           left(coalesce(nullif(fin.mask_digit_runs(coalesce(e.payload ->> 'FullyQualifiedName', e.payload ->> 'Name')), ''), '(unnamed account)'), 200),
           left(coalesce(nullif(e.payload ->> 'AccountType', ''), 'Unknown'), 64),
           left(nullif(e.payload ->> 'AccountSubType', ''), 64),
           coalesce(e.payload ->> 'AccountType', '') = 'Bank',
           coalesce(v_bank_map ->> e.external_id, case when v_mode = 'file' then coalesce(v_own, 'unmapped') else 'unmapped' end),
           v_bank_map ->> e.external_id,
           (e.payload -> 'Active') is distinct from 'false'::jsonb,
           false
    from pg_temp.q_eff e
    where e.object_type = 'Account' and e.why is null
    on conflict (connection_id, source_id) do update
      set raw_record_id = excluded.raw_record_id, source_updated_at = excluded.source_updated_at, name = excluded.name,
          type = excluded.type, subtype = excluded.subtype, is_bank = excluded.is_bank, entity_code = excluded.entity_code,
          owner_entity_code = excluded.owner_entity_code, active = excluded.active, deleted = false
      where (t.raw_record_id, t.source_updated_at, t.name, t.type, t.subtype, t.is_bank, t.entity_code, t.owner_entity_code, t.active, t.deleted)
            is distinct from (excluded.raw_record_id, excluded.source_updated_at, excluded.name, excluded.type, excluded.subtype,
                              excluded.is_bank, excluded.entity_code, excluded.owner_entity_code, excluded.active, false)
    returning (xmax = 0) as ins)
  select count(*) filter (where ins), count(*) filter (where not ins) into v_ins, v_upd from w;
  update fin.accounts t set deleted = true, active = false, name = '(deleted account)', subtype = null
  from pg_temp.q_eff e
  where e.object_type = 'Account' and e.why is not null and t.connection_id = p_connection_id and t.source_id = e.external_id and not t.deleted;
  get diagnostics v_tomb = row_count;
  v_counts := v_counts || jsonb_build_object('accounts', jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'tombstoned', v_tomb));

  -- ============================================================ invoices
  create temp table pg_temp.q_inv on commit drop as
  select e.raw_id, e.external_id as id, e.source_updated_at, e.payload #>> '{CustomerRef,value}' as cust,
         fin.qbo_date(e.payload ->> 'TxnDate') as issue_date, fin.qbo_date(e.payload ->> 'DueDate') as due_date,
         fin.qbo_money(e.payload -> 'TotalAmt') as total, fin.qbo_money(e.payload -> 'Balance') as balance,
         fin.qbo_doc_classes(e.payload) as classes,
         coalesce(e.payload #>> '{CurrencyRef,value}', 'USD') as currency,
         coalesce((e.payload -> 'Voided') = 'true'::jsonb, false) as voided
  from pg_temp.q_eff e where e.object_type = 'Invoice' and e.why is null;
  select count(*) into v_invalid from pg_temp.q_inv
  where issue_date is null or total is null or balance is null or currency !~ '^[A-Z]{3}$' or not fin.qbo_ids_ok(classes || array[coalesce(cust, 'x')]);
  with w as (
    insert into fin.invoices as t (lane_id, connection_id, source_id, raw_record_id, source_updated_at, customer_id, customer_name,
                                   issue_date, due_date, total, balance, class_id, multi_class, entity_code, currency_code, voided, deleted)
    select p_lane, p_connection_id, i.id, i.raw_id, i.source_updated_at, i.cust, (select c.name from pg_temp.q_cust c where c.id = i.cust),
           i.issue_date, i.due_date, i.total, i.balance,
           case when cardinality(i.classes) = 1 then i.classes[1] end, cardinality(i.classes) > 1,
           fin.qbo_resolve_entity(v_mode, v_own, v_tracking, i.classes, i.cust, v_class_map, v_cust_map),
           i.currency, i.voided, false
    from pg_temp.q_inv i
    where i.issue_date is not null and i.total is not null and i.balance is not null and i.currency ~ '^[A-Z]{3}$' and fin.qbo_ids_ok(i.classes || array[coalesce(i.cust, 'x')])
    on conflict (connection_id, source_id) do update
      set raw_record_id = excluded.raw_record_id, source_updated_at = excluded.source_updated_at, customer_id = excluded.customer_id,
          customer_name = excluded.customer_name, issue_date = excluded.issue_date, due_date = excluded.due_date,
          total = excluded.total, balance = excluded.balance, class_id = excluded.class_id, multi_class = excluded.multi_class,
          entity_code = excluded.entity_code, currency_code = excluded.currency_code, voided = excluded.voided, deleted = false
      where (t.raw_record_id, t.source_updated_at, t.customer_id, t.customer_name, t.issue_date, t.due_date, t.total, t.balance, t.class_id,
             t.multi_class, t.entity_code, t.currency_code, t.voided, t.deleted)
            is distinct from (excluded.raw_record_id, excluded.source_updated_at, excluded.customer_id, excluded.customer_name,
                              excluded.issue_date, excluded.due_date, excluded.total, excluded.balance, excluded.class_id,
                              excluded.multi_class, excluded.entity_code, excluded.currency_code, excluded.voided, false)
    returning (xmax = 0) as ins)
  select count(*) filter (where ins), count(*) filter (where not ins) into v_ins, v_upd from w;
  update fin.invoices t set deleted = true, total = 0, balance = 0, customer_id = null, customer_name = null, class_id = null, multi_class = false
  from pg_temp.q_eff e
  where e.object_type = 'Invoice' and e.why is not null and t.connection_id = p_connection_id and t.source_id = e.external_id and not t.deleted;
  get diagnostics v_tomb = row_count;
  v_counts := v_counts || jsonb_build_object('invoices', jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'tombstoned', v_tomb, 'invalid', v_invalid));
  select count(*) filter (where classes is not null and cardinality(classes) > 1), count(*) filter (where currency <> 'USD')
    into v_multi, v_non_usd
  from pg_temp.q_inv where issue_date is not null and total is not null and balance is not null and currency ~ '^[A-Z]{3}$' and fin.qbo_ids_ok(classes || array[coalesce(cust, 'x')]);
  v_counts := v_counts || jsonb_build_object('multi_class_invoices', v_multi, 'non_usd_invoices', v_non_usd);
  if v_fallback then
    select v_fallback_rows + count(*) into v_fallback_rows from pg_temp.q_inv where issue_date is not null and total is not null and balance is not null and currency ~ '^[A-Z]{3}$' and fin.qbo_ids_ok(classes || array[coalesce(cust, 'x')]);
  end if;

  -- ============================================================ bills
  create temp table pg_temp.q_bill on commit drop as
  select e.raw_id, e.external_id as id, e.source_updated_at, e.payload #>> '{VendorRef,value}' as vend,
         fin.qbo_date(e.payload ->> 'TxnDate') as issue_date, fin.qbo_date(e.payload ->> 'DueDate') as due_date,
         fin.qbo_money(e.payload -> 'TotalAmt') as total, fin.qbo_money(e.payload -> 'Balance') as balance,
         fin.qbo_doc_classes(e.payload) as classes,
         coalesce(e.payload #>> '{CurrencyRef,value}', 'USD') as currency,
         coalesce((e.payload -> 'Voided') = 'true'::jsonb, false) as voided
  from pg_temp.q_eff e where e.object_type = 'Bill' and e.why is null;
  select count(*) into v_invalid from pg_temp.q_bill
  where issue_date is null or total is null or balance is null or currency !~ '^[A-Z]{3}$' or not fin.qbo_ids_ok(classes || array[coalesce(vend, 'x')]);
  with w as (
    insert into fin.bills as t (lane_id, connection_id, source_id, raw_record_id, source_updated_at, vendor_id, vendor_name,
                                issue_date, due_date, total, balance, class_id, multi_class, entity_code, currency_code, voided, deleted)
    select p_lane, p_connection_id, b.id, b.raw_id, b.source_updated_at, b.vend, (select c.name from pg_temp.q_vend c where c.id = b.vend),
           b.issue_date, b.due_date, b.total, b.balance,
           case when cardinality(b.classes) = 1 then b.classes[1] end, cardinality(b.classes) > 1,
           fin.qbo_resolve_entity(v_mode, v_own, v_tracking, b.classes, null, v_class_map, v_cust_map),
           b.currency, b.voided, false
    from pg_temp.q_bill b
    where b.issue_date is not null and b.total is not null and b.balance is not null and b.currency ~ '^[A-Z]{3}$' and fin.qbo_ids_ok(b.classes || array[coalesce(b.vend, 'x')])
    on conflict (connection_id, source_id) do update
      set raw_record_id = excluded.raw_record_id, source_updated_at = excluded.source_updated_at, vendor_id = excluded.vendor_id,
          vendor_name = excluded.vendor_name, issue_date = excluded.issue_date, due_date = excluded.due_date,
          total = excluded.total, balance = excluded.balance, class_id = excluded.class_id, multi_class = excluded.multi_class,
          entity_code = excluded.entity_code, currency_code = excluded.currency_code, voided = excluded.voided, deleted = false
      where (t.raw_record_id, t.source_updated_at, t.vendor_id, t.vendor_name, t.issue_date, t.due_date, t.total, t.balance, t.class_id,
             t.multi_class, t.entity_code, t.currency_code, t.voided, t.deleted)
            is distinct from (excluded.raw_record_id, excluded.source_updated_at, excluded.vendor_id, excluded.vendor_name,
                              excluded.issue_date, excluded.due_date, excluded.total, excluded.balance, excluded.class_id,
                              excluded.multi_class, excluded.entity_code, excluded.currency_code, excluded.voided, false)
    returning (xmax = 0) as ins)
  select count(*) filter (where ins), count(*) filter (where not ins) into v_ins, v_upd from w;
  update fin.bills t set deleted = true, total = 0, balance = 0, vendor_id = null, vendor_name = null, class_id = null, multi_class = false
  from pg_temp.q_eff e
  where e.object_type = 'Bill' and e.why is not null and t.connection_id = p_connection_id and t.source_id = e.external_id and not t.deleted;
  get diagnostics v_tomb = row_count;
  v_counts := v_counts || jsonb_build_object('bills', jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'tombstoned', v_tomb, 'invalid', v_invalid));
  select count(*) filter (where classes is not null and cardinality(classes) > 1), count(*) filter (where currency <> 'USD')
    into v_multi, v_non_usd
  from pg_temp.q_bill where issue_date is not null and total is not null and balance is not null and currency ~ '^[A-Z]{3}$' and fin.qbo_ids_ok(classes || array[coalesce(vend, 'x')]);
  v_counts := v_counts || jsonb_build_object('multi_class_bills', v_multi, 'non_usd_bills', v_non_usd);
  if v_fallback then
    select v_fallback_rows + count(*) into v_fallback_rows from pg_temp.q_bill where issue_date is not null and total is not null and balance is not null and currency ~ '^[A-Z]{3}$' and fin.qbo_ids_ok(classes || array[coalesce(vend, 'x')]);
  end if;

  -- ============================================================ payments (invoices are loaded; unknown invoices stay unapplied)
  create temp table pg_temp.q_pay on commit drop as
  select e.raw_id, e.external_id as id, e.source_updated_at, e.payload,
         fin.qbo_date(e.payload ->> 'TxnDate') as txn_date, fin.qbo_money(e.payload -> 'TotalAmt') as total,
         fin.qbo_money(e.payload -> 'UnappliedAmt') as unapplied, e.payload #>> '{CustomerRef,value}' as cust,
         coalesce(e.payload #>> '{CurrencyRef,value}', 'USD') as currency,
         coalesce((e.payload -> 'Voided') = 'true'::jsonb, false) as voided,
         null::text as ent
  from pg_temp.q_eff e where e.object_type = 'Payment' and e.why is null;
  select count(*) into v_invalid from pg_temp.q_pay where txn_date is null or total is null or currency !~ '^[A-Z]{3}$' or not fin.qbo_ids_ok(array[coalesce(cust, 'x')]);
  delete from pg_temp.q_pay where txn_date is null or total is null or currency !~ '^[A-Z]{3}$' or not fin.qbo_ids_ok(array[coalesce(cust, 'x')]);

  -- One row per allocation to an invoice, in line order. invoice_id: null when the invoice is not in fin (not in raw yet, or
  -- skipped as invalid: unapplied, linked later in place) or is voided (link refused). A dead invoice never gets here: the payment is dead ('linked').
  create temp table pg_temp.q_alloc on commit drop as
  select l.pay_id, (row_number() over (partition by l.pay_id order by l.n))::integer - 1 as alloc_no, l.amount, l.inv_src,
         (fi.id is null) as unknown,
         (ie.external_id is not null and (coalesce((ie.payload -> 'Voided') = 'true'::jsonb, false)
                                          or coalesce(fi.voided, false) or coalesce(fi.deleted, false))) as refused,
         fi.id as fin_invoice_id, fi.entity_code as inv_entity
  from (
    select p.id as pay_id, x.n, fin.qbo_money(x.line -> 'Amount') as amount,
           (select lt ->> 'TxnId' from jsonb_array_elements(case when jsonb_typeof(x.line -> 'LinkedTxn') = 'array' then x.line -> 'LinkedTxn' else '[]'::jsonb end) lt
            where lt ->> 'TxnType' = 'Invoice' limit 1) as inv_src
    from pg_temp.q_pay p
    cross join lateral jsonb_array_elements(case when jsonb_typeof(p.payload -> 'Line') = 'array' then p.payload -> 'Line' else '[]'::jsonb end) with ordinality x(line, n)
  ) l
  left join pg_temp.q_eff ie on ie.object_type = 'Invoice' and ie.external_id = l.inv_src
  left join fin.invoices fi on fi.connection_id = p_connection_id and fi.source_id = l.inv_src
  where l.inv_src is not null and l.amount is not null;

  update pg_temp.q_pay p set ent = coalesce(
    (select case when count(distinct a.inv_entity) = 1 then min(a.inv_entity) end from pg_temp.q_alloc a
     where a.pay_id = p.id and a.inv_entity is not null and not a.unknown and not a.refused),
    fin.qbo_resolve_entity(v_mode, v_own, v_tracking, '{}'::text[], p.cust, v_class_map, v_cust_map));

  create temp table pg_temp.q_prow on commit drop as
  select a.pay_id, a.alloc_no, a.amount,
         case when a.unknown or a.refused then null else a.fin_invoice_id end as invoice_id,
         case when a.unknown or a.refused then null else a.inv_entity end as ent
  from pg_temp.q_alloc a
  union all
  select p.id, n.c, case when n.c = 0 then p.total else p.unapplied end, null::uuid, null::text
  from pg_temp.q_pay p
  cross join lateral (select count(*)::integer as c from pg_temp.q_alloc a where a.pay_id = p.id) n
  where n.c = 0 or coalesce(p.unapplied, 0) > 0;

  -- Reallocation log (ids only): an existing allocation row whose invoice link changes or is removed.
  create temp table pg_temp.q_realloc on commit drop as
  select f.id as payment_row, f.invoice_id as from_invoice, r.invoice_id as to_invoice, row_number() over (order by f.id) as rn
  from pg_temp.q_prow r
  join fin.payments f on f.connection_id = p_connection_id and f.source_id = r.pay_id and f.alloc_no = r.alloc_no
  where f.invoice_id is not null and f.invoice_id is distinct from r.invoice_id and not f.deleted;
  select count(*), coalesce(jsonb_agg(jsonb_build_object('payment_row', payment_row, 'from_invoice', from_invoice, 'to_invoice', to_invoice) order by rn) filter (where rn <= 200), '[]'::jsonb)
    into v_realloc_n, v_realloc
  from pg_temp.q_realloc;
  select count(*) filter (where a.refused), count(*) filter (where a.unknown) into v_refused_voided, v_unknown_invoice from pg_temp.q_alloc a;

  with w as (
    insert into fin.payments as t (lane_id, connection_id, source_id, raw_record_id, source_updated_at, invoice_id, paid_at, amount,
                                   entity_code, voided, deleted, currency_code, alloc_no, customer_name)
    select p_lane, p_connection_id, p.id, p.raw_id, p.source_updated_at, r.invoice_id,
           (p.txn_date::timestamp at time zone 'America/New_York'), r.amount, coalesce(r.ent, p.ent), p.voided, false, p.currency,
           r.alloc_no, (select c.name from pg_temp.q_cust c where c.id = p.cust)
    from pg_temp.q_prow r join pg_temp.q_pay p on p.id = r.pay_id
    on conflict (connection_id, source_id, alloc_no) do update
      set raw_record_id = excluded.raw_record_id, source_updated_at = excluded.source_updated_at, invoice_id = excluded.invoice_id,
          paid_at = excluded.paid_at, amount = excluded.amount, entity_code = excluded.entity_code, voided = excluded.voided,
          currency_code = excluded.currency_code, customer_name = excluded.customer_name, deleted = false
      where (t.raw_record_id, t.source_updated_at, t.invoice_id, t.paid_at, t.amount, t.entity_code, t.voided, t.currency_code, t.customer_name, t.deleted)
            is distinct from (excluded.raw_record_id, excluded.source_updated_at, excluded.invoice_id, excluded.paid_at, excluded.amount,
                              excluded.entity_code, excluded.voided, excluded.currency_code, excluded.customer_name, false)
    returning (xmax = 0) as ins)
  select count(*) filter (where ins), count(*) filter (where not ins) into v_ins, v_upd from w;
  -- Allocations a payment no longer has.
  update fin.payments t set deleted = true
  where t.connection_id = p_connection_id and not t.deleted
    and exists (select 1 from pg_temp.q_prow r where r.pay_id = t.source_id)
    and not exists (select 1 from pg_temp.q_prow r where r.pay_id = t.source_id and r.alloc_no = t.alloc_no);
  get diagnostics v_stale = row_count;
  update fin.payments t set deleted = true, amount = 0, invoice_id = null, customer_name = null
  from pg_temp.q_eff e
  where e.object_type = 'Payment' and e.why is not null and t.connection_id = p_connection_id and t.source_id = e.external_id and not t.deleted;
  get diagnostics v_tomb = row_count;
  v_counts := v_counts || jsonb_build_object('payments', jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'tombstoned', v_tomb,
    'stale_allocations', v_stale, 'invalid', v_invalid, 'unapplied_unknown_invoice', v_unknown_invoice,
    'links_refused_voided_invoice', v_refused_voided, 'reallocated', v_realloc_n));
  select count(*) filter (where p.currency <> 'USD') into v_non_usd from pg_temp.q_prow r join pg_temp.q_pay p on p.id = r.pay_id;
  v_counts := v_counts || jsonb_build_object('non_usd_payments', v_non_usd);
  if v_fallback then
    select v_fallback_rows + count(*) into v_fallback_rows from pg_temp.q_prow;
  end if;

  -- ============================================================ transactions (accounts are loaded)
  create temp table pg_temp.q_txn on commit drop as
  with docs as (
    select e.raw_id, e.object_type, e.external_id, e.source_updated_at, e.payload,
           fin.qbo_doc_classes(e.payload) as classes, fin.qbo_date(e.payload ->> 'TxnDate') as txn_date,
           coalesce(e.payload #>> '{CurrencyRef,value}', 'USD') as currency,
           coalesce((e.payload -> 'Voided') = 'true'::jsonb, false) as voided,
           e.object_type = 'Purchase' and coalesce((e.payload -> 'Credit') = 'true'::jsonb, false) as credit,
           case e.object_type
             when 'Payment' then e.payload #>> '{CustomerRef,value}'
             when 'Purchase' then case when e.payload #>> '{EntityRef,type}' = 'Customer' then e.payload #>> '{EntityRef,value}' end
           end as cust
    from pg_temp.q_eff e
    where e.why is null and e.object_type in ('Purchase', 'Deposit', 'JournalEntry', 'Bill', 'BillPayment', 'Payment')
  )
  select d.raw_id, d.object_type as txn_type, d.external_id as source_id, 0 as line_no, d.source_updated_at, d.txn_date, d.currency,
         d.voided, d.cust, d.classes as eclasses, case when cardinality(d.classes) = 1 then d.classes[1] end as class_id,
         h.acct, h.amount
  from docs d
  cross join lateral (select
    case d.object_type
      when 'Purchase' then d.payload #>> '{AccountRef,value}'
      when 'Deposit' then d.payload #>> '{DepositToAccountRef,value}'
      when 'Payment' then d.payload #>> '{DepositToAccountRef,value}'
      when 'BillPayment' then coalesce(d.payload #>> '{CheckPayment,BankAccountRef,value}', d.payload #>> '{CreditCardPayment,CCAccountRef,value}')
      when 'Bill' then d.payload #>> '{APAccountRef,value}'
    end as acct,
    fin.qbo_money(d.payload -> 'TotalAmt') * case when d.object_type in ('Purchase', 'BillPayment', 'Bill') then -1 else 1 end
      * case when d.credit then -1 else 1 end as amount) h
  where d.object_type <> 'JournalEntry' and h.acct is not null
  union all
  select d.raw_id, d.object_type, d.external_id, l.n::integer, d.source_updated_at, d.txn_date, d.currency, d.voided, d.cust,
         case when c.lc is null then '{}'::text[] else array[c.lc] end, c.lc, x.acct, fin.qbo_money(l.line -> 'Amount') * x.sign * case when d.credit then -1 else 1 end
  from docs d
  cross join lateral jsonb_array_elements(case when jsonb_typeof(d.payload -> 'Line') = 'array' then d.payload -> 'Line' else '[]'::jsonb end) with ordinality l(line, n)
  cross join lateral (select coalesce(fin.qbo_line_class(l.line), d.payload #>> '{ClassRef,value}') as lc) c
  cross join lateral (select
    case
      when d.object_type in ('Purchase', 'Bill') and (l.line -> 'AccountBasedExpenseLineDetail') is not null then l.line #>> '{AccountBasedExpenseLineDetail,AccountRef,value}'
      when d.object_type = 'Deposit' then l.line #>> '{DepositLineDetail,AccountRef,value}'
      when d.object_type = 'JournalEntry' then l.line #>> '{JournalEntryLineDetail,AccountRef,value}'
    end as acct,
    case
      when d.object_type in ('Purchase', 'Bill') and ((l.line -> 'AccountBasedExpenseLineDetail') is not null or (l.line -> 'ItemBasedExpenseLineDetail') is not null) then 1
      when d.object_type = 'Deposit' and (l.line -> 'DepositLineDetail') is not null then -1
      when d.object_type = 'JournalEntry' and l.line #>> '{JournalEntryLineDetail,PostingType}' = 'Debit' then 1
      when d.object_type = 'JournalEntry' and l.line #>> '{JournalEntryLineDetail,PostingType}' = 'Credit' then -1
    end as sign) x
  where x.sign is not null;
  select count(*) into v_invalid from pg_temp.q_txn where txn_date is null or amount is null or currency !~ '^[A-Z]{3}$' or not fin.qbo_ids_ok(array[coalesce(class_id, 'x'), coalesce(cust, 'x')]);
  delete from pg_temp.q_txn where txn_date is null or amount is null or currency !~ '^[A-Z]{3}$' or not fin.qbo_ids_ok(array[coalesce(class_id, 'x'), coalesce(cust, 'x')]);

  -- A BillPayment takes the entity of the live bill(s) it pays when they agree (like a payment takes its invoice's), else unmapped.
  create temp table pg_temp.q_bpent on commit drop as
  select e.external_id as id,
         (select case when count(distinct b.entity_code) = 1 then min(b.entity_code) end
          from jsonb_array_elements(case when jsonb_typeof(e.payload -> 'Line') = 'array' then e.payload -> 'Line' else '[]'::jsonb end) l
          cross join lateral jsonb_array_elements(case when jsonb_typeof(l -> 'LinkedTxn') = 'array' then l -> 'LinkedTxn' else '[]'::jsonb end) lt
          join fin.bills b on b.connection_id = p_connection_id and b.source_id = lt ->> 'TxnId' and not b.deleted and not b.voided
          where lt ->> 'TxnType' = 'Bill') as ent
  from pg_temp.q_eff e where e.object_type = 'BillPayment' and e.why is null;

  with w as (
    insert into fin.transactions as t (lane_id, connection_id, source_id, raw_record_id, source_updated_at, txn_type, line_no, txn_date,
                                       posted_at, account_id, class_id, entity_code, amount, is_uncategorized, voided, deleted, currency_code)
    select p_lane, p_connection_id, q.source_id, q.raw_id, q.source_updated_at, q.txn_type, q.line_no, q.txn_date,
           (q.txn_date::timestamp at time zone 'America/New_York'), a.id, q.class_id,
           case when q.txn_type = 'Payment'
                then coalesce(pe.ent, fin.qbo_resolve_entity(v_mode, v_own, v_tracking, '{}'::text[], q.cust, v_class_map, v_cust_map))
                when q.txn_type = 'BillPayment' then coalesce(bp.ent, 'unmapped')
                else fin.qbo_resolve_entity(v_mode, v_own, v_tracking, q.eclasses, q.cust, v_class_map, v_cust_map) end,
           q.amount, coalesce(a.name ~* '^(uncategorized|ask my accountant)', false), q.voided, false, q.currency
    from pg_temp.q_txn q
    left join fin.accounts a on a.connection_id = p_connection_id and a.source_id = q.acct and not a.deleted
    left join pg_temp.q_pay pe on q.txn_type = 'Payment' and pe.id = q.source_id
    left join pg_temp.q_bpent bp on q.txn_type = 'BillPayment' and bp.id = q.source_id
    on conflict (connection_id, txn_type, source_id, line_no) do update
      set raw_record_id = excluded.raw_record_id, source_updated_at = excluded.source_updated_at, txn_date = excluded.txn_date,
          posted_at = excluded.posted_at, account_id = excluded.account_id, class_id = excluded.class_id,
          entity_code = excluded.entity_code, amount = excluded.amount, is_uncategorized = excluded.is_uncategorized,
          voided = excluded.voided, currency_code = excluded.currency_code, deleted = false
      where (t.raw_record_id, t.source_updated_at, t.txn_date, t.posted_at, t.account_id, t.class_id, t.entity_code, t.amount,
             t.is_uncategorized, t.voided, t.currency_code, t.deleted)
            is distinct from (excluded.raw_record_id, excluded.source_updated_at, excluded.txn_date, excluded.posted_at, excluded.account_id,
                              excluded.class_id, excluded.entity_code, excluded.amount, excluded.is_uncategorized, excluded.voided,
                              excluded.currency_code, false)
    returning (xmax = 0) as ins)
  select count(*) filter (where ins), count(*) filter (where not ins) into v_ins, v_upd from w;
  -- Lines a live document no longer has.
  update fin.transactions t set deleted = true
  where t.connection_id = p_connection_id and not t.deleted
    and exists (select 1 from pg_temp.q_eff e where e.why is null and e.object_type = t.txn_type and e.external_id = t.source_id
                and fin.qbo_date(e.payload ->> 'TxnDate') is not null)
    and not exists (select 1 from pg_temp.q_txn q where q.txn_type = t.txn_type and q.source_id = t.source_id and q.line_no = t.line_no);
  get diagnostics v_stale = row_count;
  update fin.transactions t set deleted = true, amount = 0, account_id = null, class_id = null, is_uncategorized = false
  from pg_temp.q_eff e
  where e.why is not null and e.object_type = t.txn_type and e.external_id = t.source_id
    and t.connection_id = p_connection_id and not t.deleted;
  get diagnostics v_tomb = row_count;
  v_counts := v_counts || jsonb_build_object('transactions', jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'tombstoned', v_tomb,
    'stale_lines', v_stale, 'invalid', v_invalid));
  select count(*) filter (where currency <> 'USD') into v_non_usd from pg_temp.q_txn;
  v_counts := v_counts || jsonb_build_object('non_usd_transactions', v_non_usd);
  if v_fallback then
    select v_fallback_rows + count(*) into v_fallback_rows from pg_temp.q_txn;
  end if;

  select (select count(*) from fin.invoices where connection_id = p_connection_id and entity_code = 'unmapped' and not voided and not deleted)
       + (select count(*) from fin.bills where connection_id = p_connection_id and entity_code = 'unmapped' and not voided and not deleted)
       + (select count(*) from fin.transactions where connection_id = p_connection_id and entity_code = 'unmapped' and not voided and not deleted)
    into v_unmapped;
  select count(*) into v_null_account from fin.transactions
  where connection_id = p_connection_id and account_id is null and not voided and not deleted and line_no > 0;
  v_counts := v_counts || jsonb_build_object('unmapped_rows', v_unmapped, 'class_fallback_rows', v_fallback_rows,
    'null_account_lines', v_null_account,
    'invalid_records', coalesce((v_counts -> 'invoices' ->> 'invalid')::integer, 0) + coalesce((v_counts -> 'bills' ->> 'invalid')::integer, 0)
                     + coalesce((v_counts -> 'payments' ->> 'invalid')::integer, 0) + coalesce((v_counts -> 'transactions' ->> 'invalid')::integer, 0));

  drop table pg_temp.q_payroll, pg_temp.q_eff, pg_temp.q_cust, pg_temp.q_vend, pg_temp.q_inv, pg_temp.q_bill,
    pg_temp.q_pay, pg_temp.q_alloc, pg_temp.q_prow, pg_temp.q_txn, pg_temp.q_bpent, pg_temp.q_realloc;

  insert into fin.normalize_runs (lane_id, connection_id, mapping_mode, class_tracking, class_fallback, unseen_cutoff, counts,
                                  reallocation_count, reallocations, started_at, finished_at)
  values (p_lane, p_connection_id, v_mode, v_tracking, v_fallback, v_cutoff, v_counts, v_realloc_n, v_realloc, v_started, clock_timestamp());
  return v_counts || jsonb_build_object('class_tracking', v_tracking, 'class_fallback', v_fallback);
  exception when others then
    get stacked diagnostics v_err_table = table_name, v_err_constraint = constraint_name;
    raise exception 'fin.qbo_normalize failed: SQLSTATE %, table %, constraint %', sqlstate, coalesce(v_err_table, '-'), coalesce(v_err_constraint, '-')
      using errcode = sqlstate;
  end;
end;
$$;
comment on table fin.transactions is
  'QuickBooks posting lines (T-055/T-056): one row per (txn_type, source_id, line_no). A PARTIAL ledger: the bank/paying/A-P side and the lines that name an account; item-based lines have no account (account_id null), Payment and BillPayment have only their header leg, Invoice posts nowhere. Documents are not balanced; P&L comes from the report cache.';
comment on function core.fin_qbo_normalize(text, uuid) is
  'Normalizes one QuickBooks connection''s raw.source_records into fin.* (T-056): idempotent, lane-checked, never deletes, tombstones deleted/unseen/excluded records, tags entities from lane_config. Service_role only. Contract in the migration header.';
revoke all on function core.fin_qbo_normalize(text, uuid) from public, anon, authenticated;
grant execute on function core.fin_qbo_normalize(text, uuid) to service_role;
