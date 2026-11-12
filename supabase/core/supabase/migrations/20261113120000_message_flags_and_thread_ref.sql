-- T-234 part 2: Needs your attention exclusions and the thread view.
--
-- 1. comms.message_index gets five BOOLEAN flags derived from message headers at sync time: is_bulk (List-Unsubscribe, List-Id,
--    Precedence bulk/list/junk), is_calendar (text/calendar, Exchange calendarmessage, Google Calendar notification), is_auto
--    (true auto-replies only: Auto-Submitted auto-replied, X-Autoreply, X-Autorespond, Precedence auto_reply), is_generated
--    (Auto-Submitted with any other value except "no": a soft signal) and is_auth_pass (Google's own Authentication-Results
--    shows dmarc=pass, or dkim=pass aligned with the From domain: priority-sender treatment needs it). Only the booleans are
--    stored, never a header value or a body (rule 6). Existing rows read false until the message is next synced (no backfill is possible without re-reading Gmail): one full Gmail resync is REQUIRED after this runs, or old mail has no flags and no auth pass (so no priority treatment).
--    No new table: the table's lane_id and RLS policies are unchanged and apply to the new columns.
-- 2. core.comms_mail_apply_page writes the flags (same signature; absent flags = false).
-- 3. core.briefing_threads returns the flags of the thread's latest inbound message (return type changes: dropped and recreated).
-- 4. core.inbox_message_ref also returns thread_id, so the thread view can build the Gmail link (return type changes: recreated).

alter table comms.message_index
  add column if not exists is_bulk boolean not null default false,
  add column if not exists is_calendar boolean not null default false,
  add column if not exists is_auto boolean not null default false,
  add column if not exists is_generated boolean not null default false,
  add column if not exists is_auth_pass boolean not null default false;
comment on column comms.message_index.is_bulk is 'T-234: bulk or list mail (List-Unsubscribe, List-Id, Precedence bulk/list/junk). Derived at sync; the headers are not stored.';
comment on column comms.message_index.is_calendar is 'T-234: calendar invitation or update (text/calendar part, calendarmessage class, Google Calendar sender). Derived at sync.';
comment on column comms.message_index.is_auto is 'T-234: true auto-reply (Auto-Submitted auto-replied, X-Autoreply, X-Autorespond, Precedence auto_reply). Derived at sync.';
comment on column comms.message_index.is_generated is 'T-234: Auto-Submitted with a value other than no or auto-replied (e.g. auto-generated); a soft signal. Derived at sync.';
comment on column comms.message_index.is_auth_pass is 'T-234: Google''s own Authentication-Results shows dmarc=pass, or dkim=pass aligned with the From domain. Derived at sync (false on rows synced earlier until the resync); the header is not stored.';

