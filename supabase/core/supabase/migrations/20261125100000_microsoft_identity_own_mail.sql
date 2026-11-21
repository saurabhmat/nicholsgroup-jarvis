-- T-254: Microsoft identity on connections and own-mail connect for Microsoft (docs/specs/microsoft.md 6.1, 6.2).
--   * core.connections gains tenant_id (Entra tenant of the signed-in account) and cloud ('commercial' | 'gcc_high'), Microsoft rows only,
--     both set together or both null, set ONCE by core.connection_set_microsoft_identity (service_role only, lane-checked) and immutable
--     afterwards (core.connections_identity_immutable). Both are granted to authenticated with the other health columns: they are
--     identifiers, not content. Row visibility is unchanged (connections view, or the caller's own rows with own_mail).
--   * core.oauth_state_create / core.oauth_state_consume treat 'microsoft' like 'google': any member holding own_mail connects their OWN
--     account; every other provider (QuickBooks, ...) still needs owner or admin_technical. Same aal2 requirement and cap as before.
-- Tests: 320_microsoft_identity.test.sql; 050 (catalog) adjusted.

alter table core.connections add column tenant_id uuid;
alter table core.connections add column cloud text;
alter table core.connections add constraint connections_cloud_values
  check (cloud is null or cloud in ('commercial', 'gcc_high'));
-- both or neither: an identity is a tenant in a cloud
alter table core.connections add constraint connections_identity_pair
  check ((tenant_id is null) = (cloud is null));
alter table core.connections add constraint connections_identity_only_microsoft
  check (tenant_id is null or provider = 'microsoft');

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
  -- T-254: the Microsoft tenant and cloud are set once (null -> value, together by the check) and never change or clear.
  if (old.tenant_id is not null and new.tenant_id is distinct from old.tenant_id)
     or (old.cloud is not null and new.cloud is distinct from old.cloud) then
    raise exception 'core.connections: the tenant and cloud cannot change' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function core.connections_identity_immutable() from public, anon, authenticated;

grant select (tenant_id, cloud) on core.connections to authenticated;

-- ---------------------------------------------------------------- set the identity once
-- Errors carry no value: 22004 a required argument is null; 22023 the cloud is not allowed; P0002 no such connection in this lane (the same
-- for "no such id" and "another lane"); 23514 the connection is not a Microsoft one; 55000 the identity is already set.
create function core.connection_set_microsoft_identity(
  p_lane text,
  p_connection_id uuid,
  p_tenant_id uuid,
  p_cloud text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider text;
  v_set uuid;
begin
  if p_lane is null or p_connection_id is null or p_tenant_id is null or p_cloud is null then
    raise exception 'connection identity: lane, connection, tenant and cloud are required' using errcode = '22004';
  end if;
  if p_cloud not in ('commercial', 'gcc_high') then
    raise exception 'connection identity: the cloud is not allowed' using errcode = '22023';
  end if;
  -- Compare-and-set in ONE statement: a second concurrent call waits for the row lock, re-checks tenant_id is null, and updates nothing.
  update core.connections c set tenant_id = p_tenant_id, cloud = p_cloud
   where c.id = p_connection_id and c.lane_id = p_lane and c.provider = 'microsoft' and c.tenant_id is null;
  if found then
    return;
  end if;
  -- Nothing changed: say why (the row is only read here).
  select c.provider, c.tenant_id into v_provider, v_set from core.connections c where c.id = p_connection_id and c.lane_id = p_lane;
  if v_provider is null then
    raise exception 'connection identity: no such connection in this lane' using errcode = 'P0002';
  elsif v_provider <> 'microsoft' then
    raise exception 'connection identity: not a Microsoft connection' using errcode = '23514';
  else
    raise exception 'connection identity: already set' using errcode = '55000';
  end if;
end;
$$;
comment on function core.connection_set_microsoft_identity(text, uuid, uuid, text) is
  'Sets the Entra tenant id and cloud of a Microsoft connection ONCE (T-254); service_role only; lane-checked; refuses a non-Microsoft row and a second set.';
revoke all on function core.connection_set_microsoft_identity(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function core.connection_set_microsoft_identity(text, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------- connect gate: microsoft like google
create or replace function core.oauth_state_create(
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
  v_ok boolean;
begin
  -- (computed in a statement: a CASE with THEN inside an IF condition confuses the plpgsql parser)
  select case
           when p_provider in ('google', 'microsoft') then p_lane = any (core.allowed_lanes(v_uid, 'own_mail'))
           else core.has_lane_role(v_uid, p_lane, array['owner', 'admin_technical'])
         end into v_ok;
  if v_uid is null or v_ok is not true then
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
  'Starts a connect (T-035; T-247; T-254): google and microsoft need own_mail in the lane (a member connects their OWN account), any other provider owner/admin_technical, at aal2; stores the state hash and PKCE verifier.';
revoke all on function core.oauth_state_create(text, text, text, text, text) from public, anon, service_role;
grant execute on function core.oauth_state_create(text, text, text, text, text) to authenticated;

create or replace function core.oauth_state_consume(p_lane text, p_state_hash text)
returns table (provider text, code_verifier text, redirect_uri text, toolkit text, account_ref text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    return; -- same empty result as an unknown state
  end if;
  return query
    delete from core.oauth_states s
    where s.state_hash = p_state_hash
      and s.lane_id = p_lane
      and s.user_id = v_uid
      and s.expires_at > now()
      and case
            when s.provider in ('google', 'microsoft') then p_lane = any (core.allowed_lanes(v_uid, 'own_mail'))
            else core.has_lane_role(v_uid, p_lane, array['owner', 'admin_technical'])
          end
    returning s.provider, s.code_verifier, s.redirect_uri, s.toolkit, s.account_ref;
end;
$$;
comment on function core.oauth_state_consume(text, text) is
  'Finishes a connect (T-035, T-219; T-247; T-254): returns and deletes the caller''s own unexpired state for the lane when they may still connect that provider (google, microsoft: own_mail; others: owner/admin_technical); empty otherwise.';
revoke all on function core.oauth_state_consume(text, text) from public, anon, service_role;
grant execute on function core.oauth_state_consume(text, text) to authenticated;
