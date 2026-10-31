-- Lane config (T-011): versioned insert-only rows, the database secret check, the current-version view and RLS.
begin;
select plan(29);

create function pg_temp.claims(p_email text, p_aal text) returns text language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', (select id from auth.users where email = p_email), 'role', 'authenticated', 'aal', p_aal)::text, true);
$$;

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
select is(core.jsonb_has_secret('{"approvals": {"approver_roles": ["owner"], "step_up_max_age_s": 300}, "ghl": {"location_id": "loc-1"}}'), false, 'ordinary config passes the secret check');

-- ---------------------------------------------------------------- versions: gapless, insert-only
select throws_ok($$insert into core.lane_config (lane_id, version, config) values ('APK', 3, '{}')$$, '23514', null, 'a version gap is rejected');
select throws_ok($$insert into core.lane_config (lane_id, version, config) values ('APK', 1, '{}')$$, '23514', null, 'an existing version cannot be re-inserted');
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
select lives_ok($$insert into core.lane_config (lane_id, version, config) values ('PKG', 2, '{"kpis": ["mrr"]}')$$, 'service_role writes the next version');
reset role;

select * from finish();
rollback;
