-- T-195: `qbo.disconnect` joins the Approval Center (D-24: revoking our QuickBooks grant at Intuit is an external write and
-- runs only through approvals). Same state machine, hash, step-up and single claim as email (T-232), with these differences:
--   * act.is_allowed_type accepts 'qbo.disconnect'; act.proposed_actions.provider accepts 'quickbooks'.
--   * Who: owner or admin_technical of the lane may propose, approve and reject it (act.write_roles); email stays owner only.
--     A qbo.disconnect proposal is made by a person (proposer_kind 'user'), never by a job or the assistant.
--   * What: the connection must be a QuickBooks connection of the lane that is not disconnected (reconnect_required is fine:
--     disconnecting a broken connection is a normal use). target = {"realm_id": <the connection's realm>} and payload = {} exactly,
--     so there is nothing else to hide in a proposal; one pending proposal per connection.
--   * Gate: the lane policy class 'qbo_disconnect' (core.lane_policies.write_actions_allowed) and lane_config approvals_live, at
--     approve and again at claim, exactly like email. The connection need not hold a Google grant.
--   * Visibility: members with the 'connections' view (owner, admin_technical) read qbo.disconnect actions of their lane; the
--     other policy (own proposals, owner sees all) is unchanged. No content is stored: no body to purge.
--   * core.connection_token_store clears last_error when a (re)connect stores new tokens (reconnect after reconnect_required).
-- Safe to re-run: create or replace, drop-if-exists and re-add only.

-- ---------------------------------------------------------------- lane policy class
alter table core.lane_policies drop constraint if exists lane_policies_write_actions_allowed_check;
alter table core.lane_policies add constraint lane_policies_write_actions_allowed_check
  check (write_actions_allowed <@ array['email_draft', 'email_send', 'calendar', 'monday', 'notion', 'qbo_disconnect']::text[]);

-- ---------------------------------------------------------------- helpers
create or replace function act.is_allowed_type(p_type text) returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_type in ('email.send', 'email.save_draft', 'qbo.disconnect');
$$;

-- The roles that may propose, approve, reject and execute an action type in a lane.
create or replace function act.write_roles(p_type text) returns text[]
language sql
immutable
set search_path = ''
as $$
  select case when p_type = 'qbo.disconnect' then array['owner', 'admin_technical']::text[] else array['owner']::text[] end;
$$;
revoke all on function act.write_roles(text) from public, anon, authenticated;

create or replace function act.type_allowed(p_lane text, p_type text) returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from core.lane_policies p
    where p.lane_id = p_lane
      and ((p_type = 'email.send' and 'email_send' = any (p.write_actions_allowed))
        or (p_type = 'email.save_draft' and 'email_draft' = any (p.write_actions_allowed))
        or (p_type = 'qbo.disconnect' and 'qbo_disconnect' = any (p.write_actions_allowed)))
  );
$$;

-- The connection of an action is usable for its type: email needs a Google connection that was granted compose; qbo.disconnect
-- needs the lane's QuickBooks connection that is not yet disconnected and is the realm the action names.
create or replace function act.connection_ok(p_lane text, p_row act.proposed_actions) returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from core.connections c
    where c.id = p_row.connection_id and c.lane_id = p_lane
      and case
            when p_row.action_type = 'qbo.disconnect' then
              c.provider = 'quickbooks' and c.status in ('active', 'degraded', 'reconnect_required')
              and p_row.target = pg_catalog.jsonb_build_object('realm_id', c.external_account_id)
            else c.status in ('active', 'degraded') and c.features ->> 'gmail_compose' = 'true'
          end);
$$;
revoke all on function act.connection_ok(text, act.proposed_actions) from public, anon, authenticated;

-- ---------------------------------------------------------------- table
alter table act.proposed_actions drop constraint if exists proposed_actions_provider_check;
alter table act.proposed_actions add constraint proposed_actions_provider_check check (provider in ('google', 'microsoft', 'quickbooks'));

