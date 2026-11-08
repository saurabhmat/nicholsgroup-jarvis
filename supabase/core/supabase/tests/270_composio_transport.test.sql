-- T-219: Composio as a transport for the Google connector. Covered: new columns and their defaults (existing rows
-- stay native); the shape check (native has no toolkit/identity; composio needs a toolkit); the activation function
-- (service_role only, no token row, identity lower-cased and validated, audited, supersedes the lane's earlier account
-- for the toolkit on reconnect, refuses a native row, D0023 for an account another lane holds, also against a native
-- Google connection of another lane); immutability of transport/toolkit/identity; the two D-23 unique indexes; the
-- oauth_states toolkit/account_ref binding (create + consume round trip, same user/lane/single use, native states
-- unchanged); cross-lane denial with a positive control and an aal1 case.
begin;
select plan(61);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';

-- ---------------------------------------------------------------- columns, defaults, privileges
select has_column('core', 'connections', 'transport', 'transport exists');
select has_column('core', 'connections', 'toolkit', 'toolkit exists');
select has_column('core', 'connections', 'account_identity', 'account_identity exists');
select col_default_is('core', 'connections', 'transport', 'native', 'the default transport is native (existing lanes unchanged)');
select ok(has_column_privilege('authenticated', 'core.connections', 'transport', 'select')
      and has_column_privilege('authenticated', 'core.connections', 'toolkit', 'select')
      and has_column_privilege('authenticated', 'core.connections', 'account_identity', 'select'), 'authenticated may read the new columns (RLS still applies)');
select ok(not has_column_privilege('authenticated', 'core.connections', 'transport', 'update')
      and not has_table_privilege('authenticated', 'core.connections', 'insert, update, delete'), 'authenticated cannot write them');
select ok(not has_function_privilege('authenticated', 'core.connection_activate_composio(text, uuid, text, uuid)', 'execute')
      and not has_function_privilege('anon', 'core.connection_activate_composio(text, uuid, text, uuid)', 'execute')
      and has_function_privilege('service_role', 'core.connection_activate_composio(text, uuid, text, uuid)', 'execute'),
      'only service_role may activate a composio connection');

set local role service_role;
insert into core.connections (id, lane_id, provider, external_account_id, status)
values ('00000000-0000-4000-8000-000000002701', 'PKG', 'google', 'native-box@x.test', 'active');
select is((select transport from core.connections where id = '00000000-0000-4000-8000-000000002701'), 'native', 'a connection inserted the old way is native');

-- ---------------------------------------------------------------- shape check
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, transport) values ('PKG', 'google', 'ca_bad1', 'composio')$$,
                 '23514', null, 'a composio connection needs a toolkit');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, toolkit) values ('PKG', 'google', 'ca_bad2', 'gmail')$$,
                 '23514', null, 'a native connection cannot carry a toolkit');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, transport, toolkit, status, account_identity) values ('PKG', 'google', 'ca_bad3', 'composio', 'gmail', 'active', null)$$,
                 '23514', null, 'an active composio connection needs an identity');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, transport, toolkit, account_identity) values ('PKG', 'google', 'ca_bad4', 'composio', 'Gmail', 'a@x.test')$$,
                 '23514', null, 'the toolkit slug is lower-case');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, transport, toolkit, account_identity) values ('PKG', 'google', 'ca_bad5', 'composio', 'gmail', 'A@x.test')$$,
                 '23514', null, 'the identity is stored lower-cased');
select throws_ok($$insert into core.connections (lane_id, provider, external_account_id, transport) values ('PKG', 'google', 'ca_bad6', 'smtp')$$,
                 '23514', null, 'an unknown transport is refused');

-- ---------------------------------------------------------------- activation
insert into core.connections (id, lane_id, provider, external_account_id, transport, toolkit)
values ('00000000-0000-4000-8000-000000002711', 'PKG', 'google', 'ca_gm1', 'composio', 'gmail'),
       ('00000000-0000-4000-8000-000000002712', 'PKG', 'google', 'ca_cal1', 'composio', 'googlecalendar');
