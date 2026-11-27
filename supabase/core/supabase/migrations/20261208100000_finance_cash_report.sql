-- T-302: the Finance cash report (spec finance.md section 15.4): the book balance of each cash account today and at the end (Friday, New York)
-- of each of the last completed business weeks.
--   * fin.cash_book_balances: one row per (connection, account, date): the book balance QuickBooks reported for that account at the end of that
--     day. Filled by the nightly reports job from the Balance Sheet; ONLY rows of the lane's cash accounts are ever kept (the connector cuts the
--     report down to {account id, balance} pairs before it calls the writer; nothing else of the Balance Sheet reaches the database, and the
--     report is not cached: D-27 is unchanged, `balance_sheet` is not a report kind). The names say "cash book balance": never "bank balance".
--   * core.fin_cash_accounts(lane, connection): service_role only; the cash accounts of a connection EXACTLY as "Cash by account" lists them for the
--     lane (core.home_finance): is_bank, active, not deleted, mapped in lane_config entities.bank_accounts to the own entity. The job asks about these
--     and the writer accepts only these (store only what is shown).
--   * core.fin_cash_account_ids: the QuickBooks ids of those accounts. core.fin_cash_book_balances_put: the only writer (service_role); one call
--     writes ONE date for ONE connection (a week is never half written), replaces that date (rows of accounts not in the call, or all of them for an
--     empty call, are removed), refuses the whole call when any account is not one of the connection's cash accounts.
--   * core.fin_cash_book_balances_purge: service_role only; retention (26 weeks), rows of disconnected connections, and, when the history switch is
--     off, every row of the connection. The job calls it at the start of each run, on its own, so retention never depends on a successful write.
--   * core.fin_cash_history_enabled(lane): one boolean (lane_config finance.reports.cash_history, default FALSE), true only for a caller with the
--     finance view at AAL2; a finance reader cannot read lane_config.
--   * core.business_week_start(date): the Saturday that starts the business week of a date (immutable); core.finance_cash uses it, and pgTAP checks it
--     against the same fixed dates as the TypeScript cashHistoryDates tests.
--   * core.finance_cash(lane, weeks): the report. SECURITY INVOKER, same gate and states as core.home_finance_detail. Every figure here. With the history
--     switch off it returns the Today column only.
-- Production: manual part 39 (gitignored).

-- ---------------------------------------------------------------- the business week
create function core.business_week_start(p_day date)
returns date
language sql
immutable
set search_path = ''
as $$
  -- Saturday = 0 ... Friday = 6 days after the start (rule 11). Pure calendar arithmetic on a date: no time zone, no DST.
  select p_day - ((pg_catalog.date_part('dow', p_day)::integer + 1) % 7);
$$;
comment on function core.business_week_start(date) is
  'The Saturday that starts the business week (Saturday to Friday, rule 11) containing a calendar date. Pure; pass the America/New_York date.';
revoke all on function core.business_week_start(date) from public, anon;
grant execute on function core.business_week_start(date) to authenticated, service_role;

-- ---------------------------------------------------------------- fin.cash_book_balances
create table fin.cash_book_balances (
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
comment on table fin.cash_book_balances is
  'T-302: the QuickBooks book balance of a bank account at the end of a date (read from the Balance Sheet by the nightly reports job; only bank-account rows are kept, nothing else of the report). Book balance (rule 7). Rows older than 26 weeks are removed by the writer.';
create index cash_book_balances_lane_date_idx on fin.cash_book_balances (lane_id, balance_date);

create trigger cash_book_balances_set_updated_at before update on fin.cash_book_balances
  for each row execute function core.set_updated_at();
create trigger cash_book_balances_identity before update on fin.cash_book_balances
  for each row execute function fin.forbid_identity_change('lane_id', 'connection_id', 'provider', 'account_id', 'balance_date');
alter table fin.cash_book_balances enable row level security;
create policy cash_book_balances_select on fin.cash_book_balances for select to authenticated using (
  (select auth.jwt() ->> 'aal') = 'aal2'
  and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'finance'))::text[]));
revoke all on fin.cash_book_balances from public, anon, authenticated;
grant select on fin.cash_book_balances to authenticated;
-- The writer (security invoker, service_role) upserts a date and removes stale and expired rows with filtered deletes; no UPDATE of identity.
grant select, insert, update, delete on fin.cash_book_balances to service_role;

