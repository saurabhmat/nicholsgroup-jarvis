-- OAuth connect state (T-035): private table; create/consume only through the definer functions, by owner or
-- admin_technical of an enabled lane at aal2; consume is single use, same user, same lane, before expiry, and every
-- refusal looks the same.
begin;
select plan(27);
\ir helpers/lane_rls.psql

-- APK enabled for this test only, so cross-lane cases involve two lanes the owner belongs to.
update core.lanes set enabled = true where code = 'APK';

create function pg_temp.h(p text) returns text language sql immutable as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;
create function pg_temp.v(p text) returns text language sql immutable as $$ select rpad('verifier-' || p, 43, 'x') $$;

-- Runs core.oauth_state_create as a persona at an AAL; returns null on success, else the SQLSTATE.
create function pg_temp.try_create(p_email text, p_aal text, p_lane text, p_state text, p_provider text default 'quickbooks')
returns text language plpgsql as $$
begin
  perform pg_temp.claims(p_email, p_aal);
  set local role authenticated;
  perform core.oauth_state_create(p_lane, p_provider, pg_temp.h(p_state), pg_temp.v(p_state), 'http://localhost:3000/api/connect/qbo/callback');
  reset role;
  return null;
exception when others then
  reset role;
  return sqlstate;
end;
$$;

-- Runs core.oauth_state_consume as a persona; returns the provider and verifier, or null when nothing came back.
create function pg_temp.try_consume(p_email text, p_aal text, p_lane text, p_state text) returns text language plpgsql as $$
declare
  v text;
begin
  perform pg_temp.claims(p_email, p_aal);
  set local role authenticated;
  select provider || ':' || code_verifier into v from core.oauth_state_consume(p_lane, pg_temp.h(p_state));
  reset role;
  return v;
end;
$$;

-- ---------------------------------------------------------------- privileges
select ok(not has_table_privilege('authenticated', 'core.oauth_states', 'select, insert, update, delete'), 'authenticated has no table access');
select ok(not has_table_privilege('service_role', 'core.oauth_states', 'select, insert, update, delete'), 'not even service_role touches the table directly');
select ok(not has_table_privilege('anon', 'core.oauth_states', 'select'), 'anon has no table access');
select ok(not has_function_privilege('anon', 'core.oauth_state_create(text, text, text, text, text, text, text)', 'execute')
          and not has_function_privilege('anon', 'core.oauth_state_consume(text, text)', 'execute'), 'anon cannot call the functions');
select ok(not has_function_privilege('service_role', 'core.oauth_state_consume(text, text)', 'execute'), 'service_role cannot consume (it has no user to bind to)');
select ok(has_function_privilege('authenticated', 'core.oauth_state_consume(text, text)', 'execute'), 'authenticated may call consume');

-- ---------------------------------------------------------------- create: who may start a connect
select is(pg_temp.try_create('admin-technical@example.test', 'aal2', 'PKG', 's-admin'), null, 'admin_technical at aal2 may start a connect in its lane');
select is(pg_temp.try_create('owner@example.test', 'aal2', 'PKG', 's-owner'), null, 'owner at aal2 may start a connect');
select is(pg_temp.try_create('owner@example.test', 'aal1', 'PKG', 's-aal1'), '42501', 'aal1 is refused');
select is(pg_temp.try_create('finance-operator@example.test', 'aal2', 'PKG', 's-fin'), '42501', 'finance_operator is refused');
select is(pg_temp.try_create('viewer@example.test', 'aal2', 'PKG', 's-view'), '42501', 'viewer is refused');
select is(pg_temp.try_create('outsider@example.test', 'aal2', 'PKG', 's-out'), '42501', 'a user without membership is refused');
select is(pg_temp.try_create('admin-technical@example.test', 'aal2', 'APK', 's-cross'), '42501', 'cross-lane: admin_technical of PKG cannot start a connect in APK');
select is(pg_temp.try_create('owner@example.test', 'aal2', 'NL', 's-disabled'), '42501', 'a disabled lane is refused');
select is(pg_temp.try_create('owner@example.test', 'aal2', 'PKG', 's-badprov', 'dropbox'), '23514', 'an unknown provider is refused');
select is((select count(*)::int from core.oauth_states), 2, 'only the two allowed connects were stored');
select is((select count(*)::int from core.oauth_states where state_hash = pg_temp.h('s-admin')), 1,
          'the row is keyed by the SHA-256 of the state (the column cannot hold the raw state)');

-- ---------------------------------------------------------------- consume: binding and single use
select is(pg_temp.try_consume('owner@example.test', 'aal2', 'PKG', 's-admin'), null, 'another user (even an owner) cannot consume it');
select is(pg_temp.try_consume('admin-technical@example.test', 'aal1', 'PKG', 's-admin'), null, 'the same user at aal1 cannot consume it');
select is(pg_temp.try_consume('admin-technical@example.test', 'aal2', 'APK', 's-admin'), null, 'cross-lane: it cannot be consumed under another lane');
select is(pg_temp.try_consume('admin-technical@example.test', 'aal2', 'PKG', 's-admin'), 'quickbooks:' || pg_temp.v('s-admin'),
          'the user who started it gets the provider and PKCE verifier back');
select is(pg_temp.try_consume('admin-technical@example.test', 'aal2', 'PKG', 's-admin'), null, 'replay: a state works once');
select is(pg_temp.try_consume('admin-technical@example.test', 'aal2', 'PKG', 's-never'), null, 'an unknown state gives the same empty result');

-- A role removed between start and callback ends the connect.
update core.memberships set role = 'viewer', views = '{finance}'
where lane_id = 'PKG' and user_id = pg_temp.uid('admin-technical@example.test');
select is(pg_temp.try_create('owner@example.test', 'aal2', 'PKG', 's-demoted'), null, 'setup: owner starts another connect');
update core.oauth_states set user_id = pg_temp.uid('admin-technical@example.test') where state_hash = pg_temp.h('s-demoted');
select is(pg_temp.try_consume('admin-technical@example.test', 'aal2', 'PKG', 's-demoted'), null, 'a user demoted since the start cannot finish');

-- Expiry, and the per-user cap.
update core.oauth_states set created_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes'
where state_hash = pg_temp.h('s-owner');
select is(pg_temp.try_consume('owner@example.test', 'aal2', 'PKG', 's-owner'), null, 'an expired state is refused');
select is(
  (select array_agg(r order by r) from (
     select pg_temp.try_create('owner@example.test', 'aal2', 'PKG', 's-cap-' || i) r from generate_series(1, 11) i) x
   where r is not null),
  array['54000'],
  'at most 10 connects in flight per user (expired ones are cleared first)'
);

select * from finish();
rollback;
