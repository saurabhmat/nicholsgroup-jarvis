-- T-192: action.reconcile_stuck (docs/specs/approvals.md §6). An action left `executing` (the request was killed after the
-- provider accepted the send, or recording the result failed) is finished by a sweep that can ONLY verify or fail it.
--   * Nothing here creates an execution claim: the single claim of act.claim_execution stays the only one (primary key).
--   * act.reconcile_verified / act.reconcile_failed change the row only when it is still `executing`, its claim exists and
--     it has been executing for at least the lane's threshold (row lock + conditional update: two sweeps, or a sweep racing
--     a late-finishing execute, produce exactly one transition; the loser gets `false`).
--   * Terminal transitions purge the email body in the same statement (the existing guard trigger, D-19) and write the
--     status history; the history reason starts with "reconciler:".
-- Settings (lane_config.approvals, both optional): reconcile_after_minutes (default 10, 5 to 1440) and
-- reconcile_give_up_minutes (default 60, 10 to 2880, always at least reconcile_after_minutes + 5 so a not-found action is looked up
-- at least once more before it is given up on).
-- service_role only; nothing here is granted to authenticated.

create function act.approvals_minutes(p_lane text, p_key text, p_default integer, p_min integer, p_max integer) returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select case when c.config -> 'approvals' ->> p_key ~ '^[0-9]{1,5}$'
                 then least(greatest((c.config -> 'approvals' ->> p_key)::integer, p_min), p_max) end
     from core.lane_config_current c where c.lane_id = p_lane),
    p_default);
$$;
comment on function act.approvals_minutes(text, text, integer, integer, integer) is 'An integer setting of lane_config.approvals, clamped to p_min..p_max, or p_default (T-192).';
create function act.reconcile_after_minutes(p_lane text) returns integer
language sql stable set search_path = '' as $$ select act.approvals_minutes(p_lane, 'reconcile_after_minutes', 10, 5, 1440); $$;
create function act.reconcile_give_up_minutes(p_lane text) returns integer
language sql stable set search_path = '' as $$
  select greatest(act.approvals_minutes(p_lane, 'reconcile_give_up_minutes', 60, 10, 2880), act.reconcile_after_minutes(p_lane) + 5);
$$;
revoke all on function act.approvals_minutes(text, text, integer, integer, integer), act.reconcile_after_minutes(text),
  act.reconcile_give_up_minutes(text) from public, anon, authenticated;

