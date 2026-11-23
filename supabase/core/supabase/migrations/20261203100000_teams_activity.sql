-- T-289: new-message notices for Microsoft Teams (docs/specs/messages.md 7.3, 7.4, 9; decision D-62). Two things, both additive:
--
-- 1. core.push_subscriptions accepts the resource `teams_chats` (the all-chats subscription of one Teams connection), and two new checks tie the columns together:
--      * `(provider = 'microsoft_teams') = (resource = 'teams_chats')`: a `teams_chats` row exists only for a Teams connection and a Teams connection has no other resource
--        (mail and calendar rows, provider `microsoft` and, should it ever be built, `google`, keep their resources; every existing row satisfies it);
--      * a `teams_chats` row's resource_path is exactly `users/<lower-case uuid>/chats/getAllMessages`.
--    No function of core.push_subscriptions is replaced: the record, lookup, renew, mark, remove and purge functions are provider-generic and unchanged.
--
-- 2. comms.teams_activity: per Teams connection, WHEN our receiver last accepted a valid `created` notification and when the owner last opened the chat list. Columns (rule 6: no chat id, no
--    message id, no sender, no text; the receiver never reads a notification's `resource`): lane_id, connection_id (primary key), last_notice_at, notices_since_seen (0..999), last_seen_at,
--    updated_at.
--      * RLS: select only, for the OWNER of the Teams connection at AAL2 (`core.teams_connection_ids`, as comms.teams_chat_reads). An admin, another member and another lane see nothing. No write
--        grant to any role.
--      * comms.teams_activity_notice(p_lane, p_connection): the service-only writer (a valid notification arrived). The connection must be a usable (active or degraded) Teams connection of an
--        enabled lane; one answer (P0002) otherwise.
--      * comms.teams_activity_seen(p_lane, p_connection): the owner-only writer (the owner opened the chat list). One answer (P0002) for an unknown, another lane's and another person's connection.
--      * `comms` is not exposed to PostgREST, so the API reaches the writers through thin SECURITY INVOKER wrappers in `core` (core.teams_activity_notice: service_role; core.teams_activity_seen:
--        authenticated), and the owner's one read through core.teams_activity_get (security definer, owner only, returns four values: whether a live subscription exists and until when, last_notice_at, last_seen_at;
--        a Teams-only viewer cannot read core.push_subscriptions, so this is the one place the "notices are on" fact is derived).
--      * Deletion: core.teams_activity_purge_connection (service_role; the Teams disconnect purger) and core.teams_activity_purge (service_role; the T-042 retention job: every row of a disconnected
--        connection, so a disconnect whose purger failed leaves nothing). A paused lane's row stays until the connection is disconnected.
-- Tests: 331_teams_activity.test.sql (and 326/328 assertions for the push_subscriptions checks).

-- ---------------------------------------------------------------- 1. core.push_subscriptions
alter table core.push_subscriptions drop constraint push_subscriptions_resource_check;
alter table core.push_subscriptions add constraint push_subscriptions_resource_check
  check (resource in ('mail', 'calendar', 'teams_chats'));
alter table core.push_subscriptions add constraint push_subscriptions_provider_resource_check
  check ((provider = 'microsoft_teams') = (resource = 'teams_chats'));
alter table core.push_subscriptions add constraint push_subscriptions_teams_path_check
  check (resource <> 'teams_chats' or resource_path ~ '^users/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/chats/getAllMessages$');
comment on constraint push_subscriptions_provider_resource_check on core.push_subscriptions is
  'T-289: a teams_chats subscription belongs to a microsoft_teams connection and to nothing else; mail and calendar subscriptions never do.';

-- ---------------------------------------------------------------- 2. comms.teams_activity
create table comms.teams_activity (
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  connection_id uuid primary key,
  -- OUR clock: when the receiver accepted the latest valid `created` notification of this connection's subscription
  last_notice_at timestamptz,
  -- notices accepted since the owner last opened the chat list; a number only, capped (the receiver does not know which chat or whose message)
  notices_since_seen integer not null default 0 check (notices_since_seen between 0 and 999),
  -- when the owner last loaded the chat list on Messages
  last_seen_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (connection_id, lane_id) references core.connections (id, lane_id) on update restrict on delete restrict
);
comment on table comms.teams_activity is
  'T-289: per Teams connection, when a valid new-message notice last arrived and when the owner last opened the chat list (times and a capped counter only, rule 6). Owner-only select at AAL2; written only by comms.teams_activity_notice (service) and comms.teams_activity_seen (owner); deleted on disconnect.';