drop policy if exists proposed_actions_select on act.proposed_actions;
create policy proposed_actions_select on act.proposed_actions
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and (
      lane_id = any ((select core.allowed_lanes((select auth.uid()), 'approvals'))::text[])
      or (proposer_user_id = (select auth.uid())
          and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'lanes'))::text[]))
      or (action_type = 'qbo.disconnect'
          and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'connections'))::text[]))
    )
  );

-- ---------------------------------------------------------------- propose
create or replace function act.insert_proposal(
  p_lane text, p_type text, p_connection uuid, p_target jsonb, p_payload jsonb, p_version integer, p_hash text,
  p_rationale text, p_source_refs jsonb, p_proposer_kind text, p_proposer_user uuid, p_derived boolean, p_supersedes uuid
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_provider text;
  v_account text;
  v_id uuid;
begin
  if p_lane is null or p_type is null or p_connection is null or p_target is null or p_payload is null or p_hash is null then
    raise exception 'act: lane, type, connection, target, payload and hash are required' using errcode = '22004';
  end if;
  if not act.is_allowed_type(p_type) or act.is_denied_type(p_type) then
    raise exception 'act: this action type is not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from core.lanes l where l.code = p_lane and l.enabled) then
    raise exception 'act: the lane is not enabled' using errcode = '42501';
  end if;
  -- D-19: an email proposal stores the composed body, which the lane must have allowed.
  if p_type like 'email.%' and not exists (select 1 from core.lane_policies lp where lp.lane_id = p_lane and lp.store_outbound_drafts) then
    raise exception 'act: this lane does not allow storing outbound drafts' using errcode = '42501';
  end if;
  select c.provider, c.external_account_id into v_provider, v_account from core.connections c
  where c.id = p_connection and c.lane_id = p_lane and c.status <> 'disconnected';
  if v_provider is null then
    raise exception 'act: the connection does not belong to this lane or is disconnected' using errcode = '23503';
  end if;
  if p_type = 'qbo.disconnect' then
    -- A person's proposal only, for a QuickBooks connection, with exactly the realm as target and nothing in the payload.
    if p_proposer_kind <> 'user' or p_proposer_user is null or not core.has_lane_role(p_proposer_user, p_lane, act.write_roles(p_type)) then
      raise exception 'act: the owner or admin_technical role is required to propose this' using errcode = '42501';
    end if;
    if v_provider <> 'quickbooks' or p_target is distinct from pg_catalog.jsonb_build_object('realm_id', v_account) or p_payload <> '{}'::jsonb then
      raise exception 'act: the target or payload is not valid for this action' using errcode = '22023';
    end if;
  elsif v_provider not in ('google', 'microsoft') then
    raise exception 'act: the connection does not belong to this lane and provider' using errcode = '23503';
  end if;
  -- One proposal writer per lane at a time: the cap and the duplicate check below cannot race (T-232 review M2, T-231d).
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('act.insert_proposal:' || p_lane));
  -- The cap counts only unexpired proposals (expiry is lazy: an expired row still says 'proposed' until act.expire_stale).
  if (select count(*) from act.proposed_actions a where a.lane_id = p_lane and a.status = 'proposed' and a.expires_at > pg_catalog.now()
        and a.id is distinct from p_supersedes) >= 20 then
    raise exception 'act: too many pending proposals in this lane' using errcode = '54000';
  end if;
  if p_type = 'qbo.disconnect' and exists (
       select 1 from act.proposed_actions a
       where a.lane_id = p_lane and a.connection_id = p_connection and a.action_type = 'qbo.disconnect'
         and ((a.status = 'proposed' and a.expires_at > pg_catalog.now()) or a.status in ('approved', 'executing'))) then
    raise exception 'act: disconnect_already_pending' using errcode = '23505';
  end if;
  -- T-231d: jobs (the daily briefing) have their own, smaller cap, so mail that lands in "attention" can never fill the
  -- lane's slots and lock the owner's own proposals out (T-231d security review M4).
  if p_proposer_kind = 'job' and p_supersedes is null
     and (select count(*) from act.proposed_actions a where a.lane_id = p_lane and a.status = 'proposed' and a.proposer_kind = 'job'
            and a.expires_at > pg_catalog.now()) >= 6 then
    raise exception 'act: too many pending proposals in this lane (prepared replies)' using errcode = '54000';
  end if;
  -- T-231d: a job proposes at most one reply per message replied to: never while one is pending, approved, being sent
  -- or sent, and not again for 7 days after the owner rejected one (T-231d security review L1). A user's own proposals
  -- and edits (supersede) are not limited by this.
  if p_proposer_kind = 'job' and p_supersedes is null and p_payload -> 'inReplyTo' ->> 'messageId' is not null
     and exists (select 1 from act.proposed_actions a
                 where a.lane_id = p_lane and a.connection_id = p_connection
                   and a.payload -> 'inReplyTo' ->> 'messageId' = p_payload -> 'inReplyTo' ->> 'messageId'
                   and ((a.status = 'proposed' and a.expires_at > pg_catalog.now())
                        or a.status in ('approved', 'executing', 'verified')
                        or (a.status = 'failed' and act.is_unknown_failure(a.failure_code) and a.updated_at > pg_catalog.now() - interval '24 hours')
                        or (a.status = 'rejected' and a.updated_at > pg_catalog.now() - interval '7 days'))) then
    raise exception 'act: a reply to this message is already waiting for approval' using errcode = '23505';
  end if;
  -- T-234 part 3: the owner has one pending reply per message. A second proposal (two tabs, a double click) is refused; the app
  -- loads and edits the pending one. An edit (supersede) passes p_supersedes and is not affected.
  if p_proposer_kind = 'user' and p_supersedes is null and p_payload -> 'inReplyTo' ->> 'messageId' is not null
     and exists (select 1 from act.proposed_actions a
                 where a.lane_id = p_lane and a.connection_id = p_connection and a.status = 'proposed' and a.expires_at > pg_catalog.now()
                   and a.payload -> 'inReplyTo' ->> 'messageId' = p_payload -> 'inReplyTo' ->> 'messageId') then
    raise exception 'act: reply_already_pending' using errcode = '23505';
  end if;
  insert into act.proposed_actions (lane_id, action_type, connection_id, provider, target, payload, payload_schema_version, payload_sha256,
                                    rationale, source_refs, proposer_kind, proposer_user_id, derived_from_retrieved, supersedes_id, expires_at)
  values (p_lane, p_type, p_connection, v_provider, p_target, p_payload, p_version, p_hash,
          p_rationale, coalesce(p_source_refs, '[]'::jsonb), p_proposer_kind, p_proposer_user, coalesce(p_derived, false), p_supersedes,
          pg_catalog.now() + pg_catalog.make_interval(hours => act.expiry_hours(p_lane, p_type)))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function act.insert_proposal(text, text, uuid, jsonb, jsonb, integer, text, text, jsonb, text, uuid, boolean, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- approve
create or replace function act.approve(p_lane text, p_id uuid, p_hash_seen text) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row act.proposed_actions%rowtype;
  v_max integer;
  v_raw text;
begin
  if v_uid is null or coalesce((select auth.jwt() ->> 'aal'), '') <> 'aal2' then
    raise exception 'act: a signed-in session at aal2 is required' using errcode = '42501';
  end if;
  -- Any role that may approve something here; the role for this action's own type is checked once the row is loaded.
  if p_lane is null or p_id is null or p_hash_seen is null or not core.has_lane_role(v_uid, p_lane, array['owner', 'admin_technical']) then
    raise exception 'act: the owner role in this lane is required' using errcode = '42501';
  end if;
  -- Bounded here too (security review L1): a bad or huge lane setting never widens the TOTP window; 30..900 s, default 300.
  v_raw := act.lane_setting(p_lane, 'step_up_max_age_s');
  v_max := case when v_raw ~ '^[0-9]{1,4}$' then least(greatest(v_raw::integer, 30), 900) else 300 end;
  if not act.step_up_ok(v_max) then
    raise exception 'act: step_up_required' using errcode = '42501';
  end if;
  select a.* into v_row from act.proposed_actions a where a.id = p_id and a.lane_id = p_lane for update;
  if not found then
    raise exception 'act: not_found' using errcode = 'P0002';
  end if;
  if not core.has_lane_role(v_uid, p_lane, act.write_roles(v_row.action_type)) then
    raise exception 'act: the owner role in this lane is required' using errcode = '42501';
  end if;
  if v_row.status = 'approved' then
    raise exception 'act: already_approved' using errcode = 'P0001';
  end if;
  if v_row.status <> 'proposed' then
    raise exception 'act: not_pending' using errcode = 'P0001';
  end if;
  if v_row.expires_at <= pg_catalog.now() then
    raise exception 'act: expired' using errcode = 'P0001';
  end if;
  if v_row.payload_purged_at is not null or p_hash_seen <> v_row.payload_sha256 then
    raise exception 'act: hash_mismatch' using errcode = 'P0001';
  end if;
  if coalesce(act.lane_setting(p_lane, 'approvals_live'), 'false') <> 'true' then
    raise exception 'act: not_live' using errcode = 'P0001';
  end if;
  if not act.type_allowed(p_lane, v_row.action_type) then
    raise exception 'act: type_not_allowed' using errcode = 'P0001';
  end if;
  if not act.connection_ok(p_lane, v_row) then
    raise exception 'act: connection_not_enabled' using errcode = 'P0001';
  end if;
  -- T-234 part 3: never approve a second email into a conversation while an earlier one is approved, being sent, or ended in a
  -- state where it may have gone out (unknown outcome, 24 h). The check and the status change run under one lock per thread.
  if v_row.payload -> 'inReplyTo' ->> 'threadId' is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('act.approve:' || p_lane || ':' || v_row.connection_id::text || ':' || (v_row.payload -> 'inReplyTo' ->> 'threadId')));
    if exists (select 1 from act.proposed_actions a
               where a.lane_id = p_lane and a.connection_id = v_row.connection_id and a.id <> v_row.id
                 and a.payload -> 'inReplyTo' ->> 'threadId' = v_row.payload -> 'inReplyTo' ->> 'threadId'
                 and (a.status in ('approved', 'executing')
                      or (a.status = 'failed' and act.is_unknown_failure(a.failure_code) and a.updated_at > pg_catalog.now() - interval '24 hours'))) then
      raise exception 'act: check_sent_first' using errcode = 'P0001';
    end if;
    -- T-234 part 3 re-check M1: a draft made BEFORE the latest reply in this conversation went out is stale.
    if exists (select 1 from act.proposed_actions a
               where a.lane_id = p_lane and a.connection_id = v_row.connection_id and a.id <> v_row.id
                 and a.action_type = 'email.send' and a.status = 'verified' and a.verified_at > v_row.created_at
                 and a.payload -> 'inReplyTo' ->> 'threadId' = v_row.payload -> 'inReplyTo' ->> 'threadId') then
      raise exception 'act: already_replied' using errcode = 'P0001';
    end if;
  end if;
  perform set_config('act.reason', 'approved', true);
  update act.proposed_actions
  set status = 'approved', approved_by = v_uid, approved_at = pg_catalog.now(), approved_hash = v_row.payload_sha256
  where id = v_row.id;
  return v_row.payload_sha256;
