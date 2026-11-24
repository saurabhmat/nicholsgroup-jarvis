-- T-294: several Teams accounts per person in one lane (docs/specs/messages.md section 22.1, 22.2; production part 37).
-- The number is a lane setting (lane_config teams.max_accounts_per_person, an integer 1 - 5, default 1), so a lane keeps today's behaviour until a human
-- config version raises it. What changes:
--   * the unique index connections_one_teams_per_owner is dropped (a count from lane_config cannot be an index);
--   * core.teams_account_limit(lane) reads the limit (fail closed: missing, malformed or out of range is 1);
--   * core.teams_assert_one_per_owner(lane, connection) keeps its name, signature, grants and error codes; the body now compares the owner's OTHER counted Teams
--     connections in the lane with the limit (the name is historical);
--   * a before insert / update-of-status trigger on core.connections is the backstop: a move INTO a counted status (anything but disconnected or pending) is checked
--     under an advisory lock per (lane, owner), so two concurrent connects of one person wait for each other.
-- Unchanged on purpose: connections_one_teams_per_entra_object and connections_one_lane_per_account (one Microsoft account is one row in one lane, owned by one person),
-- core.connection_set_teams_identity, core.connection_token_store (its branch for the dropped index becomes unreachable; the trigger's D0024 passes through it),
-- core.teams_connection_ids and every RLS policy. No row is changed: the existing Teams rows stay valid.
-- Synthetic examples only.

drop index core.connections_one_teams_per_owner;

-- ---------------------------------------------------------------- the lane's limit
-- An integer 1 - 5 is returned as is; a missing key, a string, a fraction, 0 or 6 returns 1 (fail closed, and the default). Server-side only.
create function core.teams_account_limit(p_lane text) returns int
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_raw jsonb;
  v_num numeric;
begin
  if p_lane is null then
    return 1;
  end if;
  select c.config #> '{teams,max_accounts_per_person}' into v_raw
  from core.lane_config c where c.lane_id = p_lane order by c.version desc limit 1;
  if v_raw is null or pg_catalog.jsonb_typeof(v_raw) <> 'number' then
    return 1;
  end if;
  v_num := (v_raw #>> '{}')::numeric;
  if v_num <> pg_catalog.trunc(v_num) or v_num < 1 or v_num > 5 then
    return 1;
  end if;
  return v_num::int;
end;
$$;
comment on function core.teams_account_limit(text) is
  'T-294: how many Teams connections one person may have in the lane (lane_config teams.max_accounts_per_person, an integer 1 - 5); anything else, and a lane without a config, is 1; service_role only.';
revoke all on function core.teams_account_limit(text) from public, anon, authenticated;
grant execute on function core.teams_account_limit(text) to service_role;

-- ---------------------------------------------------------------- the check said before a token is stored
-- D0024: making this Teams connection usable would give its owner more counted Teams connections in the lane than core.teams_account_limit(lane). A connection that is
-- itself already counted passes (lowering the limit never refuses a row that is already usable). 22004 a required argument is null; P0002 no such connection in THIS
-- lane (another lane's id gets the same answer); 23514 not a Teams connection. The name is historical (it said "one per owner" before T-294).
create or replace function core.teams_assert_one_per_owner(p_lane text, p_connection_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider text;
  v_owner uuid;
  v_status text;
  v_others int;
begin
  if p_lane is null or p_connection_id is null then
    raise exception 'teams one per owner: lane and connection are required' using errcode = '22004';
  end if;
  select c.provider, c.owner_user_id, c.status into v_provider, v_owner, v_status from core.connections c where c.id = p_connection_id and c.lane_id = p_lane;
  if v_provider is null then
    raise exception 'teams one per owner: no such connection in this lane' using errcode = 'P0002';
  elsif v_provider <> 'microsoft_teams' then
    raise exception 'teams one per owner: not a Teams connection' using errcode = '23514';
  end if;
  if v_status not in ('disconnected', 'pending') then
    return; -- already counted: not a move into "counted"
  end if;
  select pg_catalog.count(*)::int into v_others from core.connections o
  where o.lane_id = p_lane and o.provider = 'microsoft_teams' and o.owner_user_id = v_owner
    and o.id <> p_connection_id and o.status not in ('disconnected', 'pending');
  if v_others >= core.teams_account_limit(p_lane) then
    raise exception 'teams one per owner: this person already has as many Teams connections in this lane as it allows' using errcode = 'D0024';
  end if;
end;
$$;
comment on function core.teams_assert_one_per_owner(text, uuid) is
  'T-278, body replaced by T-294 (the name is historical): raises D0024 when making this Teams connection usable would give its owner more counted Teams connections in the lane than core.teams_account_limit; an already counted row passes; service_role only; lane-checked.';
revoke all on function core.teams_assert_one_per_owner(text, uuid) from public, anon, authenticated;
grant execute on function core.teams_assert_one_per_owner(text, uuid) to service_role;

-- ---------------------------------------------------------------- the backstop
-- Only a move INTO a counted status is checked (an insert, or an update from pending or disconnected); a row that is already counted never fails here.
-- The advisory lock is per (lane, owner) and held to the end of the transaction, so the count below sees a concurrent connect that committed first.
create function core.connections_teams_account_limit() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_others int;
begin
  if new.status in ('disconnected', 'pending') or new.owner_user_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status not in ('disconnected', 'pending') then
    return new;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('teams_account_limit:' || new.lane_id || ':' || new.owner_user_id::text, 0));
  select pg_catalog.count(*)::int into v_others from core.connections o
  where o.lane_id = new.lane_id and o.provider = 'microsoft_teams' and o.owner_user_id = new.owner_user_id
    and o.id <> new.id and o.status not in ('disconnected', 'pending');
  if v_others >= core.teams_account_limit(new.lane_id) then
    raise exception 'core.connections: this person already has as many Teams connections in this lane as it allows' using errcode = 'D0024';
  end if;
  return new;
end;
$$;
comment on function core.connections_teams_account_limit() is
  'T-294: trigger; a Teams connection becoming usable (insert, or an update of status out of pending or disconnected) is refused with D0024 when its owner would exceed the lane limit; advisory lock per (lane, owner); no API execute.';
revoke all on function core.connections_teams_account_limit() from public, anon, authenticated;

create trigger connections_teams_account_limit
  before insert or update of status on core.connections
  for each row when (new.provider = 'microsoft_teams')
  execute function core.connections_teams_account_limit();
