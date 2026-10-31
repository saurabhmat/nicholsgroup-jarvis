-- Lane config (T-011): versioned insert-only rows, the database secret check, the current-version view and RLS.
begin;
select plan(45);
\ir helpers/lane_rls.psql

-- ---------------------------------------------------------------- schema
select has_table('core', 'lane_config', 'core.lane_config exists');
select is((select relrowsecurity from pg_class where oid = 'core.lane_config'::regclass), true, 'RLS is enabled on core.lane_config');
select ok(
  (select 'security_invoker=true' = any (reloptions) from pg_class where oid = 'core.lane_config_current'::regclass),
  'lane_config_current is security_invoker'
);
select set_eq($$select lane_id from core.lane_config where version = 1$$, array['PKG', 'APK', 'PKI', 'NC', 'NL', 'P'], 'every lane has version 1');
select is((select config #>> '{qbo,entity_mapping_mode}' from core.lane_config_current where lane_id = 'PKG'), 'file_class', 'PKG config is seeded');

-- ---------------------------------------------------------------- secret check (keys and values, any depth)
select throws_ok($$insert into core.lane_config (lane_id, version, config) values ('APK', 2, '{"client_secret": "x"}')$$, '23514', null, 'credential-named key rejected');
select throws_ok($$insert into core.lane_config (lane_id, version, config) values ('APK', 2, '{"qbo": [{"Refresh_Token": "x"}]}')$$, '23514', null, 'nested credential key rejected (case-insensitive)');
select throws_ok($$insert into core.lane_config (lane_id, version, config) values ('APK', 2, '{"stripe": {"account_id": "sk_live_abc"}}')$$, '23514', null, 'Stripe secret key value rejected');
select throws_ok($$insert into core.lane_config (lane_id, version, config) values ('APK', 2, '{"tags": ["  sb_secret_abc"]}')$$, '23514', null, 'padded Supabase secret in an array rejected');
select throws_ok($$insert into core.lane_config (lane_id, version, config) values ('APK', 2, '{"x": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"}')$$, '23514', null, 'JWT value rejected');
select throws_ok($$insert into core.lane_config (lane_id, version, config) values ('APK', 2, '{"x": "-----BEGIN RSA PRIVATE KEY-----"}')$$, '23514', null, 'PEM private key rejected');
select throws_ok($$insert into core.lane_config (lane_id, version, config) values ('APK', 2, '{"x": "postgres://user:pw@host/db"}')$$, '23514', null, 'URL with a password rejected');
select throws_ok($$insert into core.lane_config (lane_id, version, config) values ('APK', 2, '["not", "an", "object"]')$$, '23514', null, 'non-object config rejected');
select is(core.jsonb_has_secret(jsonb_build_object('x', E'\tsk_live_abc')), true, 'tab-padded secret detected');
select is(core.jsonb_has_secret(jsonb_build_object('x', E'\nsk_live_abc')), true, 'newline-padded secret detected');
select is(core.jsonb_has_secret(jsonb_build_object('x', U&'\00A0\FEFFsk_live_abc')), true, 'NBSP/BOM-padded secret detected');
select is(core.jsonb_has_secret('{"API-Key": "x"}'), true, 'hyphenated api key name detected');
select is(core.jsonb_has_secret('{"assistant": {"max_tokens": 5, "messages_per_hour": 30}}'), false, 'max_tokens is not a credential name');
select is(core.jsonb_has_secret('{"ghl_tags": ["Paid Member", "VIP 2026"]}'), false, 'free-text tags pass');
select throws_ok(
  format($$insert into core.lane_config (lane_id, version, config) values ('APK', 2, %L)$$,
         (select jsonb_build_object('blob', repeat('a', 70000)))),
  '23514', null, 'oversized config rejected'
);
select is(core.jsonb_has_secret('{"approvals": {"approver_roles": ["owner"], "step_up_max_age_s": 300}, "ghl": {"location_id": "loc-1"}}'), false, 'ordinary config passes the secret check');

-- ---------------------------------------------------------------- versions: gapless, insert-only
select throws_ok($$insert into core.lane_config (lane_id, version, config) values ('APK', 3, '{}')$$, 'P0001', 'core.lane_config: version must be the next version for the lane', 'a version gap is rejected');
select throws_ok($$insert into core.lane_config (lane_id, version, config) values ('APK', 1, '{}')$$, 'P0001', 'core.lane_config: version must be the next version for the lane', 'an existing version cannot be re-inserted');
select lives_ok($$insert into core.lane_config (lane_id, version, config) values ('APK', 2, '{"kpis": ["mrr"]}')$$, 'the next version is accepted');
select is((select version from core.lane_config_current where lane_id = 'APK'), 2, 'the current view returns the highest version');
select throws_ok($$update core.lane_config set config = '{}' where lane_id = 'PKG'$$, '42501', null, 'versions cannot be updated');
select throws_ok($$delete from core.lane_config where lane_id = 'PKG'$$, '42501', null, 'versions cannot be deleted');
select throws_ok($$truncate core.lane_config$$, '42501', null, 'lane_config cannot be truncated');

-- ---------------------------------------------------------------- RLS ('config' view: owner, admin_technical)
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select set_eq($$select lane_id from core.lane_config_current$$, array['PKG'], 'owner reads the config of enabled lanes only');
select throws_ok($$insert into core.lane_config (lane_id, version, config) values ('PKG', 2, '{}')$$, '42501', null, 'authenticated cannot write config');
reset role;

select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select set_eq($$select lane_id from core.lane_config$$, array['PKG'], 'admin_technical reads the PKG config');
reset role;

select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.lane_config), 0, 'finance_operator has no config view');
reset role;

