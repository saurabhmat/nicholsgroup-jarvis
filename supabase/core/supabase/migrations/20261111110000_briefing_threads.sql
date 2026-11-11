-- Home briefing reads, part 2 (T-231b): thread-level mail METADATA for "Needs your attention" and the Money card.
-- No table is added and no content is read: comms.message_index holds metadata only (rule 6). The rules themselves
-- (priority senders, exclusions, security alerts, money patterns) run in the app from lane_config, so a lane changes them
-- by configuration.
--
-- core.briefing_threads(p_lane, p_since): one row per mail thread active since p_since (at most 14 days back) that has
-- a message in the inbox: the latest INBOUND message (not carrying Gmail's SENT label) with its sender, subject, time,
-- labels and link; whether the latest message of the whole thread is the owner's own (SENT), so a thread already
-- answered does not count as waiting; whether the owner ever wrote in the thread; unread inbound count; inbound count.
-- At most 300 threads, newest first. SECURITY INVOKER: RLS on comms.message_index applies (AAL2 + comms view), so a
-- caller who may not read the lane's mail gets no rows. Tests: 281_briefing_threads.test.sql.

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
  last_at timestamptz
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
  if p_since < pg_catalog.now() - interval '14 days' then
    raise exception 'since must be within the last 14 days' using errcode = '22023';
  end if;
  return query
  with msgs as (
    select m.connection_id, coalesce(m.thread_id, 'm:' || m.message_id) as tkey, m.message_id, m.from_address, m.from_name,
           m.subject, m.received_at, m.source_url, m.labels, m.is_important, m.is_read, m.folder,
           ('SENT' = any (m.labels)) as is_sent
    from comms.message_index m
    where m.lane_id = p_lane and not m.deleted and m.received_at >= p_since
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
         i.is_important, l.is_sent, t.owner_replied, t.unread_count, t.inbound_count, t.last_at
  from threads t
  join last_in i on i.connection_id = t.connection_id and i.tkey = t.tkey
  join last_msg l on l.connection_id = t.connection_id and l.tkey = t.tkey
  where t.in_inbox
  order by t.last_at desc
  limit 300;
end;
$$;
comment on function core.briefing_threads(text, timestamptz) is
  'Home briefing (T-231b): per inbox thread since a time at most 14 days back, the latest inbound message metadata, whether the owner answered last / ever, unread and inbound counts. Metadata only. Invoker: RLS on comms.message_index applies.';
revoke all on function core.briefing_threads(text, timestamptz) from public, anon;
grant execute on function core.briefing_threads(text, timestamptz) to authenticated, service_role;
