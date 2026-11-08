-- Assistant policy gate (T-101): core.ai_tool_gate and the private core.ai_tool_rate.
-- Covered: privileges (authenticated only; anon and service_role cannot execute; nobody reads the rate table),
-- definer with an empty search_path, argument checks, every denial reason in gate order (aal1, outsider, cross-lane
-- non-member, admin_technical, disabled lane, category not allowed, viewer without the assistant view,
-- finance_operator without the calendar view), allowed calls, and the rate limit (per user and lane, denied calls do
-- not count).
begin;
select plan(26);
\ir helpers/lane_rls.psql

-- APK: enabled, owner is NOT a member (cross-lane denial); its default policy allows no categories.
update core.lanes set enabled = true where code = 'APK';
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');
-- NC stays disabled; the owner is a member there (seed). Give NC finance so only "disabled" can deny it.
update core.lane_policies set llm_allowed_categories = array['finance'] where lane_id = 'NC';
-- A second enabled lane where the owner IS a member but the policy allows no categories.
update core.lanes set enabled = true where code = 'PKI';
delete from core.ai_tool_rate;

create function pg_temp.gate(p_email text, p_lane text, p_view text, p_category text, p_aal text default 'aal2')
returns text language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.claims(p_email, p_aal);
  set local role authenticated;
  v := core.ai_tool_gate(p_lane, p_view, p_category);
  reset role;
  return case when (v ->> 'allowed')::boolean then 'allowed' else v ->> 'reason' end;
end;
$$;

-- ---------------------------------------------------------------- shape and privileges
select ok((select prosecdef from pg_proc where oid = 'core.ai_tool_gate(text,text,text)'::regprocedure), 'gate is security definer');
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid = 'core.ai_tool_gate(text,text,text)'::regprocedure), 'gate pins an empty search_path');
select ok(has_function_privilege('authenticated', 'core.ai_tool_gate(text,text,text)', 'execute'), 'authenticated may execute');
select ok(not has_function_privilege('anon', 'core.ai_tool_gate(text,text,text)', 'execute'), 'anon may not execute');
select ok(not has_function_privilege('service_role', 'core.ai_tool_gate(text,text,text)', 'execute'), 'service_role may not execute (user gate only)');
select ok(not has_table_privilege('authenticated', 'core.ai_tool_rate', 'select, insert, update, delete'), 'authenticated has no access to the rate table');
select ok((select relrowsecurity from pg_class where oid = 'core.ai_tool_rate'::regclass), 'rate table has RLS on');

-- ---------------------------------------------------------------- argument checks
select throws_ok($$ select pg_temp.gate('owner@example.test', 'pkg', 'finance', 'finance') $$, '22023', 'invalid lane', 'lowercase lane rejected');
select throws_ok($$ select pg_temp.gate('owner@example.test', 'PKG', 'nope', 'finance') $$, '22023', 'invalid view', 'unknown view rejected');
select throws_ok($$ select pg_temp.gate('owner@example.test', 'PKG', 'finance', 'drafting') $$, '22023', 'invalid category', 'unknown category rejected');
select ok(not has_table_privilege('service_role', 'core.ai_tool_rate', 'select, insert, update, delete'), 'service_role has no direct access to the rate table');

-- ---------------------------------------------------------------- denial reasons, in gate order
select is(pg_temp.gate('owner@example.test', 'PKG', 'finance', 'finance', 'aal1'), 'mfa_required', 'AAL1 session is denied');
select is(pg_temp.gate('outsider@example.test', 'PKG', 'finance', 'finance'), 'not_member', 'outsider is denied');
select is(pg_temp.gate('owner@example.test', 'APK', 'finance', 'finance'), 'not_member', 'cross-lane: owner of PKG is denied in APK');
select is(pg_temp.gate('admin-technical@example.test', 'PKG', 'finance', 'finance'), 'role_denied', 'admin_technical is denied all content tools');
select is(pg_temp.gate('owner@example.test', 'NC', 'finance', 'finance'), 'lane_disabled', 'disabled lane is denied');
select is(pg_temp.gate('owner@example.test', 'PKI', 'finance', 'finance'), 'category_denied', 'category outside llm_allowed_categories is denied');
select is(pg_temp.gate('owner@example.test', 'PKG', 'finance', 'finance_summary'), 'category_denied', 'PKG does not allow finance_summary');
select is(pg_temp.gate('viewer@example.test', 'PKG', 'finance', 'finance'), 'view_denied', 'viewer (finance view, no assistant view) is denied');
select is(pg_temp.gate('finance-operator@example.test', 'PKG', 'calendar', 'calendar'), 'view_denied', 'finance_operator without the calendar view is denied');

-- ---------------------------------------------------------------- allowed + rate limit
select is(pg_temp.gate('finance-operator@example.test', 'PKG', 'finance', 'finance'), 'allowed', 'finance_operator may use finance tools');
-- Limit 2 per minute for PKG through lane_config (insert-only: a new version).
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{assistant}', coalesce(config -> 'assistant', '{}'::jsonb) || '{"tool_calls_per_minute": 2}'::jsonb)
from core.lane_config where lane_id = 'PKG' order by version desc limit 1;
delete from core.ai_tool_rate;
select is(
  array[pg_temp.gate('owner@example.test', 'PKG', 'finance', 'finance'),
        pg_temp.gate('owner@example.test', 'PKG', 'finance', 'finance'),
        pg_temp.gate('owner@example.test', 'PKG', 'finance', 'finance'),
        pg_temp.gate('owner@example.test', 'PKG', 'finance', 'finance')],
  array['allowed', 'allowed', 'rate_limited', 'rate_limited'],
  'third call in the minute is rate limited (lane_config limit)'
);
select is((select calls from core.ai_tool_rate where user_id = pg_temp.uid('owner@example.test') and lane_id = 'PKG'), 2,
  'denied calls do not increment the counter');
select is(pg_temp.gate('finance-operator@example.test', 'PKG', 'finance', 'finance'), 'allowed', 'the limit is per user');
select is(pg_temp.gate('owner@example.test', 'PKG', 'finance', 'finance'), 'rate_limited',
  'calling the gate directly cannot pick a window that resets the counter');
-- A row from an earlier minute is cleared and counting starts again.
update core.ai_tool_rate set window_start = window_start - interval '1 minute' where user_id = pg_temp.uid('owner@example.test');
select is(pg_temp.gate('owner@example.test', 'PKG', 'finance', 'finance'), 'allowed', 'a new minute starts a new window');

select * from finish();
rollback;
