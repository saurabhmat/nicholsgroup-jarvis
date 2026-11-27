-- T-300, T-301: the controller's reports in the Finance section (spec finance.md section 15).
--   * core.finance_receivables(lane): aged AR by customer. The set of invoices is EXACTLY the open set core.home_finance_detail ages
--     (current connections, own entity, not voided, not deleted, balance > 0, USD); bucket by coalesce(due_date, issue_date) against
--     today (New York): current = not yet due or due today (no due date: the issue date is used, as in home_finance_detail).
--   * core.finance_weekly(lane, weeks): invoices issued and payments received per business week (Sat to Fri, New York).
--   * core.finance_week_detail(lane, week, weeks): the invoices and payments of one chosen week.
-- Read-only, SECURITY INVOKER, search_path = '', stable; same gate and states as core.home_finance_detail (core.home_finance_context:
-- finance view and AAL2). No new table, no RLS change. Every figure is computed here; the page only formats.
-- Payments (fin.payments): one row per invoice allocation plus one row for any unapplied rest; paid_at is the QuickBooks TxnDate at
-- 00:00 America/New_York (core.fin_qbo_normalize, step payments), so a payment's business date is (paid_at at time zone
-- 'America/New_York')::date. A payment counts once (grouped by connection and source id); its amount is the sum of its rows.

