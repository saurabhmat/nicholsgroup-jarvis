-- T-020 security review (HIGH): a stolen AAL2 session must not be able to add its own authenticator (which would
-- satisfy step-up and survive removing the owner's). A user may enrol an authenticator only:
--   - the first time (no enrolment recorded), or
--   - after an admin reset that granted a one-time allowance (docs/runbooks/mfa-recovery.md), consumed on use,
-- and in both cases only while the user has no verified factor. The guard runs in the MFA hook, so it holds even when
-- Supabase's MFA API is called directly. Also (review MEDIUM): attempts per user are serialised with an advisory
-- lock, so the 5-attempt limit and the lockout audit are exact under parallel requests; (LOW) users without a lane
-- membership leave a server log line.

-- Per-user enrolment state (private, like core.mfa_verification_attempts).
create table core.mfa_enrolment_state (
  user_id uuid primary key,
  enrolled_at timestamptz not null,
  -- Set by an admin during recovery (runbook); cleared when the new factor is verified.
  reset_allowed_at timestamptz,
  reset_allowed_by uuid
);
comment on table core.mfa_enrolment_state is 'MFA enrolment guard (T-020): first enrolment, then only after an admin-granted reset.';
alter table core.mfa_enrolment_state enable row level security;
revoke all on core.mfa_enrolment_state from public, anon, authenticated, service_role;

create or replace function core.mfa_verification_attempt(event jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (event ->> 'user_id')::uuid;
  v_factor uuid := (event ->> 'factor_id')::uuid;
  v_valid boolean := coalesce((event ->> 'valid')::boolean, false);
  v_failures int;
  v_factor_status text;
  v_verified int;
  v_state core.mfa_enrolment_state;
  v_lanes text[];
  v_lane text;
  c_max constant int := 5;
  c_window constant interval := interval '15 minutes';
begin
  -- One attempt per user at a time: the count and the insert below are exact.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('core.mfa_attempt:' || v_user::text, 0));
  select coalesce(array_agg(m.lane_id order by m.lane_id), '{}') into v_lanes from core.memberships m where m.user_id = v_user;

  delete from core.mfa_verification_attempts where user_id = v_user and at < now() - interval '1 day';
  select count(*) into v_failures
  from core.mfa_verification_attempts where user_id = v_user and at > now() - c_window;

  if v_failures >= c_max then
    return jsonb_build_object('decision', 'reject', 'message', 'Too many attempts. Try again in 15 minutes.');
  end if;

  if not v_valid then
    insert into core.mfa_verification_attempts (user_id, factor_id) values (v_user, v_factor);
    if v_failures + 1 = c_max then
      foreach v_lane in array v_lanes loop
        perform audit.log(v_lane, 'system', null, 'mfa.lockout', 'user:' || v_user::text, jsonb_build_object('window_minutes', 15));
      end loop;
      if cardinality(v_lanes) = 0 then
        raise log 'mfa.lockout user=% (no lane membership)', v_user;
      end if;
    end if;
    return jsonb_build_object('decision', 'continue');
  end if;

  select f.status::text into v_factor_status from auth.mfa_factors f where f.id = v_factor and f.user_id = v_user;
  if v_factor_status is distinct from 'unverified' then
    return jsonb_build_object('decision', 'continue'); -- a code for an existing authenticator
  end if;

  -- A correct first code for a NEW authenticator: allowed only as a first enrolment or a granted reset.
  select count(*) into v_verified
  from auth.mfa_factors f where f.user_id = v_user and f.status::text = 'verified';
  select * into v_state from core.mfa_enrolment_state s where s.user_id = v_user for update;

  if v_verified > 0 or (v_state.user_id is not null and v_state.reset_allowed_at is null) then
    foreach v_lane in array v_lanes loop
      perform audit.log(v_lane, 'user', v_user, 'mfa.enrolment_refused', 'factor:' || v_factor::text);
    end loop;
    if cardinality(v_lanes) = 0 then
      raise log 'mfa.enrolment_refused user=% (no lane membership)', v_user;
    end if;
    return jsonb_build_object('decision', 'reject',
      'message', 'A new authenticator can only be added after an administrator resets two-factor sign-in.');
  end if;

  insert into core.mfa_enrolment_state (user_id, enrolled_at) values (v_user, now())
  on conflict (user_id) do update set enrolled_at = now(), reset_allowed_at = null, reset_allowed_by = null;
  foreach v_lane in array v_lanes loop
    perform audit.log(v_lane, 'user', v_user, 'mfa.factor_enrolled', 'factor:' || v_factor::text);
  end loop;
  if cardinality(v_lanes) = 0 then
    raise log 'mfa.factor_enrolled user=% (no lane membership)', v_user;
  end if;
  return jsonb_build_object('decision', 'continue');
end;
$$;
revoke all on function core.mfa_verification_attempt(jsonb) from public, anon, authenticated, service_role;
grant execute on function core.mfa_verification_attempt(jsonb) to supabase_auth_admin;
