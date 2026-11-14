-- T-246: every Home and Finance figure reads only the lane's CURRENT QuickBooks connections (status <> 'disconnected',
-- core.home_finance_context.qbo_connections). Cash (T-243), Net income (T-244 H-1) and the Reports list already did; AR over 30 days,
-- AR aging, the oldest invoices, bills due in 14 days, the unmapped invoice/bill counts, the Finance AR total and the "has data" test
-- read fin.invoices / fin.bills / fin.report_cache by lane only. At go-live (H-061) the sandbox connection is disconnected but its rows
-- stay, so its invoices would have been added to the real company's AR.
--
-- The four functions are replaced with their latest bodies (20261122100000_finance_page.sql for home_finance, finance_pnl and
-- finance_overview; 20261115100000_home_finance_detail.sql for home_finance_detail) and one change: each read of fin.invoices,
-- fin.bills and the "has data" read of fin.report_cache also requires connection_id = any (c.qbo_connections). Signatures, output
-- columns, grants, security invoker and search_path are unchanged; no table changes (RLS unchanged). Read-only: no UPDATE/DELETE.
-- Production: manual part 24 (gitignored), check-part-24.sql.

create or replace function core.home_finance(p_lane text)
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
  pw record;
  v_cash_reason text; v_cash_total numeric(18,2); v_cash_as_of timestamptz; v_cash_accounts jsonb := '[]'; v_cash_unmapped integer := 0;
  v_banks_n integer;
  v_ar_reason text; v_ar_sum numeric(18,2); v_ar_n integer; v_ar_unmapped integer; v_inv_any boolean;
  v_pnl_reason text; v_inc numeric(18,2); v_exp numeric(18,2); v_pstart date; v_pend date; v_pmethod text; v_ppartial boolean; v_pas timestamptz;
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
    or exists (select 1 from fin.invoices i where i.lane_id = p_lane and i.connection_id = any (c.qbo_connections))
    or exists (select 1 from fin.report_cache r where r.lane_id = p_lane and r.connection_id = any (c.qbo_connections));
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
  -- T-243: the sum of the current balances (QuickBooks Account.CurrentBalance, kept by the normalizer in fin.accounts) of the
  -- lane's active bank accounts, as of the last books sync. The balance sheet is not read.
  if jsonb_array_length(c.bank_accounts) = 0 then
    v_cash_reason := 'bank_mapping_missing';
  else
    -- The least of the two: a balance is only as fresh as the older of the last sync and the last normalize that stored it.
    v_cash_as_of := least(coalesce(c.last_sync_at, c.last_normalized_at), coalesce(c.last_normalized_at, c.last_sync_at));
    with bank as (
      select a.source_id as acct_id, a.name as acct_name, a.current_balance as bal, a.entity_code
      from fin.accounts a
      where a.lane_id = p_lane and a.is_bank and a.active and not a.deleted and a.connection_id = any (c.qbo_connections)
    ), mapped as (
      select b.*,
        (select count(distinct m.j ->> 'owner_entity') from jsonb_array_elements(c.bank_accounts) m(j) where m.j ->> 'qbo_account_id' = b.acct_id) as owners,
        exists (select 1 from jsonb_array_elements(c.bank_accounts) m(j) where m.j ->> 'qbo_account_id' = b.acct_id and m.j ->> 'owner_entity' = c.own_entity) as own,
        (b.entity_code <> c.own_entity) as elsewhere
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
  select exists (select 1 from fin.invoices i where i.lane_id = p_lane and i.connection_id = any (c.qbo_connections) and not i.voided and not i.deleted) into v_inv_any;
  if not v_inv_any then
    v_ar_reason := 'no_invoices';
  else
    select coalesce(pg_catalog.sum(i.balance) filter (where i.entity_code = c.own_entity), 0),
           (pg_catalog.count(*) filter (where i.entity_code = c.own_entity))::integer,
           (pg_catalog.count(*) filter (where i.entity_code = 'unmapped'))::integer
    into v_ar_sum, v_ar_n, v_ar_unmapped
    from fin.invoices i
    where i.lane_id = p_lane and i.connection_id = any (c.qbo_connections) and not i.voided and not i.deleted and i.balance > 0 and i.currency_code = 'USD'
      and coalesce(i.due_date, i.issue_date) < v_today - 30;
  end if;

  -- ------------------------------------------------------------ P&L month to date
  -- T-244: the extraction is core.finance_pnl_window (shared with core.finance_pnl, the Finance page). The cached request is
  -- the one the reports job makes for this month: start_date = first day of the month, end_date inside the month (New York).
  select * into pw from core.finance_pnl_window(p_lane, v_month_start, v_month_start,
    (v_month_start + interval '1 month' - interval '1 day')::date, c.mapping_mode, c.qbo_connections);
  v_pnl_reason := case when pw.pnl_reason = 'report_not_cached' then 'month_report_not_cached' else pw.pnl_reason end;
  v_inc := pw.pnl_income; v_exp := pw.pnl_expenses; v_pstart := pw.pnl_start; v_pend := pw.pnl_end;
  v_pmethod := pw.pnl_method; v_ppartial := pw.pnl_partial; v_pas := pw.pnl_as_of;

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
  'Home finance (T-233, T-243): cash book balance (own entity bank accounts from fin.accounts current balances, D-18), AR over 30 days, P&L month to date, each with a reason when absent. Figures from fin.* only. Invoker: RLS applies.';

revoke all on function core.home_finance(text) from public, anon;
grant execute on function core.home_finance(text) to authenticated, service_role;

create or replace function core.finance_pnl(p_lane text, p_period text)
returns table (
  state text,
  as_of timestamptz,
  last_sync_at timestamptz,
  connection_status text,
  period text,
  window_start date,
  window_end date,
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
  pw record;
  v_today date := (pg_catalog.now() at time zone 'America/New_York')::date;
  v_start date;
  v_end_to date;
  v_state text;
  v_as_of timestamptz;
  v_has_data boolean;
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  if p_period is null or p_period not in ('week', 'mtd', 'ytd') then
    raise exception 'period must be week, mtd or ytd' using errcode = '22023';
  end if;
  -- Business week = Saturday to Friday (rule 11): the most recent Saturday on or before today.
  if p_period = 'week' then
    v_start := v_today - ((pg_catalog.date_part('dow', v_today)::integer + 1) % 7);
    v_end_to := v_start + 6;
  elsif p_period = 'mtd' then
    v_start := pg_catalog.date_trunc('month', v_today::timestamp)::date;
    v_end_to := (v_start + interval '1 month' - interval '1 day')::date;
  else
    v_start := pg_catalog.date_trunc('year', v_today::timestamp)::date;
    v_end_to := (v_start + interval '1 year' - interval '1 day')::date;
  end if;
  select * into c from core.home_finance_context(p_lane);
  if not coalesce(c.allowed, false) then
    return query select 'no_access'::text, null::timestamptz, null::timestamptz, null::text, p_period, null::date, null::date,
      null::text, null::numeric, null::numeric, null::numeric, null::date, null::date, null::text, false, null::timestamptz;
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
    return query select v_state, v_as_of, c.last_sync_at, c.connection_status, p_period, v_start, v_today,
      null::text, null::numeric, null::numeric, null::numeric, null::date, null::date, null::text, false, null::timestamptz;
    return;
  end if;
  select * into pw from core.finance_pnl_window(p_lane, v_start, v_start, v_end_to, c.mapping_mode, c.qbo_connections);
  return query select 'ok'::text, v_as_of, c.last_sync_at, c.connection_status, p_period, v_start, v_today,
    pw.pnl_reason, pw.pnl_income, pw.pnl_expenses, pw.pnl_net, pw.pnl_start, pw.pnl_end, pw.pnl_method, coalesce(pw.pnl_partial, false), pw.pnl_as_of;
end;
$$;
comment on function core.finance_pnl(text, text) is
  'Finance page net income (T-244) for week (Sat to today, New York), mtd or ytd (calendar year) from the cached P&L report; same gating and states as home_finance. Invoker: RLS applies.';
revoke all on function core.finance_pnl(text, text) from public, anon;
grant execute on function core.finance_pnl(text, text) to authenticated, service_role;

create or replace function core.finance_overview(p_lane text)
returns table (
  state text,
  as_of timestamptz,
  last_sync_at timestamptz,
  last_normalized_at timestamptz,
  connection_status text,
  ar_total numeric(18,2),
  ar_invoices integer,
  unmapped_bills_open integer,
  reports jsonb
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  c record;
  v_state text;
  v_as_of timestamptz;
  v_has_data boolean;
  v_ar numeric(18,2);
  v_ar_n integer;
  v_un_bills integer;
  v_reports jsonb;
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  select * into c from core.home_finance_context(p_lane);
  if not coalesce(c.allowed, false) then
    return query select 'no_access'::text, null::timestamptz, null::timestamptz, null::timestamptz, null::text, null::numeric, 0, 0, '[]'::jsonb;
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
    return query select v_state, v_as_of, c.last_sync_at, c.last_normalized_at, c.connection_status, null::numeric, 0, 0, '[]'::jsonb;
    return;
  end if;

  -- Open AR of the own entity: the same rows as the aging buckets of home_finance_detail (open, not voided/deleted, USD).
  select coalesce(pg_catalog.sum(i.balance), 0)::numeric(18,2), (pg_catalog.count(*))::integer into v_ar, v_ar_n
  from fin.invoices i
  where i.lane_id = p_lane and i.connection_id = any (c.qbo_connections) and i.entity_code = c.own_entity and not i.voided and not i.deleted and i.balance > 0 and i.currency_code = 'USD';

  select (pg_catalog.count(*))::integer into v_un_bills
  from fin.bills b
  where b.lane_id = p_lane and b.connection_id = any (c.qbo_connections) and b.entity_code = 'unmapped' and not b.voided and not b.deleted and b.balance > 0;

  -- Report metadata only (never the payload): the newest cached report per type and start date (one per aging type), current connections only: nightly re-fetches of the same period do not pile up.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'report', t.report, 'start_date', t.start_date, 'end_date', t.end_date, 'report_date', t.report_date,
           'method', t.method, 'class_filtered', t.class_filtered, 'as_of', t.as_of) order by t.report, t.as_of desc), '[]'::jsonb)
  into v_reports
  from (
    select * from (
      select distinct on (r.report, r.params ->> 'start_date', r.params ->> 'method', (r.params ? 'class'))
             r.report,
             pg_catalog.left(r.params ->> 'start_date', 10) as start_date,
             pg_catalog.left(r.params ->> 'end_date', 10) as end_date,
             pg_catalog.left(r.params ->> 'report_date', 10) as report_date,
             pg_catalog.left(r.params ->> 'method', 16) as method,
             (r.params ? 'class') as class_filtered,
             r.as_of
      from fin.report_cache r
      where r.lane_id = p_lane and r.connection_id = any (c.qbo_connections)
      order by r.report, r.params ->> 'start_date', r.params ->> 'method', (r.params ? 'class'), r.as_of desc, r.fetched_at desc
    ) d
    order by d.as_of desc
    limit 50
  ) t;

  return query select 'ok'::text, v_as_of, c.last_sync_at, c.last_normalized_at, c.connection_status, v_ar, v_ar_n, v_un_bills, v_reports;
