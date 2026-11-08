-- core.ai_tool_categories (T-105): the caller's allowed tool categories, or {} (cross-lane, viewer, admin, AAL1).
begin;
select plan(10);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');
update core.lane_policies set llm_allowed_categories = array['finance'] where lane_id = 'APK';

create function pg_temp.cats(p_email text, p_lane text, p_aal text default 'aal2') returns text[] language plpgsql as $$
declare v text[];
begin
  perform pg_temp.claims(p_email, p_aal);
  set local role authenticated;
  v := core.ai_tool_categories(p_lane);
  reset role;
  return v;
end;
$$;

select ok((select prosecdef from pg_proc where oid = 'core.ai_tool_categories(text)'::regprocedure), 'definer');
select ok(not has_function_privilege('anon', 'core.ai_tool_categories(text)', 'execute'), 'anon cannot execute');
select is(pg_temp.cats('owner@example.test', 'PKG'), (select llm_allowed_categories from core.lane_policies where lane_id = 'PKG'), 'owner sees the PKG categories');
select is(pg_temp.cats('finance-operator@example.test', 'PKG'), (select llm_allowed_categories from core.lane_policies where lane_id = 'PKG'), 'finance_operator sees them too');
select is(pg_temp.cats('owner@example.test', 'PKG', 'aal1'), '{}'::text[], 'AAL1 gets none');
select is(pg_temp.cats('owner@example.test', 'APK'), '{}'::text[], 'cross-lane: non-member gets none');
select is(pg_temp.cats('viewer@example.test', 'PKG'), '{}'::text[], 'viewer (no assistant view) gets none');
select is(pg_temp.cats('admin-technical@example.test', 'PKG'), '{}'::text[], 'admin_technical gets none');
select is(pg_temp.cats('outsider@example.test', 'PKG'), '{}'::text[], 'outsider gets none');
select is(pg_temp.cats('owner@example.test', 'NC'), '{}'::text[], 'disabled lane gets none');

select * from finish();
rollback;
