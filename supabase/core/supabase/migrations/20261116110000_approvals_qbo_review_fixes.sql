-- T-195 review fixes (security I1, L4, code M1). Applied after 20261116100000.
--   * act.approve / act.reject: the per-type role is part of the row lookup (not_found otherwise, no id probing).
--   * qbo.disconnect may only be proposed for a QuickBooks connection that is active, degraded or reconnect_required (the same list as
--     act.connection_ok): a BEFORE INSERT trigger on act.proposed_actions, so every insert path is covered.
--   * core.connections.reconnect_notified_at: set when the reconnect_required admin notice was sent; while null the daily token-health scan
--     re-raises the alert (T-195 code review M1). Not granted to authenticated (column grants on core.connections are explicit).
-- Safe to re-run.

alter table core.connections add column if not exists reconnect_notified_at timestamptz;
comment on column core.connections.reconnect_notified_at is 'T-195: when the reconnect_required admin notice was sent; null = not yet (the daily health scan re-raises it). Service role only.';

create or replace function act.qbo_disconnect_status_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.action_type = 'qbo.disconnect' and not exists (
       select 1 from core.connections c
       where c.id = new.connection_id and c.lane_id = new.lane_id and c.provider = 'quickbooks'
         and c.status in ('active', 'degraded', 'reconnect_required')) then
    raise exception 'act: the connection does not belong to this lane or is disconnected' using errcode = '23503';
  end if;
  return new;
end;
$$;
revoke all on function act.qbo_disconnect_status_guard() from public, anon, authenticated;
drop trigger if exists proposed_actions_qbo_status on act.proposed_actions;
create trigger proposed_actions_qbo_status before insert on act.proposed_actions
  for each row execute function act.qbo_disconnect_status_guard();

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
  -- T-195 review I1: the role for the action's own type is part of the lookup, so a member whose role does not cover this type
  -- (admin_technical and an email id) gets the same not_found as for an id that does not exist and cannot probe ids.
  select a.* into v_row from act.proposed_actions a
  where a.id = p_id and a.lane_id = p_lane and core.has_lane_role(v_uid, p_lane, act.write_roles(a.action_type)) for update;
  if not found then
    raise exception 'act: not_found' using errcode = 'P0002';
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
  -- T-195 review I1: the role for the action's own type is part of the lookup, so a member whose role does not cover this type
  -- (admin_technical and an email id) gets the same not_found as for an id that does not exist and cannot probe ids.
  select a.* into v_row from act.proposed_actions a
  where a.id = p_id and a.lane_id = p_lane and core.has_lane_role(v_uid, p_lane, act.write_roles(a.action_type)) for update;
  if not found then
    raise exception 'act: not_found' using errcode = 'P0002';
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