create or replace function core.finance_receivables(p_lane text)
returns table (
  state text,
  as_of timestamptz,
  last_sync_at timestamptz,
  connection_status text,
  business_date date,
  buckets jsonb,
  total numeric(18,2),
  invoice_count integer,
  customers jsonb,
  customer_count integer,
  customers_shown integer,
  customer_cap integer,
  invoice_cap integer,
  check_reason text,
  check_total numeric(18,2),
  check_report_date date,
  check_difference numeric(18,2)
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
  v_buckets jsonb;
  v_total numeric(18,2);
  v_n integer;
  v_customers jsonb;
  v_cust_n integer;
  v_cust_shown integer;
  v_cap constant integer := 50;
  v_inv_cap constant integer := 25;
  rep record;
  v_rep_total_txt text;
  v_rep_total numeric(18,2);
  v_check_reason text;
  v_check_total numeric(18,2);
  v_check_date date;
  v_check_diff numeric(18,2);
  v_fig_re constant text := '^-?[0-9]{1,16}(\.[0-9]{1,6})?$';
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  select * into c from core.home_finance_context(p_lane);
  if not coalesce(c.allowed, false) then
    return query select 'no_access'::text, null::timestamptz, null::timestamptz, null::text, v_today, '[]'::jsonb, null::numeric, 0, '[]'::jsonb, 0, 0, v_cap, v_inv_cap,
      null::text, null::numeric, null::date, null::numeric;
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
    return query select v_state, v_as_of, c.last_sync_at, c.connection_status, v_today, '[]'::jsonb, null::numeric, 0, '[]'::jsonb, 0, 0, v_cap, v_inv_cap,
      null::text, null::numeric, null::date, null::numeric;
    return;
  end if;

  with open_inv as (
    select i.customer_id, i.customer_name, i.issue_date, i.due_date, i.balance, i.id,
           (v_today - coalesce(i.due_date, i.issue_date)) as days_past,
           case when coalesce(i.due_date, i.issue_date) >= v_today then 'current'
                when v_today - coalesce(i.due_date, i.issue_date) <= 30 then '1_30'
                when v_today - coalesce(i.due_date, i.issue_date) <= 60 then '31_60'
                when v_today - coalesce(i.due_date, i.issue_date) <= 90 then '61_90'
                else '90_plus' end as bucket,
           coalesce(i.customer_id, '') as ckey
    from fin.invoices i
    where i.lane_id = p_lane and i.connection_id = any (c.qbo_connections) and i.entity_code = c.own_entity and not i.voided and not i.deleted
      and i.balance > 0 and i.currency_code = 'USD'
  ), inv_r as (
    select o.*, (pg_catalog.row_number() over (partition by o.ckey order by o.days_past desc, o.balance desc, o.id))::integer as ord from open_inv o
  ), cust as (
    -- One row per QuickBooks customer id (invoices with no customer id share one row), biggest balance first.
    select o.ckey,
           (pg_catalog.array_agg(o.customer_name order by o.issue_date desc, o.id) filter (where o.customer_name is not null))[1] as name,
           coalesce(pg_catalog.sum(o.balance) filter (where o.bucket = 'current'), 0)::numeric(18,2) as b_current,
           coalesce(pg_catalog.sum(o.balance) filter (where o.bucket = '1_30'), 0)::numeric(18,2) as b_1_30,
           coalesce(pg_catalog.sum(o.balance) filter (where o.bucket = '31_60'), 0)::numeric(18,2) as b_31_60,
           coalesce(pg_catalog.sum(o.balance) filter (where o.bucket = '61_90'), 0)::numeric(18,2) as b_61_90,
           coalesce(pg_catalog.sum(o.balance) filter (where o.bucket = '90_plus'), 0)::numeric(18,2) as b_90_plus,
           pg_catalog.sum(o.balance)::numeric(18,2) as total,
           (pg_catalog.count(*))::integer as n
    from open_inv o group by o.ckey
  ), cust_r as (
    select x.*, (pg_catalog.row_number() over (order by x.total desc, x.name nulls last, x.ckey))::integer as rn from cust x
  )
  select
    (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'bucket', k.bucket,
              'total', (select coalesce(pg_catalog.sum(o.balance), 0)::numeric(18,2) from open_inv o where o.bucket = k.bucket),
              'count', (select (pg_catalog.count(*))::integer from open_inv o where o.bucket = k.bucket))
            order by k.ord)
     from (values (1, 'current'), (2, '1_30'), (3, '31_60'), (4, '61_90'), (5, '90_plus')) k(ord, bucket)),
    (select coalesce(pg_catalog.sum(o.balance), 0)::numeric(18,2) from open_inv o),
    (select (pg_catalog.count(*))::integer from open_inv o),
    (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'name', x.name, 'current', x.b_current, '1_30', x.b_1_30, '31_60', x.b_31_60, '61_90', x.b_61_90, '90_plus', x.b_90_plus,
              'total', x.total, 'invoices', x.n, 'detail_shown', least(x.n, v_inv_cap),
              'detail', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                           'issue_date', d.issue_date, 'due_date', d.due_date, 'days_overdue', greatest(d.days_past, 0), 'balance', d.balance)
                           order by d.ord), '[]'::jsonb)
                         from inv_r d where d.ckey = x.ckey and d.ord <= v_inv_cap)) order by x.rn), '[]'::jsonb)
     from cust_r x where x.rn <= v_cap),
    (select (pg_catalog.count(*))::integer from cust)
  into v_buckets, v_total, v_n, v_customers, v_cust_n;
  v_cust_shown := least(v_cust_n, v_cap);

  -- The check line: the newest cached QuickBooks AgedReceivables report of a current connection, its TOTAL row (the last column).
  select r.* into rep from fin.report_cache r
  where r.lane_id = p_lane and r.report = 'ar_aging_summary' and r.connection_id = any (c.qbo_connections)
  order by r.params ->> 'report_date' desc nulls last, r.as_of desc, r.fetched_at desc limit 1;
  if not found then
    v_check_reason := 'not_cached';
  elsif coalesce(rep.payload #>> '{Header,TotalsWithheld}', 'false') = 'true' then
    v_check_reason := 'withheld';
  else
    select e.j #>> '{ColData,-1,value}' into v_rep_total_txt
    from jsonb_array_elements(case when jsonb_typeof(rep.payload #> '{Rows,Row}') = 'array' then rep.payload #> '{Rows,Row}' else '[]'::jsonb end) e(j)
    where e.j ->> 'type' = 'Summary' and pg_catalog.upper(pg_catalog.btrim(e.j #>> '{ColData,0,value}')) = 'TOTAL'
    limit 1;
    if v_rep_total_txt is null then
      v_check_reason := 'withheld';
    elsif v_rep_total_txt !~ v_fig_re or coalesce(rep.params ->> 'report_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      v_check_reason := 'unreadable';
    else
      v_check_date := (rep.params ->> 'report_date')::date;
      v_rep_total := pg_catalog.round(v_rep_total_txt::numeric, 2);
      -- The report is a picture of one day; the computed total is of the synced data now. A report dated before the last data
      -- processing day is not comparable.
      if v_check_date < coalesce((c.last_normalized_at at time zone 'America/New_York')::date, v_today) then
        v_check_reason := 'older_than_data';
        v_check_date := null;
      else
        v_check_total := v_rep_total;
        v_check_diff := (v_total - v_rep_total)::numeric(18,2);
      end if;
    end if;
  end if;

  return query select 'ok'::text, v_as_of, c.last_sync_at, c.connection_status, v_today, v_buckets, v_total, v_n, v_customers, v_cust_n, v_cust_shown, v_cap, v_inv_cap,
    v_check_reason, v_check_total, case when v_check_reason is null then v_check_date end, v_check_diff;
end;
$$;
comment on function core.finance_receivables(text) is
  'Aged AR by customer (T-300): the open own-entity invoices of core.home_finance_detail (same set, same buckets), one row per QuickBooks customer id (50 rows, 25 invoices each, counts returned), a totals figure and the QuickBooks AgedReceivables TOTAL with the difference when a comparable cached report exists. Same gate and states as home_finance_detail. Invoker: RLS applies.';
revoke all on function core.finance_receivables(text) from public, anon;
grant execute on function core.finance_receivables(text) to authenticated, service_role;

-- ---------------------------------------------------------------- the number of weeks (lane_config)
-- lane_config is readable only with the "config" view; a finance reader has no such right. This definer function hands out ONE integer
-- (finance.reports.weeks, 1 to 13, default 4 when absent or invalid) and only to a caller who holds the finance view at AAL2 for the lane.
create or replace function core.finance_report_weeks(p_lane text)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cfg jsonb;
  v_w text;
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' or not (p_lane = any (core.allowed_lanes(auth.uid(), 'finance'))) then
    return null;
  end if;
  select cc.config into v_cfg from core.lane_config_current cc where cc.lane_id = p_lane;
  v_w := case when pg_catalog.jsonb_typeof(v_cfg #> '{finance,reports,weeks}') = 'number' then v_cfg #>> '{finance,reports,weeks}' end;
  if v_w ~ '^[0-9]{1,2}$' and v_w::integer between 1 and 13 then
    return v_w::integer;
  end if;
  return 4;
end;
$$;
comment on function core.finance_report_weeks(text) is
  'Weeks shown by the Finance weekly report (T-301): lane_config finance.reports.weeks, 1 to 13, default 4; null for a caller without the finance view at AAL2. Definer only to read that one number.';
revoke all on function core.finance_report_weeks(text) from public, anon;
grant execute on function core.finance_report_weeks(text) to authenticated, service_role;

-- ---------------------------------------------------------------- weeks
create or replace function core.finance_weekly(p_lane text, p_weeks integer default null)
returns table (
  state text,
  as_of timestamptz,
  last_sync_at timestamptz,
  connection_status text,
  business_date date,
  weeks jsonb
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
  v_weeks jsonb;
  v_weeks_n integer;
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
    return query select 'no_access'::text, null::timestamptz, null::timestamptz, null::text, v_today, '[]'::jsonb;
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
    return query select v_state, v_as_of, c.last_sync_at, c.connection_status, v_today, '[]'::jsonb;
    return;
  end if;

  with wk as (
    select g.n, (v_cur - 7 * g.n) as w_start, (v_cur - 7 * g.n + 6) as w_end, least(v_cur - 7 * g.n + 6, v_today) as w_through
    from generate_series(0, v_weeks_n) g(n)
  ), inv as (
    select w.n, (pg_catalog.count(*))::integer as cnt, coalesce(pg_catalog.sum(i.total), 0)::numeric(18,2) as amt
    from wk w
    join fin.invoices i on i.issue_date between w.w_start and w.w_through
    where i.lane_id = p_lane and i.connection_id = any (c.qbo_connections) and i.entity_code = c.own_entity and not i.voided and not i.deleted
      and i.currency_code = 'USD'
    group by w.n
  ), pay as (
    -- One payment = one (connection, source id); its amount is the sum of its rows.
    select p.n, (pg_catalog.count(*))::integer as cnt, coalesce(pg_catalog.sum(p.amt), 0)::numeric(18,2) as amt
    from (
      select w.n, f.connection_id, f.source_id, pg_catalog.sum(f.amount) as amt
      from wk w
      join fin.payments f on (f.paid_at at time zone 'America/New_York')::date between w.w_start and w.w_through
      where f.lane_id = p_lane and f.connection_id = any (c.qbo_connections) and f.entity_code = c.own_entity and not f.voided and not f.deleted
        and f.currency_code = 'USD'
      group by w.n, f.connection_id, f.source_id
    ) p
    group by p.n
  )
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'start', w.w_start, 'end', w.w_end, 'through', w.w_through, 'is_current', (w.n = 0),
           'invoiced_count', coalesce(i.cnt, 0), 'invoiced_amount', coalesce(i.amt, 0)::numeric(18,2),
           'received_count', coalesce(p.cnt, 0), 'received_amount', coalesce(p.amt, 0)::numeric(18,2))
         order by w.n)
  into v_weeks
  from wk w left join inv i on i.n = w.n left join pay p on p.n = w.n;

  return query select 'ok'::text, v_as_of, c.last_sync_at, c.connection_status, v_today, v_weeks;
end;
$$;
comment on function core.finance_weekly(text, integer) is
  'Invoices issued (count, sum of total) and customer payments received (count of payments, sum of all their rows) per business week, Saturday to Friday America/New_York (T-301): the current week to date, then p_weeks (1 to 13) completed weeks, newest first. Own entity, current connections, USD, not voided, not deleted. Same gate and states as home_finance_detail. Invoker: RLS applies.';
revoke all on function core.finance_weekly(text, integer) from public, anon;
grant execute on function core.finance_weekly(text, integer) to authenticated, service_role;

create or replace function core.finance_week_detail(p_lane text, p_week date, p_weeks integer default null)
returns table (
  state text,
  week_valid boolean,
  week_start date,
  week_end date,
  invoices jsonb,
  invoice_count integer,
  payments jsonb,
  payment_count integer,
  row_cap integer
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
  v_cap constant integer := 50;
  v_has_data boolean;
  v_state text;
  v_through date;
  v_weeks_n integer;
  v_inv jsonb; v_inv_n integer; v_pay jsonb; v_pay_n integer;
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
    return query select 'no_access'::text, false, null::date, null::date, '[]'::jsonb, 0, '[]'::jsonb, 0, v_cap;
    return;
  end if;
  v_has_data := c.last_normalized_at is not null
    or exists (select 1 from fin.invoices i where i.lane_id = p_lane and i.connection_id = any (c.qbo_connections))
    or exists (select 1 from fin.report_cache r where r.lane_id = p_lane and r.connection_id = any (c.qbo_connections));
  v_state := case
    when not c.connected then 'not_connected'
    when c.own_entity is null then 'mapping_missing'
    when not v_has_data then 'no_data'
    else 'ok' end;
  if v_state <> 'ok' then
    return query select v_state, false, null::date, null::date, '[]'::jsonb, 0, '[]'::jsonb, 0, v_cap;
    return;
  end if;
  -- A week that is not a Saturday inside the shown range is no week at all.
  if p_week is null or p_week > v_cur or p_week < v_cur - 7 * v_weeks_n or (v_cur - p_week) % 7 <> 0 then
    return query select 'ok'::text, false, null::date, null::date, '[]'::jsonb, 0, '[]'::jsonb, 0, v_cap;
    return;
  end if;
  v_through := least(p_week + 6, v_today);

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('customer', t.customer_name, 'date', t.issue_date, 'total', t.total,
           'open_balance', t.balance) order by t.rn) filter (where t.rn <= v_cap), '[]'::jsonb),
         (pg_catalog.count(*))::integer
  into v_inv, v_inv_n
  from (
    select i.customer_name, i.issue_date, i.total, i.balance,
           (pg_catalog.row_number() over (order by i.issue_date, i.customer_name nulls last, i.id))::integer as rn
    from fin.invoices i
    where i.lane_id = p_lane and i.connection_id = any (c.qbo_connections) and i.entity_code = c.own_entity and not i.voided and not i.deleted
      and i.currency_code = 'USD' and i.issue_date between p_week and v_through
  ) t;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('customer', t.customer_name, 'date', t.paid_date, 'amount', t.amount)
           order by t.rn) filter (where t.rn <= v_cap), '[]'::jsonb),
         (pg_catalog.count(*))::integer
  into v_pay, v_pay_n
  from (
    select g.customer_name, g.paid_date, g.amount,
           (pg_catalog.row_number() over (order by g.paid_date, g.customer_name nulls last, g.source_id))::integer as rn
    from (
      select f.connection_id, f.source_id, (pg_catalog.array_agg(f.customer_name) filter (where f.customer_name is not null))[1] as customer_name,
             pg_catalog.min((f.paid_at at time zone 'America/New_York')::date) as paid_date, pg_catalog.sum(f.amount)::numeric(18,2) as amount
      from fin.payments f
      where f.lane_id = p_lane and f.connection_id = any (c.qbo_connections) and f.entity_code = c.own_entity and not f.voided and not f.deleted
        and f.currency_code = 'USD' and (f.paid_at at time zone 'America/New_York')::date between p_week and v_through
      group by f.connection_id, f.source_id
    ) g
  ) t;

  return query select 'ok'::text, true, p_week, p_week + 6, v_inv, v_inv_n, v_pay, v_pay_n, v_cap;
end;
$$;
comment on function core.finance_week_detail(text, date, integer) is
  'The invoices (customer, date, total, open balance) and payments (customer, date, amount of all rows) of one business week chosen from the weeks core.finance_weekly shows (T-301); 50 rows each, counts returned; week_valid = false for a date that is not a Saturday in that range. Same gate and states as home_finance_detail. Invoker: RLS applies.';
revoke all on function core.finance_week_detail(text, date, integer) from public, anon;
grant execute on function core.finance_week_detail(text, date, integer) to authenticated, service_role;
