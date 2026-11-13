-- T-238 review fix (code review H1): mail and calendar now sync on separate ticks, but a connection kept ONE last_error. A calendar
-- failure therefore showed on the mail row (and the reverse), and the other stream's next success erased the real error.
-- 1. core.connections.last_error_stream: which stream the stored last_error belongs to ('mail' | 'calendar'); null = the whole
--    connection (a run of both streams, or a non-Google provider). The sync job sets it with last_error; a one-stream success
--    clears last_error only when it belongs to that stream (or to the whole connection).
-- 2. core.briefing_coverage: a row shows error_kind only when the error belongs to its stream (or to the whole connection).
--    Body otherwise unchanged from 20261117110000.
-- 3. A connection leaving active/degraded drops its core.job_failures rows (see below).
-- Safe to re-run.

alter table core.connections add column if not exists last_error_stream text;
alter table core.connections drop constraint if exists connections_last_error_stream_check;
alter table core.connections add constraint connections_last_error_stream_check
  check (last_error_stream is null or last_error_stream in ('mail', 'calendar'));
comment on column core.connections.last_error_stream is
  'T-238: the stream last_error belongs to (mail | calendar); null = the whole connection. Cleared with last_error (trigger).';

-- Every writer that clears last_error (sync success, reconnect, token health) also clears the tag, so a tag never outlives its error.
create or replace function core.connections_clear_error_stream() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.last_error is null then
    new.last_error_stream := null;
  end if;
  return new;
end;
$$;
revoke all on function core.connections_clear_error_stream() from public, anon, authenticated, service_role;
drop trigger if exists connections_clear_error_stream on core.connections;
create trigger connections_clear_error_stream before insert or update of last_error, last_error_stream on core.connections
  for each row execute function core.connections_clear_error_stream();

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
      lower(c.external_account_id) as account, c.id, c.provider, c.status, c.last_sync_at, c.last_error, c.last_error_stream
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
      -- T-238: an error of the other stream is not this row's error
      when k.last_error_stream is not null and k.last_error_stream <> s.stream then null
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

-- 3. (code review M1) A connection that stops being synced (disconnected, reconnect_required, ...) is never scheduled again, so no
--    success would ever reset its failure streak and the "failed 3 times in a row" banner would stay forever. Leaving the syncable
--    states deletes that connection's core.job_failures rows; a reconnect starts a fresh count. Definer: API roles have no write
--    grant on core.job_failures.
create or replace function core.connections_clear_job_failures() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status not in ('active', 'degraded') and old.status in ('active', 'degraded') then
    delete from core.job_failures f where f.lane_id = new.lane_id and f.connection_id = new.id::text;
  end if;
  return new;
end;
$$;
revoke all on function core.connections_clear_job_failures() from public, anon, authenticated, service_role;
drop trigger if exists connections_clear_job_failures on core.connections;
create trigger connections_clear_job_failures after update of status on core.connections
  for each row execute function core.connections_clear_job_failures();
