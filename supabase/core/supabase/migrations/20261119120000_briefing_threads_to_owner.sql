-- T-240: core.briefing_threads also returns last_to_owner: true when the latest inbound message of the thread has the
-- connection's mailbox address (core.connections.external_account_id, case-insensitive) in its TO list (not only Cc/Bcc).
-- Home shows "Waiting on you" only then. Only the boolean leaves the function, never a recipient or address list.
-- Invoker as before: RLS on comms.message_index applies, and core.connections is read under its own RLS (connections view at AAL2);
-- a role that cannot read the connection gets false (the chip is simply not shown). No new table.
-- Return type changes: dropped and recreated (grants repeated).

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
  is_auth_pass boolean,
  last_to_owner boolean
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
           (exists (select 1 from core.connections c, pg_catalog.jsonb_array_elements(m.to_recipients) e
                    where c.id = m.connection_id and c.lane_id = p_lane and c.external_account_id is not null
                      and pg_catalog.lower(e ->> 'address') = pg_catalog.lower(c.external_account_id))) as to_owner,
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
         i.is_important, l.is_sent, t.owner_replied, t.unread_count, t.inbound_count, t.last_at, i.is_bulk, i.is_calendar, i.is_auto, i.is_generated, i.is_auth_pass, i.to_owner
  from threads t
  join last_in i on i.connection_id = t.connection_id and i.tkey = t.tkey
  join last_msg l on l.connection_id = t.connection_id and l.tkey = t.tkey
  where t.in_inbox
  order by t.last_at desc
  limit 300;
end;
$$;
comment on function core.briefing_threads(text, timestamptz) is
  'Home briefing (T-231b; T-234: with the header-derived flags of the latest inbound message; T-240: last_to_owner): per inbox thread since a time at most 14 days back, the latest inbound message metadata, whether the owner answered last / ever, unread and inbound counts. Metadata only. Invoker: RLS on comms.message_index applies.';

revoke all on function core.briefing_threads(text, timestamptz) from public, anon;
grant execute on function core.briefing_threads(text, timestamptz) to authenticated, service_role;