end;
$$;
comment on function core.finance_overview(text) is
  'Finance page (T-244): own-entity open AR total (equals the aging bucket sum of home_finance_detail), open unmapped bills, last normalizer run and cached report METADATA (no payload) of the current QuickBooks connections. Invoker: RLS applies.';
revoke all on function core.finance_overview(text) from public, anon;
grant execute on function core.finance_overview(text) to authenticated, service_role;

create or replace function core.home_finance_detail(p_lane text)
returns table (
  state text,
  as_of timestamptz,
  bills_due_14_total numeric(18,2),
  bills_due_14_count integer,
  aging jsonb,
  oldest jsonb,
  unmapped_invoices integer,
  unmapped_bills integer
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  c record;
  v_today date := (pg_catalog.now() at time zone 'America/New_York')::date;
  v_state text;
  v_as_of timestamptz;
  v_has_data boolean;
  v_bills_total numeric(18,2);
  v_bills_n integer;
  v_aging jsonb;
  v_oldest jsonb;
  v_un_inv integer;
  v_un_bills integer;
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  select * into c from core.home_finance_context(p_lane);
  if not coalesce(c.allowed, false) then
    return query select 'no_access'::text, null::timestamptz, null::numeric, null::integer, '[]'::jsonb, '[]'::jsonb, 0, 0;
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
    return query select v_state, v_as_of, null::numeric, null::integer, '[]'::jsonb, '[]'::jsonb, 0, 0;
    return;
  end if;

  -- Bills due from today to today + 14 (inclusive). Overdue bills are not part of this figure.
  select coalesce(pg_catalog.sum(b.balance), 0)::numeric(18,2), (pg_catalog.count(*))::integer
  into v_bills_total, v_bills_n
  from fin.bills b
  where b.lane_id = p_lane and b.connection_id = any (c.qbo_connections) and b.entity_code = c.own_entity and not b.voided and not b.deleted and b.balance > 0
    and b.due_date between v_today and v_today + 14;

  select (pg_catalog.count(*))::integer into v_un_bills
  from fin.bills b
  where b.lane_id = p_lane and b.connection_id = any (c.qbo_connections) and b.entity_code = 'unmapped' and not b.voided and not b.deleted and b.balance > 0
    and b.due_date between v_today and v_today + 14;

  -- AR aging over open own-entity invoices.
  with open_inv as (
    select i.balance,
           case when coalesce(i.due_date, i.issue_date) >= v_today then 'current'
                when v_today - coalesce(i.due_date, i.issue_date) <= 30 then '1_30'
                when v_today - coalesce(i.due_date, i.issue_date) <= 60 then '31_60'
                when v_today - coalesce(i.due_date, i.issue_date) <= 90 then '61_90'
                else '90_plus' end as bucket
    from fin.invoices i
    where i.lane_id = p_lane and i.connection_id = any (c.qbo_connections) and i.entity_code = c.own_entity and not i.voided and not i.deleted
      and i.balance > 0 and i.currency_code = 'USD'
  )
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'bucket', k.bucket,
           'total', (select coalesce(pg_catalog.sum(o.balance), 0)::numeric(18,2) from open_inv o where o.bucket = k.bucket),
           'count', (select (pg_catalog.count(*))::integer from open_inv o where o.bucket = k.bucket))
         order by k.ord)
  into v_aging
  from (values (1, 'current'), (2, '1_30'), (3, '31_60'), (4, '61_90'), (5, '90_plus')) k(ord, bucket);

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'customer', t.customer_name, 'balance', t.balance, 'days_overdue', t.days_overdue) order by t.rn), '[]'::jsonb)
  into v_oldest
  from (
    select i.customer_name, i.balance::numeric(18,2) as balance, (v_today - coalesce(i.due_date, i.issue_date))::integer as days_overdue,
           pg_catalog.row_number() over (order by v_today - coalesce(i.due_date, i.issue_date) desc, i.balance desc, i.id) as rn
    from fin.invoices i
    where i.lane_id = p_lane and i.connection_id = any (c.qbo_connections) and i.entity_code = c.own_entity and not i.voided and not i.deleted
      and i.balance > 0 and i.currency_code = 'USD' and coalesce(i.due_date, i.issue_date) < v_today
  ) t
  where t.rn <= 3;

  select (pg_catalog.count(*))::integer into v_un_inv
  from fin.invoices i
  where i.lane_id = p_lane and i.connection_id = any (c.qbo_connections) and i.entity_code = 'unmapped' and not i.voided and not i.deleted and i.balance > 0 and i.currency_code = 'USD';

  return query select 'ok'::text, v_as_of, v_bills_total, v_bills_n, v_aging, v_oldest, v_un_inv, v_un_bills;
end;
$$;
comment on function core.home_finance_detail(text) is
  'Home finance detail (T-237): own-entity bills due in the next 14 days (overdue bills excluded; unmapped_bills counts the same window), AR aging buckets by coalesce(due_date, issue_date) like home_finance and the three oldest overdue invoices (customer name, balance, days only). Figures from fin.* only; same gating and state values as home_finance. Invoker: RLS applies.';
revoke all on function core.home_finance_detail(text) from public, anon;
grant execute on function core.home_finance_detail(text) to authenticated, service_role;
