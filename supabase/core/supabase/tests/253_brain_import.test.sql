-- T-220: memory import. Covered: the new lane-policy category 'brain_import' (check constraint, tool gate), the candidate
-- columns (target_section, PA profile target), the reviewed writer brain.import_create and the reader core.brain_import_candidates:
-- shape and privileges, the happy path (open import in review, candidates readable, decide + finish delete them), refusals
-- (source, counts, path, lane, flags, lengths, secrets, sensitive numbers, rate), NL candidates keep no quote, and denial by
-- another user (second PKG owner), another lane (cross-lane both ways), AAL1, admin_technical, finance_operator, anon, service_role.
begin;
select plan(68);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');
insert into core.memberships (user_id, lane_id, role) values (pg_temp.uid('outsider@example.test'), 'APK', 'owner');
update core.memberships set role = 'owner', views = '{}' where lane_id = 'PKG' and user_id = pg_temp.uid('viewer@example.test');
delete from brain.imports;
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

-- ---------------------------------------------------------------- policy category and gate (D-40)
select lives_ok($$update core.lane_policies set llm_allowed_categories = array['brain_import'] where lane_id = 'APK'$$, 'brain_import is an allowed lane-policy category');
select throws_ok($$update core.lane_policies set llm_allowed_categories = array['drafting'] where lane_id = 'APK'$$, '23514', null, 'an unknown category is still refused');
update core.lane_policies set llm_allowed_categories = '{}' where lane_id = 'APK';
select ok((select llm_allowed_categories from core.lane_policies where lane_id = 'PKG') @> array['brain_import'], 'the local seed enables brain_import for PKG');
select is(pg_temp.gate('owner@example.test', 'PKG', 'brain', 'brain_import'), 'allowed', 'gate: the PKG owner may run brain_import in PKG');
select is(pg_temp.gate('owner@example.test', 'PKG', 'brain', 'brain_import', 'aal1'), 'mfa_required', 'gate: AAL1 refused');
select is(pg_temp.gate('admin-technical@example.test', 'PKG', 'brain', 'brain_import'), 'role_denied', 'gate: admin_technical refused');
select is(pg_temp.gate('outsider@example.test', 'PKG', 'brain', 'brain_import'), 'not_member', 'gate: another lane''s owner refused in PKG');
select is(pg_temp.gate('outsider@example.test', 'APK', 'brain', 'brain_import'), 'category_denied', 'gate: a lane whose policy does not list the category is refused');
update core.lane_policies set llm_allowed_categories = array['email'] where lane_id = 'PKG';
select is(pg_temp.gate('owner@example.test', 'PKG', 'brain', 'brain_import'), 'category_denied', 'gate: PKG without the category is refused (policy refused)');
update core.lane_policies set llm_allowed_categories = array['email', 'calendar', 'docs', 'finance', 'tasks', 'brain_import'] where lane_id = 'PKG';

-- ---------------------------------------------------------------- shape and privileges
select ok(exists (select 1 from information_schema.columns where table_schema = 'brain' and table_name = 'import_candidates' and column_name = 'target_section'), 'candidates have target_section');
select ok(not exists (select 1 from information_schema.columns where table_schema = 'brain' and table_name = 'imports' and column_name ~ 'path|text|body|raw'), 'imports hold no path, text or raw column (D-39)');
select ok((select prosecdef from pg_proc where oid = 'brain.import_create(text,text,jsonb)'::regprocedure)
          and not (select prosecdef from pg_proc where oid = 'core.brain_import_create(text,text,jsonb)'::regprocedure)
          and not (select prosecdef from pg_proc where oid = 'core.brain_import_candidates(text,uuid)'::regprocedure), 'the writer is definer; the wrappers are invoker');
select ok(has_function_privilege('authenticated', 'brain.import_create(text,text,jsonb)', 'execute')
          and not has_function_privilege('anon', 'brain.import_create(text,text,jsonb)', 'execute')
          and not has_function_privilege('service_role', 'brain.import_create(text,text,jsonb)', 'execute')
          and not has_function_privilege('anon', 'core.brain_import_create(text,text,jsonb)', 'execute')
          and not has_function_privilege('anon', 'core.brain_import_candidates(text,uuid)', 'execute'), 'authenticated only');
