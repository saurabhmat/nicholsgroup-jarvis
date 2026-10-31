-- T-010: lane registry and lane policies (architecture §5.1, §5.3; D-19 for store_outbound_drafts).
-- Read-only for signed-in users at AAL2 in the lanes they belong to; no DML for anon or authenticated (changes go
-- through service-role code). Lane rows are reference data: the seed inserts them locally; production rows are
-- inserted by a human (see .agent/pr/T-010.md).

create schema if not exists core;
revoke all on schema core from public, anon;
grant usage on schema core to authenticated, service_role;

-- ---------------------------------------------------------------- helpers

create function core.set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function core.set_updated_at() from public, anon, authenticated;

-- Placeholder until T-012: the lanes a user may read for a named view. Returns no lanes, so every lane-scoped read
-- is denied (fail closed). T-012 replaces it (`create or replace`, same signature) with the security-definer version
-- that reads core.memberships. T-012 requirements (T-010 security review): security definer with `search_path = ''`,
-- schema-qualified references, stable; return no lanes unless p_uid = auth.uid() (or the caller is service_role) and
-- the session is aal2, so no caller can list another user's lanes; decide whether disabled lanes are excluded.
create function core.allowed_lanes(p_uid uuid, p_view text) returns text[]
language sql
stable
set search_path = ''
as $$
  select '{}'::text[];
$$;
revoke all on function core.allowed_lanes(uuid, text) from public, anon;
grant execute on function core.allowed_lanes(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------- core.lanes

create table core.lanes (
  code text primary key check (code ~ '^[A-Z]{1,8}$'),
  name text not null check (name = btrim(name) and length(name) between 1 and 100),
  data_plane text not null check (data_plane in ('core', 'nl')),
  -- Nichols Law data always lives in its isolated project (architecture §5.2).
  check (code <> 'NL' or data_plane = 'nl'),
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table core.lanes is 'Lane registry (architecture §5.1). code is the lane_id (text) every lane-scoped table references.';

create trigger lanes_set_updated_at before update on core.lanes
  for each row execute function core.set_updated_at();

alter table core.lanes enable row level security;

create policy lanes_select on core.lanes
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and code = any ((select core.allowed_lanes((select auth.uid()), 'lanes'))::text[]) -- evaluated once per statement
  );

revoke all on core.lanes from public, anon, authenticated;
grant select on core.lanes to authenticated;
grant select, insert, update, delete on core.lanes to service_role;

-- ---------------------------------------------------------------- core.lane_policies

create table core.lane_policies (
  lane_id text primary key references core.lanes (code) on update restrict on delete restrict,
  -- Data categories Claude may see for this lane. Empty = none.
  llm_allowed_categories text[] not null default '{}'
    check (llm_allowed_categories <@ array['email', 'calendar', 'docs', 'finance', 'finance_summary', 'tasks']::text[]),
  store_content_bodies boolean not null default false,
  -- Keep outbound drafts in the Approval Center (D-19). Off unless the lane opts in.
  store_outbound_drafts boolean not null default false,
  indexing_enabled boolean not null default false,
  -- Retention of derived data (summaries, caches), in days.
  retention_days integer not null default 30 check (retention_days between 1 and 3650),
  -- none | status (status-level only) | summary (owner-only consolidated summaries)
  cross_lane_summary_allowed text not null default 'none'
    check (cross_lane_summary_allowed in ('none', 'status', 'summary')),
  -- Write action classes the Approval Center may propose for this lane. Empty = none.
  write_actions_allowed text[] not null default '{}'
    check (write_actions_allowed <@ array['email_draft', 'email_send', 'calendar', 'monday', 'notion']::text[]),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table core.lane_policies is 'Per-lane policy enforced by the policy gate (architecture §5.3). Defaults are the most restrictive.';

create trigger lane_policies_set_updated_at before update on core.lane_policies
  for each row execute function core.set_updated_at();

alter table core.lane_policies enable row level security;

create policy lane_policies_select on core.lane_policies
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'lane_policies'))::text[]) -- evaluated once per statement
  );

revoke all on core.lane_policies from public, anon, authenticated;
grant select on core.lane_policies to authenticated;
grant select, insert, update, delete on core.lane_policies to service_role;
