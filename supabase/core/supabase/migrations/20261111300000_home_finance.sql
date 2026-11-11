-- Home finance reads (T-233). Two functions in `core` (the API schema) so Home can show the lane's cash (book balance),
-- AR over 30 days and P&L month to date without exposing the `fin` schema. No table is added (no new RLS surface).
--
--   core.home_finance_context(p_lane)  SECURITY DEFINER, only to read what the `finance` view alone cannot: the lane's
--       QuickBooks connection facts (core.connections, `connections` view), the last normalizer run (fin.normalize_runs,
--       `health` view) and the entity / bank-account mapping (core.lane_config, `config` view). It answers only a caller
--       who holds the `finance` view of that lane at AAL2 and returns nothing else about the connection (no tokens, no
--       error text). Anyone else gets one row with allowed = false.
--   core.home_finance(p_lane)  SECURITY INVOKER: the figures, read from fin.* under the caller's RLS (AAL2 + finance view).
--
-- Figures come from SQL only (rule 7). Money is numeric(18,2). The business date and month are America/New_York (rule 11).
-- Every figure has its own `*_reason`: null when the figure is present, else why it is not (never a guess, never a sample).
--
-- Definitions (also in .agent/pr/T-233.md):
--   * Cash = the latest cached QuickBooks Balance Sheet (fin.report_cache, report 'balance_sheet'): the rows of the "Bank
--     Accounts" group, each shown in full under the entity that legally owns it per lane_config.entities.bank_accounts
--     (D-18). Only accounts owned by the lane's own entity are listed and summed; an account owned by another entity is
--     left out; a bank account in the report that is in no mapping is counted in cash_unmapped and not summed (never
--     allocated). `shared` marks an account listed under more than one owner, or whose ledger activity is attributed to
--     another entity. A balance sheet that was class-filtered is refused (a class-filtered "balance" is not the account's
--     book balance). The Balance Sheet is not cached by default (D-27), so cash is typically unavailable until D-27 is decided.
--   * AR over 30 days = the sum of balance of own-entity (entity_code = lane_config.entities.own_entity) open (balance > 0)
--     USD invoices, not voided or deleted, whose due date (issue date when none) is more than 30 days before the business
--     date. Unmapped-entity invoices that would qualify are counted in ar_unmapped and not summed.
--   * P&L month to date = the latest cached ProfitAndLoss whose range starts on the 1st of the current business month
--     (params.start_date) and ends in it. Income = leaf rows of the Income and OtherIncome groups; expenses = leaf rows of
--     COGS, Expenses and OtherExpenses; net = income - expenses. If the lane splits entities by class (file_class) the
--     report must be class-filtered, else it is refused. pnl_partial = true when the connector withheld totals because
--     payroll rows were removed (D-25): the figures then exclude payroll. The default report range is year to date, so
--     until a month-to-date report is cached the reason is 'month_report_not_cached' (nothing is derived or estimated).
--   * as_of = the last successful normalizer run of the lane's QuickBooks connection(s), else the last sync end.

