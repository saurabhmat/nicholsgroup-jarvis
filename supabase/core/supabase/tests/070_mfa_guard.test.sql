-- MFA attempt guard (T-019 review H1/M1): the auth hook limits TOTP guessing and audits lockouts and enrolments.
begin;
select plan(14);
\ir helpers/lane_rls.psql

-- The hook is called directly (postgres cannot switch to supabase_auth_admin here); the privilege tests below show
-- only Supabase Auth may call it, and the live probe in the PR notes exercises it through GoTrue.
-- A synthetic unverified TOTP factor for the owner (no secret needed: the hook only sees the verdict).
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values ('55555555-5555-4555-8555-555555555555', pg_temp.uid('owner@example.test'), 'test', 'totp', 'unverified', now(), now());

create function pg_temp.attempt(p_email text, p_valid boolean) returns text language sql security definer as $$
  select core.mfa_verification_attempt(jsonb_build_object(
    'user_id', pg_temp.uid(p_email), 'factor_id', '55555555-5555-4555-8555-555555555555',
    'factor_type', 'totp', 'valid', p_valid)) ->> 'decision';
$$;

-- ---------------------------------------------------------------- privileges
select is(has_function_privilege('supabase_auth_admin', 'core.mfa_verification_attempt(jsonb)', 'execute'), true, 'Supabase Auth can call the hook');
select is(has_function_privilege('authenticated', 'core.mfa_verification_attempt(jsonb)', 'execute'), false, 'authenticated cannot call the hook');
select is(has_function_privilege('service_role', 'core.mfa_verification_attempt(jsonb)', 'execute'), false, 'service_role cannot call the hook');
select is(has_table_privilege('authenticated', 'core.mfa_verification_attempts', 'select, insert, delete'), false, 'authenticated cannot see or reset the attempt counter');

-- ---------------------------------------------------------------- enrolment is audited
select is(pg_temp.attempt('owner@example.test', true), 'continue', 'a correct first code is accepted');
select is(
  (select count(*)::int from audit.events where action = 'mfa.factor_enrolled' and actor_id = pg_temp.uid('owner@example.test')),
  6,
  'enrolment is audited in each of the user''s lanes (owner: six)'
);

-- ---------------------------------------------------------------- 5 failures, then everything is rejected
select is(pg_temp.attempt('finance-operator@example.test', false), 'continue', 'failure 1 is passed on (Supabase rejects the code)');
select is(pg_temp.attempt('finance-operator@example.test', false), 'continue', 'failure 2');
select is(pg_temp.attempt('finance-operator@example.test', false), 'continue', 'failure 3');
select is(pg_temp.attempt('finance-operator@example.test', false), 'continue', 'failure 4');
select is(pg_temp.attempt('finance-operator@example.test', false), 'continue', 'failure 5');
select is(pg_temp.attempt('finance-operator@example.test', true), 'reject', 'after 5 failures even a correct code is rejected');
select is(
  (select count(*)::int from audit.events where action = 'mfa.lockout' and target = 'user:' || pg_temp.uid('finance-operator@example.test')::text),
  1,
  'the lockout is audited once, in the user''s lane'
);

-- Other users are unaffected; the window expires.
update core.mfa_verification_attempts set at = now() - interval '16 minutes' where user_id = pg_temp.uid('finance-operator@example.test');
select is(pg_temp.attempt('finance-operator@example.test', true), 'continue', 'after the window a correct code works again');

select * from finish();
rollback;