comment on column comms.teams_activity.last_notice_at is 'Time of OUR clock at which the receiver accepted the latest valid created notification (never read from its content).';
comment on column comms.teams_activity.notices_since_seen is 'Notifications accepted since the owner last opened the chat list; at most 999. Not shown as a count (it includes the owner''s own messages).';
create index teams_activity_lane_idx on comms.teams_activity (lane_id);

-- An activity row belongs to a Microsoft Teams connection and to nothing else (the composite foreign key proves the lane; this proves the provider).
create function comms.teams_activity_provider_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from core.connections c where c.id = new.connection_id and c.lane_id = new.lane_id and c.provider = 'microsoft_teams') then
    raise exception 'comms.teams_activity: not a Teams connection of this lane' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function comms.teams_activity_provider_guard() from public, anon, authenticated;
create trigger teams_activity_provider_guard before insert or update of connection_id, lane_id on comms.teams_activity
  for each row execute function comms.teams_activity_provider_guard();

alter table comms.teams_activity enable row level security;
create policy teams_activity_select on comms.teams_activity
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and connection_id = any (core.teams_connection_ids((select auth.uid()), lane_id))
  );
revoke all on comms.teams_activity from public, anon, authenticated, service_role;
grant select on comms.teams_activity to authenticated;

-- ---------------------------------------------------------------- the service-only writer: a valid notification arrived
create function comms.teams_activity_notice(p_lane text, p_connection uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  if p_lane is null or p_connection is null then
    raise exception 'teams activity: not found' using errcode = 'P0002';
  end if;
  -- only a usable Teams connection of an enabled lane (one answer for every other case)
  if not exists (
    select 1 from core.connections c join core.lanes l on l.code = c.lane_id and l.enabled
    where c.id = p_connection and c.lane_id = p_lane and c.provider = 'microsoft_teams' and c.status in ('active', 'degraded')
  ) then
    raise exception 'teams activity: not found' using errcode = 'P0002';
  end if;
  insert into comms.teams_activity as a (lane_id, connection_id, last_notice_at, notices_since_seen, updated_at)
  values (p_lane, p_connection, pg_catalog.now(), 1, pg_catalog.now())
  on conflict (connection_id) do update
    set last_notice_at = pg_catalog.now(),
        notices_since_seen = least(a.notices_since_seen + 1, 999),
        updated_at = pg_catalog.now()
  returning a.last_notice_at into v_at;
  return v_at;
end;
$$;
comment on function comms.teams_activity_notice(text, uuid) is
  'T-289: records that a valid new-message notification arrived for a usable Teams connection (time of our clock, a capped counter). service_role only; P0002 for an unknown, another lane''s or an unusable connection. No chat, message or sender is known or stored.';
revoke all on function comms.teams_activity_notice(text, uuid) from public, anon, authenticated;
grant execute on function comms.teams_activity_notice(text, uuid) to service_role;

-- ---------------------------------------------------------------- the owner-only writer: the chat list was opened
create function comms.teams_activity_seen(p_lane text, p_connection uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_at timestamptz;
begin
  if v_uid is null or p_lane is null or p_connection is null then
    raise exception 'teams activity: not found' using errcode = 'P0002';
  end if;
  -- the caller must own a Teams connection with this id in this lane, at AAL2 with own_mail there (core.teams_connection_ids fails closed otherwise)
  if not (p_connection = any (core.teams_connection_ids(v_uid, p_lane))) then
    raise exception 'teams activity: not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from core.connections c where c.id = p_connection and c.lane_id = p_lane and c.provider = 'microsoft_teams' and c.status in ('active', 'degraded')) then
    raise exception 'teams activity: not found' using errcode = 'P0002';
  end if;
  insert into comms.teams_activity as a (lane_id, connection_id, last_seen_at, notices_since_seen, updated_at)
  values (p_lane, p_connection, pg_catalog.now(), 0, pg_catalog.now())
  on conflict (connection_id) do update
    set last_seen_at = pg_catalog.now(), notices_since_seen = 0, updated_at = pg_catalog.now()
  returning a.last_seen_at into v_at;
  return v_at;
end;
$$;
comment on function comms.teams_activity_seen(text, uuid) is
  'T-289: the owner of a usable Teams connection opened the chat list: last_seen_at = now(), counter reset. Owner only, AAL2 (P0002 otherwise, one answer).';
revoke all on function comms.teams_activity_seen(text, uuid) from public, anon, service_role;
grant execute on function comms.teams_activity_seen(text, uuid) to authenticated;

-- ---------------------------------------------------------------- the thin wrappers in `core` (the only schema PostgREST exposes besides public)
create function core.teams_activity_notice(p_lane text, p_connection uuid)
returns timestamptz
language sql
security invoker
set search_path = ''
as $$
  select comms.teams_activity_notice(p_lane, p_connection);
$$;
comment on function core.teams_activity_notice(text, uuid) is 'T-289: wrapper of comms.teams_activity_notice for the teams-activity job (comms is not exposed to PostgREST). service_role only.';
revoke all on function core.teams_activity_notice(text, uuid) from public, anon, authenticated;
grant execute on function core.teams_activity_notice(text, uuid) to service_role;

create function core.teams_activity_seen(p_lane text, p_connection uuid)
returns timestamptz
language sql
security invoker
set search_path = ''
as $$
  select comms.teams_activity_seen(p_lane, p_connection);
$$;
comment on function core.teams_activity_seen(text, uuid) is 'T-289: wrapper of comms.teams_activity_seen (comms is not exposed to PostgREST). authenticated only; the caller must own the connection.';
revoke all on function core.teams_activity_seen(text, uuid) from public, anon, service_role;
grant execute on function core.teams_activity_seen(text, uuid) to authenticated;

-- ---------------------------------------------------------------- the owner's one read: "are notices on, and when did the last one arrive"
-- Security definer because a Teams-only viewer cannot read core.push_subscriptions (the health view); it returns THREE values about the caller's own connection and nothing else, and no row at all
-- for anyone who is not the owner of a usable Teams connection (the same checks as the writer). `live` = a subscription of the connection is active and not expired.
create function core.teams_activity_get(p_lane text, p_connection uuid)
returns table (live boolean, live_until timestamptz, last_notice_at timestamptz, last_seen_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or p_lane is null or p_connection is null then
    return;
  end if;
  if not (p_connection = any (core.teams_connection_ids(v_uid, p_lane))) then
    return;
  end if;
  return query
    select
      s.expires_at is not null,
      s.expires_at,
      a.last_notice_at,
      a.last_seen_at
    from (select 1) one
    left join lateral (
      select p.expires_at from core.push_subscriptions p
      where p.lane_id = p_lane and p.connection_id = p_connection and p.provider = 'microsoft_teams' and p.resource = 'teams_chats'
        and p.status = 'active' and p.expires_at > pg_catalog.now()
      order by p.expires_at desc limit 1
    ) s on true
    left join comms.teams_activity a on a.connection_id = p_connection and a.lane_id = p_lane
    where exists (select 1 from core.connections c where c.id = p_connection and c.lane_id = p_lane and c.provider = 'microsoft_teams' and c.status in ('active', 'degraded'));
end;
$$;
comment on function core.teams_activity_get(text, uuid) is
  'T-289: for the owner of a usable Teams connection (AAL2, own_mail): whether a live notice subscription exists (and until when) and the two activity times. No row for anyone else. Reads no chat, message or sender (none is stored).';
revoke all on function core.teams_activity_get(text, uuid) from public, anon, service_role;
grant execute on function core.teams_activity_get(text, uuid) to authenticated;

-- ---------------------------------------------------------------- deletion
create function core.teams_activity_purge_connection(p_lane text, p_connection uuid)
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
  delete from comms.teams_activity a where a.lane_id = p_lane and a.connection_id = p_connection;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
comment on function core.teams_activity_purge_connection(text, uuid) is
  'T-289: deletes the activity row of one Teams connection (called by the Teams disconnect, spec 5). service_role only; the lane must be enabled and is part of the key.';
revoke all on function core.teams_activity_purge_connection(text, uuid) from public, anon, authenticated;
grant execute on function core.teams_activity_purge_connection(text, uuid) to service_role;

create function core.teams_activity_purge(p_lane text)
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
  -- the row of every disconnected connection (a disconnect whose purger failed must not leave it)
  delete from comms.teams_activity a
  where a.lane_id = p_lane
    and exists (select 1 from core.connections c where c.id = a.connection_id and c.lane_id = a.lane_id and c.status = 'disconnected');
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
comment on function core.teams_activity_purge(text) is
  'Retention (T-289, called by the T-042 purge job): deletes the activity rows of disconnected Teams connections. service_role only.';
revoke all on function core.teams_activity_purge(text) from public, anon, authenticated;
grant execute on function core.teams_activity_purge(text) to service_role;
