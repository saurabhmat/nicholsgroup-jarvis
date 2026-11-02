-- T-031: connections and sync runs (architecture §6 M1/M2). One row per lane per provider account; tokens never live
-- here (they go to the Vault, keyed by connection id, in T-032). Columns mirror ConnectionSchema in
-- packages/connectors/src/contract/schemas.ts.
-- Read: AAL2 members with the 'connections' view (owner, admin_technical) read the health columns of core.connections;
-- the 'health' view (same roles) reads core.sync_runs. Column-level grants list the readable columns, so a column added
-- later is hidden until it is granted on purpose. Write: service_role only (connector code, jobs).

-- A storable ConnectorErrorInfo (schemas.ts): an object with the required keys, only known keys, bounded size, and
-- nothing that looks like a credential. The connector redacts first (T-033); this is the database's second line.
create function core.is_connector_error(p_error jsonb) returns boolean
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(p_error) = 'object'
    and p_error ?& array['kind', 'disposition', 'message']
    and not exists (
      select 1 from pg_catalog.jsonb_object_keys(p_error) k
      where k not in ('kind', 'disposition', 'message', 'http_status', 'provider_error_code', 'provider_tid',
                      'retry_after_seconds', 'endpoint')
    )
    and pg_catalog.pg_column_size(p_error) < 4096
    and not core.jsonb_has_secret(p_error);
$$;
revoke all on function core.is_connector_error(jsonb) from public, anon, authenticated;
grant execute on function core.is_connector_error(jsonb) to service_role;

-- ---------------------------------------------------------------- core.connections

create table core.connections (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  -- Real providers only (the contract's PROVIDERS); the test-only `mock` provider never reaches data.
  provider text not null
    check (provider in ('quickbooks', 'stripe', 'gohighlevel', 'google', 'microsoft', 'monday', 'notion', 'timesolv')),
  -- Provider account id (QuickBooks realmId, Stripe account, mailbox, workspace), from the provider, not code.
  external_account_id text not null
    check (external_account_id = pg_catalog.btrim(external_account_id) and length(external_account_id) between 1 and 256)
    check (not core.jsonb_has_secret(pg_catalog.jsonb_build_object('v', external_account_id))),
  status text not null default 'pending'
    check (status in ('pending', 'active', 'degraded', 'reconnect_required', 'disconnected')),
  -- Edition/plan features detected on the account (e.g. class_tracking), snake_case keys to booleans.
  features jsonb not null default '{}'
    check (pg_catalog.jsonb_typeof(features) = 'object')
    check (pg_catalog.pg_column_size(features) < 4096)
    check (not core.jsonb_has_secret(features)),
  features_checked_at timestamptz,
  token_expires_at timestamptz,
  last_sync_at timestamptz,
  last_error jsonb check (last_error is null or core.is_connector_error(last_error)),
  -- Who started the connect flow (verified session); null for service-created rows.
  created_by uuid references core.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lane_id, provider, external_account_id),
  -- Target for lane-consistent foreign keys (sync runs, later raw records and webhook events).
  unique (id, lane_id),
  -- Disconnecting deletes the tokens (QB-8), so nothing can still expire.
  check (status <> 'disconnected' or token_expires_at is null)
);
comment on table core.connections is
  'A lane''s connection to one provider account (T-031). No tokens: those are in the Vault, keyed by connection id (T-032).';
create index connections_lane_id_idx on core.connections (lane_id);

create trigger connections_set_updated_at before update on core.connections
  for each row execute function core.set_updated_at();

alter table core.connections enable row level security;

create policy connections_select on core.connections
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'connections'))::text[])
  );

revoke all on core.connections from public, anon, authenticated;
grant select (id, lane_id, provider, external_account_id, status, features, features_checked_at, token_expires_at,
              last_sync_at, last_error, created_at, updated_at)
  on core.connections to authenticated;
grant select, insert, update, delete on core.connections to service_role;

-- ---------------------------------------------------------------- core.sync_runs

create table core.sync_runs (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  connection_id uuid not null,
  -- full = cursor null (initial or forced reload); incremental = from the stored cursor (CDC/delta).
  kind text not null check (kind in ('full', 'incremental')),
  trigger text not null check (trigger in ('schedule', 'manual', 'webhook', 'connect')),
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'cancelled')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  records_received integer not null default 0 check (records_received >= 0),
  records_written integer not null default 0 check (records_written >= 0),
  error jsonb check (error is null or core.is_connector_error(error)),
  -- Inngest run id, for linking to the job dashboard.
  job_run_id text check (job_run_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A run belongs to a connection in the same lane.
  foreign key (connection_id, lane_id) references core.connections (id, lane_id) on update restrict on delete restrict,
  check ((status = 'running') = (finished_at is null)),
  check (finished_at is null or finished_at >= started_at),
  check (status <> 'failed' or error is not null),
  check (status <> 'succeeded' or error is null)
);
comment on table core.sync_runs is 'One row per connector sync run (T-031); counts and a redacted error only, no data.';
create index sync_runs_lane_id_idx on core.sync_runs (lane_id);
create index sync_runs_connection_started_idx on core.sync_runs (connection_id, started_at desc);

create trigger sync_runs_set_updated_at before update on core.sync_runs
  for each row execute function core.set_updated_at();

alter table core.sync_runs enable row level security;

create policy sync_runs_select on core.sync_runs
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'health'))::text[])
  );

revoke all on core.sync_runs from public, anon, authenticated;
grant select (id, lane_id, connection_id, kind, trigger, status, started_at, finished_at, records_received,
              records_written, error, job_run_id, created_at, updated_at)
  on core.sync_runs to authenticated;
grant select, insert, update, delete on core.sync_runs to service_role;
