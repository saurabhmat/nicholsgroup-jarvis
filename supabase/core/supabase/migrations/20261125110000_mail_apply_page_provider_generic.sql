-- T-252: provider-generic mail page writer (docs/specs/microsoft.md 6.3). New latest definition of core.comms_mail_apply_page (same
-- signature, grants and search_path as 20261113120000):
--   * a usable connection of provider 'google' or 'microsoft' in an enabled lane; rows are inserted with the connection's own provider;
--   * the new cursor must start with g1.<connection id>. (google) or m1.<connection id>.m: (microsoft) and be at most 16384 characters,
--     else 22023 (closes the T-063 re-review LOW: a cursor of another connection or provider can no longer be stored);
--   * removals are message id strings or {message_id, folder}; with a folder only a stored row in that folder is flagged deleted;
--   * on update an absent (or null) flag keeps the stored value; on insert it is false.
-- create or replace keeps the existing grants (service_role only). Tests: 321_mail_page_writer.test.sql; 160, 303, 050 adjusted.

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
  -- T-252 (closes the T-063 re-review LOW): a stored cursor belongs to this connection and this provider's sync.
  if p_cursor is not null then
    v_prefix := case v_provider when 'google' then 'g1.' || p_connection_id::text || '.'
                                else 'm1.' || p_connection_id::text || '.m:' end;
    if pg_catalog.char_length(p_cursor) > 16384 or not pg_catalog.starts_with(p_cursor, v_prefix) then
      raise exception 'the cursor does not belong to this connection or is too long' using errcode = '22023';
    end if;
  end if;
  -- A removal is a message id string, or {message_id, folder} (folder optional): with a folder only a stored row in that folder is flagged.
  -- (a CASE, so the object tests never run on a scalar)
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_removals) e
             where not coalesce(case pg_catalog.jsonb_typeof(e)
               when 'string' then pg_catalog.length(e #>> '{}') between 1 and 512
               when 'object' then pg_catalog.jsonb_typeof(e -> 'message_id') = 'string'
                   and pg_catalog.length(e ->> 'message_id') between 1 and 512
                   and (e - 'message_id' - 'folder') = '{}'::jsonb
                   and (not (e ? 'folder') or pg_catalog.jsonb_typeof(e -> 'folder') = 'null'
                        or (pg_catalog.jsonb_typeof(e -> 'folder') = 'string' and pg_catalog.length(e ->> 'folder') between 1 and 512))
               else false end, false)) then
    raise exception 'removals must be message id strings or {message_id, folder} objects' using errcode = '22023';
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
     and exists (select 1 from pg_catalog.jsonb_array_elements(p_removals) e
                 where m.message_id = case when pg_catalog.jsonb_typeof(e) = 'string' then e #>> '{}' else e ->> 'message_id' end
                   and (pg_catalog.jsonb_typeof(e) = 'string' or (e ->> 'folder') is null or (e ->> 'folder') = m.folder));
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
  ), fm as (
    -- The flags each message really carries (absent or null left out): on update only those overwrite the stored value.
    select coalesce(pg_catalog.jsonb_object_agg(i.message_id, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
             'is_read', i.is_read, 'is_starred', i.is_starred, 'is_important', i.is_important, 'has_attachments', i.has_attachments,
             'is_bulk', i.is_bulk, 'is_calendar', i.is_calendar, 'is_auto', i.is_auto, 'is_generated', i.is_generated,
             'is_auth_pass', i.is_auth_pass))), '{}'::jsonb) as m
    from incoming i
  ), written as (
    insert into comms.message_index as t
      (lane_id, connection_id, provider, message_id, thread_id, source_url, from_address, from_name, to_recipients,
       cc_recipients, subject, received_at, is_read, is_starred, is_important, has_attachments, is_bulk, is_calendar, is_auto, is_generated, is_auth_pass, folder, labels,
       source_updated_at)
    select p_lane, p_connection_id, v_provider, i.message_id, i.thread_id, i.source_url, i.from_address, i.from_name,
           coalesce(i.to_recipients, '[]'::jsonb), coalesce(i.cc_recipients, '[]'::jsonb), i.subject, i.received_at,
           coalesce(i.is_read, false), coalesce(i.is_starred, false), coalesce(i.is_important, false),
           coalesce(i.has_attachments, false), coalesce(i.is_bulk, false), coalesce(i.is_calendar, false), coalesce(i.is_auto, false), coalesce(i.is_generated, false), coalesce(i.is_auth_pass, false), i.folder,
           coalesce(array(select pg_catalog.jsonb_array_elements_text(coalesce(i.labels, '[]'::jsonb))), '{}'::text[]),
           i.source_updated_at
    from incoming i
    on conflict (lane_id, connection_id, message_id) do update set
      thread_id = excluded.thread_id, source_url = excluded.source_url, from_address = excluded.from_address,
      from_name = excluded.from_name, to_recipients = excluded.to_recipients, cc_recipients = excluded.cc_recipients,
      subject = excluded.subject, received_at = excluded.received_at,
      -- a flag the page does not carry (absent or null) keeps the stored value on update (false on insert, above)
      is_read = coalesce((((select fm.m from fm) -> t.message_id) ->> 'is_read')::boolean, t.is_read),
      is_starred = coalesce((((select fm.m from fm) -> t.message_id) ->> 'is_starred')::boolean, t.is_starred),
      is_important = coalesce((((select fm.m from fm) -> t.message_id) ->> 'is_important')::boolean, t.is_important),
      has_attachments = coalesce((((select fm.m from fm) -> t.message_id) ->> 'has_attachments')::boolean, t.has_attachments),
      is_bulk = coalesce((((select fm.m from fm) -> t.message_id) ->> 'is_bulk')::boolean, t.is_bulk),
      is_calendar = coalesce((((select fm.m from fm) -> t.message_id) ->> 'is_calendar')::boolean, t.is_calendar),
      is_auto = coalesce((((select fm.m from fm) -> t.message_id) ->> 'is_auto')::boolean, t.is_auto),
      is_generated = coalesce((((select fm.m from fm) -> t.message_id) ->> 'is_generated')::boolean, t.is_generated),
      is_auth_pass = coalesce((((select fm.m from fm) -> t.message_id) ->> 'is_auth_pass')::boolean, t.is_auth_pass),
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
  'Applies one mail metadata page (chunk) atomically (T-063; T-252 provider-generic): advisory lock, cursor compare-and-swap (D0409 on conflict), removals (id strings or {message_id, folder}), then upserts (stale versions skipped; header-derived flags: absent = false on insert, kept on update), then the cursor (must start with g1.<connection id>. or m1.<connection id>.m: by provider, at most 16384 characters, else 22023). Rows carry the connection''s own provider. Service_role only, lane-checked against a usable Google or Microsoft connection.';
