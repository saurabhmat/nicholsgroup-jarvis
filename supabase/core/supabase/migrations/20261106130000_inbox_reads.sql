-- Functional Inbox reads (T-202). Read-only, SECURITY INVOKER functions in `core` (the schema the API exposes): RLS on
-- comms.message_index applies unchanged (AAL2 + lane membership + the comms view), so a caller sees only mail of lanes
-- they may read. Metadata only: bodies are never stored (rule 6) and are fetched live by the app after inbox_message_ref
-- has proved the caller may see the message. No table is added; denial is tested in 240.

-- The lane's inbox, newest first: all / unread / important, keyset paging by (received_at, message_id), at most 100 rows.
create function core.inbox_messages(p_lane text, p_filter text, p_before timestamptz default null, p_before_id text default null, p_limit integer default 50)
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
  return query
  select m.message_id, m.connection_id, m.thread_id, m.from_name, m.from_address, m.subject, m.received_at,
         m.is_read, m.is_important, m.is_starred, m.has_attachments, m.source_url
  from comms.message_index m
  where m.lane_id = p_lane
    and not m.deleted
    and m.folder = 'INBOX'
    and (p_filter = 'all' or (p_filter = 'unread' and not m.is_read) or (p_filter = 'important' and m.is_important))
    and (p_before is null or (m.received_at, m.message_id) < (p_before, p_before_id))
  order by m.received_at desc, m.message_id desc
  limit p_limit;
end;
$$;
comment on function core.inbox_messages(text, text, timestamptz, text, integer) is
  'Inbox (T-202): the lane''s inbox metadata, newest first, filtered, keyset-paged, at most 100 rows. Invoker: RLS on comms.message_index applies.';
revoke all on function core.inbox_messages(text, text, timestamptz, text, integer) from public, anon;
grant execute on function core.inbox_messages(text, text, timestamptz, text, integer) to authenticated;

-- One message the caller may see (any folder, not deleted), with the connection it came from: the app checks this
-- before fetching the body live. No row = not visible (other lane, no comms view, AAL1, unknown id).
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
  source_url text
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
         m.subject, m.received_at, m.is_read, m.is_important, m.has_attachments, m.source_url
  from comms.message_index m
  where m.lane_id = p_lane and m.message_id = p_message_id and not m.deleted
  order by m.received_at desc
  limit 1;
end;
$$;
comment on function core.inbox_message_ref(text, text) is
  'Inbox (T-202): one visible message''s metadata and connection, checked before the app reads the body live. Invoker: RLS applies.';
revoke all on function core.inbox_message_ref(text, text) from public, anon;
grant execute on function core.inbox_message_ref(text, text) to authenticated;
