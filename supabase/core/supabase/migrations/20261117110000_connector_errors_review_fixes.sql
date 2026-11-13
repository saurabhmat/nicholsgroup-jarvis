-- T-196 review fixes.
-- 1. core.briefing_coverage: the stream-freshness fallback reads only job = 'sync' runs (reports and normalizer runs, new in
--    20261117100000, are not syncs and must not make a mail/calendar stream look fresh). Body otherwise unchanged from
--    20261111100000. No other reader of core.sync_runs needed a filter (the normalizer's full-reload cutoff reads kind = 'full',
--    which only a sync can be: sync_runs_job_kind_check).
-- 2. core.connector_api_errors_purge: any existing lane, including a disabled one (deleting expired rows is always safe).
-- Safe to re-run: create or replace only.

create or replace function core.briefing_coverage(p_lane text)
returns table (
  stream text,
  account text,
  connection_id uuid,
  provider text,
  status text,
  configured boolean,
  last_sync_at timestamptz,
  error_kind text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_mail boolean;
  v_cal boolean;
  v_boxes text[];
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  if pg_catalog.current_setting('role', true) = 'service_role' then
    v_mail := true;
    v_cal := true;
  else
    if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' or v_uid is null then
      return;
    end if;
    v_mail := p_lane = any (core.allowed_lanes(v_uid, 'comms'));
    v_cal := p_lane = any (core.allowed_lanes(v_uid, 'calendar'));
  end if;
  if not exists (select 1 from core.lanes l where l.code = p_lane and l.enabled) then
    return;
  end if;
  if not (v_mail or v_cal) then
    return;
  end if;

  select coalesce(array_agg(distinct lower(b.value)), '{}')
    into v_boxes
  from core.lane_config_current c,
       pg_catalog.jsonb_array_elements_text(case when pg_catalog.jsonb_typeof(c.config -> 'mailboxes') = 'array' then c.config -> 'mailboxes' else '[]'::jsonb end) b(value)
  where c.lane_id = p_lane;

  return query
  with accounts as (
    -- configured mailboxes, plus any live mail/calendar connection of the lane (one row per address)
    select lower(b) as account from pg_catalog.unnest(v_boxes) b
    union
    select lower(c.external_account_id) from core.connections c
    where c.lane_id = p_lane and c.provider in ('google', 'microsoft') and c.status <> 'disconnected'
  ),
  conn as (
    select distinct on (lower(c.external_account_id))
      lower(c.external_account_id) as account, c.id, c.provider, c.status, c.last_sync_at, c.last_error
    from core.connections c
    where c.lane_id = p_lane and c.provider in ('google', 'microsoft') and c.status <> 'disconnected'
    order by lower(c.external_account_id), (c.status = 'active') desc, c.updated_at desc
  ),
  streams as (
    select 'mail'::text as stream where v_mail
    union all
    select 'calendar'::text where v_cal
  )
  select
    s.stream,
    a.account,
    k.id,
    k.provider,
    coalesce(k.status, 'not_connected'),
    a.account = any (v_boxes),
    -- The stream's own cursor time; the connection's last succeeded run only while the stream has no cursor yet
    -- (sync_runs has no stream column, so a calendar-only success must not make mail look fresh).
    case when k.id is null then null else coalesce(
      (select max(sc.updated_at) from core.sync_cursors sc where sc.connection_id = k.id and sc.lane_id = p_lane and sc.stream = s.stream),
      (select max(r.finished_at) from core.sync_runs r where r.connection_id = k.id and r.lane_id = p_lane and r.status = 'succeeded' and r.job = 'sync')
    ) end,
    case
      when k.last_error is null then null
      when (k.last_error ->> 'kind') ~ '^[a-z][a-z_]{0,40}$' then k.last_error ->> 'kind'
      else 'unknown'
    end
  from accounts a
  cross join streams s
  left join conn k on k.account = a.account
  order by s.stream desc, a.account;
  -- Access but nothing configured or connected: one row per visible stream says so (never "no rows" = "no access").
  if not found then
    return query
    select x.stream, null::text, null::uuid, null::text, 'not_configured'::text, false, null::timestamptz, null::text
    from (select 'mail'::text as stream where v_mail union all select 'calendar'::text where v_cal) x
    order by x.stream desc;
  end if;
end;
$$;
comment on function core.briefing_coverage(text) is
  'Home briefing (T-231a): coverage per (stream, account): configured mailboxes and connected accounts, status, last sync, connector error kind only. Definer only to read connection health; answers per stream to callers holding the comms (mail) or calendar view at AAL2.';
revoke all on function core.briefing_coverage(text) from public, anon;
grant execute on function core.briefing_coverage(text) to authenticated, service_role;

comment on function core.briefing_coverage(text) is
  'Home briefing (T-231a): coverage per (stream, account): configured mailboxes and connected accounts, status, last sync, connector error kind only. Definer only to read connection health; answers per stream to callers holding the comms (mail) or calendar view at AAL2.';
revoke all on function core.briefing_coverage(text) from public, anon;
grant execute on function core.briefing_coverage(text) to authenticated, service_role;

create or replace function core.connector_api_errors_purge(p_lane text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_lane is null or not exists (select 1 from core.lanes l where l.code = p_lane) then
    raise exception 'lane does not exist' using errcode = '42501';
  end if;
  delete from core.connector_api_errors e where e.lane_id = p_lane and e.at < pg_catalog.now() - interval '90 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
comment on function core.connector_api_errors_purge(text) is 'Retention (T-196, called by the T-042 purge job): deletes a lane''s connector API errors older than 90 days. Any existing lane (deleting is always safe).';
revoke all on function core.connector_api_errors_purge(text) from public, anon, authenticated;
grant execute on function core.connector_api_errors_purge(text) to service_role;