end;
$$;
comment on function act.approve(text, uuid, text) is
  'Approves the exact payload: aal2, TOTP step-up within step_up_max_age_s (amr), a role that may approve this type (act.write_roles: owner; owner or admin_technical for qbo.disconnect), hash seen = stored hash, not expired, approvals_live, type allowed by lane policy, connection usable for the type (act.connection_ok), and for email no other approved/executing/failed-unknown action in the same thread and not made before the latest verified reply.';
revoke all on function act.approve(text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function act.approve(text, uuid, text) to authenticated;

-- ---------------------------------------------------------------- reject
create or replace function act.reject(p_lane text, p_id uuid, p_reason text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row act.proposed_actions%rowtype;
begin
  if v_uid is null or coalesce((select auth.jwt() ->> 'aal'), '') <> 'aal2' then
    raise exception 'act: a signed-in session at aal2 is required' using errcode = '42501';
  end if;
  if p_lane is null or p_id is null or not core.has_lane_role(v_uid, p_lane, array['owner', 'admin_technical']) then
    raise exception 'act: the owner role in this lane is required' using errcode = '42501';
  end if;
  if p_reason is null or pg_catalog.length(pg_catalog.btrim(p_reason)) not between 1 and 500 then
    raise exception 'act: a reason of 1 to 500 characters is required' using errcode = '22023';
  end if;
  select a.* into v_row from act.proposed_actions a where a.id = p_id and a.lane_id = p_lane for update;
  if not found then
    raise exception 'act: not_found' using errcode = 'P0002';
  end if;
  if not core.has_lane_role(v_uid, p_lane, act.write_roles(v_row.action_type)) then
    raise exception 'act: the owner role in this lane is required' using errcode = '42501';
  end if;
  if v_row.status <> 'proposed' then
    raise exception 'act: not_pending' using errcode = 'P0001';
  end if;
  perform set_config('act.reason', pg_catalog.btrim(p_reason), true);
  update act.proposed_actions set status = 'rejected' where id = v_row.id;
end;
$$;
comment on function act.reject(text, uuid, text) is 'Rejects a pending proposal (aal2, a role that may approve its type, reason required); an email body is purged (D-19).';
revoke all on function act.reject(text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function act.reject(text, uuid, text) to authenticated;

-- ---------------------------------------------------------------- claim
create or replace function act.claim_execution(p_lane text, p_id uuid) returns act.proposed_actions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row act.proposed_actions%rowtype;
begin
  select a.* into v_row from act.proposed_actions a where a.id = p_id and a.lane_id = p_lane for update;
  if not found then
    raise exception 'act: not_found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'approved' then
    raise exception 'act: not_approved' using errcode = 'P0001';
  end if;
  if v_row.approved_hash is distinct from v_row.payload_sha256 then
    raise exception 'act: hash_mismatch' using errcode = 'P0001';
  end if;
  if v_row.expires_at <= pg_catalog.now() then
    raise exception 'act: expired' using errcode = 'P0001';
  end if;
  if coalesce(act.lane_setting(p_lane, 'approvals_live'), 'false') <> 'true' then
    raise exception 'act: not_live' using errcode = 'P0001';
  end if;
  if not act.type_allowed(p_lane, v_row.action_type) then
    raise exception 'act: type_not_allowed' using errcode = 'P0001';
  end if;
  if not core.has_lane_role(v_row.approved_by, p_lane, act.write_roles(v_row.action_type)) then
    raise exception 'act: approver_revoked' using errcode = 'P0001';
  end if;
  if not act.connection_ok(p_lane, v_row) then
    raise exception 'act: connection_not_enabled' using errcode = 'P0001';
  end if;
  begin
    insert into act.execution_claims (action_id, lane_id, idempotency_key) values (v_row.id, p_lane, v_row.id);
  exception when unique_violation then
    raise exception 'act: already_claimed' using errcode = 'P0001';
  end;
  perform set_config('act.reason', 'execution claimed', true);
  update act.proposed_actions set status = 'executing', executing_at = pg_catalog.now() where id = v_row.id returning * into v_row;
  return v_row;
end;
$$;
comment on function act.claim_execution(text, uuid) is
  'approved -> executing with the single execution claim (service_role only). Re-checks hash, expiry, approvals_live, lane policy, approver role for the type and the connection.';
revoke all on function act.claim_execution(text, uuid) from public, anon, authenticated, service_role;
grant execute on function act.claim_execution(text, uuid) to service_role;

-- ---------------------------------------------------------------- reconnect clears the old error
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
    -- T-195: a (re)connect stores working tokens, so the error that made it reconnect_required no longer applies.
    update core.connections set status = 'active', token_expires_at = p_expires_at, last_error = null where id = p_connection_id;
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
revoke all on function core.connection_token_store(text, uuid, text, timestamptz, uuid) from public, anon, authenticated;
grant execute on function core.connection_token_store(text, uuid, text, timestamptz, uuid) to service_role;
