-- T-012: users, lane memberships, roles, and the real core.allowed_lanes() (architecture §5.4).
-- Replaces T-010's fail-closed placeholder. Requirements from the T-010 security review (M2, L2): security definer
-- with an empty search_path; answers only for the caller's own uid at AAL2 (service_role may ask for any uid); only
-- enabled lanes. No DML for anon/authenticated: users and memberships are managed by service-role code.

-- ---------------------------------------------------------------- views and roles

-- Every view name a policy may pass to allowed_lanes(). Adding a module's view = `create or replace` here (reviewed).
-- Removing one needs a data migration for memberships.views (the check below is not re-validated); allowed_lanes()
-- also intersects with this list, so a removed name stops granting access at once.
create function core.view_names() returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'lanes', 'lane_policies', 'memberships', 'action_index',                  -- registry and administration
    'finance', 'approvals', 'assistant', 'briefing', 'comms', 'calendar',     -- content
    'documents', 'projects', 'commitments', 'memory',
    'connections', 'health', 'jobs', 'config', 'audit'                        -- operations (no content)
  ]::text[];
$$;

-- Content views a viewer may be granted by name (architecture §5.4, e.g. NL weekly cash). Never administration,
-- operations, approvals or the assistant.
create function core.viewer_view_names() returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['finance', 'briefing', 'projects', 'calendar', 'commitments']::text[];
$$;

-- Views each role gets in a lane it belongs to. A viewer additionally gets the named views on its membership.
-- admin_technical has no content view (architecture §5.4); break-glass access is a separate, time-boxed grant.
-- 'approvals' is owner-only here: a proposer (e.g. finance_operator) sees its own proposals through the act.* policy's
-- proposer clause (docs/specs/approvals.md §4). 'action_index' (status counts, no content) is for every member.
create function core.role_views(p_role text) returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_role
    when 'owner' then core.view_names()
    when 'finance_operator' then array['lanes', 'action_index', 'finance', 'assistant']::text[] -- assistant: Oct 31, 2026
    when 'admin_technical' then array['lanes', 'action_index', 'lane_policies', 'memberships', 'connections', 'health', 'jobs', 'config']::text[]
    when 'viewer' then array['lanes', 'action_index']::text[]
    else '{}'::text[]
  end;
$$;

revoke all on function core.view_names() from public, anon;
revoke all on function core.viewer_view_names() from public, anon;
revoke all on function core.role_views(text) from public, anon;
grant execute on function core.view_names(), core.viewer_view_names(), core.role_views(text) to authenticated, service_role;

-- ---------------------------------------------------------------- core.users

create table core.users (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (display_name = btrim(display_name) and length(display_name) between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table core.users is 'Portal users (one per Supabase Auth user). Authorization comes from core.memberships only.';

create trigger users_set_updated_at before update on core.users
  for each row execute function core.set_updated_at();

-- ---------------------------------------------------------------- core.memberships

create table core.memberships (
  user_id uuid not null references core.users (id) on delete cascade,
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  role text not null check (role in ('owner', 'finance_operator', 'viewer', 'admin_technical')),
  -- Named views a viewer may open in this lane (e.g. 'finance'). Only viewers carry them.
  views text[] not null default '{}' check (array_position(views, null) is null and views <@ core.viewer_view_names()),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, lane_id),
  check (role = 'viewer' or views = '{}')
);
comment on table core.memberships is 'One role per user per lane (architecture §5.4). Read through core.allowed_lanes().';

create index memberships_lane_id_idx on core.memberships (lane_id);

create trigger memberships_set_updated_at before update on core.memberships
  for each row execute function core.set_updated_at();

-- ---------------------------------------------------------------- core.allowed_lanes (replaces the T-010 placeholder)

-- True when the caller may ask about p_uid: it is the caller itself at aal2, or the session's database role is
-- service_role (jobs). The role is the one PostgREST set from the verified JWT (`set role`), read from the `role`
-- setting; inside a security-definer function that is still the caller's role. JWT claims alone are not trusted
-- for this, because any session can set request.jwt.claims.
create function core.may_resolve(p_uid uuid) returns boolean
language sql
stable
set search_path = ''
as $$
  select p_uid is not null and (
    pg_catalog.current_setting('role', true) = 'service_role'
    or (p_uid = (select auth.uid()) and (select auth.jwt() ->> 'aal') = 'aal2')
  );
$$;
revoke all on function core.may_resolve(uuid) from public, anon, authenticated;

-- Lanes in which p_uid may open p_view. Fails closed (empty array) unless core.may_resolve(p_uid), the lane is
-- enabled, and p_uid's membership role (or a viewer's named views) includes p_view, a currently known view name.
-- Security definer so RLS policies can call it without granting users read access to other members' rows.
create or replace function core.allowed_lanes(p_uid uuid, p_view text) returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.lane_id order by m.lane_id), '{}'::text[])
  from core.memberships m
  join core.lanes l on l.code = m.lane_id
  where core.may_resolve(p_uid)
    and p_view is not null
    and m.user_id = p_uid
    and l.enabled
    and p_view = any (core.role_views(m.role) || m.views)
    and p_view = any (core.view_names());
$$;
comment on function core.allowed_lanes(uuid, text) is
  'Lanes where p_uid may open p_view. Own uid at aal2 only (service_role: any uid); enabled lanes only.';
-- `create or replace` keeps the T-010 grants; restate them so this file is the reference.
revoke all on function core.allowed_lanes(uuid, text) from public, anon;
grant execute on function core.allowed_lanes(uuid, text) to authenticated, service_role;

-- True when p_uid holds one of p_roles in an enabled lane p_lane, under the same rules as allowed_lanes(). For
-- actions a view does not imply, e.g. finance sign-off (owner, finance_operator) that a viewer with the 'finance'
-- view must not perform.
create function core.has_lane_role(p_uid uuid, p_lane text, p_roles text[]) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from core.memberships m
    join core.lanes l on l.code = m.lane_id
    where core.may_resolve(p_uid)
      and m.user_id = p_uid
      and m.lane_id = p_lane
      and l.enabled
      and m.role = any (p_roles)
  );
$$;
revoke all on function core.has_lane_role(uuid, text, text[]) from public, anon;
grant execute on function core.has_lane_role(uuid, text, text[]) to authenticated, service_role;

-- ---------------------------------------------------------------- RLS

alter table core.users enable row level security;
alter table core.memberships enable row level security;

-- A user reads their own memberships; roles with the 'memberships' view (owner, admin_technical) read the lane's.
create policy memberships_select on core.memberships
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and (
      user_id = (select auth.uid())
      or lane_id = any ((select core.allowed_lanes((select auth.uid()), 'memberships'))::text[])
    )
  );

-- A user reads their own profile, and the profiles of members in lanes where they hold the 'memberships' view.
create policy users_select on core.users
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and (
      id = (select auth.uid())
      or exists (
        select 1 from core.memberships m
        where m.user_id = core.users.id
          and m.lane_id = any ((select core.allowed_lanes((select auth.uid()), 'memberships'))::text[])
      )
    )
  );

revoke all on core.users, core.memberships from public, anon, authenticated;
grant select on core.users, core.memberships to authenticated;
grant select, insert, update, delete on core.users, core.memberships to service_role;
