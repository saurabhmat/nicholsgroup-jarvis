-- T-247 part 1: every mailbox has an owner, and the new view `own_mail` ("my own mailboxes only").
-- Decisions (Saurabh, Nov 14, 2026): every member sees only their own mail, admin_technical included; Saurabh's existing
-- pub-k.org mailbox and its data become his only.
--   * core.connections.owner_user_id: the user whose mailbox/calendar this is. Set at connect time to the signed-in user.
--     Only Google/Microsoft (mail and calendar, native and Composio) rows carry an owner; QuickBooks and the other providers
--     never do (check). A mail row without an owner is invisible to every user (fail closed): the connect code always sets it and
--     the production check (part 25) asserts none exists. It never changes once set (trigger); null -> value is allowed ONCE
--     (service_role only) so legacy rows can be claimed by a reviewed backfill.
--   * Backfill from created_by for Google/Microsoft rows (who clicked Connect).
--   * core.view_names() gets 'own_mail'; owner, admin_technical and viewer hold it (finance_operator does not). It grants only the
--     caller's own mailboxes: content is readable through mailbox ownership, never through a lane role.
--   * core.mailbox_ids(uid, lane): the connection ids a user owns (the one place that rule is written). Policies and readers use it.
--   * core.connections RLS: a member reads the rows of their own mailboxes (own_mail view + owner_user_id = auth.uid()); the
--     `connections` view (owner, admin_technical) still reads every connection's HEALTH columns of the lane, as before.
-- Tests: 319_mail_ownership.test.sql.

-- ---------------------------------------------------------------- column, backfill, rules
alter table core.connections add column if not exists owner_user_id uuid references core.users (id) on update restrict on delete restrict;
comment on column core.connections.owner_user_id is
  'T-247: the user who owns this mailbox/calendar connection (Google, Microsoft; native and Composio). Null for QuickBooks and other providers. Set at connect time, never changed.';
create index if not exists connections_owner_user_idx on core.connections (owner_user_id) where owner_user_id is not null;

update core.connections set owner_user_id = created_by
 where provider in ('google', 'microsoft') and owner_user_id is null and created_by is not null;

alter table core.connections drop constraint if exists connections_owner_only_mail;
alter table core.connections add constraint connections_owner_only_mail
  check (owner_user_id is null or provider in ('google', 'microsoft'));

create or replace function core.connections_identity_immutable() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.lane_id is distinct from old.lane_id or new.provider is distinct from old.provider
     or new.external_account_id is distinct from old.external_account_id
     or new.transport is distinct from old.transport or new.toolkit is distinct from old.toolkit
     or (old.account_identity is not null and new.account_identity is distinct from old.account_identity) then
    raise exception 'core.connections: lane, provider, account, transport and toolkit cannot change' using errcode = '42501';
  end if;
  -- T-247: the owner is set once (a legacy row has none) and never changes or clears.
  if old.owner_user_id is not null and new.owner_user_id is distinct from old.owner_user_id then
    raise exception 'core.connections: the owner cannot change' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function core.connections_identity_immutable() from public, anon, authenticated;

grant select (owner_user_id) on core.connections to authenticated;

-- ---------------------------------------------------------------- the view
create or replace function core.view_names() returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'lanes', 'lane_policies', 'memberships', 'action_index',                  -- registry and administration
    'finance', 'approvals', 'assistant', 'briefing', 'comms', 'calendar',     -- content
    'documents', 'projects', 'commitments', 'memory', 'brain',
    'own_mail',                                                               -- the caller's own mailboxes only (T-247)
    'connections', 'health', 'jobs', 'config', 'audit'                        -- operations (no content)
  ]::text[];
$$;
revoke all on function core.view_names() from public, anon;
grant execute on function core.view_names() to authenticated, service_role;

create or replace function core.role_views(p_role text) returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_role
    when 'owner' then core.view_names()
    when 'finance_operator' then array['lanes', 'action_index', 'finance', 'assistant']::text[]
    when 'admin_technical' then array['lanes', 'action_index', 'lane_policies', 'memberships', 'connections', 'health', 'jobs', 'config', 'own_mail']::text[]
    when 'viewer' then array['lanes', 'action_index', 'own_mail']::text[]
    else '{}'::text[]
  end;
$$;
revoke all on function core.role_views(text) from public, anon;
grant execute on function core.role_views(text) to authenticated, service_role;

-- ---------------------------------------------------------------- mailbox ownership (one definition)
-- The Google/Microsoft connections p_uid owns (in p_lane, or in every lane when null) while p_uid holds own_mail there. Fails closed:
-- empty unless core.may_resolve(p_uid) (the caller's own uid at AAL2, or the service role asking on a job's behalf), and only for
-- enabled lanes (allowed_lanes). Definer: reads core.connections without needing the `connections` view.
create function core.mailbox_ids(p_uid uuid, p_lane text default null) returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(c.id order by c.id), '{}'::uuid[])
  from core.connections c
  where core.may_resolve(p_uid)
    and p_uid is not null
    and c.owner_user_id = p_uid
    and c.provider in ('google', 'microsoft')
    and (p_lane is null or c.lane_id = p_lane)
    and c.lane_id = any (core.allowed_lanes(p_uid, 'own_mail'));
$$;
comment on function core.mailbox_ids(uuid, text) is
  'T-247: ids of the mail/calendar connections p_uid owns (in p_lane, or any lane when null), while p_uid holds own_mail there. Empty unless p_uid is the caller at AAL2 or the caller is service_role.';
revoke all on function core.mailbox_ids(uuid, text) from public, anon;
grant execute on function core.mailbox_ids(uuid, text) to authenticated, service_role;

-- True when p_uid may be given briefings in p_lane: holds own_mail there (a member with a mailbox of their own).
create function core.may_brief(p_uid uuid, p_lane text) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_lane is not null and p_lane = any (core.allowed_lanes(p_uid, 'own_mail'));
$$;
comment on function core.may_brief(uuid, text) is 'T-247: p_uid holds own_mail in p_lane (the gate of the briefing functions, replacing owner role + briefing view). Same resolution rules as allowed_lanes.';
revoke all on function core.may_brief(uuid, text) from public, anon;
grant execute on function core.may_brief(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------- core.connections RLS
drop policy if exists connections_select on core.connections;
create policy connections_select on core.connections
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and (
      -- health of the lane's connections (owner, admin_technical): status, last sync, error, provider, account address
      lane_id = any ((select core.allowed_lanes((select auth.uid()), 'connections'))::text[])
      -- a member's own mailboxes
      or (owner_user_id = (select auth.uid())
          and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'own_mail'))::text[]))
    )
  );