select ok(not has_table_privilege('authenticated', 'brain.import_candidates', 'insert, update, delete')
          and not has_table_privilege('authenticated', 'brain.imports', 'insert, update, delete'), 'still no user DML on imports or candidates');
select throws_ok(format($$insert into brain.import_candidates (import_id, lane_id, user_id, fact, target_path, target_lane) values (gen_random_uuid(), 'PKG', %L, 'f', 'Notes/X.md', 'PKG')$$, pg_temp.uid('owner@example.test')),
                 '23503', null, 'a candidate needs an import (foreign key)');

-- ---------------------------------------------------------------- owner: create, read, decide
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
create temp table made (import_id uuid, candidate_id uuid) on commit drop;
grant all on made to authenticated;
insert into made select * from core.brain_import_create('PKG', 'claude_paste', $j$[
  {"fact":"Prefers short replies","evidence":"I like short replies","target_path":"Context/Preferences.md","target_section":"Writing","target_lane":"PKG","flags":[]},
  {"fact":"Works with a client on a matter","evidence":"a quote that must not be kept","target_path":"Context/Work.md","target_section":"Key people","target_lane":"PKG","flags":["possible_nl_content"]},
  {"fact":"Likes a morning summary","evidence":null,"target_path":"Employees/Personal-Assistant.md","target_section":"2. Priority order","target_lane":"PKG","flags":["instruction_dropped"]}
]$j$);
select is((select count(*)::int from made), 3, 'create: three candidates returned');
select is((select count(distinct import_id)::int from made), 1, 'create: one import');
select is((select count(*)::int from core.brain_import_candidates('PKG', (select import_id from made limit 1))), 3, 'the reader returns the caller''s three candidates');
select is((select o_evidence from core.brain_import_candidates('PKG', (select import_id from made limit 1)) where o_fact like 'Works with%'), null, 'a possible-NL candidate keeps no quote, even when the caller sent one');
select is((select o_evidence from core.brain_import_candidates('PKG', (select import_id from made limit 1)) where o_fact like 'Prefers%'), 'I like short replies', 'an ordinary candidate keeps its quote');
select is((select array_agg(o_target_section order by o_target_section) from core.brain_import_candidates('PKG', (select import_id from made limit 1))), array['2. Priority order', 'Key people', 'Writing'], 'target sections are stored');
select is((select status from brain.imports where id = (select import_id from made limit 1)), 'review', 'the import is open for review');
select is((select count(*)::int from core.brain_import_decide('PKG', (select import_id from made limit 1), jsonb_build_array(jsonb_build_object('id', (select candidate_id from made limit 1), 'decision', 'keep')), false)), 1, 'decide: the kept fact comes back');
select is((select count(*)::int from core.brain_import_decide('PKG', (select import_id from made limit 1), '[]', true)), 1, 'decide + finish: closes the import');
select is((select count(*)::int from core.brain_import_candidates('PKG', (select import_id from made limit 1))), 0, 'after finish: the candidates are gone');
reset role;
select is((select count(*)::int from brain.import_candidates), 0, 'after finish: no candidate row remains');
select is((select status from brain.imports where id = (select import_id from made limit 1)), 'done', 'after finish: the import is done');

