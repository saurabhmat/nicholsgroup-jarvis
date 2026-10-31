-- T-019 security review H1/M1: limit TOTP guessing and audit factor enrolment, in the database, because an attacker
-- with an AAL1 session can call Supabase's MFA endpoints directly (no app-side counter can see that).
-- Supabase Auth calls core.mfa_verification_attempt() on every TOTP verification ([auth.hook.mfa_verification_attempt]).
-- After 5 failed attempts within 15 minutes every further attempt (even a correct code) is rejected until the window
-- passes: about 20 guesses per hour instead of thousands. The first lockout in a window and every first successful
-- verification of a new factor are written to audit.events in each of the user's lanes.

-- Failed attempts (private: RLS on, no policies, no grants to API roles; only the hook writes it).
create table core.mfa_verification_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  factor_id uuid not null,
  at timestamptz not null default now()
);
comment on table core.mfa_verification_attempts is 'Failed TOTP attempts for the MFA attempt guard (T-019). Written by the auth hook only.';
create index mfa_verification_attempts_user_at_idx on core.mfa_verification_attempts (user_id, at desc);
alter table core.mfa_verification_attempts enable row level security;
revoke all on core.mfa_verification_attempts from public, anon, authenticated, service_role;

create function core.mfa_verification_attempt(event jsonb) returns jsonb
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
  v_lane text;
  c_max constant int := 5;
  c_window constant interval := interval '15 minutes';
begin
  delete from core.mfa_verification_attempts where user_id = v_user and at < now() - interval '1 day';
  select count(*) into v_failures
  from core.mfa_verification_attempts where user_id = v_user and at > now() - c_window;

  if v_failures >= c_max then
    return jsonb_build_object('decision', 'reject', 'message', 'Too many attempts. Try again in 15 minutes.');
  end if;

  if not v_valid then
    insert into core.mfa_verification_attempts (user_id, factor_id) values (v_user, v_factor);
    if v_failures + 1 = c_max then
      for v_lane in select m.lane_id from core.memberships m where m.user_id = v_user loop
        perform audit.log(v_lane, 'system', null, 'mfa.lockout', 'user:' || v_user::text, jsonb_build_object('window_minutes', 15));
      end loop;
    end if;
    return jsonb_build_object('decision', 'continue');
  end if;

  -- A correct code for a factor that is not verified yet: the user is adding an authenticator.
  select f.status::text into v_factor_status from auth.mfa_factors f where f.id = v_factor and f.user_id = v_user;
  if v_factor_status = 'unverified' then
    for v_lane in select m.lane_id from core.memberships m where m.user_id = v_user loop
      perform audit.log(v_lane, 'user', v_user, 'mfa.factor_enrolled', 'factor:' || v_factor::text);
    end loop;
  end if;
  return jsonb_build_object('decision', 'continue');
end;
$$;
comment on function core.mfa_verification_attempt(jsonb) is
  'Supabase Auth hook (mfa_verification_attempt): 5 failed TOTP attempts per 15 minutes, then reject; audits lockouts and enrolments.';
revoke all on function core.mfa_verification_attempt(jsonb) from public, anon, authenticated, service_role;
grant usage on schema core to supabase_auth_admin;
grant execute on function core.mfa_verification_attempt(jsonb) to supabase_auth_admin;
