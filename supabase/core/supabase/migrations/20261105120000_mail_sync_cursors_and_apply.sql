-- T-063: per-connection sync cursors and the atomic apply of one Gmail metadata sync page.
--
-- core.sync_cursors holds the opaque cursor of one sync stream of one connection (Gmail: stream 'mail'; Calendar and
-- Graph streams reuse it, T-064/T-066/T-067). A cursor is provider-encoded and carries no token (T-062 rules); it is
-- stored in the SAME transaction as the page it follows, so a failed apply never advances it.
--
-- core.comms_mail_apply_page applies one MailSyncResult page to comms.message_index: removals first, then upserts, all
-- or nothing. An upsert replaces a row only when the incoming source_updated_at is not older than the stored one (a
-- missing incoming version counts as oldest); classifier and summary columns are never touched. A removal sets deleted
-- = true; an upsert clears it only when the caller says the page is fresh (p_revive).
-- Replay safety comes from the cursor, not from the timestamps: Gmail's internalDate does not change when labels
-- change, so equal versions must apply. A page is applied under a per-connection advisory lock and only if the stored
-- cursor still equals the cursor the run started from (p_expected_cursor, compare-and-swap); a concurrent or replayed
-- run gets SQLSTATE D0409 and writes nothing. Metadata columns only: the
-- function has no parameter that could carry a body, snippet or preview (rule 6).
--
-- Access: service_role has NO table grants; it reaches both tables only through the two security-definer functions
-- (each checks the connection belongs to the lane, is a usable Google connection, and the lane is enabled).
-- Reads: standard lane policy on the 'health' view (owner, admin_technical at aal2); the cursor text itself is withheld
-- by column grants.

create table core.sync_cursors (
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  connection_id uuid not null,
  -- 'mail' (Gmail history), later 'calendar' and per-folder streams.
  stream text not null check (stream ~ '^[a-z][a-z0-9_]{0,63}$'),
  cursor_value text not null check (length(cursor_value) between 1 and 16384 and cursor_value !~ '[[:cntrl:]]'),
  updated_at timestamptz not null default now(),
  primary key (connection_id, stream),
  -- Lane-consistent: the connection belongs to the same lane.
  -- A cursor is derived state: if a connection row is ever deleted its cursors go with it (disconnecting keeps the row).
  foreign key (connection_id, lane_id) references core.connections (id, lane_id) on update restrict on delete cascade
);
comment on table core.sync_cursors is
  'Sync cursor per (connection, stream) (T-063). Opaque provider cursor, no tokens. Written only by core.comms_mail_apply_page.';
create index sync_cursors_lane_idx on core.sync_cursors (lane_id);

create trigger sync_cursors_set_updated_at before update on core.sync_cursors
  for each row execute function core.set_updated_at();

alter table core.sync_cursors enable row level security;

create policy sync_cursors_select on core.sync_cursors
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'health'))::text[])
  );

revoke all on core.sync_cursors from public, anon, authenticated, service_role;
grant select (lane_id, connection_id, stream, updated_at) on core.sync_cursors to authenticated;

