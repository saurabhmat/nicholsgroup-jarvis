-- T-032: Vault token functions, keyed by connection id (architecture §6 M2; CLAUDE.md rule 4).
-- A connection's credential (an OAuth token set or an API key, serialised by the connector) is one Vault secret.
-- core.connection_secrets maps connection -> Vault secret id; it is private (RLS on, no policy, no API grants).
-- The four functions are security definer (owner postgres) and executable by service_role only, which the connector's
-- vault module (T-033, packages/connectors/src/vault/**) is the only caller of. Every call names the lane and checks
-- that the connection belongs to it before touching the Vault, so a wrong-lane call fails rather than reads.
-- Store and revoke are audited (no secret material in the entry); rotate is not (access tokens refresh hourly).

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

-- The connection's status after the lane check, or an error. Shared by the four functions.
create function core.connection_for_token(p_lane_id text, p_connection_id uuid) returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_lane_id is null or p_connection_id is null then
    raise exception 'connection token: lane and connection are required' using errcode = '22004';
  end if;
  select c.status into v_status from core.connections c where c.id = p_connection_id and c.lane_id = p_lane_id;
  if v_status is null then
    -- Same error for "no such connection" and "connection in another lane".
    raise exception 'connection token: no connection % in lane %', p_connection_id, p_lane_id using errcode = 'P0002';
  end if;
  return v_status;
end;
$$;
revoke all on function core.connection_for_token(text, uuid) from public, anon, authenticated;

-- Store the first credential for a connection. Fails if one is already stored (use rotate).
create function core.connection_token_store(
  p_lane_id text,
  p_connection_id uuid,
  p_secret text,
  p_expires_at timestamptz default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  if core.connection_for_token(p_lane_id, p_connection_id) = 'disconnected' then
    raise exception 'connection token: connection is disconnected' using errcode = '55000';
  end if;
  if p_secret is null or length(p_secret) = 0 or length(p_secret) > 16384 then
    raise exception 'connection token: secret must be 1 to 16384 characters' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('core.connection_secrets:' || p_connection_id::text));
  if exists (select 1 from core.connection_secrets s where s.connection_id = p_connection_id) then
    raise exception 'connection token: already stored; rotate instead' using errcode = '23505';
  end if;
  v_secret_id := vault.create_secret(p_secret, 'connection:' || p_connection_id::text, 'Connector credential (T-032)');
  insert into core.connection_secrets (connection_id, lane_id, vault_secret_id) values (p_connection_id, p_lane_id, v_secret_id);
  update core.connections set token_expires_at = p_expires_at where id = p_connection_id;
  perform audit.log(p_lane_id, 'service', null, 'connection.token_stored', 'connection:' || p_connection_id::text, '{}');
end;
$$;

-- The stored credential, or an error when there is none or the connection cannot be used.
create function core.connection_token_read(p_lane_id text, p_connection_id uuid) returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_status text := core.connection_for_token(p_lane_id, p_connection_id);
  v_secret text;
begin
  if v_status = 'disconnected' then
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

-- Replace the stored credential (token refresh, key rotation).
create function core.connection_token_rotate(
  p_lane_id text,
  p_connection_id uuid,
  p_secret text,
  p_expires_at timestamptz default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  if core.connection_for_token(p_lane_id, p_connection_id) = 'disconnected' then
    raise exception 'connection token: connection is disconnected' using errcode = '55000';
  end if;
  if p_secret is null or length(p_secret) = 0 or length(p_secret) > 16384 then
    raise exception 'connection token: secret must be 1 to 16384 characters' using errcode = '22023';
  end if;
  select s.vault_secret_id into v_secret_id
  from core.connection_secrets s
  where s.connection_id = p_connection_id and s.lane_id = p_lane_id
  for update;
  if v_secret_id is null then
    raise exception 'connection token: none stored for connection %', p_connection_id using errcode = 'P0002';
  end if;
  perform vault.update_secret(v_secret_id, p_secret);
  update core.connection_secrets set rotated_at = now() where connection_id = p_connection_id;
  update core.connections set token_expires_at = p_expires_at where id = p_connection_id;
end;
$$;

-- Delete the stored credential (disconnect, QB-8). Idempotent: returns false when nothing was stored.
-- Works on any status, so a disconnect can always clean up.
create function core.connection_token_revoke(p_lane_id text, p_connection_id uuid) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  perform core.connection_for_token(p_lane_id, p_connection_id);
  delete from core.connection_secrets s
  where s.connection_id = p_connection_id and s.lane_id = p_lane_id
  returning s.vault_secret_id into v_secret_id;
  update core.connections set token_expires_at = null where id = p_connection_id;
  if v_secret_id is null then
    return false;
  end if;
  delete from vault.secrets where id = v_secret_id;
  perform audit.log(p_lane_id, 'service', null, 'connection.token_revoked', 'connection:' || p_connection_id::text, '{}');
  return true;
end;
$$;

revoke all on function core.connection_token_store(text, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function core.connection_token_read(text, uuid) from public, anon, authenticated;
revoke all on function core.connection_token_rotate(text, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function core.connection_token_revoke(text, uuid) from public, anon, authenticated;
grant execute on function core.connection_token_store(text, uuid, text, timestamptz) to service_role;
grant execute on function core.connection_token_read(text, uuid) to service_role;
grant execute on function core.connection_token_rotate(text, uuid, text, timestamptz) to service_role;
grant execute on function core.connection_token_revoke(text, uuid) to service_role;
