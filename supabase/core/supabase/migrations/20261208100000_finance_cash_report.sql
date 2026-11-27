-- T-302: the Finance cash report (spec finance.md section 15.4): the book balance of each bank account today and at the end (Friday, New York)
-- of each of the last completed business weeks.
--   * fin.bank_balances: one row per (connection, bank account, date): the book balance QuickBooks reported for that account at the end of
--     that day. Filled by the nightly reports job from the Balance Sheet; ONLY rows of bank accounts are ever kept (the connector cuts the
--     report down to {account id, balance} pairs before it calls the writer; nothing else of the Balance Sheet reaches the database, and the
--     report is not cached: D-27 is unchanged, `balance_sheet` is not a report kind).
--   * core.fin_bank_balances_put: the only writer (service_role). It validates lane, connection, date and that EVERY account is a bank
--     account (is_bank, not deleted) of that connection in fin.accounts, i.e. one the normalizer kept: payroll accounts are never stored
--     there (D-25), so a payroll or excluded account cannot be written. One call writes ALL accounts of one date (a week is never half written),
--     removes the date's rows of accounts not in the call (a figure that could not be read is not kept stale), and removes the connection's
--     rows older than 26 weeks (retention).
--   * core.fin_bank_account_ids: service_role only; the QuickBooks ids of the connection's bank accounts the job may ask the report about.
--   * core.finance_cash(lane, weeks): the report. SECURITY INVOKER, same gate and states as core.home_finance_detail. Every figure here.
-- Production: manual part 39 (gitignored).

-- ---------------------------------------------------------------- fin.bank_balances
create table fin.bank_balances (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  connection_id uuid not null,
  provider text not null default 'quickbooks' check (provider = 'quickbooks'),
  account_id uuid not null,
  balance_date date not null,
  book_balance numeric(18,2) not null,
  as_of timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, account_id, balance_date),
  foreign key (connection_id, lane_id, provider) references core.connections (id, lane_id, provider)
    on update restrict on delete restrict,
  foreign key (account_id, connection_id) references fin.accounts (id, connection_id)
    on update restrict on delete restrict
);
comment on table fin.bank_balances is
  'T-302: the QuickBooks book balance of a bank account at the end of a date (read from the Balance Sheet by the nightly reports job; only bank-account rows are kept, nothing else of the report). Book balance, not bank balance (rule 7). Rows older than 26 weeks are removed by the writer.';
create index bank_balances_lane_date_idx on fin.bank_balances (lane_id, balance_date);

create trigger bank_balances_set_updated_at before update on fin.bank_balances
  for each row execute function core.set_updated_at();
create trigger bank_balances_identity before update on fin.bank_balances
  for each row execute function fin.forbid_identity_change('lane_id', 'connection_id', 'provider', 'account_id', 'balance_date');
alter table fin.bank_balances enable row level security;
create policy bank_balances_select on fin.bank_balances for select to authenticated using (
  (select auth.jwt() ->> 'aal') = 'aal2'
  and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'finance'))::text[]));
revoke all on fin.bank_balances from public, anon, authenticated;
grant select on fin.bank_balances to authenticated;
-- The writer (security invoker, service_role) upserts a date and removes stale and expired rows with filtered deletes; no UPDATE of identity.
grant select, insert, update, delete on fin.bank_balances to service_role;

-- ---------------------------------------------------------------- the bank accounts the job may ask about
create function core.fin_bank_account_ids(p_lane text, p_connection_id uuid)
returns text[]
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_lane is null or p_connection_id is null then
    raise exception 'fin.bank_account_ids: every argument is required' using errcode = '22004';
  end if;
  if not exists (select 1 from core.connections c
                 join core.lanes l on l.code = c.lane_id and l.enabled
                 where c.id = p_connection_id and c.lane_id = p_lane and c.provider = 'quickbooks' and c.status in ('active', 'degraded')) then
    raise exception 'fin.bank_account_ids: usable QuickBooks connection not found in this lane' using errcode = '42501';
  end if;
  return coalesce((select pg_catalog.array_agg(a.source_id order by a.source_id) from fin.accounts a
                   where a.lane_id = p_lane and a.connection_id = p_connection_id and a.is_bank and a.active and not a.deleted), '{}'::text[]);
