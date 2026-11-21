-- T-253: provider-generic calendar page writer (docs/specs/microsoft.md 6.3). New latest definition of core.cal_events_apply_page (same
-- signature, grants, definer and search_path as 20261105140000, the only earlier definition); the diff against that body is the provider condition only:
--   * a usable connection of provider 'google' or 'microsoft' in an enabled lane (42501 otherwise); rows are inserted with the connection's own provider;
--   * the new cursor must start with g1.<connection id>.c: (google) or m1.<connection id>.c: (microsoft) and be at most 16384 characters, else 22023.
-- Reader inventory (T-253, docs/plan-review.md "T-253: review results"): every other function and view whose latest body names 'google' was already
-- generalised by T-247/T-252/T-254 or is Google-only on purpose (Composio D-23 duplicate checks), so this is the only body replaced.
-- create or replace keeps the existing grants (service_role only); they are restated below. Tests: 322_calendar_page_writer.test.sql.

create or replace function core.cal_events_apply_page(
  p_lane text,
  p_connection_id uuid,
  p_removals jsonb,
  p_upserts jsonb,
  p_expected_cursor text,
  p_cursor text,
  p_complete boolean default false,
  p_drop_calendars text[] default '{}'
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_removed integer := 0;
  v_written integer := 0;
  v_incoming integer := 0;
  v_current text;
  v_dropped integer := 0;
  v_provider text;
  v_prefix text;
begin
  if p_lane is null or p_connection_id is null or p_removals is null or p_upserts is null then
    raise exception 'lane, connection, removals and upserts are required' using errcode = '22004';
  end if;
  if pg_catalog.jsonb_typeof(p_removals) <> 'array' or pg_catalog.jsonb_typeof(p_upserts) <> 'array'
     or pg_catalog.jsonb_array_length(p_removals) > 1000 or pg_catalog.jsonb_array_length(p_upserts) > 1000 then
    raise exception 'removals and upserts must be arrays of at most 1000 entries' using errcode = '22023';
  end if;
  select c.provider into v_provider
  from core.connections c
  join core.lanes l on l.code = c.lane_id and l.enabled
  where c.id = p_connection_id and c.lane_id = p_lane and c.provider in ('google', 'microsoft')
    and c.status in ('active', 'degraded');
  if v_provider is null then
    raise exception 'usable Google or Microsoft connection not found in this lane' using errcode = '42501';
  end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_removals) e
             where pg_catalog.jsonb_typeof(e) <> 'object'
                or pg_catalog.jsonb_typeof(e -> 'calendar_id') is distinct from 'string'
                or pg_catalog.jsonb_typeof(e -> 'event_id') is distinct from 'string'
                or pg_catalog.length(e ->> 'calendar_id') not between 1 and 512
                or pg_catalog.length(e ->> 'event_id') not between 1 and 512) then
    raise exception 'removals must be objects with a calendar_id and an event_id' using errcode = '22023';
  end if;
  v_prefix := case v_provider when 'google' then 'g1.' else 'm1.' end || p_connection_id::text || '.c:';
  if p_cursor is not null and (pg_catalog.length(p_cursor) > 16384
     or pg_catalog.left(p_cursor, pg_catalog.length(v_prefix)) <> v_prefix) then
    raise exception 'the cursor must be this connection''s calendar cursor' using errcode = '22023';
  end if;
  if p_drop_calendars is null or pg_catalog.cardinality(p_drop_calendars) > 10
     or exists (select 1 from pg_catalog.unnest(p_drop_calendars) d where d is null or pg_catalog.length(d) not between 1 and 512) then
    raise exception 'drop list must be at most 10 calendar ids' using errcode = '22023';
  end if;
  -- Every element is validated here, so a bad record is a clear 22023 and not a cast failure deep in the insert.
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_upserts) e
             where pg_catalog.jsonb_typeof(e) <> 'object'
                or pg_catalog.jsonb_typeof(e -> 'calendar_id') is distinct from 'string'
                or pg_catalog.jsonb_typeof(e -> 'event_id') is distinct from 'string'
                or pg_catalog.length(e ->> 'calendar_id') not between 1 and 512
                or pg_catalog.length(e ->> 'event_id') not between 1 and 512
                or pg_catalog.jsonb_typeof(e -> 'status') is distinct from 'string'
                or (e ->> 'status') not in ('confirmed', 'tentative', 'cancelled')
                or (e ? 'attendees' and pg_catalog.jsonb_typeof(e -> 'attendees') not in ('array', 'null'))) then
    raise exception 'each upsert needs a calendar_id, an event_id, a known status and array-typed attendees' using errcode = '22023';
  end if;

  -- One writer per connection's calendar stream at a time; the cursor check then makes a stale page an error.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_connection_id::text || ':calendar', 63));
  select s.cursor_value into v_current
  from core.sync_cursors s where s.connection_id = p_connection_id and s.lane_id = p_lane and s.stream = 'calendar';
  if v_current is distinct from p_expected_cursor then
    raise exception 'the stored cursor moved: another run applied a page first' using errcode = 'D0409';
  end if;

  -- Calendars that left the selection: this lane's rows of this connection only.
  delete from cal.event_index x
   where x.lane_id = p_lane and x.connection_id = p_connection_id and x.calendar_id = any (p_drop_calendars);
  get diagnostics v_dropped = row_count;

  -- Removals: the row stays (retention purges it) and reads as cancelled.
  update cal.event_index x
     set status = 'cancelled'
   where x.lane_id = p_lane and x.connection_id = p_connection_id and x.status <> 'cancelled'
     and (x.calendar_id, x.event_id) in (select e ->> 'calendar_id', e ->> 'event_id' from pg_catalog.jsonb_array_elements(p_removals) e);
  get diagnostics v_removed = row_count;

  select pg_catalog.count(*) into v_incoming from (select distinct e ->> 'calendar_id', e ->> 'event_id'
    from pg_catalog.jsonb_array_elements(p_upserts) e) d;
  with incoming as (
    select distinct on (r.calendar_id, r.event_id) r.*
    from pg_catalog.jsonb_array_elements(p_upserts) with ordinality as e(v, n),
         pg_catalog.jsonb_to_record(e.v)
           as r(calendar_id text, event_id text, ical_uid text, source_url text, title text, location text,
                organizer_email text, organizer_name text, start_at timestamptz, end_at timestamptz, all_day boolean,
                start_date date, end_date date, timezone text, attendees jsonb, status text, recurring_event_id text,
                original_start_at timestamptz, online_meeting_url text, source_updated_at timestamptz)
    order by r.calendar_id, r.event_id, e.n desc
  ), written as (
    insert into cal.event_index as t
      (lane_id, connection_id, provider, calendar_id, event_id, ical_uid, source_url, title, location, organizer_email,
       organizer_name, start_at, end_at, all_day, start_date, end_date, timezone, attendees, status, recurring_event_id,
       original_start_at, online_meeting_url, source_updated_at)
    select p_lane, p_connection_id, v_provider, i.calendar_id, i.event_id, i.ical_uid, i.source_url, i.title, i.location,
           i.organizer_email, i.organizer_name, i.start_at, i.end_at, coalesce(i.all_day, false), i.start_date, i.end_date,
           i.timezone, coalesce(i.attendees, '[]'::jsonb), i.status, i.recurring_event_id, i.original_start_at,
           i.online_meeting_url, i.source_updated_at
    from incoming i
    on conflict (lane_id, connection_id, calendar_id, event_id) do update set
      -- A cancelled stub changes status (and the version, when it has one) only; a normal event replaces everything.
      ical_uid = case when excluded.status = 'cancelled' then t.ical_uid else excluded.ical_uid end,
      source_url = case when excluded.status = 'cancelled' then t.source_url else excluded.source_url end,
      title = case when excluded.status = 'cancelled' then t.title else excluded.title end,
      location = case when excluded.status = 'cancelled' then t.location else excluded.location end,
      organizer_email = case when excluded.status = 'cancelled' then t.organizer_email else excluded.organizer_email end,
      organizer_name = case when excluded.status = 'cancelled' then t.organizer_name else excluded.organizer_name end,
      start_at = case when excluded.status = 'cancelled' then t.start_at else excluded.start_at end,
      end_at = case when excluded.status = 'cancelled' then t.end_at else excluded.end_at end,
      all_day = case when excluded.status = 'cancelled' then t.all_day else excluded.all_day end,
      start_date = case when excluded.status = 'cancelled' then t.start_date else excluded.start_date end,
      end_date = case when excluded.status = 'cancelled' then t.end_date else excluded.end_date end,
      timezone = case when excluded.status = 'cancelled' then t.timezone else excluded.timezone end,
      attendees = case when excluded.status = 'cancelled' then t.attendees else excluded.attendees end,
      recurring_event_id = case when excluded.status = 'cancelled' then t.recurring_event_id else excluded.recurring_event_id end,
      original_start_at = case when excluded.status = 'cancelled' then t.original_start_at else excluded.original_start_at end,
      online_meeting_url = case when excluded.status = 'cancelled' then t.online_meeting_url else excluded.online_meeting_url end,
      status = excluded.status,
      source_updated_at = case when excluded.status = 'cancelled'
                               then coalesce(excluded.source_updated_at, t.source_updated_at)
                               else excluded.source_updated_at end
    where case when excluded.status = 'cancelled'
               then excluded.source_updated_at is null or t.source_updated_at is null
                    or excluded.source_updated_at >= t.source_updated_at
               when t.status = 'cancelled'
               then excluded.source_updated_at is not null
                    and (t.source_updated_at is null or excluded.source_updated_at > t.source_updated_at)
               else t.source_updated_at is null
                    or (excluded.source_updated_at is not null and excluded.source_updated_at >= t.source_updated_at)
          end
    returning 1
  )
  select pg_catalog.count(*) into v_written from written;

  if p_cursor is not null then
    insert into core.sync_cursors (lane_id, connection_id, stream, cursor_value)
    values (p_lane, p_connection_id, 'calendar', p_cursor)
    on conflict (connection_id, stream) do update set cursor_value = excluded.cursor_value;
  end if;

  if p_complete then
    update core.connections set last_sync_at = pg_catalog.now() where id = p_connection_id and lane_id = p_lane;
  end if;

  return pg_catalog.jsonb_build_object('removed', v_removed, 'written', v_written, 'skipped', v_incoming - v_written);
end;
$$;
comment on function core.cal_events_apply_page(text, uuid, jsonb, jsonb, text, text, boolean, text[]) is
  'Applies one Google or Microsoft Calendar metadata page (chunk) atomically (T-064; T-253 provider-generic): advisory lock, cursor compare-and-swap on every chunk (D0409), removals, then upserts (stale versions skipped; cancelled stubs merge status only; rows carry the connection''s own provider), then the cursor (must start with g1.<connection id>.c: or m1.<connection id>.c: by provider, at most 16384 characters, else 22023). Service_role only, lane-checked against a usable Google or Microsoft connection.';
revoke all on function core.cal_events_apply_page(text, uuid, jsonb, jsonb, text, text, boolean, text[]) from public, anon, authenticated;
grant execute on function core.cal_events_apply_page(text, uuid, jsonb, jsonb, text, text, boolean, text[]) to service_role;
