-- Home finance detail (T-237 part A): bills due in the next 14 days, AR aging buckets and the three oldest overdue invoices
-- for the redesigned Home. One read-only function in `core`; no table is added (no new RLS surface).
--
--   core.home_finance_detail(p_lane)  SECURITY INVOKER: reads fin.* under the caller's RLS (AAL2 + the lane's finance view).
--       Gating, state values and the own-entity rule are the same as core.home_finance (T-233): the state comes from
--       core.home_finance_context (not_connected / mapping_missing / no_data / ok / no_access). Any state other than 'ok'
--       returns no figure (null / empty array / 0 for the unmapped counts).
--
-- Definitions. Business date = America/New_York (rule 11). Own entity = lane_config entities.own_entity. Only open
-- (balance > 0), not voided, not deleted rows of the own entity are summed; rows with entity_code 'unmapped' are counted
-- in unmapped_* and never summed. Invoices are USD only (as in home_finance); fin.bills has no currency column.
--   * bills_due_14_*: open bills with due_date from today to today + 14 inclusive. Overdue bills (due before today) are NOT included.
--   * aging: five buckets in the order current, 1_30, 31_60, 61_90, 90_plus over open invoices; days past due = today - due_date.
--     A null due_date, or a due_date of today or later, is 'current'. Buckets with no invoice are present with total 0.00, count 0.
--   * oldest: up to three open invoices with the largest days past due (> 0 only), ties by larger balance then id. The
--     output carries the customer name (may be null) and amounts only: no invoice, source or customer ids.
-- Money is numeric(18,2); figures come from SQL only (rule 7).

create function core.home_finance_detail(p_lane text)
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
    or exists (select 1 from fin.invoices i where i.lane_id = p_lane)
    or exists (select 1 from fin.report_cache r where r.lane_id = p_lane);
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
  where b.lane_id = p_lane and b.entity_code = c.own_entity and not b.voided and not b.deleted and b.balance > 0
    and b.due_date between v_today and v_today + 14;

  select (pg_catalog.count(*) filter (where b.entity_code = 'unmapped'))::integer into v_un_bills
  from fin.bills b
  where b.lane_id = p_lane and not b.voided and not b.deleted and b.balance > 0;

  -- AR aging over open own-entity invoices.
  with open_inv as (
    select i.balance,
           case when i.due_date is null or i.due_date >= v_today then 'current'
                when v_today - i.due_date <= 30 then '1_30'
                when v_today - i.due_date <= 60 then '31_60'
                when v_today - i.due_date <= 90 then '61_90'
                else '90_plus' end as bucket
    from fin.invoices i
    where i.lane_id = p_lane and i.entity_code = c.own_entity and not i.voided and not i.deleted
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
    select i.customer_name, i.balance::numeric(18,2) as balance, (v_today - i.due_date)::integer as days_overdue,
           pg_catalog.row_number() over (order by v_today - i.due_date desc, i.balance desc, i.id) as rn
    from fin.invoices i
    where i.lane_id = p_lane and i.entity_code = c.own_entity and not i.voided and not i.deleted
      and i.balance > 0 and i.currency_code = 'USD' and i.due_date < v_today
  ) t
  where t.rn <= 3;

  select (pg_catalog.count(*))::integer into v_un_inv
  from fin.invoices i
  where i.lane_id = p_lane and i.entity_code = 'unmapped' and not i.voided and not i.deleted and i.balance > 0 and i.currency_code = 'USD';

  return query select 'ok'::text, v_as_of, v_bills_total, v_bills_n, v_aging, v_oldest, v_un_inv, v_un_bills;
end;
$$;
comment on function core.home_finance_detail(text) is
  'Home finance detail (T-237): own-entity bills due in the next 14 days (overdue bills excluded), AR aging buckets and the three oldest overdue invoices (customer name, balance, days only). Figures from fin.* only; same gating and state values as home_finance. Invoker: RLS applies.';
revoke all on function core.home_finance_detail(text) from public, anon;
grant execute on function core.home_finance_detail(text) to authenticated, service_role;
