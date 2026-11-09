-- T-227: explicit per-section completion of the setup interview (brain.section_completions, brain.section_complete and the
-- core.brain_section_* wrappers). Covered: shape (non-null lane_id, RLS, one custom policy, no user DML, no service_role),
-- the writer (own rows, idempotent first-wins, unknown / null / empty / oversized section lists refused), denial by another
-- user (second PKG owner), another lane (cross-lane both ways), AAL1, admin_technical, finance_operator, anon and service_role.
begin;
select plan(37);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');
insert into core.memberships (user_id, lane_id, role) values (pg_temp.uid('outsider@example.test'), 'APK', 'owner');
update core.memberships set role = 'owner', views = '{}' where lane_id = 'PKG' and user_id = pg_temp.uid('viewer@example.test');
delete from brain.section_completions;

-- ---------------------------------------------------------------- shape
select ok(not exists (select 1 from information_schema.columns where table_schema = 'brain' and table_name = 'section_completions' and column_name = 'lane_id' and is_nullable = 'YES'),
          'lane_id is not null');
select ok((select relrowsecurity from pg_class where oid = 'brain.section_completions'::regclass), 'RLS is enabled');
select is((select count(*)::int from pg_policy where polrelid = 'brain.section_completions'::regclass), 1, 'exactly one policy');
select ok(not has_table_privilege('authenticated', 'brain.section_completions', 'insert, update, delete, truncate')
          and not has_table_privilege('anon', 'brain.section_completions', 'select, insert, update, delete')
          and not has_table_privilege('service_role', 'brain.section_completions', 'select, insert, update, delete'),
          'no user DML; anon and service_role have no access');
select ok((select a.atttypid = 'timestamptz'::regtype from pg_attribute a where a.attrelid = 'brain.section_completions'::regclass and a.attname = 'completed_at'), 'completed_at is timestamptz');
select ok(brain.valid_section('A-1') and brain.valid_section('B-6') and not brain.valid_section('A-5') and not brain.valid_section('B-7')
          and not brain.valid_section('') and not brain.valid_section(null) and not brain.valid_section('a-1'), 'only the bank''s ten section ids are valid');

-- ---------------------------------------------------------------- owner: complete, idempotent, validated
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.brain_section_completions('PKG')), 0, 'untouched: nothing is complete');
select is((select o_section_id from core.brain_section_complete('PKG', array['B-3'])), 'B-3', 'complete one section');
select is((select count(*)::int from core.brain_section_completions('PKG')), 1, '... and it is listed');
select is((select count(*)::int from core.brain_section_complete('PKG', array['A-1', 'A-1', 'B-3', 'B-5'])), 3, 'several at once, duplicates collapsed');
select is((select array_agg(section_id order by section_id) from core.brain_section_completions('PKG')), array['A-1', 'B-3', 'B-5'], 'the list is exactly the completed sections (no others)');
reset role;
select is((select completed_at from brain.section_completions where section_id = 'B-3' and user_id = pg_temp.uid('owner@example.test')) <= now(), true, 'completed_at is set');
create temp table first_at on commit drop as select completed_at from brain.section_completions where section_id = 'B-3' and user_id = pg_temp.uid('owner@example.test');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select lives_ok($$select * from core.brain_section_complete('PKG', array['B-3'])$$, 'completing again is idempotent');
reset role;
select is((select completed_at from brain.section_completions where section_id = 'B-3' and user_id = pg_temp.uid('owner@example.test')), (select completed_at from first_at), 'the first completion time is kept');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select * from core.brain_section_complete('PKG', array['A-9'])$$, '22023', 'brain: unknown section', 'an unknown section id is refused');
select throws_ok($$select * from core.brain_section_complete('PKG', array['A-1', 'zzz'])$$, '22023', 'brain: unknown section', '... also among valid ones (nothing is written)');
select throws_ok($$select * from core.brain_section_complete('PKG', null)$$, '22023', 'brain: unknown section', 'null list refused');
select throws_ok($$select * from core.brain_section_complete('PKG', '{}')$$, '22023', 'brain: unknown section', 'empty list refused');
select throws_ok($$select * from core.brain_section_complete('PKG', array[null::text])$$, '22023', 'brain: unknown section', 'null element refused');
select throws_ok($$insert into brain.section_completions (lane_id, user_id, section_id) values ('PKG', auth.uid(), 'B-1')$$, '42501', null, 'no direct insert');
select throws_ok($$delete from brain.section_completions$$, '42501', null, 'no direct delete');
reset role;
select is((select count(*)::int from brain.section_completions), 3, 'the refused calls wrote nothing');

-- ---------------------------------------------------------------- other user (second PKG owner)
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from brain.section_completions), 0, 'other user: sees none of the first user''s rows');
select is((select count(*)::int from core.brain_section_completions('PKG')), 0, 'other user: the list is empty (their own rows only)');
select is((select count(*)::int from core.brain_section_complete('PKG', array['B-1'])), 1, 'other user: records their own');
reset role;
select is((select array_agg(section_id order by section_id) from brain.section_completions where user_id = pg_temp.uid('owner@example.test')), array['A-1', 'B-3', 'B-5'], 'the first user''s rows are untouched');

-- ---------------------------------------------------------------- cross-lane
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.brain_section_completions('PKG')), 0, 'other lane owner: sees nothing in PKG');
select throws_ok($$select * from core.brain_section_complete('PKG', array['A-2'])$$, '42501', 'brain: the owner role in this lane is required', 'other lane owner: cannot complete in PKG');
select is((select count(*)::int from core.brain_section_complete('APK', array['A-2'])), 1, 'other lane owner: can in their own lane');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.brain_section_completions('APK')), 0, 'PKG owner: sees nothing in APK');
select throws_ok($$select * from core.brain_section_complete('APK', array['A-2'])$$, '42501', 'brain: the owner role in this lane is required', 'PKG owner: cannot complete in APK');
reset role;

-- ---------------------------------------------------------------- AAL1, non-owner roles, anon, service_role
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from brain.section_completions) , 0, 'AAL1: reads nothing');
select throws_ok($$select * from core.brain_section_complete('PKG', array['A-3'])$$, '42501', 'brain: a signed-in session at aal2 is required', 'AAL1: cannot write');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select * from core.brain_section_complete('PKG', array['A-3'])$$, '42501', 'brain: the owner role in this lane is required', 'admin_technical: cannot write');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select * from core.brain_section_complete('PKG', array['A-3'])$$, '42501', 'brain: the owner role in this lane is required', 'finance_operator: cannot write');
reset role;
set local role anon;
select throws_ok($$select * from core.brain_section_completions('PKG')$$, '42501', null, 'anon: denied');
reset role;
set local role service_role;
select throws_ok($$select * from brain.section_complete('PKG', array['A-3'])$$, '42501', null, 'service_role: cannot call the writer');
reset role;

select * from finish();
rollback;
