-- Home v1 reads (T-200). Two read-only functions in `core` (the schema the API exposes) so Home can show today's meetings
-- and an attention count without exposing the `cal` and `comms` schemas. Both are SECURITY INVOKER: they run as the
-- signed-in user, so the existing RLS on cal.event_index, comms.message_index and core.lane_config applies unchanged
-- (AAL2 + lane membership for the module's view). A caller who may not see a lane gets no rows / zero counts.
-- No table is added (no new RLS surface); cross-lane, outsider, anon and AAL1 denial are tested in 230.

-- Today's meetings: events overlapping [p_from, p_to), cancelled ones left out, one row per event even when it sits on
-- two calendars (same iCal UID and start; the copy with links and a location is kept). Timed events overlap by instant;
-- all-day events by DATE against the business calendar (America/New_York, rule 11): the sync stores an all-day event's
-- instants as midnight in its own calendar's zone, so an instant test would show a UTC or Los Angeles calendar's
-- tomorrow as today. Window capped at 7 days, at most 50 rows. Only the columns Home shows.
create function core.home_meetings(p_lane text, p_from timestamptz, p_to timestamptz)
returns table (
  title text,
  start_at timestamptz,
  end_at timestamptz,
  all_day boolean,
  start_date date,
  location text,
  source_url text,
  online_meeting_url text
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
  if p_to <= p_from or p_to - p_from > interval '7 days' then
    raise exception 'window must be positive and at most 7 days' using errcode = '22023';
  end if;
  -- New York dates the window touches: [v_from_date, v_to_date) (p_to itself is excluded).
  v_from_date := (p_from at time zone 'America/New_York')::date;
  v_to_date := ((p_to - interval '1 microsecond') at time zone 'America/New_York')::date + 1;
  return query
  select d.title, d.start_at, d.end_at, d.all_day, d.start_date, d.location, d.source_url, d.online_meeting_url
  from (
    select distinct on (coalesce(e.ical_uid, e.calendar_id || ':' || e.event_id), e.start_at)
      e.title, e.start_at, e.end_at, e.all_day, e.start_date, e.location, e.source_url, e.online_meeting_url
    from cal.event_index e
    where e.lane_id = p_lane
      and e.status is distinct from 'cancelled'
      and (
        (not e.all_day and e.start_at < p_to and e.end_at > p_from)
        or (e.all_day and e.start_date < v_to_date and e.end_date > v_from_date)
      )
    order by coalesce(e.ical_uid, e.calendar_id || ':' || e.event_id), e.start_at,
      (e.title is null), (e.online_meeting_url is null), (e.source_url is null), (e.location is null), e.calendar_id
  ) d
  order by d.all_day desc, d.start_at, d.title
  limit 50;
end;
$$;
comment on function core.home_meetings(text, timestamptz, timestamptz) is
  'Home v1 (T-200): the lane''s events overlapping a window of at most 7 days, cancelled excluded, de-duplicated across calendars. Invoker: RLS on cal.event_index applies.';
revoke all on function core.home_meetings(text, timestamptz, timestamptz) from public, anon;
grant execute on function core.home_meetings(text, timestamptz, timestamptz) to authenticated, service_role;

-- Attention counts for Home: unread inbox mail since p_since that Gmail marks important, and unread inbox mail from the
-- lane's priority senders (lane_config.priority_senders: addresses or '@domain'). Counts only: no subject, sender or body
-- leaves this function. `priority_configured` is false when the lane has no priority senders or the caller may not read
-- the lane config. p_since at most 7 days back.
create function core.home_mail_attention(p_lane text, p_since timestamptz)
returns table (unread_important integer, unread_priority integer, priority_configured boolean)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_senders text[];
begin
  if p_lane is null or p_since is null then
    raise exception 'lane and since are required' using errcode = '22004';
  end if;
  if p_since < now() - interval '7 days' then
    raise exception 'since must be within the last 7 days' using errcode = '22023';
  end if;
  select coalesce(array_agg(lower(s.value)), '{}')
    into v_senders
  from core.lane_config_current c,
       jsonb_array_elements_text(case when jsonb_typeof(c.config -> 'priority_senders') = 'array' then c.config -> 'priority_senders' else '[]'::jsonb end) s(value)
  where c.lane_id = p_lane;

  return query
  select
    count(*) filter (where m.is_important)::integer,
    count(*) filter (where cardinality(v_senders) > 0 and (
      lower(m.from_address) = any (v_senders)
      or ('@' || split_part(lower(m.from_address), '@', 2)) = any (v_senders)
    ))::integer,
    cardinality(v_senders) > 0
  from comms.message_index m
  where m.lane_id = p_lane
    and not m.deleted
    and not m.is_read
    and m.folder = 'INBOX'
    and m.received_at >= p_since;
end;
$$;
comment on function core.home_mail_attention(text, timestamptz) is
  'Home v1 (T-200): counts of unread inbox mail (important; from priority senders) since a time at most 7 days back. Counts only. Invoker: RLS on comms.message_index and core.lane_config applies.';
revoke all on function core.home_mail_attention(text, timestamptz) from public, anon;
grant execute on function core.home_mail_attention(text, timestamptz) to authenticated, service_role;

-- Whether Home may show a calendar for this caller and lane: 'no_access' (not AAL2, or no calendar view on the lane),
-- 'not_connected' (allowed, but no calendar-capable connection), 'connected'. SECURITY DEFINER only to look at
-- core.connections, which needs the separate `connections` view; it answers only for a caller who already holds the
-- calendar view on that lane, and returns nothing else about the connection.
create function core.home_calendar_status(p_lane text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' or not (p_lane = any (core.allowed_lanes(auth.uid(), 'calendar'))) then
    return 'no_access';
  end if;
  if exists (
    select 1 from core.connections c
    where c.lane_id = p_lane and c.provider in ('google', 'microsoft') and c.status <> 'disconnected'
  ) then
    return 'connected';
  end if;
  return 'not_connected';
end;
$$;
comment on function core.home_calendar_status(text) is
  'Home v1 (T-200): no_access | not_connected | connected for the caller''s calendar view on a lane. Definer only to read core.connections; answers only callers with the calendar view at AAL2.';
revoke all on function core.home_calendar_status(text) from public, anon;
grant execute on function core.home_calendar_status(text) to authenticated, service_role;