select lives_ok($$select core.connection_activate_composio('PKG', '00000000-0000-4000-8000-000000002711', ' Boss@PKG-Test.Example ', null)$$,
                'activation works without any token row');
select is((select status || '/' || account_identity from core.connections where id = '00000000-0000-4000-8000-000000002711'), 'active/boss@pkg-test.example',
          'the connection is active and the identity is lower-cased and trimmed');
reset role;
select is((select count(*)::int from core.connection_secrets where connection_id = '00000000-0000-4000-8000-000000002711'), 0, 'no token row was created');
select is((select count(*)::int from audit.events where target = 'connection:00000000-0000-4000-8000-000000002711' and action = 'connection.composio_activated'), 1, 'activation is audited');
set local role service_role;
select throws_ok($$select core.connection_activate_composio('PKG', '00000000-0000-4000-8000-000000002701', 'native-box@x.test', null)$$,
                 '55000', null, 'a native connection cannot be activated through this function');
select throws_ok($$select core.connection_activate_composio('APK', '00000000-0000-4000-8000-000000002712', 'boss@pkg-test.example', null)$$,
                 'P0002', null, 'cross-lane: the connection is not found under another lane');
select throws_ok($$select core.connection_activate_composio('PKG', '00000000-0000-4000-8000-000000002712', 'no spaces allowed', null)$$,
                 '22023', null, 'an invalid identity is refused');
select is((select status from core.connections where id = '00000000-0000-4000-8000-000000002712'), 'pending', 'a refused activation leaves the row pending');

-- a second account for the same toolkit in the same lane: a reconnect supersedes the first
insert into core.connections (id, lane_id, provider, external_account_id, transport, toolkit)
values ('00000000-0000-4000-8000-000000002713', 'PKG', 'google', 'ca_gm2', 'composio', 'gmail');
select throws_ok($$update core.connections set status = 'active', account_identity = 'second@pkg-test.example' where id = '00000000-0000-4000-8000-000000002713'$$,
                 '23505', null, 'a direct update cannot make a second usable account for the toolkit in the lane');
select lives_ok($$select core.connection_activate_composio('PKG', '00000000-0000-4000-8000-000000002713', 'boss@pkg-test.example', null)$$,
                'the reconnect activates through the function');
select is((select status from core.connections where id = '00000000-0000-4000-8000-000000002711'), 'disconnected', 'the earlier account for the toolkit is superseded');
select is((select count(*)::int from core.connections where lane_id = 'PKG' and toolkit = 'gmail' and status = 'active'), 1, 'exactly one usable gmail account in the lane');

-- one account address, one lane (D-23)
insert into core.connections (id, lane_id, provider, external_account_id, transport, toolkit)
values ('00000000-0000-4000-8000-000000002721', 'APK', 'google', 'ca_gm_apk', 'composio', 'gmail');
select throws_ok($$select core.connection_activate_composio('APK', '00000000-0000-4000-8000-000000002721', 'BOSS@pkg-test.example', null)$$,
                 'D0023', null, 'the same address (any case) in a second lane is refused with D0023');
select is((select status from core.connections where id = '00000000-0000-4000-8000-000000002721'), 'pending', 'the refused lane stays pending');
select throws_ok($$select core.connection_activate_composio('APK', '00000000-0000-4000-8000-000000002721', 'native-box@x.test', null)$$,
                 'D0023', null, 'a mailbox that PKG connected natively is refused in APK too (across transports)');
select lives_ok($$select core.connection_activate_composio('APK', '00000000-0000-4000-8000-000000002721', 'apk-box@x.test', null)$$,
                'a different address in another lane is fine');
-- the same address under the other toolkit is a different account row, same lane
select lives_ok($$select core.connection_activate_composio('PKG', '00000000-0000-4000-8000-000000002712', 'boss@pkg-test.example', null)$$,
                'the same address for the calendar toolkit in the same lane is fine');