select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.lane_config_current), 0, 'a non-member reads no config');
reset role;

select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.lane_config), 0, 'AAL1 reads no config');
reset role;

set local role anon;
select throws_ok($$select count(*) from core.lane_config$$, '42501', null, 'anon cannot read lane_config');
reset role;

set local role service_role;
select lives_ok($$insert into core.lane_config (lane_id, version, config) values ('PKG', 2, '{"kpis": ["mrr"], "mailboxes": ["ops@example.test"], "approvals": {"approvals_live": false}}')$$, 'service_role writes the next version');
reset role;

-- ---------------------------------------------------------------- lane_config_public (every lane member)
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is(core.lane_config_public('PKG') -> 'kpis', '["mrr"]'::jsonb, 'finance_operator reads the public subset (kpis)');
select is(core.lane_config_public('PKG') -> 'approvals_live', 'false'::jsonb, 'the public subset carries approvals_live');
select ok(not (core.lane_config_public('PKG') ? 'mailboxes'), 'the public subset omits mailboxes');
select is(core.lane_config_public('APK'), null, 'no public config for a lane the user is not in');
reset role;

select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is(core.lane_config_public('PKG'), null, 'a non-member gets no public config');
reset role;

select pg_temp.claims('viewer@example.test', 'aal1');
set local role authenticated;
select is(core.lane_config_public('PKG'), null, 'AAL1 gets no public config');
reset role;

-- A writer cannot be deleted while its versions exist (insert-only rows; restrict, not a misleading trigger error).
insert into core.lane_config (lane_id, version, config, created_by)
  values ('PKG', 3, '{}', (select id from auth.users where email = 'admin-technical@example.test'));
select throws_ok(
  $$delete from core.users where id = (select id from auth.users where email = 'admin-technical@example.test')$$,
  '23503', null, 'a config writer cannot be deleted (restrict)'
);

-- Cross-lane: with APK enabled, a PKG-only admin still reads no APK config; the owner (member of both) reads both.
update core.lanes set enabled = true where code = 'APK';
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select set_eq($$select lane_id from core.lane_config_current$$, array['PKG'], 'a PKG-only admin reads no APK config');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select set_eq($$select lane_id from core.lane_config_current$$, array['APK', 'PKG'], 'the owner reads both enabled lanes');
reset role;

select * from finish();
rollback;
