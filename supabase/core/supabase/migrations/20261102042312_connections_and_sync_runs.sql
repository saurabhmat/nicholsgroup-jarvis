-- T-031: connections and sync runs (architecture §6 M1/M2). One row per lane per provider account; tokens never live
-- here (they go to the Vault, keyed by connection id, in T-032). Columns mirror ConnectionSchema in
-- packages/connectors/src/contract/schemas.ts.
-- Read: AAL2 members with the 'connections' view (owner, admin_technical) read the health columns of core.connections;
-- the 'health' view (same roles) reads core.sync_runs. Column-level grants list the readable columns, so a column added
-- later is hidden until it is granted on purpose. Write: service_role only (connector code, jobs).
-- Sync cursors do not belong on core.connections: a connection can have several streams (mail, calendar, drive) and a
-- targeted run advances only some of them. T-038 adds a private per-(connection, stream) cursor table.

-- A storable ConnectorErrorInfo, value for value (ConnectorErrorInfoSchema in schemas.ts: strict, every key present,
-- nullable ones may be null), bounded and free of anything credential-like. The connector redacts first (T-033); this
-- is the database's second line, and keeps rows parseable by the strict Zod schema.
create function core.is_connector_error(p_error jsonb) returns boolean
language sql
immutable
set search_path = ''
as $$
  -- CASE, not AND: SQL does not promise left-to-right evaluation, and the key and cast steps need an object.
  select case
    when p_error is null or pg_catalog.jsonb_typeof(p_error) <> 'object' then false
    when (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(p_error) k)
         is distinct from array['disposition', 'endpoint', 'http_status', 'kind', 'message', 'provider_error_code',
                                'provider_tid', 'retry_after_seconds'] then false
    else
      p_error ->> 'kind' in ('lane_mismatch', 'connection_unavailable', 'reconnect_required', 'unsupported_op',
                             'invalid_input', 'rate_limited', 'transient', 'timeout', 'not_found', 'forbidden',
                             'provider_error')
      and p_error ->> 'disposition' in ('retry', 'reconnect_required', 'fail')
      and pg_catalog.jsonb_typeof(p_error -> 'message') = 'string'
      and length(p_error ->> 'message') between 1 and 500
      and case pg_catalog.jsonb_typeof(p_error -> 'http_status')
            when 'null' then true
            when 'number' then (p_error ->> 'http_status') ~ '^[1-5][0-9]{2}$'
            else false end
      and case pg_catalog.jsonb_typeof(p_error -> 'provider_error_code')
            when 'null' then true
            when 'string' then length(p_error ->> 'provider_error_code') <= 128
            else false end
      and case pg_catalog.jsonb_typeof(p_error -> 'provider_tid')
            when 'null' then true
            when 'string' then length(p_error ->> 'provider_tid') <= 256
            else false end
      and case pg_catalog.jsonb_typeof(p_error -> 'retry_after_seconds')
            when 'null' then true
            when 'number' then (p_error ->> 'retry_after_seconds') ~ '^[0-9]{1,9}$'
            else false end
      -- A path template: no scheme/host, query, fragment or whitespace (ids and PII ride in those).
      and case pg_catalog.jsonb_typeof(p_error -> 'endpoint')
            when 'null' then true
            when 'string' then (p_error ->> 'endpoint') ~ '^/[^?#[:space:]]*$' and length(p_error ->> 'endpoint') <= 256
            else false end
      and not core.jsonb_has_secret(p_error)
  end;
$$;
revoke all on function core.is_connector_error(jsonb) from public, anon, authenticated;
grant execute on function core.is_connector_error(jsonb) to service_role;

-- Detected features: snake_case keys (SnakeKeySchema) to booleans (ConnectionFeaturesSchema), no credential-named keys.
create function core.is_connection_features(p_features jsonb) returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_features is null or pg_catalog.jsonb_typeof(p_features) <> 'object' then false
    else pg_catalog.pg_column_size(p_features) < 4096
      and not exists (
        select 1 from pg_catalog.jsonb_each(p_features) e
        where e.key !~ '^[a-z][a-z0-9_]{0,63}$' or pg_catalog.jsonb_typeof(e.value) <> 'boolean'
      )
      and not core.jsonb_has_secret(p_features)
  end;
$$;
revoke all on function core.is_connection_features(jsonb) from public, anon, authenticated;
grant execute on function core.is_connection_features(jsonb) to service_role;

-- ---------------------------------------------------------------- core.connections

create table core.connections (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  -- Real providers only (the contract's PROVIDERS); the test-only `mock` provider never reaches data.
  provider text not null
    check (provider in ('quickbooks', 'stripe', 'gohighlevel', 'google', 'microsoft', 'monday', 'notion', 'timesolv')),
  -- Provider account id (QuickBooks realmId, Stripe account, mailbox, workspace), from the provider, not code.
  -- The secret scan also runs here, so a key pasted as an account id is refused. Accepted false positive: a mailbox
  -- whose local part starts with a vendor key prefix (e.g. `secret_...@`); such a mailbox cannot be connected.
  external_account_id text not null
    check (external_account_id = pg_catalog.btrim(external_account_id) and length(external_account_id) between 1 and 256)
    check (not core.jsonb_has_secret(pg_catalog.jsonb_build_object('v', external_account_id))),
  status text not null default 'pending'
    check (status in ('pending', 'active', 'degraded', 'reconnect_required', 'disconnected')),
  features jsonb not null default '{}' check (core.is_connection_features(features)),
  features_checked_at timestamptz,
  token_expires_at timestamptz,
  last_sync_at timestamptz,
  last_error jsonb check (last_error is null or core.is_connector_error(last_error)),
  -- Who started the connect flow (verified session); null for service-created rows.
  created_by uuid references core.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lane_id, provider, external_account_id),
  -- Target for lane-consistent foreign keys (sync runs, Vault mapping, later raw records and webhook events).
  unique (id, lane_id),
  -- Disconnecting deletes the credential (QB-8), so nothing can still expire.
  check (status <> 'disconnected' or token_expires_at is null)
);
comment on table core.connections is
  'A lane''s connection to one provider account (T-031). No tokens: those are in the Vault, keyed by connection id (T-032).';
comment on column core.connections.token_expires_at is
  'Expiry of the credential whose loss forces a reconnect (OAuth refresh token, API key), not the short-lived access token. Null = does not expire or unknown. T-040 warns on it.';
comment on column core.connections.last_sync_at is 'End of the last successful sync run.';
create index connections_lane_id_idx on core.connections (lane_id);

create trigger connections_set_updated_at before update on core.connections
  for each row execute function core.set_updated_at();

-- A connection never moves between lanes (its tokens, runs and records are lane-bound), nor changes provider/account.
create function core.connections_identity_immutable() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.lane_id is distinct from old.lane_id or new.provider is distinct from old.provider
     or new.external_account_id is distinct from old.external_account_id then
    raise exception 'core.connections: lane, provider and account cannot change' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function core.connections_identity_immutable() from public, anon, authenticated;

create trigger connections_identity_immutable before update on core.connections
  for each row execute function core.connections_identity_immutable();

alter table core.connections enable row level security;

create policy connections_select on core.connections
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'connections'))::text[])
  );

-- external_account_id is shown on Settings -> Connections (T-197) so the admin can check the right file is connected.
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