-- ---------------------------------------------------------------- immutability
select throws_ok($$update core.connections set toolkit = 'googlecalendar' where id = '00000000-0000-4000-8000-000000002713'$$, '42501', null, 'the toolkit cannot change');
select throws_ok($$update core.connections set transport = 'native', toolkit = null, account_identity = null where id = '00000000-0000-4000-8000-000000002713'$$, '42501', null, 'the transport cannot change');
select throws_ok($$update core.connections set account_identity = 'someone-else@x.test' where id = '00000000-0000-4000-8000-000000002713'$$, '42501', null, 'the verified identity cannot change');

-- disconnecting (status only) frees the account for another lane
select lives_ok($$update core.connections set status = 'disconnected' where id = '00000000-0000-4000-8000-000000002713'$$, 'disconnect PKG gmail (status only; no token exists)');

-- M2: PKG holds the address through the calendar toolkit; a different toolkit in another lane is still the same account
insert into core.connections (id, lane_id, provider, external_account_id, transport, toolkit)
values ('00000000-0000-4000-8000-000000002722', 'APK', 'google', 'ca_gm_apk2', 'composio', 'gmail');
select throws_ok($$select core.connection_activate_composio('APK', '00000000-0000-4000-8000-000000002722', 'boss@pkg-test.example', null)$$,
                 'D0023', null, 'M2: gmail in APK is refused while googlecalendar in PKG holds the address (any toolkit)');
-- M3: the reverse direction: native Google in another lane cannot take an address a composio row in PKG holds
insert into core.connections (id, lane_id, provider, external_account_id)
values ('00000000-0000-4000-8000-000000002724', 'APK', 'google', 'Boss@PKG-Test.example');
select throws_ok($$select core.connection_token_store('APK', '00000000-0000-4000-8000-000000002724', 'synthetic-token-m3', null)$$,
                 'D0023', null, 'M3: native token store in APK is refused while a composio row in PKG holds the address');
select lives_ok($$select core.connection_token_store('PKG', (select id from core.connections where external_account_id = 'native-box@x.test' and lane_id = 'PKG'), 'synthetic-token-m3b', null)$$,
                'M3 control: a native store for an address nobody else holds still works');
select lives_ok($$update core.connections set status = 'disconnected' where id = '00000000-0000-4000-8000-000000002712'$$, 'M3: PKG calendar composio row disconnected (status only)');
select lives_ok($$select core.connection_token_store('APK', '00000000-0000-4000-8000-000000002724', 'synthetic-token-m3c', null)$$,
                'M3: once the composio row is disconnected, the native store for that address works');
reset role;

-- ---------------------------------------------------------------- oauth_states: toolkit + account ref
create function pg_temp.h(p text) returns text language sql immutable as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;
create function pg_temp.v(p text) returns text language sql immutable as $$ select rpad('verifier-' || p, 43, 'x') $$;
create function pg_temp.mk(p_email text, p_aal text, p_lane text, p_state text) returns text language plpgsql as $$
begin
  perform pg_temp.claims(p_email, p_aal);
  set local role authenticated;
  perform core.oauth_state_create(p_lane, 'google', pg_temp.h(p_state), pg_temp.v(p_state), 'http://localhost:3000/api/connect/composio/callback');
  reset role;
  return null;
exception when others then
  reset role;
  return sqlstate;
end;
$$;
-- The connector's server-side bind (service_role), for a user's own state.
create function pg_temp.bind(p_lane text, p_state text, p_email text, p_toolkit text, p_ref text) returns text language plpgsql as $$
begin
  set local role service_role;
  perform core.oauth_state_bind(p_lane, pg_temp.h(p_state), pg_temp.uid(p_email), p_toolkit, p_ref);
  reset role;
  return null;
exception when others then
  reset role;
  return sqlstate;
end;
$$;
create function pg_temp.take(p_email text, p_aal text, p_lane text, p_state text) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.claims(p_email, p_aal);
  set local role authenticated;
  select coalesce(toolkit, '-') || ':' || coalesce(account_ref, '-') into v from core.oauth_state_consume(p_lane, pg_temp.h(p_state));
  reset role;
  return v;
