-- T-219: Composio as a transport for the Google connector (D-30, D-35; AI Brain spec §8.3). No new table: every table
-- touched already has lane_id, RLS and pgTAP (core.connections, core.oauth_states); this adds columns, indexes and two
-- reviewed functions, with pgTAP in 270_composio_transport.test.sql.
--
-- core.connections
--   transport          'native' (our Google OAuth client, tokens in the Vault: every existing row) or 'composio' (Composio
--                      holds the Google tokens; there is no token row for such a connection).
--   toolkit            the Composio toolkit slug ('gmail', 'googlecalendar', later more, T-222); null for native.
--   account_identity   the verified account address (the mailbox), lower-cased; set only by the activation function.
--   external_account_id (existing) holds the Composio connected account id ('ca_...', a non-secret id) for composio rows.
-- A composio connection is activated by core.connection_activate_composio (no token row, unlike connection_token_store).
-- D-23 still holds: one connected account per lane per toolkit, and one mailbox per lane (also against a native Google
-- connection of another lane). A reconnect (new Composio account) supersedes the lane's earlier usable account for the
-- toolkit (marked disconnected here; revoking it at Composio is an external write and runs only through approvals, D-24).
--
-- core.oauth_states gets `toolkit` and `account_ref` (the connected account id returned by Composio's link call, kept
-- server-side so the callback never trusts an id from the URL); the create/consume functions take and return them.

-- ---------------------------------------------------------------- core.connections
alter table core.connections
  add column transport text not null default 'native' check (transport in ('native', 'composio')),
  add column toolkit text check (toolkit ~ '^[a-z][a-z0-9_]{1,63}$'),
  add column account_identity text
    check (account_identity is null or (account_identity = pg_catalog.lower(pg_catalog.btrim(account_identity)) and length(account_identity) between 3 and 320 and account_identity ~ '^[^\s\u0000-\u001f\u007f-\u009f]+$'))
    check (account_identity is null or not core.jsonb_has_secret(pg_catalog.jsonb_build_object('v', account_identity)));

alter table core.connections
  add constraint connections_transport_shape check (
    (transport = 'native' and toolkit is null and account_identity is null)
    or (transport = 'composio' and toolkit is not null and (account_identity is not null or status in ('pending', 'disconnected')))
  );

comment on column core.connections.transport is 'native = our Google OAuth client and Vault tokens; composio = Composio holds the tokens (T-219, D-35).';
comment on column core.connections.toolkit is 'Composio toolkit slug of a composio connection (gmail, googlecalendar); null for native (T-219).';
comment on column core.connections.account_identity is 'Verified account address (lower-cased) of a composio connection; set by core.connection_activate_composio only (T-219).';

create unique index connections_one_composio_per_lane_toolkit
  on core.connections (lane_id, toolkit)
  where transport = 'composio' and status not in ('disconnected', 'pending');
create unique index connections_one_lane_per_composio_identity
  on core.connections (toolkit, pg_catalog.lower(account_identity))
  where transport = 'composio' and status not in ('disconnected', 'pending');
comment on index core.connections_one_composio_per_lane_toolkit is 'D-23: one Composio connected account per lane per toolkit.';
comment on index core.connections_one_lane_per_composio_identity is 'D-23: one Composio account address (per toolkit) is connected to one lane only.';

-- Transport, toolkit and (once set) the identity never change on a row, as lane, provider and account do not.
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
  return new;
end;
$$;
revoke all on function core.connections_identity_immutable() from public, anon, authenticated;

-- Column-level read access for Settings -> Connections (the existing policy applies: aal2 + the 'connections' view).
grant select (transport, toolkit, account_identity) on core.connections to authenticated;

-- Activates a composio connection after the server checked the Composio account (ACTIVE, right toolkit) and read its
-- identity, and checked that identity against lane_config.mailboxes. No token row. Security definer, service_role only
-- (the connector, after the signed-in owner/admin_technical at aal2 completed the connect flow).
create function core.connection_activate_composio(
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
  -- The same Google account connected natively in another lane holds it too (D-23 across transports).
  if exists (
    select 1 from core.connections n
    where n.provider = 'google' and n.transport = 'native' and n.lane_id <> p_lane_id
      and pg_catalog.lower(n.external_account_id) = v_identity and n.status not in ('disconnected', 'pending')
  ) then
    raise exception 'connection activate: the provider account is connected to another lane' using errcode = 'D0023';
  end if;
  -- A reconnect supersedes the lane's earlier usable account for this toolkit. No token to delete (none is stored).
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
comment on function core.connection_activate_composio(text, uuid, text, uuid) is
  'T-219: activates a composio connection (no token row) after the connector verified the account and its identity; supersedes the lane''s earlier account for the toolkit; D0023 when the account is another lane''s.';
revoke all on function core.connection_activate_composio(text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function core.connection_activate_composio(text, uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------- core.oauth_states (toolkit + account ref)
alter table core.oauth_states
  add column toolkit text check (toolkit is null or toolkit ~ '^[a-z][a-z0-9_]{1,63}$'),
  add column account_ref text check (account_ref is null or account_ref ~ '^[A-Za-z0-9_-]{1,128}$'),
  add constraint oauth_states_toolkit_ref check ((toolkit is null) = (account_ref is null));

drop function core.oauth_state_create(text, text, text, text, text);
create function core.oauth_state_create(
  p_lane text,
  p_provider text,
  p_state_hash text,
  p_code_verifier text,
  p_redirect_uri text,
  p_toolkit text default null,
  p_account_ref text default null
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
  insert into core.oauth_states (lane_id, user_id, provider, state_hash, code_verifier, redirect_uri, toolkit, account_ref)
  values (p_lane, v_uid, p_provider, p_state_hash, p_code_verifier, p_redirect_uri, p_toolkit, p_account_ref);
end;
$$;
comment on function core.oauth_state_create(text, text, text, text, text, text, text) is
  'Starts a connect (T-035, T-219): owner/admin_technical of the lane at aal2 only; stores the state hash, the PKCE verifier and, for a Composio connect, the toolkit and the connected account id.';
revoke all on function core.oauth_state_create(text, text, text, text, text, text, text) from public, anon, service_role;
grant execute on function core.oauth_state_create(text, text, text, text, text, text, text) to authenticated;

drop function core.oauth_state_consume(text, text);
create function core.oauth_state_consume(p_lane text, p_state_hash text)
returns table (provider text, code_verifier text, redirect_uri text, toolkit text, account_ref text)
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
    returning s.provider, s.code_verifier, s.redirect_uri, s.toolkit, s.account_ref;
end;
$$;
comment on function core.oauth_state_consume(text, text) is
  'Finishes a connect (T-035, T-219): returns and deletes the caller''s own unexpired state for the lane; empty otherwise.';
revoke all on function core.oauth_state_consume(text, text) from public, anon, service_role;
grant execute on function core.oauth_state_consume(text, text) to authenticated;
