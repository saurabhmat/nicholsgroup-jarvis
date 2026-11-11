-- T-234 part 0 re-review: withdraw a job's still-pending proposal. A briefing run that timed out must not leave an orphan
-- email.send proposal behind. act.withdraw_proposed moves ONE row from `proposed` to the existing terminal state
-- `invalidated` (the guard trigger purges the body and writes the status history with the given reason). It touches only a
-- proposal that is still `proposed` and was made by a job (proposer_kind = 'job'): an approved, executing or finished
-- action, and a person's own proposal, are never touched. service_role only; nothing is granted to authenticated.
create function act.withdraw_proposed(p_lane text, p_id uuid, p_reason text) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row act.proposed_actions%rowtype;
begin
  if p_lane is null or p_id is null or p_reason is null or pg_catalog.length(pg_catalog.btrim(p_reason)) not between 1 and 200 then
    raise exception 'act: a lane, an action and a reason of 1 to 200 characters are required' using errcode = '22023';
  end if;
  select a.* into v_row from act.proposed_actions a where a.id = p_id and a.lane_id = p_lane for update;
  if not found or v_row.status <> 'proposed' or v_row.proposer_kind <> 'job' then
    return false;
  end if;
  perform set_config('act.reason', 'withdrawn: ' || pg_catalog.btrim(p_reason), true);
  update act.proposed_actions set status = 'invalidated' where id = v_row.id;
  return true;
end;
$$;
comment on function act.withdraw_proposed(text, uuid, text) is
  'T-234: withdraws a still-pending JOB proposal (proposed -> invalidated, body purged by the guard). False when not found, not proposed or not a job proposal. service_role only.';

create function core.act_withdraw_proposed(p_lane text, p_id uuid, p_reason text) returns boolean
language sql security invoker set search_path = '' as $$ select act.withdraw_proposed(p_lane, p_id, p_reason); $$;

revoke all on function act.withdraw_proposed(text, uuid, text), core.act_withdraw_proposed(text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function act.withdraw_proposed(text, uuid, text), core.act_withdraw_proposed(text, uuid, text) to service_role;
