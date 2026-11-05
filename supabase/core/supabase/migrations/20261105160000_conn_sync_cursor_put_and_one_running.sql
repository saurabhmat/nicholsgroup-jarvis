-- T-038: the generic connector sync job (conn.sync).
--
-- 1. One running sync per connection (backstop to the Inngest concurrency key): a partial unique index on
--    core.sync_runs (connection_id) where status = 'running'. A second start gets 23505 and the job skips. A run that
--    died without finishing is cancelled by the next start (see the job), so the index never blocks a connection for good.
-- 2. core.sync_cursor_put: compare-and-swap write of a stream's cursor, for connectors that sync through the generic
--    contract (Connector.sync). The Gmail and Calendar applies keep storing their own cursors with their pages.
--    service_role has no table grants on core.sync_cursors; like the other cursor functions this one is security definer,
--    lane-checked, and refuses a connection that is not usable. It writes only the generic stream 'default': the 'mail'
--    and 'calendar' cursors must move only together with their pages, inside the apply functions.

-- Rows left open before this index existed (none expected) are closed so the index can be built. (No explicit table
-- lock: the migration runner does not open a transaction block. A run starting in the gap would only make the index
-- build fail and the migration stop; no sync job runs before this migration ships.)
update core.sync_runs set status = 'cancelled', finished_at = now() where status = 'running';

create unique index sync_runs_one_running_idx on core.sync_runs (connection_id) where status = 'running';

-- p_expected: the cursor the run read (null = none stored). p_cursor: the new cursor. Returns true when stored, false
-- when the stored cursor is no longer p_expected (another run got there first; nothing is written).
create function core.sync_cursor_put(p_lane text, p_connection_id uuid, p_stream text, p_expected text, p_cursor text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current text;
begin
  if p_lane is null or p_connection_id is null or p_stream is null or p_cursor is null then
    raise exception 'lane, connection, stream and cursor are required' using errcode = '22004';
  end if;
  if p_stream <> 'default' or length(p_cursor) not between 1 and 16384 or p_cursor ~ '[[:cntrl:]]' then
    raise exception 'invalid stream or cursor' using errcode = '22023';
  end if;
  -- Same key as the mail apply (core.comms_mail_apply_page); the calendar apply locks on '<id>:calendar'. Both only
  -- matter for their own streams, which this function cannot write. Taken before the usable check, so a connection
  -- that moves to reconnect_required meanwhile is seen.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_connection_id::text, 63));
  if not exists (select 1 from core.connections c
                 join core.lanes l on l.code = c.lane_id and l.enabled
                 where c.id = p_connection_id and c.lane_id = p_lane and c.status in ('active', 'degraded')) then
    raise exception 'usable connection not found in this lane' using errcode = '42501';
  end if;
  select s.cursor_value into v_current
  from core.sync_cursors s
  where s.connection_id = p_connection_id and s.lane_id = p_lane and s.stream = p_stream;
  if v_current is distinct from p_expected then
    return false;
  end if;
  insert into core.sync_cursors (lane_id, connection_id, stream, cursor_value)
  values (p_lane, p_connection_id, p_stream, p_cursor)
  on conflict (connection_id, stream) do update set cursor_value = excluded.cursor_value;
  return true;
end;
$$;
comment on function core.sync_cursor_put(text, uuid, text, text, text) is
  'Compare-and-swap write of the generic ''default'' sync cursor (T-038). Service_role only, lane-checked, usable connections only; never the mail or calendar cursors.';
revoke all on function core.sync_cursor_put(text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function core.sync_cursor_put(text, uuid, text, text, text) to service_role;
