-- T-274: the Calendar page's reader. core.calendar_events(p_lane, p_from, p_to) returns the CALLER's own events of one lane (Google and Microsoft
-- calendars together) overlapping a window of at most 43 days (a six-week month grid), cancelled events left out, the same meeting on several of the
-- caller's calendars returned once (same key and tie-break as core.briefing_events), with the winning copy's connection and provider and the ids of
-- every one of the caller's connections that holds a copy. No description and no attendee list is returned (the attendee count is used only to pick between copies; rule 6).
-- Security invoker: RLS on cal.event_index applies (AAL2, own_mail, own connections); the own-mailbox filter is stated again, as the other readers do.
-- At most 501 rows come back (the page shows 500; a 501st row is the signal "more events than shown"), below the API's max rows.
-- Tests: 327_calendar_events.test.sql.
create function core.calendar_events(p_lane text, p_from timestamptz, p_to timestamptz)
returns table (
  connection_id uuid,
  provider text,
  connection_ids uuid[],
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
  v_ids uuid[];
begin
  if p_lane is null or p_from is null or p_to is null then
    raise exception 'lane and window are required' using errcode = '22004';
  end if;
  if p_to <= p_from or p_to - p_from > interval '43 days' then
    raise exception 'window must be positive and at most 43 days' using errcode = '22023';
  end if;
  v_ids := core.mailbox_ids((select auth.uid()), p_lane);
  v_from_date := (p_from at time zone 'America/New_York')::date;
  v_to_date := ((p_to - interval '1 microsecond') at time zone 'America/New_York')::date + 1;
  return query
  select d.connection_id, d.provider, d.connection_ids, d.calendar_id, d.event_id, d.title, d.start_at, d.end_at, d.all_day, d.start_date, d.end_date,
         d.timezone, d.location, d.source_url, d.online_meeting_url, d.organizer_email, d.organizer_name, d.status
  from (
    select distinct on (m.dedup_key, m.start_at)
      m.connection_id, m.provider, g.connection_ids, m.calendar_id, m.event_id, m.title, m.start_at, m.end_at, m.all_day, m.start_date, m.end_date,
      m.timezone, m.location, m.source_url, m.online_meeting_url, m.organizer_email, m.organizer_name, m.status
    from (
      select e.connection_id, e.provider, e.calendar_id, e.event_id, e.title, e.start_at, e.end_at, e.all_day, e.start_date, e.end_date,
             e.timezone, e.location, e.source_url, e.online_meeting_url, e.organizer_email, e.organizer_name, e.status,
             coalesce(e.ical_uid, e.calendar_id || ':' || e.event_id) as dedup_key,
             (pg_catalog.jsonb_array_length(e.attendees) = 0) as no_attendees
      from cal.event_index e
      where e.lane_id = p_lane
        and e.connection_id = any (v_ids)
        and e.status is distinct from 'cancelled'
        and (
          (not e.all_day and e.start_at < p_to and e.end_at > p_from)
          or (e.all_day and e.start_date < v_to_date and e.end_date > v_from_date)
        )
    ) m
    join (
      -- every one of the caller's connections holding a copy: sorted, without duplicates
      select x.dedup_key, x.start_at, pg_catalog.array_agg(distinct x.connection_id order by x.connection_id) as connection_ids
      from (
        select coalesce(e.ical_uid, e.calendar_id || ':' || e.event_id) as dedup_key, e.start_at, e.connection_id
        from cal.event_index e
        where e.lane_id = p_lane
          and e.connection_id = any (v_ids)
          and e.status is distinct from 'cancelled'
          and (
            (not e.all_day and e.start_at < p_to and e.end_at > p_from)
            or (e.all_day and e.start_date < v_to_date and e.end_date > v_from_date)
          )
      ) x
      group by x.dedup_key, x.start_at
    ) g on g.dedup_key = m.dedup_key and g.start_at is not distinct from m.start_at
    order by m.dedup_key, m.start_at,
      (m.title is null), (m.online_meeting_url is null), (m.source_url is null), m.no_attendees, m.calendar_id, m.connection_id
  ) d
  order by d.all_day desc, d.start_at, d.title
  limit 501;
end;
$$;
comment on function core.calendar_events(text, timestamptz, timestamptz) is
  'Calendar page (T-274): the caller''s own events of a lane overlapping a window of at most 43 days, cancelled excluded, one row per meeting across the caller''s calendars (winning copy plus every connection id), returns no attendee list and no description (the attendee count is used only to pick between copies). At most 501 rows (the 501st means "more than shown"). Invoker: RLS applies; the own-mailbox filter is explicit.';
revoke all on function core.calendar_events(text, timestamptz, timestamptz) from public, anon, service_role;
grant execute on function core.calendar_events(text, timestamptz, timestamptz) to authenticated;