-- The lane's actions that have been executing for at least the threshold, oldest first, with what the claim recorded.
-- `give_up` is true once the action is older than reconcile_give_up_minutes (the point at which an undecidable lookup ends
-- in failed / outcome_unknown instead of waiting for the next sweep). One lane per call; the app passes the lane.
create function act.stuck_actions(p_lane text, p_limit integer default 20)
returns table (action jsonb, claim_outcome text, claim_external_id text, give_up boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.to_jsonb(a), c.outcome, c.external_id,
         coalesce(a.executing_at, a.updated_at) <= pg_catalog.now() - pg_catalog.make_interval(mins => act.reconcile_give_up_minutes(p_lane))
  from act.proposed_actions a
  join act.execution_claims c on c.action_id = a.id and c.lane_id = a.lane_id
  where a.lane_id = p_lane and a.status = 'executing'
    and coalesce(a.executing_at, a.updated_at) <= pg_catalog.now() - pg_catalog.make_interval(mins => act.reconcile_after_minutes(p_lane))
  order by coalesce(a.executing_at, a.updated_at), a.id
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;
comment on function act.stuck_actions(text, integer) is 'Executing actions older than the lane threshold, with their claim state (T-192, service_role only).';

-- executing -> verified, by the reconciler. False (no change) when the action is no longer executing or is not yet due.
create function act.reconcile_verified(p_lane text, p_id uuid, p_external_id text, p_outcome text) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row act.proposed_actions%rowtype;
begin
  if p_outcome not in ('accepted', 'already_applied') or p_external_id is null or pg_catalog.length(p_external_id) not between 1 and 256 then
    raise exception 'act: invalid outcome' using errcode = '22023';
  end if;
  select a.* into v_row from act.proposed_actions a where a.id = p_id and a.lane_id = p_lane for update;
  if not found or v_row.status <> 'executing'
     or coalesce(v_row.executing_at, v_row.updated_at) > pg_catalog.now() - pg_catalog.make_interval(mins => act.reconcile_after_minutes(p_lane)) then
    return false;
  end if;
  if not exists (select 1 from act.execution_claims c where c.action_id = p_id and c.lane_id = p_lane) then
    raise exception 'act: no claim' using errcode = 'P0001';
  end if;
  -- The claim already holds the provider id of the send: never verify a different message.
  if exists (select 1 from act.execution_claims c where c.action_id = p_id and c.lane_id = p_lane and c.external_id is not null and c.external_id <> p_external_id) then
    return false;
  end if;
  perform pg_catalog.set_config('act.reason', 'reconciler: verified by read-back', true);
  update act.proposed_actions
  set status = 'verified', verified_at = pg_catalog.now(), executed_at = coalesce(executed_at, pg_catalog.now()),
      result = pg_catalog.jsonb_build_object('external_id', p_external_id, 'outcome', p_outcome, 'reconciled', true)
  where id = p_id and lane_id = p_lane and status = 'executing';
  update act.execution_claims set outcome = 'verified', finished_at = pg_catalog.now(), external_id = coalesce(external_id, p_external_id)
  where action_id = p_id and lane_id = p_lane;
  return true;
end;
$$;

-- executing -> failed, by the reconciler: a read-back mismatch, or an outcome nobody can decide (a human checks the mailbox).
create function act.reconcile_failed(p_lane text, p_id uuid, p_code text, p_outcome text) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row act.proposed_actions%rowtype;
begin
  if p_outcome not in ('mismatch', 'outcome_unknown', 'sent') or p_code is null or p_code !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'act: invalid outcome' using errcode = '22023';
  end if;
  select a.* into v_row from act.proposed_actions a where a.id = p_id and a.lane_id = p_lane for update;
  if not found or v_row.status <> 'executing'
     or coalesce(v_row.executing_at, v_row.updated_at) > pg_catalog.now() - pg_catalog.make_interval(mins => act.reconcile_after_minutes(p_lane)) then
    return false;
  end if;
  if not exists (select 1 from act.execution_claims c where c.action_id = p_id and c.lane_id = p_lane) then
    raise exception 'act: no claim' using errcode = 'P0001';
  end if;
  -- 'sent': the provider accepted the send (the claim holds its id) but it could not be read back; the claim keeps 'sent'.
  if p_outcome = 'sent' and not exists (select 1 from act.execution_claims c where c.action_id = p_id and c.lane_id = p_lane and c.outcome = 'sent') then
    raise exception 'act: invalid outcome' using errcode = '22023';
  end if;
  perform pg_catalog.set_config('act.reason', 'reconciler: failed: ' || p_code, true);
  update act.proposed_actions set status = 'failed', failure_code = p_code where id = p_id and lane_id = p_lane and status = 'executing';
  update act.execution_claims set outcome = p_outcome, finished_at = pg_catalog.now() where action_id = p_id and lane_id = p_lane;
  return true;
end;
$$;

-- The settled state of one action, for an execute that finds it was finished by someone else (the reconciler). Status and failure
-- code only. service_role only.
create function act.action_state(p_lane text, p_id uuid) returns table (status text, failure_code text)
language sql
stable
security definer
set search_path = ''
as $$
  select a.status, a.failure_code from act.proposed_actions a where a.lane_id = p_lane and a.id = p_id;
$$;

revoke all on function act.stuck_actions(text, integer), act.reconcile_verified(text, uuid, text, text),
  act.reconcile_failed(text, uuid, text, text), act.action_state(text, uuid) from public, anon, authenticated, service_role;
grant execute on function act.stuck_actions(text, integer), act.reconcile_verified(text, uuid, text, text),
  act.reconcile_failed(text, uuid, text, text), act.action_state(text, uuid) to service_role;

-- Wrappers (the exposed surface), same pattern as core.act_*.
create function core.act_stuck_actions(p_lane text, p_limit integer default 20)
returns table (action jsonb, claim_outcome text, claim_external_id text, give_up boolean)
language sql stable security invoker set search_path = '' as $$ select * from act.stuck_actions(p_lane, p_limit); $$;
create function core.act_reconcile_verified(p_lane text, p_id uuid, p_external_id text, p_outcome text) returns boolean
language sql security invoker set search_path = '' as $$ select act.reconcile_verified(p_lane, p_id, p_external_id, p_outcome); $$;
create function core.act_reconcile_failed(p_lane text, p_id uuid, p_code text, p_outcome text) returns boolean
language sql security invoker set search_path = '' as $$ select act.reconcile_failed(p_lane, p_id, p_code, p_outcome); $$;
create function core.act_action_state(p_lane text, p_id uuid) returns table (status text, failure_code text)
language sql stable security invoker set search_path = '' as $$ select * from act.action_state(p_lane, p_id); $$;
revoke all on function core.act_stuck_actions(text, integer), core.act_reconcile_verified(text, uuid, text, text),
  core.act_reconcile_failed(text, uuid, text, text), core.act_action_state(text, uuid) from public, anon, authenticated, service_role;
grant execute on function core.act_stuck_actions(text, integer), core.act_reconcile_verified(text, uuid, text, text),
  core.act_reconcile_failed(text, uuid, text, text), core.act_action_state(text, uuid) to service_role;