end;
$$;

select is(pg_temp.mk('owner@example.test', 'aal2', 'PKG', 'c-1'), null, 'owner at aal2 starts a connect with the original five-argument create');
select is(pg_temp.mk('viewer@example.test', 'aal2', 'PKG', 'c-5'), '42501', 'a viewer cannot start it');
select is(pg_temp.mk('admin-technical@example.test', 'aal2', 'APK', 'c-6'), '42501', 'cross-lane: a PKG-only admin cannot start it in APK');
select throws_ok($$set local role authenticated; select core.oauth_state_create('PKG', 'google', repeat('a', 64), repeat('v', 43), 'http://localhost:3000/x', 'gmail', 'ca_forged')$$,
                 '42883', null, 'a caller cannot pass a toolkit or account ref to create (no such function)');
reset role;
select ok(not has_function_privilege('authenticated', 'core.oauth_state_bind(text, text, uuid, text, text)', 'execute')
      and not has_function_privilege('anon', 'core.oauth_state_bind(text, text, uuid, text, text)', 'execute')
      and has_function_privilege('service_role', 'core.oauth_state_bind(text, text, uuid, text, text)', 'execute'), 'only service_role may bind an account to a state');
select throws_ok($$set local role authenticated; select core.oauth_state_bind('PKG', repeat('a', 64), '00000000-0000-4000-8000-000000000001', 'gmail', 'ca_x')$$,
                 '42501', null, 'authenticated cannot call bind');
reset role;
select is(pg_temp.bind('PKG', 'c-1', 'admin-technical@example.test', 'gmail', 'ca_link1'), 'P0002', 'bind for another user''s state finds nothing');
select is(pg_temp.bind('APK', 'c-1', 'owner@example.test', 'gmail', 'ca_link1'), 'P0002', 'cross-lane: bind under another lane finds nothing');
select is(pg_temp.bind('PKG', 'c-1', 'owner@example.test', 'gmail', 'ca bad'), '23514', 'a malformed account ref is refused');
select is(pg_temp.bind('PKG', 'c-1', 'owner@example.test', 'gmail', 'ca_link1'), null, 'the connector binds the toolkit and account to the user''s own state');
select is(pg_temp.bind('PKG', 'c-1', 'owner@example.test', 'gmail', 'ca_other'), 'P0002', 'a bound state cannot be re-bound');
select is(pg_temp.take('admin-technical@example.test', 'aal2', 'PKG', 'c-1'), null, 'another user cannot consume it');
select is(pg_temp.take('owner@example.test', 'aal2', 'APK', 'c-1'), null, 'cross-lane: it cannot be consumed under another lane');
select is(pg_temp.take('owner@example.test', 'aal1', 'PKG', 'c-1'), null, 'aal1 cannot consume it');
select is(pg_temp.take('owner@example.test', 'aal2', 'PKG', 'c-1'), 'gmail:ca_link1', 'the starter gets the toolkit and the account ref back, server-side');
select is(pg_temp.take('owner@example.test', 'aal2', 'PKG', 'c-1'), null, 'single use');
select is(pg_temp.mk('owner@example.test', 'aal2', 'PKG', 'n-1'), null, 'a native state (no toolkit) is unchanged');
select is(pg_temp.take('owner@example.test', 'aal2', 'PKG', 'n-1'), '-:-', 'a native state comes back with no toolkit');

-- ---------------------------------------------------------------- cross-lane denial on connections
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.connections where lane_id = 'APK' and transport = 'composio'), 0, 'a PKG-only admin sees no APK composio connection');
select is((select count(*)::int from core.connections where lane_id = 'PKG' and transport = 'composio'), 3, 'positive control: the same role sees the PKG composio rows (gmail x2 incl. superseded, calendar)');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.connections where lane_id = 'PKG' and transport = 'composio'), 0, 'aal1 sees nothing');
reset role;

select * from finish();
rollback;