-- ---------------------------------------------------------------- refusals (each writes nothing)
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select * from core.brain_import_create('PKG', 'brain_zip', '[{"fact":"x","target_path":"Context/Work.md","target_section":"Key people","target_lane":"PKG"}]')$$, '22023', 'brain: invalid import source', 'source brain_zip has no candidates');
select throws_ok($$select * from core.brain_import_create('PKG', 'upload', '[]')$$, '22023', 'brain: invalid import source', 'unknown source refused');
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', '[]')$$, '22023', 'brain: candidates must be an array of 1 to 100', 'no candidates refused');
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', (select jsonb_agg(jsonb_build_object('fact', 'f' || g, 'target_path', 'Context/Work.md', 'target_section', 'Key people', 'target_lane', 'PKG')) from generate_series(1, 101) g))$$,
                 '22023', 'brain: candidates must be an array of 1 to 100', 'more than 100 candidates refused');
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', '[{"fact":"x","target_path":"Notes/Free.md","target_section":"Key people","target_lane":"PKG"}]')$$, '22023', 'brain: invalid candidate', 'a target outside the four interview pages refused');
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', '[{"fact":"x","target_path":"Context/Work.md","target_section":"Key people","target_lane":"APK"}]')$$, '22023', 'brain: invalid candidate', 'a target lane the caller cannot open refused');
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', '[{"fact":"x","target_path":"Context/Work.md","target_section":"Key people","target_lane":"PKG","flags":["approved"]}]')$$, '22023', 'brain: invalid candidate', 'an unknown flag refused');
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', '[{"fact":"","target_path":"Context/Work.md","target_section":"Key people","target_lane":"PKG"}]')$$, '22023', 'brain: invalid candidate', 'an empty fact refused');
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', jsonb_build_array(jsonb_build_object('fact', repeat('a', 1001), 'target_path', 'Context/Work.md', 'target_section', 'Key people', 'target_lane', 'PKG')))$$, '22023', 'brain: invalid candidate', 'a fact over 1000 characters refused');
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', jsonb_build_array(jsonb_build_object('fact', 'f', 'evidence', repeat('e', 301), 'target_path', 'Context/Work.md', 'target_section', 'Key people', 'target_lane', 'PKG')))$$, '22023', 'brain: invalid candidate', 'a quote over 300 characters refused');
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', '[{"fact":"x","target_path":"Context/Work.md","target_section":"Bad\nHeading","target_lane":"PKG"}]')$$, '22023', 'brain: invalid candidate', 'a section with a newline refused');
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', '[{"fact":"x","target_path":"Context/Work.md","target_section":"Rules","target_lane":"PKG"}]')$$, '22023', 'brain: invalid candidate', 'a section that is not importable for the page is refused');
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', '[{"fact":"x","target_path":"Employees/Personal-Assistant.md","target_section":"7. Rules","target_lane":"PKG"}]')$$, '22023', 'brain: invalid candidate', 'the Personal Assistant Rules section is refused');
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', '[{"fact":"x","target_path":"Employees/Personal-Assistant.md","target_section":"5. Drafting rules","target_lane":"PKG"}]')$$, '22023', 'brain: invalid candidate', 'the Personal Assistant Drafting rules section is refused');
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', '[{"fact":"key sk_live_abcdefghijklmnop1234","target_path":"Context/Work.md","target_section":"Key people","target_lane":"PKG"}]')$$, '23514', null, 'a credential in a fact refused');
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', '[{"fact":"SSN 123-45-6789","target_path":"Context/Work.md","target_section":"Key people","target_lane":"PKG"}]')$$, '22023', null, 'an SSN in a fact refused');
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', '[{"fact":"ok","evidence":"card 4111 1111 1111 1111","target_path":"Context/Work.md","target_section":"Key people","target_lane":"PKG"}]')$$, '22023', null, 'a card number in a quote refused');
reset role;
select is((select count(*)::int from brain.imports) + (select count(*)::int from brain.import_candidates), 1, 'the refused calls wrote nothing (only the finished import remains)');

-- rate: 20 imports in an hour, the 21st is refused
insert into brain.imports (lane_id, user_id, source, status) select 'PKG', pg_temp.uid('owner@example.test'), 'claude_paste', 'review' from generate_series(1, 19);
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', '[{"fact":"x","target_path":"Context/Work.md","target_section":"Key people","target_lane":"PKG"}]')$$, '54000', 'brain: too many imports', 'rate: the 21st import in an hour is refused');
reset role;
delete from brain.imports where status = 'review';

-- ---------------------------------------------------------------- other user (second PKG owner)
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
truncate made;
insert into made select * from core.brain_import_create('PKG', 'chatgpt_paste', '[{"fact":"Owner fact","target_path":"Context/About-Me.md","target_section":"Goals right now","target_lane":"PKG"}]');
reset role;
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.brain_import_candidates('PKG', (select import_id from made limit 1))), 0, 'other user: cannot read the first user''s candidates');
select throws_ok($$select * from core.brain_import_decide('PKG', (select import_id from made limit 1), '[]', true)$$, '42501', 'brain: import not found', 'other user: cannot decide the first user''s import');
select is((select count(*)::int from core.brain_import_create('PKG', 'claude_export', '[{"fact":"Viewer fact","target_path":"Context/Work.md","target_section":"Key people","target_lane":"PKG"}]')), 1, 'other user: creates their own');
reset role;
select is((select count(*)::int from brain.import_candidates where user_id = pg_temp.uid('owner@example.test')), 1, 'the first user''s candidate is untouched');
select is((select count(*)::int from brain.imports where user_id = pg_temp.uid('viewer@example.test')), 1, 'the new import belongs to the caller (auth.uid()), not a caller-supplied user');

