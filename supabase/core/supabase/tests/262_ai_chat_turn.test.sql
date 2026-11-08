-- core.ai_chat_turn (T-105 review H1, M1): who may start a chat turn, and the per-minute turn limit.
begin;
select plan(13);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code in ('APK', 'PKI');
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');
update core.lane_policies set llm_allowed_categories = array['finance'] where lane_id = 'APK';
-- PKI: owner is a member, enabled, but the policy allows no categories.
delete from core.ai_chat_rate;

create function pg_temp.turn(p_email text, p_lane text, p_aal text default 'aal2') returns text language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.claims(p_email, p_aal);
  set local role authenticated;
  v := core.ai_chat_turn(p_lane);
  reset role;
  return case when (v ->> 'allowed')::boolean then 'allowed' else v ->> 'reason' end;
end;
$$;

select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'core.ai_chat_turn(text)'::regprocedure), 'definer, empty search_path');
select ok(not has_function_privilege('anon', 'core.ai_chat_turn(text)', 'execute') and not has_function_privilege('service_role', 'core.ai_chat_turn(text)', 'execute'), 'only authenticated may execute');
select ok(not has_table_privilege('authenticated', 'core.ai_chat_rate', 'select, insert, update, delete'), 'rate table is private');
select is(pg_temp.turn('owner@example.test', 'PKG', 'aal1'), 'mfa_required', 'AAL1 refused');
select is(pg_temp.turn('owner@example.test', 'APK'), 'forbidden', 'cross-lane: non-member refused');
select is(pg_temp.turn('viewer@example.test', 'PKG'), 'forbidden', 'viewer refused');
select is(pg_temp.turn('admin-technical@example.test', 'PKG'), 'forbidden', 'admin_technical refused');
select is(pg_temp.turn('outsider@example.test', 'PKG'), 'forbidden', 'outsider refused');
select is(pg_temp.turn('owner@example.test', 'PKI'), 'forbidden', 'lane with no allowed categories refused');
select is(pg_temp.turn('owner@example.test', 'NC'), 'forbidden', 'disabled lane refused');
select is(pg_temp.turn('finance-operator@example.test', 'PKG'), 'allowed', 'finance_operator allowed');

insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{assistant}', coalesce(config -> 'assistant', '{}'::jsonb) || '{"turns_per_minute": 2}'::jsonb)
from core.lane_config where lane_id = 'PKG' order by version desc limit 1;
delete from core.ai_chat_rate;
select is(array[pg_temp.turn('owner@example.test', 'PKG'), pg_temp.turn('owner@example.test', 'PKG'), pg_temp.turn('owner@example.test', 'PKG')],
  array['allowed', 'allowed', 'rate_limited'], 'third turn in the minute is rate limited');
select is((select calls from (select turns as calls from core.ai_chat_rate where user_id = pg_temp.uid('owner@example.test')) x), 2, 'refused turns do not count');

select * from finish();
rollback;
