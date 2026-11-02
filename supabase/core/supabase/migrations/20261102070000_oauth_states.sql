-- OAuth connect flow state (T-035). One row per started connect: the lane, the user who started it, the provider,
-- a SHA-256 of the `state` parameter (the value itself is never stored) and the PKCE code verifier. Rows live 10
-- minutes and are deleted when consumed, so a state works once.
--
-- Private table: RLS on, no policy, no grants. Reached only through two security-definer functions that the signed-in
-- user calls with their own session, so the database enforces the binding instead of trusting the caller:
--   core.oauth_state_create: caller is owner or admin_technical of the (enabled) lane, at aal2 (core.has_lane_role).
--   core.oauth_state_consume: the same user, still owner/admin_technical at aal2, before expiry; deletes the row.
-- A missing, expired, other-user or other-lane state gives the same empty result, so a caller cannot probe states.

create table core.oauth_states (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null
    check (provider in ('quickbooks', 'stripe', 'gohighlevel', 'google', 'microsoft', 'monday', 'notion', 'timesolv')),
  state_hash text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  -- RFC 7636: 43-128 characters from the unreserved set.
  code_verifier text not null check (code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'),
  redirect_uri text not null check (redirect_uri ~ '^https?://[^\s]+$' and length(redirect_uri) <= 512),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  check (expires_at > created_at)
);
comment on table core.oauth_states is
  'OAuth connect state + PKCE verifier (T-035). Private: only core.oauth_state_create / core.oauth_state_consume.';

create index oauth_states_user_id_idx on core.oauth_states (user_id);
create index oauth_states_lane_id_idx on core.oauth_states (lane_id);

alter table core.oauth_states enable row level security;
revoke all on core.oauth_states from public, anon, authenticated, service_role;

-- At most 10 connects in flight per user (stops a loop from filling the table).
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
  -- Expired rows (anyone's: abandoned connects) go first; the table stays tiny.
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

create function core.oauth_state_consume(p_lane text, p_state_hash text)
returns table (provider text, code_verifier text, redirect_uri text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not core.has_lane_role(v_uid, p_lane, array['owner', 'admin_technical']) then
    return; -- same empty result as an unknown state
  end if;
  return query
    delete from core.oauth_states s
    where s.state_hash = p_state_hash
      and s.lane_id = p_lane
      and s.user_id = v_uid
      and s.expires_at > now()
    returning s.provider, s.code_verifier, s.redirect_uri;
end;
$$;
comment on function core.oauth_state_consume(text, text) is
  'Finishes a connect (T-035): returns and deletes the caller''s own unexpired state for the lane; empty otherwise.';
revoke all on function core.oauth_state_consume(text, text) from public, anon, service_role;
grant execute on function core.oauth_state_consume(text, text) to authenticated;