-- ---------------------------------------------------------------- cross-lane
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', '[{"fact":"x","target_path":"Context/Work.md","target_section":"Key people","target_lane":"PKG"}]')$$, '42501', 'brain: the owner role in this lane is required', 'APK owner: cannot create an import in PKG');
select throws_ok($$select * from core.brain_import_create('APK', 'claude_paste', '[{"fact":"x","target_path":"Context/Work.md","target_section":"Key people","target_lane":"PKG"}]')$$, '22023', 'brain: invalid candidate', 'APK owner: cannot target PKG from an APK import');
select is((select count(*)::int from core.brain_import_candidates('PKG', (select import_id from made limit 1))), 0, 'APK owner: reads no PKG candidates');
select is((select count(*)::int from core.brain_import_create('APK', 'claude_paste', '[{"fact":"APK fact","target_path":"Context/Work.md","target_section":"Key people","target_lane":"APK"}]')), 1, 'APK owner: can in their own lane');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select * from core.brain_import_create('APK', 'claude_paste', '[{"fact":"x","target_path":"Context/Work.md","target_section":"Key people","target_lane":"APK"}]')$$, '42501', 'brain: the owner role in this lane is required', 'PKG owner: cannot create an import in APK');
reset role;

-- ---------------------------------------------------------------- AAL1, non-owner roles, anon, service_role
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', '[{"fact":"x","target_path":"Context/Work.md","target_section":"Key people","target_lane":"PKG"}]')$$, '42501', 'brain: a signed-in session at aal2 is required', 'AAL1: cannot create');
select is((select count(*)::int from core.brain_import_candidates('PKG', (select import_id from made limit 1))), 0, 'AAL1: reads no candidates');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', '[{"fact":"x","target_path":"Context/Work.md","target_section":"Key people","target_lane":"PKG"}]')$$, '42501', 'brain: the owner role in this lane is required', 'admin_technical: cannot create');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', '[{"fact":"x","target_path":"Context/Work.md","target_section":"Key people","target_lane":"PKG"}]')$$, '42501', 'brain: the owner role in this lane is required', 'finance_operator: cannot create');
reset role;
set local role anon;
select throws_ok($$select * from core.brain_import_candidates('PKG', gen_random_uuid())$$, '42501', null, 'anon: cannot read');
select throws_ok($$select * from core.brain_import_create('PKG', 'claude_paste', '[]')$$, '42501', null, 'anon: cannot create');
reset role;
set local role service_role;
select throws_ok($$select * from brain.import_create('PKG', 'claude_paste', '[]')$$, '42501', null, 'service_role: cannot call the writer');
reset role;

-- ---------------------------------------------------------------- an owner with two brain lanes (T-220 security M1)
insert into core.memberships (user_id, lane_id, role) values (pg_temp.uid('owner@example.test'), 'APK', 'owner');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.brain_import_create('PKG', 'claude_paste', '[{"fact":"Two lanes","target_path":"Context/Work.md","target_section":"Key people","target_lane":"APK"},{"fact":"Home","target_path":"Context/About-Me.md","target_section":"Goals right now","target_lane":"PKG"}]')), 2,
          'an owner with two brain lanes imports into PKG with a Work candidate for the second lane');
reset role;
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');

-- ---------------------------------------------------------------- the chat gate counts tool categories only (T-220 security M2)
update core.lane_policies set llm_allowed_categories = array['brain_import'] where lane_id = 'PKG';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((core.ai_chat_turn('PKG') ->> 'allowed')::boolean, false, 'a policy with only brain_import does not open the chat');
reset role;
update core.lane_policies set llm_allowed_categories = array['email', 'brain_import'] where lane_id = 'PKG';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(core.ai_chat_turn('PKG') -> 'categories', '["email"]'::jsonb, 'brain_import is not offered to the chat as a category');
select is((select count(*)::int from core.brain_import_create('PKG', 'claude_paste', '[{"fact":"x","target_path":"Context/Work.md","target_section":"Key people","target_lane":"PKG"}]')), 1, 'the import is unaffected');
reset role;

-- ---------------------------------------------------------------- purge still reaches the new rows
select is(core.brain_import_purge('PKG') >= 0, true, 'the existing purge runs over the new columns');
select * from finish();
rollback;