-- ---------------------------------------------------------------- read a cursor
create function core.sync_cursor_get(p_lane text, p_connection_id uuid, p_stream text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cursor text;
begin
  if p_lane is null or p_connection_id is null or p_stream is null then
    raise exception 'lane, connection and stream are required' using errcode = '22004';
  end if;
  if not exists (select 1 from core.connections c
                 join core.lanes l on l.code = c.lane_id and l.enabled
                 where c.id = p_connection_id and c.lane_id = p_lane) then
    raise exception 'connection not found in this lane' using errcode = '42501';
  end if;
  select s.cursor_value into v_cursor
  from core.sync_cursors s
  where s.connection_id = p_connection_id and s.lane_id = p_lane and s.stream = p_stream;
  return v_cursor;
end;
$$;
comment on function core.sync_cursor_get(text, uuid, text) is
  'Sync cursor of one stream of a connection (T-063); null when none. Service_role only, lane-checked.';
revoke all on function core.sync_cursor_get(text, uuid, text) from public, anon, authenticated;
grant execute on function core.sync_cursor_get(text, uuid, text) to service_role;

-- ---------------------------------------------------------------- apply one Gmail page
-- p_removals: json array of message ids (strings). p_upserts: json array of metadata objects with exactly the
-- MessageMeta fields. p_expected_cursor: the cursor the run read before this page (null = none stored); checked only
-- when p_cursor is given. p_cursor: the cursor that follows the page, stored with it; null = an intermediate chunk of a
-- larger page (no cursor write, no check; the last chunk carries it). p_complete: the run reached its end
-- (last_sync_at). p_revive: the page is fresh, so an upsert may clear `deleted`. Returns counts as jsonb.
create function core.comms_mail_apply_page(
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
                is_starred boolean, is_important boolean, has_attachments boolean, folder text, labels jsonb,
                source_updated_at timestamptz)
    order by r.message_id, e.n desc
  ), written as (
    insert into comms.message_index as t
      (lane_id, connection_id, provider, message_id, thread_id, source_url, from_address, from_name, to_recipients,
       cc_recipients, subject, received_at, is_read, is_starred, is_important, has_attachments, folder, labels,
       source_updated_at)
    select p_lane, p_connection_id, 'google', i.message_id, i.thread_id, i.source_url, i.from_address, i.from_name,
           coalesce(i.to_recipients, '[]'::jsonb), coalesce(i.cc_recipients, '[]'::jsonb), i.subject, i.received_at,
           coalesce(i.is_read, false), coalesce(i.is_starred, false), coalesce(i.is_important, false),
           coalesce(i.has_attachments, false), i.folder,
           coalesce(array(select pg_catalog.jsonb_array_elements_text(coalesce(i.labels, '[]'::jsonb))), '{}'::text[]),
           i.source_updated_at
    from incoming i
    on conflict (lane_id, connection_id, message_id) do update set
      thread_id = excluded.thread_id, source_url = excluded.source_url, from_address = excluded.from_address,
      from_name = excluded.from_name, to_recipients = excluded.to_recipients, cc_recipients = excluded.cc_recipients,
      subject = excluded.subject, received_at = excluded.received_at, is_read = excluded.is_read,
      is_starred = excluded.is_starred, is_important = excluded.is_important, has_attachments = excluded.has_attachments,
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
  'Applies one Gmail metadata page (chunk) atomically (T-063): advisory lock, cursor compare-and-swap (D0409 on conflict), removals, then upserts (stale versions skipped), then the cursor. Service_role only, lane-checked against a usable Google connection.';
revoke all on function core.comms_mail_apply_page(text, uuid, jsonb, jsonb, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function core.comms_mail_apply_page(text, uuid, jsonb, jsonb, text, text, boolean, boolean) to service_role;

-- A full resync discards the stored cursor first (the new run stores a fresh one with its first page).
create function core.sync_cursor_reset(p_lane text, p_connection_id uuid, p_stream text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_lane is null or p_connection_id is null or p_stream is null then
    raise exception 'lane, connection and stream are required' using errcode = '22004';
  end if;
  if not exists (select 1 from core.connections c
                 join core.lanes l on l.code = c.lane_id and l.enabled
                 where c.id = p_connection_id and c.lane_id = p_lane) then
    raise exception 'connection not found in this lane' using errcode = '42501';
  end if;
  delete from core.sync_cursors s where s.connection_id = p_connection_id and s.lane_id = p_lane and s.stream = p_stream;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;
comment on function core.sync_cursor_reset(text, uuid, text) is
  'Deletes one stream''s cursor (T-063, full resync). Service_role only, lane-checked.';
revoke all on function core.sync_cursor_reset(text, uuid, text) from public, anon, authenticated;
grant execute on function core.sync_cursor_reset(text, uuid, text) to service_role;
