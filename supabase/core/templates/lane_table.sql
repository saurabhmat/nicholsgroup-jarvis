-- Template for a new lane-scoped table (T-013). Copy into a migration created with
-- `supabase migration new <name> --workdir supabase/core`, replace <schema>, <table> and <view>, and add pgTAP tests
-- in the same change (CLAUDE.md rule 3). <view> is a name from core.view_names(); add one there if the module
-- needs a new view (and decide which roles get it in core.role_views()).

create schema if not exists <schema>;
revoke all on schema <schema> from public, anon;
grant usage on schema <schema> to authenticated, service_role;

create table <schema>.<table> (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  -- ... columns: money numeric(18,2), time timestamptz (CLAUDE.md rule 11) ...
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index <table>_lane_id_idx on <schema>.<table> (lane_id);

create trigger <table>_set_updated_at before update on <schema>.<table>
  for each row execute function core.set_updated_at();

alter table <schema>.<table> enable row level security;

-- The standard lane policy (architecture §5.4). The catalog test (050_catalog) checks this exact shape.
create policy <table>_select on <schema>.<table>
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), '<view>'))::text[])
  );

-- Reads for members; writes from service-role code (jobs, connectors) or security-definer functions.
revoke all on <schema>.<table> from public, anon, authenticated;
grant select on <schema>.<table> to authenticated;
grant select, insert, update, delete on <schema>.<table> to service_role;

-- pgTAP (supabase/core/supabase/tests/NNN_<table>.test.sql):
--   begin; select plan(N); \ir helpers/lane_rls.psql
--   select pg_temp.has_standard_lane_policy('<schema>.<table>', '<view>');
--   cross-lane denial: a member of another lane reads 0 rows; aal1 reads 0 rows; anon is denied
--   select * from finish(); rollback;