-- ---------------------------------------------------------------- the history switch (lane_config)
create function core.fin_cash_history_enabled(p_lane text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cfg jsonb;
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' or not (p_lane = any (core.allowed_lanes(auth.uid(), 'finance'))) then
    return false;
  end if;
  select cc.config into v_cfg from core.lane_config_current cc where cc.lane_id = p_lane;
  -- Fail closed: only the JSON boolean true switches the weekly history on (absent, false or anything else: off).
  return coalesce(v_cfg #> '{finance,reports,cash_history}' = 'true'::jsonb, false);
end;
$$;
comment on function core.fin_cash_history_enabled(text) is
  'T-302: lane_config finance.reports.cash_history (default false) as one boolean; false for a caller without the finance view at AAL2. Definer only to read that one value.';
revoke all on function core.fin_cash_history_enabled(text) from public, anon;
grant execute on function core.fin_cash_history_enabled(text) to authenticated, service_role;

-- ---------------------------------------------------------------- the cash accounts of a connection
create function core.fin_cash_accounts(p_lane text, p_connection_id uuid)
returns table (id uuid, source_id text)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_cfg jsonb;
  v_own text;
begin
  if p_lane is null or p_connection_id is null then
    raise exception 'fin.cash_accounts: every argument is required' using errcode = '22004';
  end if;
  if not exists (select 1 from core.connections c
                 join core.lanes l on l.code = c.lane_id and l.enabled
                 where c.id = p_connection_id and c.lane_id = p_lane and c.provider = 'quickbooks' and c.status in ('active', 'degraded')) then
    raise exception 'fin.cash_accounts: usable QuickBooks connection not found in this lane' using errcode = '42501';
  end if;
  select cc.config into v_cfg from core.lane_config_current cc where cc.lane_id = p_lane;
  v_own := case when pg_catalog.jsonb_typeof(v_cfg #> '{entities,own_entity}') = 'string' then v_cfg #>> '{entities,own_entity}' end;
  if v_own is null or pg_catalog.jsonb_typeof(v_cfg #> '{entities,bank_accounts}') is distinct from 'array' then
    return;
  end if;
  -- The same rule as core.home_finance ("Cash by account"): a bank account, active, not deleted, mapped to the own entity in lane_config.
  return query
  select a.id, a.source_id from fin.accounts a
  where a.lane_id = p_lane and a.connection_id = p_connection_id and a.is_bank and a.active and not a.deleted
    and exists (select 1 from pg_catalog.jsonb_array_elements(v_cfg #> '{entities,bank_accounts}') m(j)
                where m.j ->> 'qbo_account_id' = a.source_id and m.j ->> 'owner_entity' = v_own)
  order by a.source_id;
end;
$$;
comment on function core.fin_cash_accounts(text, uuid) is
  'T-302: the cash accounts of a usable QuickBooks connection exactly as Cash by account lists them (bank, active, not deleted, mapped to the own entity). Service_role only.';
revoke all on function core.fin_cash_accounts(text, uuid) from public, anon, authenticated;
grant execute on function core.fin_cash_accounts(text, uuid) to service_role;

create function core.fin_cash_account_ids(p_lane text, p_connection_id uuid)
returns text[]
language sql
stable
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(x.source_id order by x.source_id), '{}'::text[]) from core.fin_cash_accounts(p_lane, p_connection_id) x;
$$;
comment on function core.fin_cash_account_ids(text, uuid) is
  'T-302: QuickBooks account ids of core.fin_cash_accounts (what the reports job may read from the Balance Sheet). Service_role only.';
revoke all on function core.fin_cash_account_ids(text, uuid) from public, anon, authenticated;
grant execute on function core.fin_cash_account_ids(text, uuid) to service_role;

-- ---------------------------------------------------------------- the writer
-- p_balances: a JSON array of exactly { "account_id": "<QuickBooks id, digits>", "book_balance": "<figure as QuickBooks sent it>" } objects.
-- Every message is constant (no data in an error). 22004 missing argument; 42501 connection not usable in this lane; 22023 anything else refused.
-- An EMPTY array is valid and clears the date for this connection (nothing could be read).
create function core.fin_cash_book_balances_put(p_lane text, p_connection_id uuid, p_date date, p_as_of timestamptz, p_balances jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_today date := (pg_catalog.now() at time zone 'America/New_York')::date;
  v_fig constant text := '^-?[0-9]{1,15}(\.[0-9]{1,6})?$';
  v_n integer;
  v_items integer;
  v_ids uuid[];
begin
  if p_lane is null or p_connection_id is null or p_date is null or p_as_of is null or p_balances is null then
    raise exception 'fin.cash_book_balances_put: every argument is required' using errcode = '22004';
  end if;
  if not exists (select 1 from core.connections c
                 join core.lanes l on l.code = c.lane_id and l.enabled
                 where c.id = p_connection_id and c.lane_id = p_lane and c.provider = 'quickbooks' and c.status in ('active', 'degraded')) then
    raise exception 'fin.cash_book_balances_put: usable QuickBooks connection not found in this lane' using errcode = '42501';
  end if;
  -- A date from today back 26 weeks; never the future. The read time is not in the future either (a few minutes of clock difference allowed).
  if p_date > v_today or p_date < v_today - 182 then
    raise exception 'fin.cash_book_balances_put: date out of range' using errcode = '22023';
  end if;
  if p_as_of > pg_catalog.now() + interval '5 minutes' then
    raise exception 'fin.cash_book_balances_put: as_of is in the future' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_balances) <> 'array' or pg_catalog.jsonb_array_length(p_balances) > 200 then
    raise exception 'fin.cash_book_balances_put: balances must be an array of at most 200' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_balances) e(j)
    where case when pg_catalog.jsonb_typeof(e.j) <> 'object' then true
               else (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(e.j) k) <> 2
                    or pg_catalog.jsonb_typeof(e.j -> 'account_id') is distinct from 'string'
                    or pg_catalog.jsonb_typeof(e.j -> 'book_balance') is distinct from 'string'
                    or coalesce(e.j ->> 'account_id', '') !~ '^[0-9]{1,20}$'
                    or coalesce(e.j ->> 'book_balance', '') !~ v_fig end) then
    raise exception 'fin.cash_book_balances_put: a balance item is not valid' using errcode = '22023';
  end if;
  v_items := pg_catalog.jsonb_array_length(p_balances);
  if (select pg_catalog.count(distinct e.j ->> 'account_id') from pg_catalog.jsonb_array_elements(p_balances) e(j)) <> v_items then
    raise exception 'fin.cash_book_balances_put: an account is listed twice' using errcode = '22023';
  end if;
  -- Every account must be one of THIS connection's cash accounts (core.fin_cash_accounts: bank, active, not deleted, mapped to the own entity).
  select pg_catalog.array_agg(a.id) into v_ids
  from pg_catalog.jsonb_array_elements(p_balances) e(j)
  join core.fin_cash_accounts(p_lane, p_connection_id) a on a.source_id = e.j ->> 'account_id';
  if coalesce(pg_catalog.cardinality(v_ids), 0) <> v_items then
    raise exception 'fin.cash_book_balances_put: an account is not a cash account of this connection' using errcode = '22023';
  end if;

  -- The insert repeats the validated conditions (no gap between the check and the use) and the number of rows written must equal the items.
  insert into fin.cash_book_balances (lane_id, connection_id, account_id, balance_date, book_balance, as_of)
  select p_lane, p_connection_id, a.id, p_date, pg_catalog.round((e.j ->> 'book_balance')::numeric, 2), p_as_of
  from pg_catalog.jsonb_array_elements(p_balances) e(j)
  join fin.accounts a on a.source_id = e.j ->> 'account_id' and a.connection_id = p_connection_id and a.lane_id = p_lane
                      and a.is_bank and a.active and not a.deleted and a.id = any (v_ids)
  on conflict (connection_id, account_id, balance_date) do update set book_balance = excluded.book_balance, as_of = excluded.as_of;
  get diagnostics v_n = row_count;
  if v_n <> v_items then
    raise exception 'fin.cash_book_balances_put: the accounts changed while writing' using errcode = '22023';
  end if;

  -- The date holds exactly this call's accounts: a figure that could not be read tonight is not left over from an earlier night. An empty call
  -- (v_ids is null) clears the date for this connection.
  delete from fin.cash_book_balances b
  where b.lane_id = p_lane and b.connection_id = p_connection_id and b.balance_date = p_date and not (b.account_id = any (coalesce(v_ids, '{}'::uuid[])));
  return v_n;
end;
$$;
comment on function core.fin_cash_book_balances_put(text, uuid, date, timestamptz, jsonb) is
  'T-302: writes the book balances of the cash accounts of one QuickBooks connection at the end of one date, in one call (upsert; the date''s other rows are removed; an empty list clears the date). Refuses the whole call when any account is not one of the connection''s cash accounts (bank, active, not deleted, mapped to the own entity). Service_role only.';
revoke all on function core.fin_cash_book_balances_put(text, uuid, date, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function core.fin_cash_book_balances_put(text, uuid, date, timestamptz, jsonb) to service_role;

-- ---------------------------------------------------------------- retention and the switch
-- Called by the reports job at the start of every run, on its own. Removes, in the lane: rows older than 26 weeks (any connection), every row of a
-- disconnected connection (at once, at the next run of any connection of the lane), and, when p_all, every row of p_connection_id (the history
-- switch is off: stored history is not kept). Returns the number of rows removed. Each DELETE has a top-level WHERE (pg-safeupdate).
create function core.fin_cash_book_balances_purge(p_lane text, p_connection_id uuid, p_all boolean)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_today date := (pg_catalog.now() at time zone 'America/New_York')::date;
  v_n integer := 0;
  v_k integer;
begin
  if p_lane is null or p_connection_id is null or p_all is null then
    raise exception 'fin.cash_book_balances_purge: every argument is required' using errcode = '22004';
  end if;
  if not exists (select 1 from core.connections c join core.lanes l on l.code = c.lane_id and l.enabled
                 where c.id = p_connection_id and c.lane_id = p_lane and c.provider = 'quickbooks') then
    raise exception 'fin.cash_book_balances_purge: QuickBooks connection not found in this lane' using errcode = '42501';
  end if;
  delete from fin.cash_book_balances b where b.lane_id = p_lane and b.balance_date < v_today - 182;
  get diagnostics v_k = row_count;
  v_n := v_n + v_k;
  delete from fin.cash_book_balances b
  where b.lane_id = p_lane and b.connection_id in (select c.id from core.connections c where c.lane_id = p_lane and c.status = 'disconnected');
  get diagnostics v_k = row_count;
  v_n := v_n + v_k;
  if p_all then
    delete from fin.cash_book_balances b where b.lane_id = p_lane and b.connection_id = p_connection_id;
    get diagnostics v_k = row_count;
    v_n := v_n + v_k;
  end if;
  return v_n;
end;
$$;
comment on function core.fin_cash_book_balances_purge(text, uuid, boolean) is
  'T-302: retention (26 weeks), rows of disconnected connections, and, with p_all, every row of the connection (history switch off). Lane and connection checked. Service_role only.';
revoke all on function core.fin_cash_book_balances_purge(text, uuid, boolean) from public, anon, authenticated;
grant execute on function core.fin_cash_book_balances_purge(text, uuid, boolean) to service_role;

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
  history_enabled boolean,
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
  v_cur date := core.business_week_start((pg_catalog.now() at time zone 'America/New_York')::date);
  v_hist boolean;
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
  -- The weekly history is shown only when the lane's config switches it on (default off); otherwise the Today column only.
  v_hist := core.fin_cash_history_enabled(p_lane);
  select * into c from core.home_finance_context(p_lane);
  if not coalesce(c.allowed, false) then
    return query select 'no_access'::text, null::timestamptz, null::timestamptz, null::text, v_today, null::text, v_weeks_n, false, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb;
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
    return query select v_state, v_as_of, c.last_sync_at, c.connection_status, v_today, null::text, v_weeks_n, false, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb;
    return;
  end if;

  if pg_catalog.jsonb_array_length(c.bank_accounts) = 0 then
    v_reason := 'bank_mapping_missing';
  else
    -- Today: the stored current balance, as of the older of the last sync and the last normalize (as the Overview's Cash by account).
    v_today_as_of := least(coalesce(c.last_sync_at, c.last_normalized_at), coalesce(c.last_normalized_at, c.last_sync_at));
    with cols as (
      -- 0 = today; n = 1..N: the Friday that ends the n-th completed business week (Saturday to Friday).
      select g.n, case when g.n = 0 then v_today else v_cur - 7 * (g.n - 1) - 1 end as d from generate_series(0, case when v_hist then v_weeks_n else 0 end) g(n)
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
                  else (select b.book_balance from fin.cash_book_balances b
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
                        else (select pg_catalog.min(b.as_of) from fin.cash_book_balances b
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

  return query select 'ok'::text, v_as_of, c.last_sync_at, c.connection_status, v_today, v_reason, v_weeks_n, v_hist,
    coalesce(v_cols, '[]'::jsonb), coalesce(v_accts, '[]'::jsonb), coalesce(v_tot, '[]'::jsonb);
end;
$$;
comment on function core.finance_cash(text, integer) is
  'Cash report (T-302): the book balance of each own bank account (as Cash by account lists them) today and at the end (Friday, New York) of each of p_weeks (1 to 13) completed business weeks, newest first, each cell with its change from the next older column, per-column as_of, and a total row that is null when any account of the column has no stored balance. Same gate and states as home_finance_detail. Invoker: RLS applies.';
revoke all on function core.finance_cash(text, integer) from public, anon;
grant execute on function core.finance_cash(text, integer) to authenticated, service_role;
