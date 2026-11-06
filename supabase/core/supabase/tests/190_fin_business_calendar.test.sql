-- Business calendar (T-080, spec finance.md section 5): fin.et_date, month_start, next_month_start, ytd_start,
-- business_week, month_range, ytd_range, mtd_range. Every case runs under three session timezones and must give
-- identical results. Covers DST (Mar 8 and Nov 1, 2026), year boundaries, Friday 23:59:59 vs Saturday 00:00 ET.
begin;
select plan(13);

create temp table want (label text primary key, want text not null) on commit drop;
create temp table got (tz text, label text, got text, primary key (tz, label)) on commit drop;

create function pg_temp.z(t timestamptz) returns text language sql immutable as
$$ select to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;

-- Expected values (UTC renderings of ET instants).
insert into want values
  ('et_date Dec31 23:59:59 ET',        '2026-12-31'),
  ('et_date Jan1 00:00 ET',            '2027-01-01'),
  ('et_date late evening ET (UTC next day)', '2026-11-05'),
  ('month_start Nov (EDT, 00:00 Nov 1)', '2026-11-01T04:00:00Z'),
  ('next_month_start Nov (EST)',       '2026-12-01T05:00:00Z'),
  ('Nov 2026 hours',                   '721'),
  ('month_start Mar (EST)',            '2026-03-01T05:00:00Z'),
  ('next_month_start Mar (EDT)',       '2026-04-01T04:00:00Z'),
  ('Mar 2026 hours',                   '743'),
  ('month_start Dec',                  '2026-12-01T05:00:00Z'),
  ('next_month_start Dec crosses year', '2027-01-01T05:00:00Z'),
  ('month_start any day = first day',  '2026-11-01T04:00:00Z'),
  ('ytd_start mid-year',               '2026-01-01T05:00:00Z'),
  ('ytd_start on Jan 1',               '2027-01-01T05:00:00Z'),
  ('week Fri 23:59:59 ET start',       '2026-10-31T04:00:00Z'),
  ('week Fri 23:59:59 ET end',         '2026-11-07T05:00:00Z'),
  ('week Sat 00:00 ET start',          '2026-11-07T05:00:00Z'),
  ('week Sat 00:00 ET end',            '2026-11-14T05:00:00Z'),
  ('week Sun start',                   '2026-11-07T05:00:00Z'),
  ('week Nov (DST end) hours',         '169'),
  ('week Mar (DST start) start',       '2026-03-07T05:00:00Z'),
  ('week Mar (DST start) end',         '2026-03-14T04:00:00Z'),
  ('week Mar (DST start) hours',       '167'),
  ('week year boundary start',         '2026-12-26T05:00:00Z'),
  ('week year boundary end',           '2027-01-02T05:00:00Z'),
  ('month_range start',                '2026-11-01T04:00:00Z'),
  ('month_range end',                  '2026-12-01T05:00:00Z'),
  ('ytd_range start',                  '2026-01-01T05:00:00Z'),
  ('ytd_range end',                    '2026-12-01T05:00:00Z'),
  ('mtd_range start',                  '2026-11-01T04:00:00Z'),
  ('mtd_range end = p_ts',         '2026-11-05T15:00:00Z'),
  ('mtd_range end (Nov 1 ET, DST day)', '2026-11-01T12:00:00Z');