end;
$$;
comment on function core.fin_bank_account_ids(text, uuid) is
  'T-302: QuickBooks account ids of the active bank accounts the normalizer kept for a usable QuickBooks connection of the lane (payroll accounts are never in fin.accounts). Service_role only.';
revoke all on function core.fin_bank_account_ids(text, uuid) from public, anon, authenticated;
grant execute on function core.fin_bank_account_ids(text, uuid) to service_role;

-- ---------------------------------------------------------------- the writer
-- p_balances: a JSON array of exactly { "account_id": "<QuickBooks id, digits>", "book_balance": "<figure as QuickBooks sent it>" } objects.
-- Every message is constant (no data in an error). 22004 missing argument; 42501 connection not usable in this lane; 22023 anything else refused.
create function core.fin_bank_balances_put(p_lane text, p_connection_id uuid, p_date date, p_as_of timestamptz, p_balances jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_today date := (pg_catalog.now() at time zone 'America/New_York')::date;
  v_fig constant text := '^-?[0-9]{1,15}(\.[0-9]{1,6})?$';
  v_n integer;
  v_ids uuid[];
begin
  if p_lane is null or p_connection_id is null or p_date is null or p_as_of is null or p_balances is null then
    raise exception 'fin.bank_balances_put: every argument is required' using errcode = '22004';
  end if;
  if not exists (select 1 from core.connections c
                 join core.lanes l on l.code = c.lane_id and l.enabled
                 where c.id = p_connection_id and c.lane_id = p_lane and c.provider = 'quickbooks' and c.status in ('active', 'degraded')) then
    raise exception 'fin.bank_balances_put: usable QuickBooks connection not found in this lane' using errcode = '42501';
  end if;
  -- A date from today back 26 weeks; never the future. The read time is not in the future either (a minute of clock difference allowed).
  if p_date > v_today or p_date < v_today - 182 then
    raise exception 'fin.bank_balances_put: date out of range' using errcode = '22023';
  end if;
  if p_as_of > pg_catalog.now() + interval '5 minutes' then
    raise exception 'fin.bank_balances_put: as_of is in the future' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_balances) <> 'array' or pg_catalog.jsonb_array_length(p_balances) > 200 then
    raise exception 'fin.bank_balances_put: balances must be an array of at most 200' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_balances) e(j)
    where case when pg_catalog.jsonb_typeof(e.j) <> 'object' then true
               else (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(e.j) k) <> 2
                    or pg_catalog.jsonb_typeof(e.j -> 'account_id') is distinct from 'string'
                    or pg_catalog.jsonb_typeof(e.j -> 'book_balance') is distinct from 'string'
                    or coalesce(e.j ->> 'account_id', '') !~ '^[0-9]{1,20}$'
                    or coalesce(e.j ->> 'book_balance', '') !~ v_fig end) then
    raise exception 'fin.bank_balances_put: a balance item is not valid' using errcode = '22023';
  end if;
  if (select pg_catalog.count(distinct e.j ->> 'account_id') from pg_catalog.jsonb_array_elements(p_balances) e(j)) <> pg_catalog.jsonb_array_length(p_balances) then
    raise exception 'fin.bank_balances_put: an account is listed twice' using errcode = '22023';
  end if;
  -- Every account must be a bank account of THIS connection and lane that the normalizer kept (not deleted). One that is not refuses the whole call.
  select pg_catalog.array_agg(a.id) into v_ids
  from pg_catalog.jsonb_array_elements(p_balances) e(j)
  join fin.accounts a on a.source_id = e.j ->> 'account_id'
  where a.lane_id = p_lane and a.connection_id = p_connection_id and a.is_bank and not a.deleted;
  if coalesce(pg_catalog.cardinality(v_ids), 0) <> pg_catalog.jsonb_array_length(p_balances) then
    raise exception 'fin.bank_balances_put: an account is not a bank account of this connection' using errcode = '22023';
  end if;

  insert into fin.bank_balances (lane_id, connection_id, account_id, balance_date, book_balance, as_of)
  select p_lane, p_connection_id, a.id, p_date, pg_catalog.round((e.j ->> 'book_balance')::numeric, 2), p_as_of
  from pg_catalog.jsonb_array_elements(p_balances) e(j)
  join fin.accounts a on a.source_id = e.j ->> 'account_id' and a.connection_id = p_connection_id and a.lane_id = p_lane
  on conflict (connection_id, account_id, balance_date) do update set book_balance = excluded.book_balance, as_of = excluded.as_of;
  get diagnostics v_n = row_count;

  -- The date holds exactly this call's accounts: a figure that could not be read tonight is not left over from an earlier night.
  delete from fin.bank_balances b
  where b.lane_id = p_lane and b.connection_id = p_connection_id and b.balance_date = p_date and not (b.account_id = any (v_ids));
  -- Retention: 26 weeks.
  delete from fin.bank_balances b
  where b.lane_id = p_lane and b.connection_id = p_connection_id and b.balance_date < v_today - 182;
  return v_n;