create or replace function core.comms_mail_apply_page(
  p_lane text,
  p_connection_id uuid,
  p_removals jsonb,
  p_upserts jsonb,
  p_expected_cursor text,
  p_cursor text,
  p_complete boolean default false,
  p_revive boolean default false
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
begin
  if p_lane is null or p_connection_id is null or p_removals is null or p_upserts is null then
    raise exception 'lane, connection, removals and upserts are required' using errcode = '22004';
  end if;
  if pg_catalog.jsonb_typeof(p_removals) <> 'array' or pg_catalog.jsonb_typeof(p_upserts) <> 'array'
     or pg_catalog.jsonb_array_length(p_removals) > 1000 or pg_catalog.jsonb_array_length(p_upserts) > 1000 then
    raise exception 'removals and upserts must be arrays of at most 1000 entries' using errcode = '22023';
  end if;
  if not exists (select 1 from core.connections c
                 join core.lanes l on l.code = c.lane_id and l.enabled
                 where c.id = p_connection_id and c.lane_id = p_lane and c.provider = 'google'
                   and c.status in ('active', 'degraded')) then
    raise exception 'usable Google connection not found in this lane' using errcode = '42501';
  end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_removals) e
             where pg_catalog.jsonb_typeof(e) <> 'string' or pg_catalog.length(e #>> '{}') not between 1 and 512) then
    raise exception 'removals must be message id strings' using errcode = '22023';
  end if;
  -- Every element is validated here, so a bad record is a clear 22023 and not a cast failure deep in the insert.
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_upserts) e
             where pg_catalog.jsonb_typeof(e) <> 'object'
                or pg_catalog.jsonb_typeof(e -> 'message_id') is distinct from 'string'
                or pg_catalog.length(e ->> 'message_id') not between 1 and 512
                or (e ? 'labels' and pg_catalog.jsonb_typeof(e -> 'labels') not in ('array', 'null'))
                or (e ? 'to_recipients' and pg_catalog.jsonb_typeof(e -> 'to_recipients') not in ('array', 'null'))
                or (e ? 'cc_recipients' and pg_catalog.jsonb_typeof(e -> 'cc_recipients') not in ('array', 'null'))
                or pg_catalog.jsonb_typeof(e -> 'received_at') is distinct from 'string') then
    raise exception 'each upsert needs a message_id, a received_at and array-typed labels and recipients' using errcode = '22023';
  end if;

  -- One writer per connection at a time; the cursor check below then makes a stale or concurrent page a no-op error.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_connection_id::text, 63));
  -- Every chunk (not only the last) is checked, so a stale run cannot apply earlier chunks before failing.
  select s.cursor_value into v_current
  from core.sync_cursors s where s.connection_id = p_connection_id and s.lane_id = p_lane and s.stream = 'mail';
  if v_current is distinct from p_expected_cursor then
    raise exception 'the stored cursor moved: another run applied a page first' using errcode = 'D0409';
  end if;

  -- Removals first: the row stays (retention purges it) and is flagged.
  update comms.message_index m
     set deleted = true
   where m.lane_id = p_lane and m.connection_id = p_connection_id and not m.deleted
     and m.message_id in (select e #>> '{}' from pg_catalog.jsonb_array_elements(p_removals) e);
  get diagnostics v_removed = row_count;

  -- Upserts. One row per message id (the last occurrence wins); stale versions are skipped, not errors.
  select pg_catalog.count(*) into v_incoming from (select distinct e ->> 'message_id'
    from pg_catalog.jsonb_array_elements(p_upserts) e) d;
  with incoming as (
    select distinct on (r.message_id) r.*
    from pg_catalog.jsonb_array_elements(p_upserts) with ordinality as e(v, n),
         pg_catalog.jsonb_to_record(e.v)
           as r(message_id text, thread_id text, source_url text, from_address text, from_name text,
                to_recipients jsonb, cc_recipients jsonb, subject text, received_at timestamptz, is_read boolean,
                is_starred boolean, is_important boolean, has_attachments boolean, is_bulk boolean, is_calendar boolean, is_auto boolean, is_generated boolean, is_auth_pass boolean, folder text, labels jsonb,
                source_updated_at timestamptz)
    order by r.message_id, e.n desc
  ), written as (
    insert into comms.message_index as t
      (lane_id, connection_id, provider, message_id, thread_id, source_url, from_address, from_name, to_recipients,
       cc_recipients, subject, received_at, is_read, is_starred, is_important, has_attachments, is_bulk, is_calendar, is_auto, is_generated, is_auth_pass, folder, labels,
       source_updated_at)
    select p_lane, p_connection_id, 'google', i.message_id, i.thread_id, i.source_url, i.from_address, i.from_name,
           coalesce(i.to_recipients, '[]'::jsonb), coalesce(i.cc_recipients, '[]'::jsonb), i.subject, i.received_at,
           coalesce(i.is_read, false), coalesce(i.is_starred, false), coalesce(i.is_important, false),
           coalesce(i.has_attachments, false), coalesce(i.is_bulk, false), coalesce(i.is_calendar, false), coalesce(i.is_auto, false), coalesce(i.is_generated, false), coalesce(i.is_auth_pass, false), i.folder,
           coalesce(array(select pg_catalog.jsonb_array_elements_text(coalesce(i.labels, '[]'::jsonb))), '{}'::text[]),
           i.source_updated_at
    from incoming i
    on conflict (lane_id, connection_id, message_id) do update set
      thread_id = excluded.thread_id, source_url = excluded.source_url, from_address = excluded.from_address,
      from_name = excluded.from_name, to_recipients = excluded.to_recipients, cc_recipients = excluded.cc_recipients,
      subject = excluded.subject, received_at = excluded.received_at, is_read = excluded.is_read,
      is_starred = excluded.is_starred, is_important = excluded.is_important, has_attachments = excluded.has_attachments,
      is_bulk = excluded.is_bulk, is_calendar = excluded.is_calendar, is_auto = excluded.is_auto,
      is_generated = excluded.is_generated, is_auth_pass = excluded.is_auth_pass,
      folder = excluded.folder, labels = excluded.labels, source_updated_at = excluded.source_updated_at,
      deleted = case when p_revive then false else t.deleted end
    -- A missing incoming version counts as oldest: it never replaces a row that has one.
    where t.source_updated_at is null
       or (excluded.source_updated_at is not null and excluded.source_updated_at >= t.source_updated_at)
    returning 1
  )
  select pg_catalog.count(*) into v_written from written;

  if p_cursor is not null then
    insert into core.sync_cursors (lane_id, connection_id, stream, cursor_value)
    values (p_lane, p_connection_id, 'mail', p_cursor)
    on conflict (connection_id, stream) do update set cursor_value = excluded.cursor_value;
  end if;

  if p_complete then
    update core.connections set last_sync_at = pg_catalog.now() where id = p_connection_id and lane_id = p_lane;
  end if;

  return pg_catalog.jsonb_build_object('removed', v_removed, 'written', v_written, 'skipped', v_incoming - v_written);
end;
$$;
comment on function core.comms_mail_apply_page(text, uuid, jsonb, jsonb, text, text, boolean, boolean) is
  'Applies one Gmail metadata page (chunk) atomically (T-063): advisory lock, cursor compare-and-swap (D0409 on conflict), removals, then upserts (stale versions skipped; T-234: with the header-derived flags), then the cursor. Service_role only, lane-checked against a usable Google connection.';
-- create or replace keeps the existing grants (service_role only).

drop function if exists core.briefing_threads(text, timestamptz);
create function core.briefing_threads(p_lane text, p_since timestamptz)
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
  is_auth_pass boolean
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
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
  return query
  with msgs as (
    select m.connection_id, coalesce(m.thread_id, 'm:' || m.message_id) as tkey, m.message_id, m.from_address, m.from_name,
           m.subject, m.received_at, m.source_url, m.labels, m.is_important, m.is_read, m.folder, m.is_bulk, m.is_calendar, m.is_auto, m.is_generated, m.is_auth_pass,
           ('SENT' = any (m.labels)) as is_sent
    from comms.message_index m
    -- Unsent drafts are neither inbound mail nor a reply: left out.
    where m.lane_id = p_lane and not m.deleted and m.received_at >= p_since and not ('DRAFT' = any (m.labels))
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
         i.is_important, l.is_sent, t.owner_replied, t.unread_count, t.inbound_count, t.last_at, i.is_bulk, i.is_calendar, i.is_auto, i.is_generated, i.is_auth_pass
  from threads t
  join last_in i on i.connection_id = t.connection_id and i.tkey = t.tkey
  join last_msg l on l.connection_id = t.connection_id and l.tkey = t.tkey
  where t.in_inbox
  order by t.last_at desc
  limit 300;
end;
$$;
comment on function core.briefing_threads(text, timestamptz) is
  'Home briefing (T-231b; T-234: with the header-derived flags of the latest inbound message): per inbox thread since a time at most 14 days back, the latest inbound message metadata, whether the owner answered last / ever, unread and inbound counts. Metadata only. Invoker: RLS on comms.message_index applies.';

revoke all on function core.briefing_threads(text, timestamptz) from public, anon;
grant execute on function core.briefing_threads(text, timestamptz) to authenticated, service_role;

drop function if exists core.inbox_message_ref(text, text);
create function core.inbox_message_ref(p_lane text, p_message_id text)
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
begin
  if p_lane is null or p_message_id is null then
    raise exception 'lane and message id are required' using errcode = '22004';
  end if;
  return query
  select m.message_id, m.connection_id, m.provider, m.from_name, m.from_address, to_jsonb(m.to_recipients), to_jsonb(m.cc_recipients),
         m.subject, m.received_at, m.is_read, m.is_important, m.has_attachments, m.source_url, m.thread_id
  from comms.message_index m
  where m.lane_id = p_lane and m.message_id = p_message_id and not m.deleted
  order by m.received_at desc
  limit 1;
end;
$$;
comment on function core.inbox_message_ref(text, text) is
  'Inbox (T-202; T-234: with thread_id): one visible message''s metadata and connection, checked before the app reads the body live. Invoker: RLS applies.';
revoke all on function core.inbox_message_ref(text, text) from public, anon;
grant execute on function core.inbox_message_ref(text, text) to authenticated;
