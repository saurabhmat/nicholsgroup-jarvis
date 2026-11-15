-- T-247 part 2: mail and calendar are readable only through mailbox ownership (Saurabh, Nov 14, 2026: "every member sees only
-- their own mail, admin_technical included; nobody has access to anyone else's mail").
--   * comms.message_index and cal.event_index RLS: AAL2 + the lane's own_mail view + connection_id in the caller's own mailboxes
--     (core.mailbox_ids). The old comms / calendar views no longer grant any content: a lane role never grants another user's mail.
--   * Every reader function filters by the same rule EXPLICITLY (definer functions and the service-role job path bypass RLS):
--     core.home_meetings, core.home_mail_attention, core.home_calendar_status, core.briefing_coverage, core.briefing_events,
--     core.briefing_threads, core.inbox_messages, core.inbox_message_ref, core.act_reply_state (the last is in part 4).
--   * The job path (the scheduled briefing, service_role) names the mailbox owner: core.briefing_coverage / briefing_events /
--     briefing_threads take p_owner (used ONLY when the caller's role is service_role; any other caller is always auth.uid()).
--   * core.briefing_coverage lists the caller's OWN accounts only (not the lane's mailbox list and not other users' accounts): no row
--     of anyone else's mailbox, status or address. Admin connection health stays in Settings (core.connections, `connections` view).
-- Tests: 319_mail_ownership.test.sql; 150, 230, 240, 280, 281, 313 adjusted.

-- ---------------------------------------------------------------- who is asking
-- The user whose mailboxes a read covers: the caller, or (service_role only) the owner the job names. Null = nobody (reads return nothing).
create function core.mail_reader(p_owner uuid) returns uuid
language sql
stable
set search_path = ''
as $$
  select case when pg_catalog.current_setting('role', true) = 'service_role' then p_owner else (select auth.uid()) end;
$$;
comment on function core.mail_reader(uuid) is 'T-247: whose mailboxes a read covers: auth.uid(), or the named owner when the caller is service_role (jobs). Null when unknown.';
revoke all on function core.mail_reader(uuid) from public, anon;
grant execute on function core.mail_reader(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------- RLS
drop policy if exists message_index_select on comms.message_index;
create policy message_index_select on comms.message_index
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'own_mail'))::text[])
    and connection_id = any ((select core.mailbox_ids((select auth.uid()), null))::uuid[])
  );
drop policy if exists event_index_select on cal.event_index;
create policy event_index_select on cal.event_index
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'own_mail'))::text[])
    and connection_id = any ((select core.mailbox_ids((select auth.uid()), null))::uuid[])
  );

-- ---------------------------------------------------------------- Home: meetings, attention, calendar status
create or replace function core.home_meetings(p_lane text, p_from timestamptz, p_to timestamptz)
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
  v_ids uuid[];