create function pg_temp.run_all(p_tz text) returns void language plpgsql as $f$
begin
  perform set_config('timezone', p_tz, true);
  insert into got
  select p_tz, l, g from (values
    ('et_date Dec31 23:59:59 ET',        fin.et_date('2027-01-01T04:59:59Z')::text),
    ('et_date Jan1 00:00 ET',            fin.et_date('2027-01-01T05:00:00Z')::text),
    ('et_date late evening ET (UTC next day)', fin.et_date('2026-11-06T03:30:00Z')::text),
    ('month_start Nov (EDT, 00:00 Nov 1)', pg_temp.z(fin.month_start('2026-11-15'))),
    ('next_month_start Nov (EST)',       pg_temp.z(fin.next_month_start('2026-11-15'))),
    ('Nov 2026 hours',                   (extract(epoch from fin.next_month_start('2026-11-15') - fin.month_start('2026-11-15')) / 3600)::int::text),
    ('month_start Mar (EST)',            pg_temp.z(fin.month_start('2026-03-31'))),
    ('next_month_start Mar (EDT)',       pg_temp.z(fin.next_month_start('2026-03-31'))),
    ('Mar 2026 hours',                   (extract(epoch from fin.next_month_start('2026-03-08') - fin.month_start('2026-03-08')) / 3600)::int::text),
    ('month_start Dec',                  pg_temp.z(fin.month_start('2026-12-31'))),
    ('next_month_start Dec crosses year', pg_temp.z(fin.next_month_start('2026-12-31'))),
    ('month_start any day = first day',  pg_temp.z(fin.month_start('2026-11-30'))),
    ('ytd_start mid-year',               pg_temp.z(fin.ytd_start('2026-06-10'))),
    ('ytd_start on Jan 1',               pg_temp.z(fin.ytd_start('2027-01-01'))),
    ('week Fri 23:59:59 ET start',       pg_temp.z((select week_start from fin.business_week('2026-11-07T04:59:59Z')))),
    ('week Fri 23:59:59 ET end',         pg_temp.z((select week_end from fin.business_week('2026-11-07T04:59:59Z')))),
    ('week Sat 00:00 ET start',          pg_temp.z((select week_start from fin.business_week('2026-11-07T05:00:00Z')))),
    ('week Sat 00:00 ET end',            pg_temp.z((select week_end from fin.business_week('2026-11-07T05:00:00Z')))),
    ('week Sun start',                   pg_temp.z((select week_start from fin.business_week('2026-11-08T17:00:00Z')))),
    ('week Nov (DST end) hours',         (select (extract(epoch from week_end - week_start) / 3600)::int::text from fin.business_week('2026-11-03T15:00:00Z'))),
    ('week Mar (DST start) start',       pg_temp.z((select week_start from fin.business_week('2026-03-08T12:00:00Z')))),
    ('week Mar (DST start) end',         pg_temp.z((select week_end from fin.business_week('2026-03-08T12:00:00Z')))),
    ('week Mar (DST start) hours',       (select (extract(epoch from week_end - week_start) / 3600)::int::text from fin.business_week('2026-03-08T12:00:00Z'))),
    ('week year boundary start',         pg_temp.z((select week_start from fin.business_week('2026-12-31T15:00:00Z')))),
    ('week year boundary end',           pg_temp.z((select week_end from fin.business_week('2026-12-31T15:00:00Z')))),
    ('month_range start',                pg_temp.z((select period_start from fin.month_range('2026-11-20')))),
    ('month_range end',                  pg_temp.z((select period_end from fin.month_range('2026-11-20')))),
    ('ytd_range start',                  pg_temp.z((select period_start from fin.ytd_range('2026-11-15')))),
    ('ytd_range end',                    pg_temp.z((select period_end from fin.ytd_range('2026-11-15')))),
    ('mtd_range start',                  pg_temp.z((select period_start from fin.mtd_range('2026-11-05T15:00:00Z')))),
    ('mtd_range end = p_ts',         pg_temp.z((select period_end from fin.mtd_range('2026-11-05T15:00:00Z')))),
    ('mtd_range end (Nov 1 ET, DST day)', pg_temp.z((select period_end from fin.mtd_range('2026-11-01T12:00:00Z'))))
  ) v(l, g);
end $f$;

select pg_temp.run_all('UTC');
select pg_temp.run_all('Asia/Tokyo');
select pg_temp.run_all('Asia/Kolkata');
select pg_temp.run_all('America/Los_Angeles');

select is((select count(*)::int from want), 32, 'expected-value table has 32 cases');
select is(array(select tz::text || '=' || count(*) from got group by tz order by tz), array['America/Los_Angeles=32', 'Asia/Kolkata=32', 'Asia/Tokyo=32', 'UTC=32'], 'every case ran under every session timezone');

