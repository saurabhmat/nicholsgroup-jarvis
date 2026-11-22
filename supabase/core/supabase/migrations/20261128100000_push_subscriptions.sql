-- T-068, T-264: provider change-notification subscriptions (docs/specs/microsoft.md sections 6.4, 14). One row per subscription the portal created at a
-- provider (today Microsoft Graph: one for the inbox, one for the default calendar, per connection). The row is what makes a subscription actionable: the
-- receiver finds a notification's lane and connection ONLY through it, and the renewer and the stop path act only on rows recorded for the same (lane, connection).
--
-- The `clientState` (the secret Graph echoes in every notification) is a Vault secret per subscription, never a column: this table holds only the secret's id
-- (`vault_secret_id`, not readable through the API). Removing a subscription deletes its secret.
--
-- Access: private writes. service_role has NO table grants; it reaches the table only through the security-definer functions below (empty search_path,
-- lane-checked, service_role only). Reads: owner and admin_technical at AAL2 through the standard lane policy on the 'health' view (the audience of the Settings
-- connections health), and only the columns that view needs (no provider subscription id, no resource path, no secret id). Content: none is stored.
-- Retention: core.push_subscriptions_purge deletes rows of removed subscriptions after a fixed 30 days (class "policy", like core.connector_api_errors).
--
-- core.webhook_events already accepts provider 'microsoft' (its check lists it since T-036); this migration changes nothing there (pgTAP 326 asserts it).
-- The functions are provider-generic (no provider name in a body), so the T-253 inventory of functions that name 'google' is unchanged.

create table core.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  connection_id uuid not null,
  provider text not null check (provider in ('google', 'microsoft')),
  -- Which stream a notification means: the connection's mail or its calendar. The receiver queues a sync of exactly this stream.
  resource text not null check (resource in ('mail', 'calendar')),
  -- The provider's id of the subscription (a GUID at Microsoft). The lookup key of a notification; hidden from the API.
  subscription_id text not null check (length(subscription_id) between 1 and 256 and subscription_id !~ '[[:cntrl:]]'),
  -- The non-secret template that was subscribed, e.g. me/mailfolders('inbox')/messages. Never an address or an id.
  resource_path text not null check (length(resource_path) between 1 and 200 and resource_path ~ '^[A-Za-z0-9_/()'' .-]+$'),
  expires_at timestamptz not null,
  -- active: usable. reauthorization_required: the provider asked for a reauthorization (renewed by the next renewal run). removed: gone or stopped.
  status text not null default 'active' check (status in ('active', 'reauthorization_required', 'removed')),
  -- The Vault secret holding the clientState; null once removed (the secret is deleted). Private.
  vault_secret_id uuid unique,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lane_id, provider, subscription_id),
  -- Lane-consistent: the connection belongs to the same lane.
  foreign key (connection_id, lane_id) references core.connections (id, lane_id) on delete restrict,
  check ((status = 'removed') = (removed_at is not null)),
  check (status = 'removed' or vault_secret_id is not null)
);
comment on table core.push_subscriptions is
  'Provider change-notification subscriptions (T-068): ids, resource, expiry, status; the clientState is a Vault secret, never a column. Written only by core.push_subscription_* functions.';
comment on column core.push_subscriptions.vault_secret_id is 'Id of the Vault secret holding the clientState; never readable through the API.';

-- At most one live subscription per connection and stream.
create unique index push_subscriptions_one_live_idx on core.push_subscriptions (connection_id, resource) where status <> 'removed';
create index push_subscriptions_lane_idx on core.push_subscriptions (lane_id, status);

create trigger push_subscriptions_set_updated_at before update on core.push_subscriptions
  for each row execute function core.set_updated_at();

alter table core.push_subscriptions enable row level security;

create policy push_subscriptions_select on core.push_subscriptions
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'health'))::text[])
  );

revoke all on core.push_subscriptions from public, anon, authenticated, service_role;
grant select (id, lane_id, connection_id, provider, resource, status, expires_at, created_at, updated_at)
  on core.push_subscriptions to authenticated;