begin
  if p_lane is null or p_from is null or p_to is null then
    raise exception 'lane and window are required' using errcode = '22004';
  end if;
  if p_to <= p_from or p_to - p_from > interval '7 days' then
    raise exception 'window must be positive and at most 7 days' using errcode = '22023';
  end if;
  -- T-247: the caller's own calendars only (RLS says the same; stated here too).
  v_ids := core.mailbox_ids((select auth.uid()), p_lane);
  v_from_date := (p_from at time zone 'America/New_York')::date;
  v_to_date := ((p_to - interval '1 microsecond') at time zone 'America/New_York')::date + 1;
  return query
  select d.title, d.start_at, d.end_at, d.all_day, d.start_date, d.location, d.source_url, d.online_meeting_url
  from (
    select distinct on (coalesce(e.ical_uid, e.calendar_id || ':' || e.event_id), e.start_at)
      e.title, e.start_at, e.end_at, e.all_day, e.start_date, e.location, e.source_url, e.online_meeting_url
    from cal.event_index e
    where e.lane_id = p_lane
      and e.connection_id = any (v_ids)
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
  'Home v1 (T-200; T-247: the caller''s own calendars only): events overlapping a window of at most 7 days, cancelled excluded, de-duplicated across calendars. Invoker: RLS on cal.event_index applies, and the own-mailbox filter is explicit.';

create or replace function core.home_mail_attention(p_lane text, p_since timestamptz)
returns table (unread_important integer, unread_priority integer, priority_configured boolean)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_senders text[];
  v_uid uuid := (select auth.uid());
  v_ids uuid[];
begin
  if p_lane is null or p_since is null then
    raise exception 'lane and since are required' using errcode = '22004';
  end if;
  if p_since < now() - interval '7 days' then
    raise exception 'since must be within the last 7 days' using errcode = '22023';
  end if;
  -- No row (not zero counts) for a caller without their own mail in this lane (T-247: no own_mail view, AAL1, service_role).
  if v_uid is null or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' or not (p_lane = any (core.allowed_lanes(v_uid, 'own_mail'))) then
    return;
  end if;
  v_ids := core.mailbox_ids(v_uid, p_lane);
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
    and m.connection_id = any (v_ids)
    and not m.deleted
    and not m.is_read
    and m.folder = 'INBOX'
    and m.received_at >= p_since;
end;
$$;
comment on function core.home_mail_attention(text, timestamptz) is
  'Home v1 (T-200; T-247: the caller''s own mailboxes only): counts of unread inbox mail (important; from priority senders) since a time at most 7 days back. Counts only; no row without own_mail. Invoker: RLS on comms.message_index and core.lane_config applies.';

-- 'no_access' (not AAL2, or no own_mail view on the lane), 'not_connected' (no calendar-capable connection OF THE CALLER), 'connected'.
create or replace function core.home_calendar_status(p_lane text)
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
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' or auth.uid() is null or not (p_lane = any (core.allowed_lanes(auth.uid(), 'own_mail'))) then
    return 'no_access';
  end if;
  -- Native connections only: a composio connection indexes no calendar yet (T-223). Only the caller's own (T-247).
  if exists (
    select 1 from core.connections c
    where c.lane_id = p_lane and c.owner_user_id = auth.uid()
      and c.provider in ('google', 'microsoft') and c.transport = 'native' and c.status <> 'disconnected'
  ) then
    return 'connected';
  end if;
  return 'not_connected';
end;
$$;
comment on function core.home_calendar_status(text) is
  'Home v1 (T-200; T-247): no_access | not_connected | connected for the caller''s own calendar connections on a lane. Definer only to read core.connections; answers only callers with own_mail at AAL2.';

-- ---------------------------------------------------------------- briefing reads (user path and job path)
drop function if exists core.briefing_coverage(text);
create function core.briefing_coverage(p_lane text, p_owner uuid default null)
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
  v_reader uuid;
  v_mail boolean;
  v_cal boolean;
  v_boxes text[];
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  if pg_catalog.current_setting('role', true) <> 'service_role' and coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    return;
  end if;
  v_reader := core.mail_reader(p_owner);
  if v_reader is null then
    return;
  end if;
  -- T-247: the reader's own mail and calendar (own_mail view); never another user's accounts.
  v_mail := p_lane = any (core.allowed_lanes(v_reader, 'own_mail'));
  v_cal := v_mail;
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
    -- the reader's own live mail/calendar connections of the lane (one row per address)
    select lower(c.external_account_id) as account from core.connections c
    where c.lane_id = p_lane and c.owner_user_id = v_reader and c.provider in ('google', 'microsoft') and c.status <> 'disconnected'
  ),
  conn as (
    select distinct on (lower(c.external_account_id))
      lower(c.external_account_id) as account, c.id, c.provider, c.status, c.last_sync_at, c.last_error, c.last_error_stream
    from core.connections c
    where c.lane_id = p_lane and c.owner_user_id = v_reader and c.provider in ('google', 'microsoft') and c.status <> 'disconnected'
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
  -- Access but nothing connected: one row per visible stream says so (never "no rows" = "no access").
  if not found then
    return query
    select x.stream, null::text, null::uuid, null::text, 'not_configured'::text, false, null::timestamptz, null::text
    from (select 'mail'::text as stream where v_mail union all select 'calendar'::text where v_cal) x
    order by x.stream desc;
  end if;
end;
$$;
comment on function core.briefing_coverage(text, uuid) is
  'Home briefing (T-231a; T-247: the reader''s own accounts only): coverage per (stream, account): status, last sync, connector error kind only. p_owner is used only when the caller is service_role (the job path). Definer only to read connection health; answers callers holding own_mail at AAL2.';
revoke all on function core.briefing_coverage(text, uuid) from public, anon;
grant execute on function core.briefing_coverage(text, uuid) to authenticated, service_role;

drop function if exists core.briefing_events(text, timestamptz, timestamptz);
create function core.briefing_events(p_lane text, p_from timestamptz, p_to timestamptz, p_owner uuid default null)
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
  v_ids uuid[];
begin
  if p_lane is null or p_from is null or p_to is null then
    raise exception 'lane and window are required' using errcode = '22004';
  end if;
  if p_to <= p_from or p_to - p_from > interval '8 days' then
    raise exception 'window must be positive and at most 8 days' using errcode = '22023';
  end if;
  -- T-247: only the reader's own calendars (the job names its owner as p_owner; anyone else is auth.uid()).
  v_ids := core.mailbox_ids(core.mail_reader(p_owner), p_lane);
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
      and e.connection_id = any (v_ids)
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
comment on function core.briefing_events(text, timestamptz, timestamptz, uuid) is
  'Home briefing (T-231a; T-247: the reader''s own calendars only): events overlapping a window of at most 8 days, cancelled excluded, de-duplicated across calendars, with attendees, organizer and the event zone. p_owner only for service_role (job path). Invoker: RLS applies; the own-mailbox filter is explicit.';
revoke all on function core.briefing_events(text, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function core.briefing_events(text, timestamptz, timestamptz, uuid) to authenticated, service_role;

drop function if exists core.briefing_threads(text, timestamptz);
create function core.briefing_threads(p_lane text, p_since timestamptz, p_owner uuid default null)
returns table (
  connection_id uuid,
  thread_key text,
  message_id text,
  from_address text,
  from_name text,
  subject text,
  received_at timestamptz,
  source_url text,
  labels text[],
  is_important boolean,
  last_is_owner boolean,
  owner_replied boolean,
  unread_count integer,
  inbound_count integer,
  last_at timestamptz,
  is_bulk boolean,
  is_calendar boolean,
  is_auto boolean,
  is_generated boolean,
  is_auth_pass boolean,
  last_to_owner boolean
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if p_lane is null or p_since is null then
    raise exception 'lane and since are required' using errcode = '22004';
  end if;
  -- More than 14 days back (plus a minute of clock slack for callers that computed p_since a moment ago) is refused;
  -- within the slack the window is clamped to 14 days.
  if p_since < pg_catalog.now() - interval '14 days 1 minute' then
    raise exception 'since must be within the last 14 days' using errcode = '22023';
  end if;
  p_since := greatest(p_since, pg_catalog.now() - interval '14 days');
  -- T-247: only the reader's own mailboxes (the job names its owner as p_owner; anyone else is auth.uid()).
  v_ids := core.mailbox_ids(core.mail_reader(p_owner), p_lane);
  return query
  with msgs as (
    select m.connection_id, coalesce(m.thread_id, 'm:' || m.message_id) as tkey, m.message_id, m.from_address, m.from_name,
           m.subject, m.received_at, m.source_url, m.labels, m.is_important, m.is_read, m.folder, m.is_bulk, m.is_calendar, m.is_auto, m.is_generated, m.is_auth_pass,
           (exists (select 1 from core.connections c, pg_catalog.jsonb_array_elements(m.to_recipients) e
                    where c.id = m.connection_id and c.lane_id = p_lane and c.external_account_id is not null
                      and pg_catalog.lower(e ->> 'address') = pg_catalog.lower(c.external_account_id))) as to_owner,
           ('SENT' = any (m.labels)) as is_sent
    from comms.message_index m
    -- Unsent drafts are neither inbound mail nor a reply: left out.
    where m.lane_id = p_lane and m.connection_id = any (v_ids) and not m.deleted and m.received_at >= p_since and not ('DRAFT' = any (m.labels))
  ),
  threads as (
    select g.connection_id, g.tkey,
           bool_or(g.folder = 'INBOX') as in_inbox,
           bool_or(g.is_sent) as owner_replied,
           (count(*) filter (where not g.is_sent and not g.is_read and g.folder = 'INBOX'))::integer as unread_count,
           (count(*) filter (where not g.is_sent))::integer as inbound_count,
           max(g.received_at) as last_at
    from msgs g
    group by g.connection_id, g.tkey
  ),
  last_msg as (
    select distinct on (g.connection_id, g.tkey) g.connection_id, g.tkey, g.is_sent
    from msgs g
    order by g.connection_id, g.tkey, g.received_at desc, g.message_id
  ),
  last_in as (
    select distinct on (g.connection_id, g.tkey) g.*
    from msgs g
    where not g.is_sent
    order by g.connection_id, g.tkey, g.received_at desc, g.message_id
  )
  select t.connection_id, t.tkey, i.message_id, i.from_address, i.from_name, i.subject, i.received_at, i.source_url, i.labels,
         i.is_important, l.is_sent, t.owner_replied, t.unread_count, t.inbound_count, t.last_at, i.is_bulk, i.is_calendar, i.is_auto, i.is_generated, i.is_auth_pass, i.to_owner
  from threads t
  join last_in i on i.connection_id = t.connection_id and i.tkey = t.tkey
  join last_msg l on l.connection_id = t.connection_id and l.tkey = t.tkey
  where t.in_inbox
  order by t.last_at desc
  limit 300;
end;
$$;
comment on function core.briefing_threads(text, timestamptz, uuid) is
  'Home briefing (T-231b; T-234 flags; T-240 last_to_owner; T-247: the reader''s own mailboxes only): per inbox thread since a time at most 14 days back, the latest inbound message metadata, whether the owner answered last / ever, unread and inbound counts. Metadata only. p_owner only for service_role (job path). Invoker: RLS applies; the own-mailbox filter is explicit.';
revoke all on function core.briefing_threads(text, timestamptz, uuid) from public, anon;
grant execute on function core.briefing_threads(text, timestamptz, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------- Inbox
create or replace function core.inbox_messages(p_lane text, p_filter text, p_before timestamptz default null, p_before_id text default null, p_limit integer default 50)
returns table (
  message_id text,
  connection_id uuid,
  thread_id text,
  from_name text,
  from_address text,
  subject text,
  received_at timestamptz,
  is_read boolean,
  is_important boolean,
  is_starred boolean,
  has_attachments boolean,
  source_url text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if p_lane is null or p_filter is null then
    raise exception 'lane and filter are required' using errcode = '22004';
  end if;
  if p_filter not in ('all', 'unread', 'important') then
    raise exception 'unknown filter' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'limit must be 1 to 100' using errcode = '22023';
  end if;
  if (p_before is null) <> (p_before_id is null) then
    raise exception 'paging needs both before and before_id' using errcode = '22023';
  end if;
  v_ids := core.mailbox_ids((select auth.uid()), p_lane);
  return query
  select m.message_id, m.connection_id, m.thread_id, m.from_name, m.from_address, m.subject, m.received_at,
         m.is_read, m.is_important, m.is_starred, m.has_attachments, m.source_url
  from comms.message_index m
  where m.lane_id = p_lane
    and m.connection_id = any (v_ids)
    and not m.deleted
    and m.folder = 'INBOX'
    and (p_filter = 'all' or (p_filter = 'unread' and not m.is_read) or (p_filter = 'important' and m.is_important))
    and (p_before is null or (m.received_at, m.message_id) < (p_before, p_before_id))
  order by m.received_at desc, m.message_id desc
  limit p_limit;
end;
$$;
comment on function core.inbox_messages(text, text, timestamptz, text, integer) is
  'Inbox (T-202; T-247: the caller''s own mailboxes only): inbox metadata, newest first, filtered, keyset-paged, at most 100 rows. Invoker: RLS on comms.message_index applies; the own-mailbox filter is explicit.';

create or replace function core.inbox_message_ref(p_lane text, p_message_id text)
returns table (
  message_id text,
  connection_id uuid,
  provider text,
  from_name text,
  from_address text,
  to_recipients jsonb,
  cc_recipients jsonb,
  subject text,
  received_at timestamptz,
  is_read boolean,
  is_important boolean,
  has_attachments boolean,
  source_url text,
  thread_id text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if p_lane is null or p_message_id is null then
    raise exception 'lane and message id are required' using errcode = '22004';
  end if;
  v_ids := core.mailbox_ids((select auth.uid()), p_lane);
  return query
  select m.message_id, m.connection_id, m.provider, m.from_name, m.from_address, to_jsonb(m.to_recipients), to_jsonb(m.cc_recipients),
         m.subject, m.received_at, m.is_read, m.is_important, m.has_attachments, m.source_url, m.thread_id
  from comms.message_index m
  where m.lane_id = p_lane and m.connection_id = any (v_ids) and m.message_id = p_message_id and not m.deleted
  order by m.received_at desc
  limit 1;
end;
$$;
comment on function core.inbox_message_ref(text, text) is
  'Inbox (T-202; T-234: with thread_id; T-247: own mailboxes only): one visible message''s metadata and connection, checked before the app reads the body live. Invoker: RLS applies; the own-mailbox filter is explicit.';
