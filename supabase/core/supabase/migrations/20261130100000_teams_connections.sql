-- T-278: Microsoft Teams connections (docs/specs/messages.md 4.2, 7.1; decision D-66: a separate Teams connection, provider
-- 'microsoft_teams', through a second Entra app used only for Teams). Everything is additive; the mail and calendar paths do not change.
--   * provider checks of core.connections, core.oauth_states, core.webhook_events and core.push_subscriptions accept 'microsoft_teams'.
--   * connections_owner_only_mail: a Teams row has an OWNER (the person who signed in to Teams). A Teams row without an owner is refused
--     (connections_teams_has_owner): it would be invisible to everyone.
--   * connections_identity_only_microsoft: the tenant and cloud columns may sit on a 'microsoft' or a 'microsoft_teams' row.
--   * core.connections.entra_object_id (new): the Entra object id of the Teams account (`/me` id). Teams rows only, set ONCE together with
--     the tenant and cloud by core.connection_set_teams_identity (service_role only), immutable afterwards (connections_identity_immutable),
--     NO column grant to authenticated (it is server-only: it recognises the person's own messages and builds the subscription resource).
--   * one usable Teams connection per person per lane (partial unique index connections_one_teams_per_owner; core.connection_set_teams_identity
--     checks it first and raises D0024 so the connect can say why). One Teams ACCOUNT in one lane only (D-23) is the existing
--     connections_one_lane_per_account index, which is keyed on (provider, address) and therefore also covers 'microsoft_teams'.
--   * core.teams_connection_ids(uid, lane): the one place "my Teams connections" is written (as core.mailbox_ids for mail). Fails closed.
--   * core.oauth_state_create / consume: 'microsoft_teams' is connected by any member holding own_mail (their OWN account), like google and
--     microsoft; every other provider still needs owner or admin_technical.
-- NOT changed: core.mailbox_ids and every mail/calendar reader keep `provider in ('google', 'microsoft')`, so a Teams row is never a mailbox
-- (pgTAP 328 asserts it). Row visibility of core.connections is unchanged (own rows through owner_user_id + own_mail; the `connections` view
-- reads the HEALTH columns of every row of the lane; entra_object_id is in neither grant).
-- Tests: 328_teams_connections.test.sql.

-- ---------------------------------------------------------------- provider checks
alter table core.connections drop constraint connections_provider_check;
alter table core.connections add constraint connections_provider_check
  check (provider in ('quickbooks', 'stripe', 'gohighlevel', 'google', 'microsoft', 'microsoft_teams', 'monday', 'notion', 'timesolv'));

alter table core.oauth_states drop constraint oauth_states_provider_check;
alter table core.oauth_states add constraint oauth_states_provider_check
  check (provider in ('quickbooks', 'stripe', 'gohighlevel', 'google', 'microsoft', 'microsoft_teams', 'monday', 'notion', 'timesolv'));

alter table core.webhook_events drop constraint webhook_events_provider_check;
alter table core.webhook_events add constraint webhook_events_provider_check
  check (provider in ('quickbooks', 'stripe', 'gohighlevel', 'google', 'microsoft', 'microsoft_teams', 'monday', 'notion', 'timesolv'));

alter table core.push_subscriptions drop constraint push_subscriptions_provider_check;
alter table core.push_subscriptions add constraint push_subscriptions_provider_check
  check (provider in ('google', 'microsoft', 'microsoft_teams'));

-- ---------------------------------------------------------------- owner and identity rules
alter table core.connections drop constraint connections_owner_only_mail;
alter table core.connections add constraint connections_owner_only_mail
  check (owner_user_id is null or provider in ('google', 'microsoft', 'microsoft_teams'));
alter table core.connections add constraint connections_teams_has_owner
  check (provider <> 'microsoft_teams' or owner_user_id is not null);

alter table core.connections drop constraint connections_identity_only_microsoft;
alter table core.connections add constraint connections_identity_only_microsoft
  check (tenant_id is null or provider in ('microsoft', 'microsoft_teams'));

alter table core.connections add column entra_object_id uuid;
comment on column core.connections.entra_object_id is
  'T-278: the Entra object id of a Teams account (microsoft_teams rows only). Set once with the tenant and cloud by core.connection_set_teams_identity; never changes; not readable by authenticated.';
alter table core.connections add constraint connections_entra_only_teams
  check (entra_object_id is null or provider = 'microsoft_teams');
-- a Teams identity is a tenant, a cloud AND an object id, all set together (the pair check already ties the tenant to the cloud)
alter table core.connections add constraint connections_teams_identity_complete
  check (provider <> 'microsoft_teams' or ((tenant_id is null) = (entra_object_id is null)));

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
  -- T-278: the Entra object id of a Teams account is set once and never changes or clears.
  if old.entra_object_id is not null and new.entra_object_id is distinct from old.entra_object_id then
    raise exception 'core.connections: the Entra object id cannot change' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function core.connections_identity_immutable() from public, anon, authenticated;

-- one usable Teams connection per person per lane (a disconnected or pending row does not count: a reconnect reuses the row, a new account
-- can be connected after a Disconnect)
create unique index connections_one_teams_per_owner on core.connections (lane_id, owner_user_id)
  where provider = 'microsoft_teams' and status not in ('disconnected', 'pending');

-- ---------------------------------------------------------------- set the Teams identity once
-- Errors carry no value: 22004 a required argument is null; 22023 the cloud is not allowed; P0002 no such connection in this lane (the same for
-- "no such id" and "another lane"); 23514 the connection is not a Teams one; 55000 the identity is already set; D0024 the owner already has
-- ANOTHER usable Teams connection in this lane.
create function core.connection_set_teams_identity(
  p_lane text,
  p_connection_id uuid,
  p_tenant_id uuid,
  p_cloud text,
  p_entra_object_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider text;
  v_set uuid;
  v_owner uuid;
begin
  if p_lane is null or p_connection_id is null or p_tenant_id is null or p_cloud is null or p_entra_object_id is null then
    raise exception 'teams identity: lane, connection, tenant, cloud and object id are required' using errcode = '22004';
  end if;
  if p_cloud not in ('commercial', 'gcc_high') then
    raise exception 'teams identity: the cloud is not allowed' using errcode = '22023';
  end if;
  select c.provider, c.tenant_id, c.owner_user_id into v_provider, v_set, v_owner
  from core.connections c where c.id = p_connection_id and c.lane_id = p_lane for update;
  if v_provider is null then
    raise exception 'teams identity: no such connection in this lane' using errcode = 'P0002';
  elsif v_provider <> 'microsoft_teams' then
    raise exception 'teams identity: not a Teams connection' using errcode = '23514';
  elsif v_set is not null then
    raise exception 'teams identity: already set' using errcode = '55000';
  end if;
  -- One usable Teams connection per person per lane: said here, before any token is stored, so the connect can refuse with a fixed message.
  if exists (
    select 1 from core.connections o
    where o.lane_id = p_lane and o.provider = 'microsoft_teams' and o.owner_user_id = v_owner
      and o.id <> p_connection_id and o.status not in ('disconnected', 'pending')
  ) then
    raise exception 'teams identity: this person already has a Teams connection in this lane' using errcode = 'D0024';
  end if;
  update core.connections c set tenant_id = p_tenant_id, cloud = p_cloud, entra_object_id = p_entra_object_id
   where c.id = p_connection_id and c.lane_id = p_lane and c.provider = 'microsoft_teams' and c.tenant_id is null;
  if not found then
    raise exception 'teams identity: already set' using errcode = '55000';
  end if;
end;
$$;
comment on function core.connection_set_teams_identity(text, uuid, uuid, text, uuid) is
  'T-278: sets the Entra tenant id, cloud and object id of a Teams connection ONCE; service_role only; lane-checked; refuses a non-Teams row, a second set (55000) and a second usable Teams connection of the same owner in the lane (D0024).';
revoke all on function core.connection_set_teams_identity(text, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function core.connection_set_teams_identity(text, uuid, uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------- my Teams connections (one definition)
-- The Teams connections p_uid owns (in p_lane, or in every lane when null) while p_uid holds own_mail there. Fails closed: empty unless
-- core.may_resolve(p_uid) (the caller's own uid at AAL2, or the service role asking on a job's behalf), and only for enabled lanes.
create function core.teams_connection_ids(p_uid uuid, p_lane text default null) returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(c.id order by c.id), '{}'::uuid[])
  from core.connections c
  where core.may_resolve(p_uid)
    and p_uid is not null
    and c.owner_user_id = p_uid
    and c.provider = 'microsoft_teams'
    and (p_lane is null or c.lane_id = p_lane)
    and c.lane_id = any (core.allowed_lanes(p_uid, 'own_mail'));
$$;
comment on function core.teams_connection_ids(uuid, text) is
  'T-278: ids of the Teams connections p_uid owns (in p_lane, or any lane when null), while p_uid holds own_mail there. Empty unless p_uid is the caller at AAL2 or the caller is service_role.';
revoke all on function core.teams_connection_ids(uuid, text) from public, anon;
grant execute on function core.teams_connection_ids(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------- connect gate: microsoft_teams like google and microsoft
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
           when p_provider in ('google', 'microsoft', 'microsoft_teams') then p_lane = any (core.allowed_lanes(v_uid, 'own_mail'))
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
  'Starts a connect (T-035; T-247; T-254; T-278): google, microsoft and microsoft_teams need own_mail in the lane (a member connects their OWN account), any other provider owner/admin_technical, at aal2; stores the state hash and PKCE verifier.';
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
            when s.provider in ('google', 'microsoft', 'microsoft_teams') then p_lane = any (core.allowed_lanes(v_uid, 'own_mail'))
            else core.has_lane_role(v_uid, p_lane, array['owner', 'admin_technical'])
          end
    returning s.provider, s.code_verifier, s.redirect_uri, s.toolkit, s.account_ref;
end;
$$;
comment on function core.oauth_state_consume(text, text) is
  'Finishes a connect (T-035, T-219; T-247; T-254; T-278): returns and deletes the caller''s own unexpired state for the lane when they may still connect that provider (google, microsoft, microsoft_teams: own_mail; others: owner/admin_technical); empty otherwise.';
revoke all on function core.oauth_state_consume(text, text) from public, anon, service_role;
grant execute on function core.oauth_state_consume(text, text) to authenticated;
