-- T-219 review fixes (security M1, M2, M3, L4). Follow-up to 20261108120000 (no new table; lane_id, RLS and policies of the
-- touched tables are unchanged; pgTAP in 270_composio_transport.test.sql).
--
-- M1  A caller can no longer attach a toolkit or connected account id to its own state: core.oauth_state_create is back to
--     the original five arguments (authenticated). The connector binds the account server-side with the service_role-only
--     core.oauth_state_bind (same lane, same user, unexpired, bound once).
-- M2  D-23 across toolkits: an address held by a usable composio row in another lane (any toolkit) refuses activation
--     (D0023). Both directions take one advisory lock per address first, so two lanes racing for it cannot both win.
-- M3  Reverse direction: core.connection_token_store (native Google) refuses an address held by a usable composio row in
--     another lane (D0023), under the same lock.
-- L4  core.home_calendar_status counts native connections only (a composio connection indexes nothing yet).

-- ---------------------------------------------------------------- M1
drop function core.oauth_state_create(text, text, text, text, text, text, text);
create function core.oauth_state_create(
  p_lane text,
  p_provider text,
  p_state_hash text,
  p_code_verifier text,
  p_redirect_uri text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null
     or not core.has_lane_role(v_uid, p_lane, array['owner', 'admin_technical']) then
    raise exception 'connect not allowed' using errcode = '42501';
  end if;
  delete from core.oauth_states where expires_at <= now();
  if (select count(*) from core.oauth_states where user_id = v_uid) >= 10 then
    raise exception 'too many connects in progress' using errcode = '54000';
  end if;
  insert into core.oauth_states (lane_id, user_id, provider, state_hash, code_verifier, redirect_uri)
  values (p_lane, v_uid, p_provider, p_state_hash, p_code_verifier, p_redirect_uri);
end;
$$;
comment on function core.oauth_state_create(text, text, text, text, text) is
  'Starts a connect (T-035): owner/admin_technical of the lane at aal2 only; stores the state hash and PKCE verifier.';
revoke all on function core.oauth_state_create(text, text, text, text, text) from public, anon, service_role;
grant execute on function core.oauth_state_create(text, text, text, text, text) to authenticated;

-- Binds a Composio toolkit and the connected account created for this connect to the user's own pending state. Called by
-- the connector (service_role) after the signed-in user's create succeeded and Composio's link call returned the id.
create function core.oauth_state_bind(p_lane text, p_state_hash text, p_user uuid, p_toolkit text, p_account_ref text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update core.oauth_states s set toolkit = p_toolkit, account_ref = p_account_ref
  where s.state_hash = p_state_hash and s.lane_id = p_lane and s.user_id = p_user
    and s.expires_at > now() and s.toolkit is null and s.account_ref is null;
  if not found then
    raise exception 'oauth state: nothing to bind' using errcode = 'P0002';
  end if;
end;
$$;
comment on function core.oauth_state_bind(text, text, uuid, text, text) is
  'T-219: service_role only. Binds toolkit + connected account id to the user''s own unexpired, unbound state; once.';
revoke all on function core.oauth_state_bind(text, text, uuid, text, text) from public, anon, authenticated;
grant execute on function core.oauth_state_bind(text, text, uuid, text, text) to service_role;

-- ---------------------------------------------------------------- M2
create or replace function core.connection_activate_composio(
  p_lane_id text,
  p_connection_id uuid,
  p_identity text,
  p_actor_id uuid default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transport text;
  v_toolkit text;
  v_identity text := pg_catalog.lower(pg_catalog.btrim(p_identity));
  v_constraint text;
  v_superseded int;
begin
  perform core.connection_for_token(p_lane_id, p_connection_id, true);
  select c.transport, c.toolkit into v_transport, v_toolkit
  from core.connections c where c.id = p_connection_id and c.lane_id = p_lane_id;
  if v_transport is distinct from 'composio' then
    raise exception 'connection activate: not a composio connection' using errcode = '55000';
  end if;
  if v_identity is null or length(v_identity) not between 3 and 320 or v_identity !~ '^[^\s\u0000-\u001f\u007f-\u009f]+$' then
    raise exception 'connection activate: the account identity is not valid' using errcode = '22023';
  end if;
  -- One lock per address, shared with core.connection_token_store, so two lanes racing for it cannot both win.
  perform pg_advisory_xact_lock(pg_catalog.hashtext(v_identity));
  -- The address held natively in another lane (D-23 across transports) ...
  if exists (
    select 1 from core.connections n
    where n.provider = 'google' and n.transport = 'native' and n.lane_id <> p_lane_id
      and pg_catalog.lower(n.external_account_id) = v_identity and n.status not in ('disconnected', 'pending')
  )
  -- ... or by any composio toolkit in another lane (gmail in one lane, calendar in another is still one account).
  or exists (
    select 1 from core.connections o
    where o.transport = 'composio' and o.lane_id <> p_lane_id and o.account_identity = v_identity
      and o.status not in ('disconnected', 'pending')
  ) then
    raise exception 'connection activate: the provider account is connected to another lane' using errcode = 'D0023';
  end if;
  update core.connections o set status = 'disconnected', token_expires_at = null
  where o.lane_id = p_lane_id and o.transport = 'composio' and o.toolkit = v_toolkit
    and o.id <> p_connection_id and o.status not in ('disconnected', 'pending');
  get diagnostics v_superseded = row_count;
  begin
    update core.connections set status = 'active', account_identity = v_identity, token_expires_at = null, last_error = null
    where id = p_connection_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint in ('connections_one_lane_per_composio_identity', 'connections_one_lane_per_account', 'connections_one_composio_per_lane_toolkit') then
      raise exception 'connection activate: the provider account is connected to another lane' using errcode = 'D0023';
    end if;
    raise;
  end;
  perform audit.log(p_lane_id, case when p_actor_id is null then 'service' else 'user' end, p_actor_id,
                    'connection.composio_activated', 'connection:' || p_connection_id::text,
                    pg_catalog.jsonb_build_object('toolkit', v_toolkit, 'superseded', v_superseded));
end;
$$;

-- ---------------------------------------------------------------- M3
create or replace function core.connection_token_store(
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
  v_constraint text;
  v_provider text;
  v_account text;
begin
  perform core.connection_for_token(p_lane_id, p_connection_id, true);
  perform core.connection_token_check_secret(p_secret);
  select c.provider, pg_catalog.lower(c.external_account_id) into v_provider, v_account
  from core.connections c where c.id = p_connection_id and c.lane_id = p_lane_id;
  if v_provider = 'google' then
    -- Same lock as core.connection_activate_composio; a composio row in another lane holding this address refuses (D-23).
    perform pg_advisory_xact_lock(pg_catalog.hashtext(v_account));
    if exists (
      select 1 from core.connections o
      where o.transport = 'composio' and o.lane_id <> p_lane_id and o.account_identity = v_account
        and o.status not in ('disconnected', 'pending')
    ) then
      raise exception 'connection token: the provider account is connected to another lane' using errcode = 'D0023';
    end if;
  end if;
  select s.vault_secret_id into v_secret_id from core.connection_secrets s where s.connection_id = p_connection_id;
  if v_secret_id is null then
    v_secret_id := vault.create_secret(p_secret, 'connection:' || p_connection_id::text, 'Connector credential (T-032)');
    insert into core.connection_secrets (connection_id, lane_id, vault_secret_id) values (p_connection_id, p_lane_id, v_secret_id);
  else
    perform vault.update_secret(v_secret_id, p_secret);
    update core.connection_secrets set rotated_at = now() where connection_id = p_connection_id;
  end if;
  begin
    update core.connections set status = 'active', token_expires_at = p_expires_at where id = p_connection_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'connections_one_lane_per_account' then
      raise exception 'connection token: the provider account is connected to another lane' using errcode = 'D0023';
    end if;
    raise;
  end;
  perform audit.log(p_lane_id, case when p_actor_id is null then 'service' else 'user' end, p_actor_id,
                    'connection.token_stored', 'connection:' || p_connection_id::text, '{}');
end;
$$;

-- ---------------------------------------------------------------- L4
create or replace function core.home_calendar_status(p_lane text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' or not (p_lane = any (core.allowed_lanes(auth.uid(), 'calendar'))) then
    return 'no_access';
  end if;
  -- Native connections only: a composio connection indexes no calendar yet (T-223).
  if exists (
    select 1 from core.connections c
    where c.lane_id = p_lane and c.provider in ('google', 'microsoft') and c.transport = 'native' and c.status <> 'disconnected'
  ) then
    return 'connected';
  end if;
  return 'not_connected';
end;
$$;