-- ---------------------------------------------------------------- list: the live subscriptions of one connection
-- Rows that are not removed, for exactly this (lane, connection). The renewer acts only on what this returns, so it cannot touch another connection's subscription.
create function core.push_subscription_list(p_lane text, p_connection_id uuid)
returns table (resource text, subscription_id text, status text, expires_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_lane is null or p_connection_id is null then
    raise exception 'lane and connection are required' using errcode = '22004';
  end if;
  return query
    select s.resource, s.subscription_id, s.status, s.expires_at
    from core.push_subscriptions s
    where s.lane_id = p_lane and s.connection_id = p_connection_id and s.status <> 'removed'
    order by s.resource;
end;
$$;
comment on function core.push_subscription_list(text, uuid) is
  'Change notifications (T-068): the live subscriptions recorded for one (lane, connection); service_role only.';
revoke all on function core.push_subscription_list(text, uuid) from public, anon, authenticated;
grant execute on function core.push_subscription_list(text, uuid) to service_role;

-- ---------------------------------------------------------------- record: a subscription was created at the provider
-- Checks the connection (this lane, this provider, usable, lane enabled), keeps the clientState in the Vault, and supersedes any live row of the same stream
-- (its secret is deleted). Returns the new row's id. The clientState is a bind parameter only: it never appears in SQL text, a log or an error.
create function core.push_subscription_record(
  p_lane text,
  p_connection_id uuid,
  p_provider text,
  p_resource text,
  p_subscription_id text,
  p_resource_path text,
  p_expires_at timestamptz,
  p_client_state text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok boolean;
  v_id uuid := gen_random_uuid();
  v_secret uuid;
  v_old record;
begin
  if p_lane is null or p_connection_id is null or p_provider is null or p_resource is null or p_subscription_id is null
     or p_resource_path is null or p_expires_at is null or p_client_state is null then
    raise exception 'every argument is required' using errcode = '22004';
  end if;
  -- Graph's longest lifetime is 10,080 minutes (7 days); a day of slack for the answer it gives.
  if p_expires_at <= pg_catalog.now() or p_expires_at > pg_catalog.now() + interval '8 days' then
    raise exception 'the expiry must be in the future and within 8 days' using errcode = '22023';
  end if;
  -- At least 32 characters of a random value; Graph allows at most 128.
  if pg_catalog.length(p_client_state) not between 32 and 128 or p_client_state ~ '[[:cntrl:]]' then
    raise exception 'the client state must be 32 to 128 printable characters' using errcode = '22023';
  end if;
  select true into v_ok
  from core.connections c
  join core.lanes l on l.code = c.lane_id and l.enabled
  where c.id = p_connection_id and c.lane_id = p_lane and c.provider = p_provider and c.status in ('active', 'degraded');
  if v_ok is null then
    raise exception 'connection not found in this lane' using errcode = '42501';
  end if;

  -- The one live row of this stream is superseded.
  for v_old in
    select s.id, s.vault_secret_id from core.push_subscriptions s
    where s.connection_id = p_connection_id and s.resource = p_resource and s.status <> 'removed' for update
  loop
    update core.push_subscriptions s set status = 'removed', removed_at = pg_catalog.now(), vault_secret_id = null where s.id = v_old.id;
    if v_old.vault_secret_id is not null then
      delete from vault.secrets where id = v_old.vault_secret_id;
    end if;
  end loop;

  v_secret := vault.create_secret(p_client_state, 'push_subscription:' || v_id::text, 'Change-notification clientState (T-068)');
  insert into core.push_subscriptions (id, lane_id, connection_id, provider, resource, subscription_id, resource_path, expires_at, vault_secret_id)
  values (v_id, p_lane, p_connection_id, p_provider, p_resource, p_subscription_id, p_resource_path, p_expires_at, v_secret);
  return v_id;
end;
$$;
comment on function core.push_subscription_record(text, uuid, text, text, text, text, timestamptz, text) is
  'Change notifications (T-068): records a created subscription for a usable connection of this lane and keeps its clientState in the Vault; service_role only.';
revoke all on function core.push_subscription_record(text, uuid, text, text, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function core.push_subscription_record(text, uuid, text, text, text, text, timestamptz, text) to service_role;

-- ---------------------------------------------------------------- lookup: a notification's subscription (receiver)
-- Asked per lane with the id from the notification. Returns the live row with its clientState only when the connection is still usable and the lane is enabled;
-- an unknown id, a removed row, another lane's row and a disconnected connection all return nothing. The receiver compares the clientState in constant time.
create function core.push_subscription_lookup(p_lane text, p_provider text, p_subscription_id text)
returns table (connection_id uuid, resource text, status text, client_state text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_lane is null or p_provider is null or p_subscription_id is null or pg_catalog.length(p_subscription_id) not between 1 and 256 then
    return;
  end if;
  return query
    select s.connection_id, s.resource, s.status, d.decrypted_secret::text
    from core.push_subscriptions s
    join core.connections c on c.id = s.connection_id and c.lane_id = s.lane_id
    join core.lanes l on l.code = s.lane_id and l.enabled
    join vault.decrypted_secrets d on d.id = s.vault_secret_id
    where s.lane_id = p_lane and s.provider = p_provider and s.subscription_id = p_subscription_id
      and s.status <> 'removed' and c.status not in ('disconnected', 'pending');
end;
$$;
comment on function core.push_subscription_lookup(text, text, text) is
  'Change notifications (T-068): the live subscription of a lane by the provider id, with its clientState, for a usable connection; service_role only.';
revoke all on function core.push_subscription_lookup(text, text, text) from public, anon, authenticated;
grant execute on function core.push_subscription_lookup(text, text, text) to service_role;

-- ---------------------------------------------------------------- renewed: the expiry moved
create function core.push_subscription_renewed(p_lane text, p_connection_id uuid, p_subscription_id text, p_expires_at timestamptz)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_lane is null or p_connection_id is null or p_subscription_id is null or p_expires_at is null then
    raise exception 'every argument is required' using errcode = '22004';
  end if;
  if p_expires_at <= pg_catalog.now() or p_expires_at > pg_catalog.now() + interval '8 days' then
    raise exception 'the expiry must be in the future and within 8 days' using errcode = '22023';
  end if;
  update core.push_subscriptions s
  set expires_at = p_expires_at, status = 'active'
  where s.lane_id = p_lane and s.connection_id = p_connection_id and s.subscription_id = p_subscription_id and s.status <> 'removed'
  returning s.id into v_id;
  return v_id is not null;
end;
$$;
comment on function core.push_subscription_renewed(text, uuid, text, timestamptz) is
  'Change notifications (T-264): moves a live subscription''s expiry (bounded to 8 days) and clears reauthorization_required; lane- and connection-bound; service_role only.';
revoke all on function core.push_subscription_renewed(text, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function core.push_subscription_renewed(text, uuid, text, timestamptz) to service_role;

-- ---------------------------------------------------------------- mark: reauthorization asked, or removed
-- 'removed' also deletes the Vault secret. Only a live row moves; returns whether a row changed.
create function core.push_subscription_mark(p_lane text, p_connection_id uuid, p_subscription_id text, p_status text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_secret uuid;
begin
  if p_lane is null or p_connection_id is null or p_subscription_id is null then
    raise exception 'lane, connection and subscription are required' using errcode = '22004';
  end if;
  if p_status is null or p_status not in ('reauthorization_required', 'removed') then
    raise exception 'status must be reauthorization_required or removed' using errcode = '22023';
  end if;
  select s.id, s.vault_secret_id into v_id, v_secret
  from core.push_subscriptions s
  where s.lane_id = p_lane and s.connection_id = p_connection_id and s.subscription_id = p_subscription_id and s.status <> 'removed'
  for update;
  if v_id is null then
    return false;
  end if;
  if p_status = 'removed' then
    update core.push_subscriptions s set status = 'removed', removed_at = pg_catalog.now(), vault_secret_id = null where s.id = v_id;
    if v_secret is not null then
      delete from vault.secrets where id = v_secret;
    end if;
  else
    update core.push_subscriptions s set status = 'reauthorization_required' where s.id = v_id;
  end if;
  return true;
end;
$$;
comment on function core.push_subscription_mark(text, uuid, text, text) is
  'Change notifications (T-264): marks a live subscription reauthorization_required or removed (deleting its Vault secret); lane- and connection-bound; service_role only.';
revoke all on function core.push_subscription_mark(text, uuid, text, text) from public, anon, authenticated;
grant execute on function core.push_subscription_mark(text, uuid, text, text) to service_role;

-- ---------------------------------------------------------------- remove every live subscription of a connection
-- Disconnect, and a provider that is no longer enabled for the lane. Works whatever the connection's status. Returns how many rows were removed.
create function core.push_subscriptions_remove_connection(p_lane text, p_connection_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer := 0;
  v_row record;
begin
  if p_lane is null or p_connection_id is null then
    raise exception 'lane and connection are required' using errcode = '22004';
  end if;
  for v_row in
    select s.id, s.vault_secret_id from core.push_subscriptions s
    where s.lane_id = p_lane and s.connection_id = p_connection_id and s.status <> 'removed' for update
  loop
    update core.push_subscriptions s set status = 'removed', removed_at = pg_catalog.now(), vault_secret_id = null where s.id = v_row.id;
    if v_row.vault_secret_id is not null then
      delete from vault.secrets where id = v_row.vault_secret_id;
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
comment on function core.push_subscriptions_remove_connection(text, uuid) is
  'Change notifications (T-264): marks every live subscription of one (lane, connection) removed and deletes the Vault secrets; service_role only.';
revoke all on function core.push_subscriptions_remove_connection(text, uuid) from public, anon, authenticated;
grant execute on function core.push_subscriptions_remove_connection(text, uuid) to service_role;

-- ---------------------------------------------------------------- purge (retention)
create function core.push_subscriptions_purge(p_lane text)
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
  delete from core.push_subscriptions s
  where s.lane_id = p_lane and s.status = 'removed' and s.removed_at < pg_catalog.now() - interval '30 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
comment on function core.push_subscriptions_purge(text) is
  'Retention (T-068, called by the T-042 purge job): deletes a lane''s removed subscription rows older than a fixed 30 days.';
revoke all on function core.push_subscriptions_purge(text) from public, anon, authenticated;
grant execute on function core.push_subscriptions_purge(text) to service_role;