create function core.home_finance_context(p_lane text)
returns table (
  allowed boolean,
  connected boolean,
  connection_status text,
  last_sync_at timestamptz,
  last_normalized_at timestamptz,
  own_entity text,
  mapping_mode text,
  bank_accounts jsonb
)
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
    return query select false, false, null::text, null::timestamptz, null::timestamptz, null::text, null::text, '[]'::jsonb;
    return;
  end if;
  select cc.config into v_cfg from core.lane_config_current cc where cc.lane_id = p_lane;
  return query
  select
    true,
    exists (select 1 from core.connections k where k.lane_id = p_lane and k.provider = 'quickbooks' and k.status <> 'disconnected'),
    (select k.status from core.connections k where k.lane_id = p_lane and k.provider = 'quickbooks' and k.status <> 'disconnected'
       order by (k.status = 'active') desc, k.created_at desc limit 1),
    (select max(k.last_sync_at) from core.connections k where k.lane_id = p_lane and k.provider = 'quickbooks' and k.status <> 'disconnected'),
    (select max(r.finished_at) from fin.normalize_runs r where r.lane_id = p_lane),
    case when jsonb_typeof(v_cfg #> '{entities,own_entity}') = 'string' then v_cfg #>> '{entities,own_entity}' end,
    case when jsonb_typeof(v_cfg #> '{qbo,entity_mapping_mode}') = 'string' then v_cfg #>> '{qbo,entity_mapping_mode}' end,
    case when jsonb_typeof(v_cfg #> '{entities,bank_accounts}') = 'array' then v_cfg #> '{entities,bank_accounts}' else '[]'::jsonb end;
end;
$$;
comment on function core.home_finance_context(text) is
  'Home finance (T-233): QuickBooks connection facts, last normalizer run and entity/bank mapping for a caller who holds the finance view at AAL2. Definer only to read those; allowed = false for anyone else.';
revoke all on function core.home_finance_context(text) from public, anon;
grant execute on function core.home_finance_context(text) to authenticated, service_role;

create function core.home_finance(p_lane text)
returns table (
  state text,
  as_of timestamptz,
  last_sync_at timestamptz,
  connection_status text,
  business_date date,
  cash_reason text,
  cash_total numeric(18,2),
  cash_as_of timestamptz,
  cash_accounts jsonb,
  cash_unmapped integer,
  ar_reason text,
  ar_over_30 numeric(18,2),
  ar_invoices integer,
  ar_unmapped integer,
  pnl_reason text,
  pnl_income numeric(18,2),
  pnl_expenses numeric(18,2),
  pnl_net numeric(18,2),
  pnl_start date,
  pnl_end date,
  pnl_method text,
  pnl_partial boolean,
  pnl_as_of timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  c record;
  v_today date := (pg_catalog.now() at time zone 'America/New_York')::date;
  v_month_start date := pg_catalog.date_trunc('month', (pg_catalog.now() at time zone 'America/New_York'))::date;
  v_state text;
  v_as_of timestamptz;
  v_has_data boolean;
  rep record;
  v_cash_reason text; v_cash_total numeric(18,2); v_cash_as_of timestamptz; v_cash_accounts jsonb := '[]'; v_cash_unmapped integer := 0;
  v_banks_n integer;
  v_ar_reason text; v_ar_sum numeric(18,2); v_ar_n integer; v_ar_unmapped integer; v_inv_any boolean;
  v_pnl_reason text; v_inc numeric(18,2); v_exp numeric(18,2); v_pstart date; v_pend date; v_pmethod text; v_ppartial boolean; v_pas timestamptz;
  v_data_rows integer;
  v_rows jsonb;
  v_pnl_re constant text := '^-?[0-9]{1,16}(\.[0-9]{1,6})?$';
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  select * into c from core.home_finance_context(p_lane);
  if not coalesce(c.allowed, false) then
    return query select 'no_access'::text, null::timestamptz, null::timestamptz, null::text, v_today,
      null::text, null::numeric, null::timestamptz, '[]'::jsonb, 0,
      null::text, null::numeric, 0, 0,
      null::text, null::numeric, null::numeric, null::numeric, null::date, null::date, null::text, false, null::timestamptz;
    return;
  end if;

  v_as_of := coalesce(c.last_normalized_at, c.last_sync_at);
  v_has_data := c.last_normalized_at is not null
    or exists (select 1 from fin.invoices i where i.lane_id = p_lane)
    or exists (select 1 from fin.report_cache r where r.lane_id = p_lane);
  v_state := case
    when not c.connected then 'not_connected'
    when c.own_entity is null then 'mapping_missing'
    when not v_has_data then 'no_data'
    else 'ok' end;

  if v_state <> 'ok' then
    return query select v_state, v_as_of, c.last_sync_at, c.connection_status, v_today,
      null::text, null::numeric, null::timestamptz, '[]'::jsonb, 0,
      null::text, null::numeric, 0, 0,
      null::text, null::numeric, null::numeric, null::numeric, null::date, null::date, null::text, false, null::timestamptz;
    return;
  end if;

  -- ------------------------------------------------------------ cash (book balance)
  select r.* into rep from fin.report_cache r
  where r.lane_id = p_lane and r.report = 'balance_sheet'
  order by r.as_of desc, r.fetched_at desc limit 1;
  if not found then
    v_cash_reason := 'balance_sheet_not_cached';
  elsif rep.params ? 'class' then
    v_cash_reason := 'balance_sheet_class_filtered';
  elsif coalesce(rep.payload #>> '{Header,SummarizeColumnsBy}', 'Total') <> 'Total' then
    v_cash_reason := 'report_has_columns';
  elsif jsonb_array_length(c.bank_accounts) = 0 then
    v_cash_reason := 'bank_mapping_missing';
  else
    v_cash_as_of := rep.as_of;
    v_rows := case when jsonb_typeof(rep.payload #> '{Rows,Row}') = 'array' then rep.payload #> '{Rows,Row}' else '[]'::jsonb end;
    with bank as (
      select (e.j #>> '{ColData,0,id}') as acct_id, (e.j #>> '{ColData,0,value}') as acct_name,
             case when (e.j #>> '{ColData,1,value}') ~ v_pnl_re
                  then pg_catalog.round((e.j #>> '{ColData,1,value}')::numeric, 2) end as bal
      from jsonb_array_elements(v_rows) e(j)
      where e.j ->> 'type' = 'Data' and e.j ->> 'group' = 'BankAccounts' and (e.j #>> '{ColData,0,id}') is not null
    ), mapped as (
      select b.*,
        (select count(distinct m.j ->> 'owner_entity') from jsonb_array_elements(c.bank_accounts) m(j) where m.j ->> 'qbo_account_id' = b.acct_id) as owners,
        exists (select 1 from jsonb_array_elements(c.bank_accounts) m(j) where m.j ->> 'qbo_account_id' = b.acct_id and m.j ->> 'owner_entity' = c.own_entity) as own,
        exists (select 1 from fin.accounts a where a.lane_id = p_lane and a.source_id = b.acct_id and a.is_bank and a.entity_code <> c.own_entity) as elsewhere
      from bank b
    )
    select
      coalesce(pg_catalog.sum(x.bal) filter (where x.own), 0),
      coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name', x.acct_name, 'book_balance', x.bal,
        'shared', (x.owners > 1 or x.elsewhere)) order by x.acct_name, x.acct_id) filter (where x.own), '[]'::jsonb),
      (pg_catalog.count(*) filter (where x.owners = 0))::integer,
      (pg_catalog.count(*) filter (where x.own))::integer
    into v_cash_total, v_cash_accounts, v_cash_unmapped, v_banks_n
    from mapped x;
    if v_banks_n = 0 then
      v_cash_reason := 'no_own_bank_accounts';
    elsif exists (select 1 from jsonb_array_elements(v_cash_accounts) a(j) where a.j ->> 'book_balance' is null) then
      v_cash_reason := 'balance_unreadable';
    end if;
  end if;

  -- ------------------------------------------------------------ AR over 30 days
  select exists (select 1 from fin.invoices i where i.lane_id = p_lane and not i.voided and not i.deleted) into v_inv_any;
  if not v_inv_any then
    v_ar_reason := 'no_invoices';
  else
    select coalesce(pg_catalog.sum(i.balance) filter (where i.entity_code = c.own_entity), 0),
           (pg_catalog.count(*) filter (where i.entity_code = c.own_entity))::integer,
           (pg_catalog.count(*) filter (where i.entity_code = 'unmapped'))::integer
    into v_ar_sum, v_ar_n, v_ar_unmapped
    from fin.invoices i
    where i.lane_id = p_lane and not i.voided and not i.deleted and i.balance > 0 and i.currency_code = 'USD'
      and coalesce(i.due_date, i.issue_date) < v_today - 30;
  end if;

  -- ------------------------------------------------------------ P&L month to date
  select r.* into rep from fin.report_cache r
  where r.lane_id = p_lane and r.report = 'pnl'
    and r.params ->> 'start_date' = pg_catalog.to_char(v_month_start, 'YYYY-MM-DD')
    and r.params ->> 'end_date' >= pg_catalog.to_char(v_month_start, 'YYYY-MM-DD')
    and r.params ->> 'end_date' <= pg_catalog.to_char(v_month_start + interval '1 month' - interval '1 day', 'YYYY-MM-DD')
  order by r.as_of desc, r.fetched_at desc limit 1;
  if not found then
    v_pnl_reason := 'month_report_not_cached';
  elsif c.mapping_mode = 'file_class' and not (rep.params ? 'class') then
    v_pnl_reason := 'report_not_split_by_class';
  elsif coalesce(rep.payload #>> '{Header,SummarizeColumnsBy}', 'Total') <> 'Total' then
    v_pnl_reason := 'report_has_columns';
  else
    v_rows := case when jsonb_typeof(rep.payload #> '{Rows,Row}') = 'array' then rep.payload #> '{Rows,Row}' else '[]'::jsonb end;
    select
      pg_catalog.sum(x.amt) filter (where x.grp in ('Income', 'OtherIncome')),
      pg_catalog.sum(x.amt) filter (where x.grp in ('COGS', 'Expenses', 'OtherExpenses')),
      pg_catalog.count(*)::integer,
      (pg_catalog.count(*) filter (where x.amt is null))::integer
    into v_inc, v_exp, v_data_rows, v_banks_n
    from (
      select e.j ->> 'group' as grp,
             case when (e.j #>> '{ColData,1,value}') ~ v_pnl_re
                  then pg_catalog.round((e.j #>> '{ColData,1,value}')::numeric, 2) end as amt
      from jsonb_array_elements(v_rows) e(j)
      where e.j ->> 'type' = 'Data' and (e.j ->> 'group') in ('Income', 'OtherIncome', 'COGS', 'Expenses', 'OtherExpenses')
    ) x;
    if v_data_rows = 0 then
      v_pnl_reason := 'report_empty';
    elsif v_banks_n > 0 then
      v_pnl_reason := 'figure_unreadable';
    else
      v_inc := coalesce(v_inc, 0);
      v_exp := coalesce(v_exp, 0);
      v_pstart := (rep.params ->> 'start_date')::date;
      v_pend := (rep.params ->> 'end_date')::date;
      v_pmethod := rep.params ->> 'method';
      v_ppartial := coalesce(rep.payload #>> '{Header,TotalsWithheld}', 'false') = 'true';
      v_pas := rep.as_of;
    end if;
  end if;

  return query select 'ok'::text, v_as_of, c.last_sync_at, c.connection_status, v_today,
    v_cash_reason, case when v_cash_reason is null then v_cash_total end, case when v_cash_reason is null then v_cash_as_of end,
    case when v_cash_reason is null then v_cash_accounts else '[]'::jsonb end, v_cash_unmapped,
    v_ar_reason, case when v_ar_reason is null then v_ar_sum end, case when v_ar_reason is null then v_ar_n else 0 end,
    case when v_ar_reason is null then v_ar_unmapped else 0 end,
    v_pnl_reason, case when v_pnl_reason is null then v_inc end, case when v_pnl_reason is null then v_exp end,
    case when v_pnl_reason is null then v_inc - v_exp end,
    case when v_pnl_reason is null then v_pstart end, case when v_pnl_reason is null then v_pend end,
    case when v_pnl_reason is null then v_pmethod end, coalesce(v_ppartial, false), case when v_pnl_reason is null then v_pas end;
end;
$$;
comment on function core.home_finance(text) is
  'Home finance (T-233): cash book balance (own entity bank accounts, D-18), AR over 30 days, P&L month to date, each with a reason when absent. Figures from fin.* only. Invoker: RLS applies.';
revoke all on function core.home_finance(text) from public, anon;
grant execute on function core.home_finance(text) to authenticated, service_role;
