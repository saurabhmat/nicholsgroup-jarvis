-- T-282: the portal's own read markers for Microsoft Teams chats (docs/specs/messages.md 7.2, 8.1; decision D-62, Q-M5: the portal does NOT mark chats read at Microsoft).
-- comms.teams_chat_reads holds, per Teams connection and chat, the `createdDateTime` of the newest message the person was shown when they opened the chat in the portal. NOTHING else
-- (rule 6): no topic, member, preview, message id or sender. Columns: lane_id, connection_id, chat_id (Graph's `19:...` id, at most 200 characters), read_through (Microsoft's clock,
-- not ours), updated_at.
--   * RLS: select only, for the OWNER of the Teams connection at AAL2 (`core.teams_connection_ids`, T-278: owner = the caller, provider microsoft_teams, the lane in the caller's own_mail
--     lanes). An admin, another member and another lane see nothing. No write grant to any role: rows are written only by comms.teams_chat_read_mark.
--   * comms.teams_chat_read_mark (security definer): the caller must own the Teams connection of that lane (one answer, P0002, for an unknown id, another lane's and another person's, so nothing is
--     revealed); the marker only moves FORWARD; a time more than 5 minutes ahead of now() is refused; at most 1,000 rows per connection (the least recently touched are removed).
--   * `comms` is not exposed to PostgREST (README): the app reaches the table through two thin SECURITY INVOKER wrappers in `core` (as core.act_* for approvals): core.teams_chat_reads_list
--     (RLS applies) and core.teams_chat_read_mark.
--   * Deletion: core.teams_chat_reads_purge_connection (service_role; called by the Teams disconnect purger) and core.teams_chat_reads_purge (service_role; the T-042 retention job, class
--     "policy": rows untouched for 90 days, and every row of a disconnected connection).
-- A marker is touched (updated_at) each time the person opens the chat, so an active chat never ages out. Nothing in this migration changes an existing object.
-- Tests: 329_teams_chat_reads.test.sql.

create table comms.teams_chat_reads (
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  connection_id uuid not null,
  -- the Graph chat id (`19:...`); the bound is the same one the app uses before any request
  chat_id text not null check (chat_id ~ '^19:[A-Za-z0-9._@:-]{1,197}$'),
  -- Microsoft's clock: the createdDateTime of the newest message shown
  read_through timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (connection_id, chat_id),
  foreign key (connection_id, lane_id) references core.connections (id, lane_id) on update restrict on delete restrict
);
comment on table comms.teams_chat_reads is
  'T-282: the portal''s own read marker per Teams connection and chat (ids and a timestamp only, rule 6). Owner-only select at AAL2; written only by comms.teams_chat_read_mark; at most 1000 rows per connection; deleted on disconnect and after 90 days.';
comment on column comms.teams_chat_reads.read_through is
  'createdDateTime (Microsoft''s clock) of the newest message the person was shown when they opened the chat in the portal.';
create index teams_chat_reads_touched_idx on comms.teams_chat_reads (connection_id, updated_at desc);
create index teams_chat_reads_retention_idx on comms.teams_chat_reads (lane_id, updated_at);

-- A marker belongs to a Microsoft Teams connection and to nothing else (the composite foreign key proves the lane; this proves the provider).
create function comms.teams_chat_reads_provider_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from core.connections c where c.id = new.connection_id and c.lane_id = new.lane_id and c.provider = 'microsoft_teams') then
    raise exception 'comms.teams_chat_reads: not a Teams connection of this lane' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function comms.teams_chat_reads_provider_guard() from public, anon, authenticated;
create trigger teams_chat_reads_provider_guard before insert or update of connection_id, lane_id on comms.teams_chat_reads
  for each row execute function comms.teams_chat_reads_provider_guard();

alter table comms.teams_chat_reads enable row level security;
create policy teams_chat_reads_select on comms.teams_chat_reads
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and connection_id = any (core.teams_connection_ids((select auth.uid()), lane_id))
  );
revoke all on comms.teams_chat_reads from public, anon, authenticated, service_role;
grant select on comms.teams_chat_reads to authenticated;

