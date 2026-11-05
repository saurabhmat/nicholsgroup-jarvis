-- Business calendar (T-080, spec finance.md section 5). Pure functions, no tables, so no RLS.
-- All conversions use the fixed zone 'America/New_York' on explicit timestamp / timestamptz values and never read the
-- session timezone: date -> timestamp casts are timezone-free, and we never call date_trunc on a timestamptz or cast a
-- date to timestamptz. Marked immutable like Postgres's own timezone(text, timestamptz) (a tzdata update is the only
-- thing that can change a result, as for the built-in). Business week = Saturday 00:00 ET to the next Saturday 00:00 ET
-- (end exclusive). Local-time arithmetic is done on plain timestamps before converting, so DST days are 23/25 hours.
-- All ranges are half-open [start, end). Not for use in index or generated-column expressions (tzdata dependence).

create or replace function fin.et_date(p_ts timestamptz) returns date
language sql immutable parallel safe set search_path = ''
as $$ select (p_ts at time zone 'America/New_York')::date $$;

create or replace function fin.month_start(p_d date) returns timestamptz
language sql immutable parallel safe set search_path = ''
as $$ select date_trunc('month', p_d::timestamp) at time zone 'America/New_York' $$;

create or replace function fin.next_month_start(p_d date) returns timestamptz
language sql immutable parallel safe set search_path = ''
as $$ select (date_trunc('month', p_d::timestamp) + interval '1 month') at time zone 'America/New_York' $$;

create or replace function fin.ytd_start(p_d date) returns timestamptz
language sql immutable parallel safe set search_path = ''
as $$ select date_trunc('year', p_d::timestamp) at time zone 'America/New_York' $$;

create or replace function fin.business_week(p_ts timestamptz)
returns table (week_start timestamptz, week_end timestamptz)
language sql immutable parallel safe set search_path = ''
as $$
  with l as (select date_trunc('day', p_ts at time zone 'America/New_York') as d)
  select
    (l.d - ((extract(dow from l.d)::int + 1) % 7) * interval '1 day') at time zone 'America/New_York',
    (l.d - ((extract(dow from l.d)::int + 1) % 7) * interval '1 day' + interval '7 days') at time zone 'America/New_York'
  from l
$$;

-- Period helpers (half-open). p_d is any date in the month / year.
create or replace function fin.month_range(p_d date)
returns table (period_start timestamptz, period_end timestamptz)
language sql immutable parallel safe set search_path = ''
as $$ select fin.month_start(p_d), fin.next_month_start(p_d) $$;

-- Year to date through the end of p_d's month (callers cap the end at now() for the current month).
create or replace function fin.ytd_range(p_d date)
returns table (period_start timestamptz, period_end timestamptz)
language sql immutable parallel safe set search_path = ''
as $$ select fin.ytd_start(p_d), fin.next_month_start(p_d) $$;

-- Month to date as of p_ts: [month start of p_ts's ET month, p_ts) so a past p_ts never includes later events.
create or replace function fin.mtd_range(p_ts timestamptz)
returns table (period_start timestamptz, period_end timestamptz)
language sql immutable parallel safe set search_path = ''
as $$ select fin.month_start(fin.et_date(p_ts)), p_ts $$;

revoke all on function fin.et_date(timestamptz), fin.month_start(date), fin.next_month_start(date), fin.ytd_start(date),
  fin.business_week(timestamptz), fin.month_range(date), fin.ytd_range(date), fin.mtd_range(timestamptz)
  from public, anon;
grant execute on function fin.et_date(timestamptz), fin.month_start(date), fin.next_month_start(date), fin.ytd_start(date),
  fin.business_week(timestamptz), fin.month_range(date), fin.ytd_range(date), fin.mtd_range(timestamptz)
  to authenticated, service_role;
