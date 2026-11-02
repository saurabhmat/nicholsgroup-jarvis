-- T-032: Vault token functions, keyed by connection id (architecture §6 M2; CLAUDE.md rule 4).
-- A connection's credential (an OAuth token set or an API key, serialised by the connector) is one Vault secret.
-- core.connection_secrets maps connection -> Vault secret id; it is private (RLS on, no policy, no API grants).
-- The functions are security definer (owner postgres) and executable by service_role only; the connector's vault
-- module (T-033, packages/connectors/src/vault/**) is their only caller. Every call names the lane and checks that the
-- connection belongs to it before touching the Vault, so a wrong-lane call fails rather than reads.
--
-- Not a database guarantee: Supabase's vault extension itself grants service_role read/write on vault.* (granted by
-- supabase_admin, so a migration cannot revoke it). Lane isolation of tokens therefore also relies on T-033's lint
-- rule that only packages/connectors/src/vault/** touches `vault.` or `connection_token_` (docs/plan-review.md §7).
-- Pass secrets as bind parameters only, never as SQL literals: a failing statement is logged with its text.
--
-- Lifecycle, each step one call and one transaction, serialised per connection by a row lock on core.connections:
-- - store:  connect or reconnect (any status). Creates or replaces the credential, sets status 'active'. Audited.
-- - read:   the credential, unless disconnected (reconnect_required may still read, e.g. to revoke at the provider).
-- - rotate: token refresh / key rotation; keeps the status. Not audited (access tokens refresh hourly).
-- - revoke: disconnect (QB-8). Deletes the credential, sets status 'disconnected'. Audited; idempotent.
-- `p_expires_at` is the expiry of the credential whose loss forces a reconnect (refresh token, API key), not the
-- access token's; pass null explicitly when it does not expire.

create table core.connection_secrets (
  connection_id uuid primary key,
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  vault_secret_id uuid not null unique,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  foreign key (connection_id, lane_id) references core.connections (id, lane_id) on update restrict on delete restrict
);
comment on table core.connection_secrets is
  'Connection -> Vault secret id (T-032). Private: reached only through core.connection_token_* functions.';
create index connection_secrets_lane_id_idx on core.connection_secrets (lane_id);

alter table core.connection_secrets enable row level security;
revoke all on core.connection_secrets from public, anon, authenticated, service_role;

-- The connection's status after the lane check, or an error. With p_lock, the row stays locked to the end of the
-- transaction, which serialises token writes and status changes per connection. Shared by the functions below.
create function core.connection_for_token(p_lane_id text, p_connection_id uuid, p_lock boolean) returns text
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_lane_id is null or p_connection_id is null then
    raise exception 'connection token: lane and connection are required' using errcode = '22004';
  end if;
  if p_lock then
    select c.status into v_status from core.connections c
    where c.id = p_connection_id and c.lane_id = p_lane_id for update;
  else
    select c.status into v_status from core.connections c where c.id = p_connection_id and c.lane_id = p_lane_id;
  end if;
  if v_status is null then
    -- Same error for "no such connection" and "connection in another lane".
    raise exception 'connection token: no connection % in lane %', p_connection_id, p_lane_id using errcode = 'P0002';
  end if;
  return v_status;
end;
$$;
revoke all on function core.connection_for_token(text, uuid, boolean) from public, anon, authenticated;

create function core.connection_token_check_secret(p_secret text) returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_secret is null or length(p_secret) = 0 or length(p_secret) > 16384 then
    raise exception 'connection token: secret must be 1 to 16384 characters' using errcode = '22023';
  end if;
end;
$$;
revoke all on function core.connection_token_check_secret(text) from public, anon, authenticated;

-- Connect or reconnect: store the credential (replacing any previous one) and mark the connection active.
-- p_actor_id: the verified user who completed the connect flow, or null for service-initiated connects.
create function core.connection_token_store(
  p_lane_id text,
  p_connection_id uuid,
  p_secret text,
  p_expires_at timestamptz,
  p_actor_id uuid default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  perform core.connection_for_token(p_lane_id, p_connection_id, true);
  perform core.connection_token_check_secret(p_secret);
  select s.vault_secret_id into v_secret_id from core.connection_secrets s where s.connection_id = p_connection_id;
  if v_secret_id is null then
    v_secret_id := vault.create_secret(p_secret, 'connection:' || p_connection_id::text, 'Connector credential (T-032)');
    insert into core.connection_secrets (connection_id, lane_id, vault_secret_id) values (p_connection_id, p_lane_id, v_secret_id);
  else
    perform vault.update_secret(v_secret_id, p_secret);
    update core.connection_secrets set rotated_at = now() where connection_id = p_connection_id;
  end if;
  update core.connections set status = 'active', token_expires_at = p_expires_at where id = p_connection_id;
  perform audit.log(p_lane_id, case when p_actor_id is null then 'service' else 'user' end, p_actor_id,
                    'connection.token_stored', 'connection:' || p_connection_id::text, '{}');
end;
$$;

-- The stored credential, or an error when there is none or the connection is disconnected.
create function core.connection_token_read(p_lane_id text, p_connection_id uuid) returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  if core.connection_for_token(p_lane_id, p_connection_id, false) = 'disconnected' then
    raise exception 'connection token: connection is disconnected' using errcode = '55000';
  end if;
  select d.decrypted_secret into v_secret
  from core.connection_secrets s
  join vault.decrypted_secrets d on d.id = s.vault_secret_id
  where s.connection_id = p_connection_id and s.lane_id = p_lane_id;
  if v_secret is null then
    raise exception 'connection token: none stored for connection %', p_connection_id using errcode = 'P0002';
  end if;
  return v_secret;
end;
$$;

-- Replace the stored credential (token refresh, key rotation). Keeps the status.
create function core.connection_token_rotate(
  p_lane_id text,
  p_connection_id uuid,
  p_secret text,
  p_expires_at timestamptz
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  if core.connection_for_token(p_lane_id, p_connection_id, true) = 'disconnected' then
    raise exception 'connection token: connection is disconnected' using errcode = '55000';
  end if;
  perform core.connection_token_check_secret(p_secret);
  select s.vault_secret_id into v_secret_id from core.connection_secrets s where s.connection_id = p_connection_id;
  if v_secret_id is null then
    raise exception 'connection token: none stored for connection %', p_connection_id using errcode = 'P0002';
  end if;
  perform vault.update_secret(v_secret_id, p_secret);
  update core.connection_secrets set rotated_at = now() where connection_id = p_connection_id;
  update core.connections set token_expires_at = p_expires_at where id = p_connection_id;
end;
$$;

-- Disconnect (QB-8): delete the credential and mark the connection disconnected, atomically. Works on any status and
-- is idempotent. Returns true when a credential was deleted. Revoking at the provider happens before (T-195).
create function core.connection_token_revoke(p_lane_id text, p_connection_id uuid, p_actor_id uuid default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text := core.connection_for_token(p_lane_id, p_connection_id, true);
  v_secret_id uuid;
begin
  delete from core.connection_secrets s
  where s.connection_id = p_connection_id and s.lane_id = p_lane_id
  returning s.vault_secret_id into v_secret_id;
  if v_secret_id is not null then
    delete from vault.secrets where id = v_secret_id;
  end if;
  if v_status <> 'disconnected' then
    update core.connections set status = 'disconnected', token_expires_at = null where id = p_connection_id;
  end if;
  if v_secret_id is not null or v_status <> 'disconnected' then
    perform audit.log(p_lane_id, case when p_actor_id is null then 'service' else 'user' end, p_actor_id,
                      'connection.disconnected', 'connection:' || p_connection_id::text,
                      pg_catalog.jsonb_build_object('vault_entry_deleted', v_secret_id is not null));
  end if;
  return v_secret_id is not null;
end;
$$;

-- Backstop for code that updates core.connections directly: a connection cannot be marked disconnected while a
-- credential is still stored. Security definer because the writer (service_role) cannot see the private mapping.
create function core.connections_no_orphan_secret() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'disconnected' and old.status is distinct from 'disconnected'
     and exists (select 1 from core.connection_secrets s where s.connection_id = new.id) then
    raise exception 'core.connections: use core.connection_token_revoke to disconnect (a credential is stored)'
      using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function core.connections_no_orphan_secret() from public, anon, authenticated;

create trigger connections_no_orphan_secret before update of status on core.connections
  for each row execute function core.connections_no_orphan_secret();

revoke all on function core.connection_token_store(text, uuid, text, timestamptz, uuid) from public, anon, authenticated;
revoke all on function core.connection_token_read(text, uuid) from public, anon, authenticated;
revoke all on function core.connection_token_rotate(text, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function core.connection_token_revoke(text, uuid, uuid) from public, anon, authenticated;
grant execute on function core.connection_token_store(text, uuid, text, timestamptz, uuid) to service_role;
grant execute on function core.connection_token_read(text, uuid) to service_role;
grant execute on function core.connection_token_rotate(text, uuid, text, timestamptz) to service_role;
grant execute on function core.connection_token_revoke(text, uuid, uuid) to service_role;