-- ---------------------------------------------------------------- the one writer
create function comms.teams_chat_read_mark(p_lane text, p_connection uuid, p_chat text, p_read_through timestamptz)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_rt timestamptz;
begin
  if v_uid is null or p_lane is null or p_connection is null then
    raise exception 'teams read marker: not found' using errcode = 'P0002';
  end if;
  -- the caller must own a Teams connection with this id in this lane, at AAL2 with own_mail there (core.teams_connection_ids fails closed otherwise)
  if not (p_connection = any (core.teams_connection_ids(v_uid, p_lane))) then
    raise exception 'teams read marker: not found' using errcode = 'P0002';
  end if;
  if p_chat is null or p_chat !~ '^19:[A-Za-z0-9._@:-]{1,197}$' then
    raise exception 'teams read marker: chat id is not valid' using errcode = '22023';
  end if;
  if p_read_through is null or p_read_through > pg_catalog.now() + interval '5 minutes' or p_read_through < timestamptz '2020-01-01 00:00:00+00' then
    raise exception 'teams read marker: time is not valid' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('teams_chat_reads:' || p_connection::text, 0));
  insert into comms.teams_chat_reads as r (lane_id, connection_id, chat_id, read_through, updated_at)
  values (p_lane, p_connection, p_chat, p_read_through, pg_catalog.now())
  on conflict (connection_id, chat_id) do update
    set read_through = greatest(r.read_through, excluded.read_through), updated_at = pg_catalog.now()
  returning r.read_through into v_rt;
  -- at most 1000 per connection: the least recently touched go (never the one just written)
  delete from comms.teams_chat_reads d
  where d.connection_id = p_connection
    and d.chat_id in (
      select o.chat_id from comms.teams_chat_reads o
      where o.connection_id = p_connection and o.chat_id <> p_chat
      order by o.updated_at desc, o.chat_id
      offset 999
    );
  return v_rt;
end;
$$;
comment on function comms.teams_chat_read_mark(text, uuid, text, timestamptz) is
  'T-282: records that the caller has seen a Teams chat up to a message time. Owner of the connection only (one answer, P0002, otherwise); forward only; not more than 5 minutes ahead of now(); at most 1000 rows per connection. Returns the stored time.';
revoke all on function comms.teams_chat_read_mark(text, uuid, text, timestamptz) from public, anon, service_role;
grant execute on function comms.teams_chat_read_mark(text, uuid, text, timestamptz) to authenticated;

-- ---------------------------------------------------------------- the thin wrappers in `core` (the only schema PostgREST exposes besides public)
create function core.teams_chat_reads_list(p_lane text, p_connection uuid)
returns table (chat_id text, read_through timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select r.chat_id, r.read_through
  from comms.teams_chat_reads r
  where r.lane_id = p_lane and r.connection_id = p_connection
  order by r.updated_at desc
  limit 1000;
$$;
comment on function core.teams_chat_reads_list(text, uuid) is
  'T-282: the caller''s own read markers of one Teams connection (chat id and time). Invoker: RLS applies (owner of the connection, AAL2); anyone else gets no rows.';
revoke all on function core.teams_chat_reads_list(text, uuid) from public, anon, service_role;
grant execute on function core.teams_chat_reads_list(text, uuid) to authenticated;

create function core.teams_chat_read_mark(p_lane text, p_connection uuid, p_chat text, p_read_through timestamptz)
returns timestamptz
language sql
security invoker
set search_path = ''
as $$
  select comms.teams_chat_read_mark(p_lane, p_connection, p_chat, p_read_through);
$$;
comment on function core.teams_chat_read_mark(text, uuid, text, timestamptz) is 'T-282: wrapper of comms.teams_chat_read_mark (comms is not exposed to PostgREST).';
revoke all on function core.teams_chat_read_mark(text, uuid, text, timestamptz) from public, anon, service_role;
grant execute on function core.teams_chat_read_mark(text, uuid, text, timestamptz) to authenticated;

-- ---------------------------------------------------------------- deletion
create function core.teams_chat_reads_purge_connection(p_lane text, p_connection uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_lane is null or p_connection is null or not exists (select 1 from core.lanes l where l.code = p_lane and l.enabled) then
    raise exception 'lane is not available' using errcode = '42501';
  end if;
  delete from comms.teams_chat_reads r where r.lane_id = p_lane and r.connection_id = p_connection;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
comment on function core.teams_chat_reads_purge_connection(text, uuid) is
  'T-282: deletes every read marker of one Teams connection (called by the Teams disconnect, spec 5). service_role only; the lane must be enabled and is part of the key.';
revoke all on function core.teams_chat_reads_purge_connection(text, uuid) from public, anon, authenticated;
grant execute on function core.teams_chat_reads_purge_connection(text, uuid) to service_role;

create function core.teams_chat_reads_purge(p_lane text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_lane is null or not exists (select 1 from core.lanes l where l.code = p_lane and l.enabled) then
    raise exception 'lane is not available' using errcode = '42501';
  end if;
  -- every marker of a disconnected connection (a disconnect whose purger failed must not leave them), and every marker untouched for 90 days (a fixed window, class "policy")
  delete from comms.teams_chat_reads r
  where r.lane_id = p_lane
    and (r.updated_at < pg_catalog.now() - interval '90 days'
         or exists (select 1 from core.connections c where c.id = r.connection_id and c.lane_id = r.lane_id and c.status = 'disconnected'));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
comment on function core.teams_chat_reads_purge(text) is
  'Retention (T-282, called by the T-042 purge job): deletes a lane''s Teams read markers untouched for a fixed 90 days and those of disconnected connections. service_role only.';
revoke all on function core.teams_chat_reads_purge(text) from public, anon, authenticated;
grant execute on function core.teams_chat_reads_purge(text) to service_role;