select is(
  array(select format('%s: %s <> %s', g.label, g.got, w.want) from got g join want w using (label) where g.tz = 'UTC' and g.got is distinct from w.want order by 1),
  '{}'::text[], 'UTC session: every case matches the expected ET result');
select is(
  array(select format('%s: %s <> %s', g.label, g.got, w.want) from got g join want w using (label) where g.tz = 'Asia/Tokyo' and g.got is distinct from w.want order by 1),
  '{}'::text[], 'Asia/Tokyo session: every case matches');
select is(
  array(select format('%s: %s <> %s', g.label, g.got, w.want) from got g join want w using (label) where g.tz = 'Asia/Kolkata' and g.got is distinct from w.want order by 1),
  '{}'::text[], 'Asia/Kolkata session: every case matches');
select is(
  array(select format('%s: %s <> %s', g.label, g.got, w.want) from got g join want w using (label) where g.tz = 'America/Los_Angeles' and g.got is distinct from w.want order by 1),
  '{}'::text[], 'America/Los_Angeles session: every case matches');
select is(
  array(select a.label from got a join got b on a.label = b.label and a.tz = 'UTC' and b.tz <> 'UTC' and a.got is distinct from b.got),
  '{}'::text[], 'results are identical across all session timezones');

-- Business-week structure over a full year of hourly-ish probes: always Saturday 00:00 ET, 7 local days, contains the probe.
select is(
  (select count(*)::int from generate_series('2026-01-01T00:00:00Z'::timestamptz, '2027-01-10T00:00:00Z', interval '97 minutes') t,
          lateral fin.business_week(t) w
   where not (w.week_start <= t and t < w.week_end
              and extract(dow from w.week_start at time zone 'America/New_York') = 6
              and (w.week_start at time zone 'America/New_York')::time = '00:00'
              and (w.week_end at time zone 'America/New_York') = (w.week_start at time zone 'America/New_York') + interval '7 days')),
  0, 'business_week always spans Sat 00:00 ET to the next Sat 00:00 ET and contains the probe (97-minute sweep of 2026)');
-- Boundary: the instant before Saturday 00:00 ET is the prior week; the instant itself starts a new week.
select isnt(
  (select week_start from fin.business_week('2026-11-07T04:59:59.999999Z')),
  (select week_start from fin.business_week('2026-11-07T05:00:00Z')),
  'one microsecond before Saturday 00:00 ET is a different week');

-- Function properties.
select is(
  array(select p.proname::text from pg_proc p where p.pronamespace = 'fin'::regnamespace
        and p.proname in ('et_date', 'month_start', 'next_month_start', 'ytd_start', 'business_week', 'month_range', 'ytd_range', 'mtd_range')
        and (p.provolatile <> 'i' or p.prosecdef or not coalesce(p.proconfig, '{}') @> array['search_path=""']) order by 1),
  '{}'::text[], 'calendar functions are immutable, invoker rights, with an empty search_path');
select is(
  (select count(*)::int from pg_proc p where p.pronamespace = 'fin'::regnamespace
   and p.proname in ('et_date', 'month_start', 'next_month_start', 'ytd_start', 'business_week', 'month_range', 'ytd_range', 'mtd_range')),
  8, 'all eight calendar functions exist');
select is(
  array(select p.proname::text from pg_proc p where p.pronamespace = 'fin'::regnamespace
        and p.proname in ('et_date', 'month_start', 'next_month_start', 'ytd_start', 'business_week', 'month_range', 'ytd_range', 'mtd_range')
        and (has_function_privilege('anon', p.oid, 'execute') or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0)) order by 1),
  '{}'::text[], 'anon and PUBLIC cannot execute the calendar functions') ;
select is(
  array(select p.proname::text from pg_proc p where p.pronamespace = 'fin'::regnamespace
        and p.proname in ('et_date', 'month_start', 'next_month_start', 'ytd_start', 'business_week', 'month_range', 'ytd_range', 'mtd_range')
        and not (has_function_privilege('authenticated', p.oid, 'execute') and has_function_privilege('service_role', p.oid, 'execute')) order by 1),
  '{}'::text[], 'authenticated and service_role can execute the calendar functions');

select * from finish();
rollback;
