-- Home briefing reads, part 1 (T-231a): the Coverage strip and the calendar section of the daily briefing.
-- No table is added. Two read-only functions in `core` (the schema the API exposes), like the Home v1 reads (T-200):
--
-- core.briefing_coverage(p_lane): one row per (account, stream) the briefing covers: each mailbox the lane configures
--   (lane_config.mailboxes) and each Google/Microsoft account connected to the lane, for the 'mail' stream (caller holds
--   the comms view) and the 'calendar' stream (caller holds the calendar view). For each: the connection's status
--   ('not_connected' when a configured mailbox has no live connection), when that stream last synced (the stream's
--   cursor time or the connection's last succeeded run, whichever is later), and the connector error KIND only (never
--   provider text). SECURITY DEFINER only to read core.connections / core.sync_cursors / core.sync_runs, which need the
--   connections/health views (a deliberate, narrow widening: comms/calendar holders see which accounts feed the briefing,
--   their status, error kind and sync time, never tokens or provider text; plan-review T-231); it answers only for a caller who already holds the comms or calendar view on the lane at
--   AAL2, per stream, and returns nothing else about the connection (no tokens, no error messages).
--   Missing access is never "nothing": a stream the caller may see always appears, as not_connected if need be, and as
--   one 'not_configured' row (account null) when the lane has no mailbox and no connection at all.
--
-- core.briefing_events(p_lane, p_from, p_to): the lane's events overlapping a window of at most 8 days (today plus the
--   7-day look-ahead), cancelled excluded, de-duplicated across calendars like core.home_meetings, with the columns the
--   briefing needs: attendees (addresses, names, response), organizer, the event's own time zone and the connection it
--   came from (to find the owner's own RSVP). SECURITY INVOKER: RLS on cal.event_index applies (AAL2 + calendar view).
-- Tests: 280_briefing_coverage_and_events.test.sql (incl. cross-lane, outsider, AAL1 and no-view denial).

create function core.briefing_coverage(p_lane text)
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
      (select max(r.finished_at) from core.sync_runs r where r.connection_id = k.id and r.lane_id = p_lane and r.status = 'succeeded')
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

create function core.briefing_events(p_lane text, p_from timestamptz, p_to timestamptz)
returns table (
  connection_id uuid,
  calendar_id text,
  event_id text,
  title text,
  start_at timestamptz,
  end_at timestamptz,
  all_day boolean,
  start_date date,
  end_date date,
  timezone text,
  location text,
  source_url text,
  online_meeting_url text,
  organizer_email text,
  organizer_name text,
  attendees jsonb,
  status text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_from_date date;
  v_to_date date;
begin
  if p_lane is null or p_from is null or p_to is null then
    raise exception 'lane and window are required' using errcode = '22004';
  end if;
  if p_to <= p_from or p_to - p_from > interval '8 days' then
    raise exception 'window must be positive and at most 8 days' using errcode = '22023';
  end if;
  v_from_date := (p_from at time zone 'America/New_York')::date;
  v_to_date := ((p_to - interval '1 microsecond') at time zone 'America/New_York')::date + 1;
  return query
  select d.connection_id, d.calendar_id, d.event_id, d.title, d.start_at, d.end_at, d.all_day, d.start_date, d.end_date,
         d.timezone, d.location, d.source_url, d.online_meeting_url, d.organizer_email, d.organizer_name, d.attendees, d.status
  from (
    select distinct on (coalesce(e.ical_uid, e.calendar_id || ':' || e.event_id), e.start_at)
      e.connection_id, e.calendar_id, e.event_id, e.title, e.start_at, e.end_at, e.all_day, e.start_date, e.end_date,
      e.timezone, e.location, e.source_url, e.online_meeting_url, e.organizer_email, e.organizer_name, e.attendees, e.status
    from cal.event_index e
    where e.lane_id = p_lane
      and e.status is distinct from 'cancelled'
      and (
        (not e.all_day and e.start_at < p_to and e.end_at > p_from)
        or (e.all_day and e.start_date < v_to_date and e.end_date > v_from_date)
      )
    order by coalesce(e.ical_uid, e.calendar_id || ':' || e.event_id), e.start_at,
      (e.title is null), (e.online_meeting_url is null), (e.source_url is null), (pg_catalog.jsonb_array_length(e.attendees) = 0), e.calendar_id
  ) d
  order by d.all_day desc, d.start_at, d.title
  limit 200;
end;
$$;
comment on function core.briefing_events(text, timestamptz, timestamptz) is
  'Home briefing (T-231a): the lane''s events overlapping a window of at most 8 days, cancelled excluded, de-duplicated across calendars, with attendees, organizer and the event zone. Invoker: RLS on cal.event_index applies.';
revoke all on function core.briefing_events(text, timestamptz, timestamptz) from public, anon;
grant execute on function core.briefing_events(text, timestamptz, timestamptz) to authenticated, service_role;