end;
$$;
comment on function core.fin_bank_balances_put(text, uuid, date, timestamptz, jsonb) is
  'T-302: writes the book balances of bank accounts of one QuickBooks connection at the end of one date, in one call (upsert; the date''s other rows are removed; rows older than 26 weeks are removed). Refuses the whole call when any account is not a bank account (is_bank, not deleted) of the connection in this lane. Service_role only.';
revoke all on function core.fin_bank_balances_put(text, uuid, date, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function core.fin_bank_balances_put(text, uuid, date, timestamptz, jsonb) to service_role;

-- ---------------------------------------------------------------- the report
-- columns[i]: { kind: today | week_end, date, as_of, read, accounts }  (index 0 = today, then the Fridays, newest first)
-- accounts[j]: { name, shared, cells: [ { book_balance, change } per column ] }   change = this column minus the next OLDER column; null when either is missing
-- totals:      { cells: [ { book_balance, change, missing } per column ] }        null total when ANY account of the column is missing
create or replace function core.finance_cash(p_lane text, p_weeks integer default null)
returns table (
  state text,
  as_of timestamptz,
  last_sync_at timestamptz,
  connection_status text,
  business_date date,
  reason text,
  weeks integer,
  columns jsonb,
  accounts jsonb,
  totals jsonb
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  c record;
  v_today date := (pg_catalog.now() at time zone 'America/New_York')::date;
  v_cur date := (pg_catalog.now() at time zone 'America/New_York')::date - ((pg_catalog.date_part('dow', (pg_catalog.now() at time zone 'America/New_York')::date)::integer + 1) % 7);
  v_state text;
  v_as_of timestamptz;
  v_has_data boolean;
  v_weeks_n integer;
  v_reason text;
  v_today_as_of timestamptz;
  v_cols jsonb := '[]';
  v_accts jsonb := '[]';
  v_tot jsonb := '[]';
  v_own_n integer;
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  if p_weeks is not null and (p_weeks < 1 or p_weeks > 13) then
    raise exception 'weeks must be 1 to 13' using errcode = '22023';
  end if;
  v_weeks_n := coalesce(p_weeks, core.finance_report_weeks(p_lane), 4);
  select * into c from core.home_finance_context(p_lane);
  if not coalesce(c.allowed, false) then
    return query select 'no_access'::text, null::timestamptz, null::timestamptz, null::text, v_today, null::text, v_weeks_n, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb;
    return;
  end if;
  v_as_of := coalesce(c.last_normalized_at, c.last_sync_at);
  v_has_data := c.last_normalized_at is not null
    or exists (select 1 from fin.invoices i where i.lane_id = p_lane and i.connection_id = any (c.qbo_connections))
    or exists (select 1 from fin.report_cache r where r.lane_id = p_lane and r.connection_id = any (c.qbo_connections));
  v_state := case
    when not c.connected then 'not_connected'
    when c.own_entity is null then 'mapping_missing'
    when not v_has_data then 'no_data'
    else 'ok' end;
  if v_state <> 'ok' then
    return query select v_state, v_as_of, c.last_sync_at, c.connection_status, v_today, null::text, v_weeks_n, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb;
    return;
  end if;

  if pg_catalog.jsonb_array_length(c.bank_accounts) = 0 then
    v_reason := 'bank_mapping_missing';
  else
    -- Today: the stored current balance, as of the older of the last sync and the last normalize (as the Overview's Cash by account).
    v_today_as_of := least(coalesce(c.last_sync_at, c.last_normalized_at), coalesce(c.last_normalized_at, c.last_sync_at));
    with cols as (
      -- 0 = today; n = 1..N: the Friday that ends the n-th completed business week (Saturday to Friday).
      select g.n, case when g.n = 0 then v_today else v_cur - 7 * (g.n - 1) - 1 end as d from generate_series(0, v_weeks_n) g(n)
    ), bank as (
      -- Exactly the accounts "Cash by account" lists (core.home_finance): current connections, active, not deleted, mapped to the own entity.
      select a.id, a.source_id as acct_id, a.name as acct_name, a.current_balance as bal, a.entity_code
      from fin.accounts a
      where a.lane_id = p_lane and a.is_bank and a.active and not a.deleted and a.connection_id = any (c.qbo_connections)
    ), mapped as (
      select b.*,
        (select count(distinct m.j ->> 'owner_entity') from pg_catalog.jsonb_array_elements(c.bank_accounts) m(j) where m.j ->> 'qbo_account_id' = b.acct_id) as owners,
        exists (select 1 from pg_catalog.jsonb_array_elements(c.bank_accounts) m(j) where m.j ->> 'qbo_account_id' = b.acct_id and m.j ->> 'owner_entity' = c.own_entity) as own,
        (b.entity_code <> c.own_entity) as elsewhere
      from bank b
    ), own as (
      select m.*, (pg_catalog.row_number() over (order by m.acct_name, m.acct_id))::integer as rn from mapped m where m.own
    ), cell as (
      select o.id, o.rn, k.n, k.d,
             case when k.n = 0 then o.bal
                  else (select b.book_balance from fin.bank_balances b
                        where b.lane_id = p_lane and b.account_id = o.id and b.balance_date = k.d and b.connection_id = any (c.qbo_connections)) end as bal
      from own o cross join cols k
    ), chg as (
      select x.*, pg_catalog.lead(x.bal) over (partition by x.id order by x.n) as older from cell x
    ), tot as (
      select x.n, (pg_catalog.count(*))::integer as accounts, (pg_catalog.count(x.bal))::integer as have, pg_catalog.sum(x.bal) as s from cell x group by x.n
    ), tot2 as (
      select t.n, t.accounts, t.have, (case when t.have = t.accounts and t.accounts > 0 then t.s end)::numeric(18,2) as total from tot t
    ), tot3 as (
      select t.*, pg_catalog.lead(t.total) over (order by t.n) as older_total from tot2 t
    )
    select
      (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'kind', case when k.n = 0 then 'today' else 'week_end' end,
          'date', k.d,
          'as_of', case when k.n = 0 then v_today_as_of
                        else (select pg_catalog.min(b.as_of) from fin.bank_balances b
                              where b.lane_id = p_lane and b.account_id in (select o.id from own o) and b.balance_date = k.d and b.connection_id = any (c.qbo_connections)) end,
          'read', t.have, 'accounts', t.accounts) order by k.n)
       from cols k join tot3 t on t.n = k.n),
      (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'name', o.acct_name, 'shared', (o.owners > 1 or o.elsewhere),
          'cells', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                      'book_balance', x.bal::numeric(18,2),
                      'change', (case when x.bal is not null and x.older is not null then x.bal - x.older end)::numeric(18,2)) order by x.n)
                    from chg x where x.id = o.id)) order by o.rn)
       from own o),
      (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'book_balance', t.total,
          'change', (case when t.total is not null and t.older_total is not null then t.total - t.older_total end)::numeric(18,2),
          'missing', t.accounts - t.have) order by t.n)
       from tot3 t),
      (select (pg_catalog.count(*))::integer from own)
    into v_cols, v_accts, v_tot, v_own_n;
    if v_own_n = 0 then
      v_reason := 'no_own_bank_accounts';
      v_cols := '[]'; v_accts := '[]'; v_tot := '[]';
    end if;
  end if;

  return query select 'ok'::text, v_as_of, c.last_sync_at, c.connection_status, v_today, v_reason, v_weeks_n,
    coalesce(v_cols, '[]'::jsonb), coalesce(v_accts, '[]'::jsonb), coalesce(v_tot, '[]'::jsonb);
end;
$$;
comment on function core.finance_cash(text, integer) is
  'Cash report (T-302): the book balance of each own bank account (as Cash by account lists them) today and at the end (Friday, New York) of each of p_weeks (1 to 13) completed business weeks, newest first, each cell with its change from the next older column, per-column as_of, and a total row that is null when any account of the column has no stored balance. Same gate and states as home_finance_detail. Invoker: RLS applies.';
revoke all on function core.finance_cash(text, integer) from public, anon;
grant execute on function core.finance_cash(text, integer) to authenticated, service_role;
