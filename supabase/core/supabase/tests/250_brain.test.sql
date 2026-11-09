-- AI brain (T-210): schema brain, the 'brain' view, the writers (brain.document_save / employee_save / skill_save /
-- import_decide), the core.brain_* wrappers and core.brain_import_purge.
-- Covered: the view (owner only), privileges (no user DML, service_role cannot write, anon denied), optimistic version
-- check, no-op save, pruning to 20 versions, path/size/secret refusals (function and CHECK constraint), version rows
-- (append-only, kind/owner copied), denial by: another lane (cross-lane), another user (About-Me, Preferences, imports),
-- AAL1, admin_technical, finance_operator, anon and service_role; imports (decide, finish deletes candidates, expiry,
-- NL flag keeps no evidence); the import purge (23 h cut, cross-lane, disabled lane, privileges).
begin;
select plan(132);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
-- Another lane's owner: the outsider persona owns APK only. A second PKG owner: the viewer persona, upgraded in this transaction.
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');
insert into core.memberships (user_id, lane_id, role) values (pg_temp.uid('outsider@example.test'), 'APK', 'owner');
update core.memberships set role = 'owner', views = '{}' where lane_id = 'PKG' and user_id = pg_temp.uid('viewer@example.test');
-- Start clean (a developer's own rows are removed inside this transaction only).
delete from brain.imports;
delete from brain.documents;
delete from brain.employees;
delete from brain.skills;

-- ---------------------------------------------------------------- the view
select ok('brain' = any (core.view_names()), 'brain is a known view name');
select ok('brain' = any (core.role_views('owner')), 'owner gets the brain view');
select ok(not ('brain' = any (core.role_views('viewer'))) and not ('brain' = any (core.role_views('finance_operator')))
          and not ('brain' = any (core.role_views('admin_technical'))) and not ('brain' = any (core.viewer_view_names())),
          'viewer, finance_operator, admin_technical and viewer-named views do not get it');
select is(pg_temp.lanes_for('owner@example.test', 'brain'), array['PKG'], 'owner: brain lanes = PKG');
select is(pg_temp.lanes_for('admin-technical@example.test', 'brain'), '{}'::text[], 'admin_technical: no brain lane');
select is(pg_temp.lanes_for('finance-operator@example.test', 'brain'), '{}'::text[], 'finance_operator: no brain lane');

-- ---------------------------------------------------------------- privileges and shape
select ok(not has_table_privilege('service_role', 'brain.documents', 'insert, update, delete')
          and not has_table_privilege('service_role', 'brain.document_versions', 'insert, update, delete')
          and not has_table_privilege('service_role', 'brain.import_candidates', 'select, insert, update, delete')
          and not has_table_privilege('service_role', 'brain.imports', 'select, insert, update, delete'),
          'service_role cannot write brain rows (and cannot read imports or candidates)');
select ok((select bool_and(not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('service_role', p.oid, 'execute'))
           from pg_proc p where p.pronamespace = 'brain'::regnamespace and p.proname in ('document_save', 'employee_save', 'skill_save', 'import_decide')),
          'the four writers are executable by authenticated only');
select ok(not has_function_privilege('authenticated', 'core.brain_import_purge(text)', 'execute')
          and not has_function_privilege('anon', 'core.brain_import_purge(text)', 'execute')
          and has_function_privilege('service_role', 'core.brain_import_purge(text)', 'execute'),
          'the import purge is service_role only');
select ok((select bool_and(p.prosecdef) from pg_proc p where p.pronamespace = 'brain'::regnamespace and p.proname in ('document_save', 'employee_save', 'skill_save', 'import_decide'))
          and (select bool_and(not p.prosecdef) from pg_proc p where p.pronamespace = 'core'::regnamespace and p.proname like 'brain\_%' escape '\' and p.proname <> 'brain_import_purge'),
          'the writers are definer; the core.brain_* wrappers are invoker');
select ok(not exists (select 1 from information_schema.columns where table_schema = 'brain' and table_name = 'imports' and column_name = 'storage_path'),
          'brain.imports has no storage_path');
select ok(not exists (select 1 from information_schema.columns where table_schema = 'brain'
                      and column_name in ('lane_id') and is_nullable = 'YES'), 'every lane_id in brain is not null');
select is((select count(*)::int from pg_class c where c.relnamespace = 'brain'::regnamespace and c.relkind = 'r'), 7, 'brain has the seven tables');
select ok((select bool_and(a.atttypid = 'timestamptz'::regtype) from pg_attribute a join pg_class c on c.oid = a.attrelid
           where c.relnamespace = 'brain'::regnamespace and c.relkind = 'r' and a.attname in ('created_at', 'updated_at', 'finished_at') and not a.attisdropped),
          'all brain times are timestamptz');
select pg_temp.has_standard_lane_policy('brain.employees', 'brain');
select pg_temp.has_standard_lane_policy('brain.skills', 'brain');

-- ---------------------------------------------------------------- owner: save, version check, no-op
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select o_version from core.brain_document_save('PKG', 'Context/About-Me.md', '# About me
Name: Synthetic Owner', 0)), 1, 'create: version 1');
select is((select o_version from core.brain_document_save('PKG', 'Context/About-Me.md', '# About me
Name: Synthetic Owner (edited)', 1)), 2, 'update with the current version: version 2');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/About-Me.md', 'stale', 1)$$, '40001', 'brain: version_conflict',
                 'a stale if_version is refused');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/About-Me.md', 'create again', 0)$$, '40001', 'brain: version_conflict',
                 'if_version 0 on an existing page is refused');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Work.md', 'x', 3)$$, '40001', 'brain: version_conflict',
                 'a missing page with if_version > 0 is refused');
select is((select o_version from core.brain_document_save('PKG', 'Context/About-Me.md', '# About me
Name: Synthetic Owner (edited)', 2)), 2, 'saving identical text is a no-op (same version)');
select is((select count(*)::int from core.brain_document_versions('PKG', 'Context/About-Me.md')), 2, '... and adds no version row');
select is((select body_md from core.brain_document_get('PKG', 'Context/About-Me.md')), '# About me
Name: Synthetic Owner (edited)', 'get returns the saved text');
select is((select kind from core.brain_document_get('PKG', 'Context/About-Me.md')), 'about_me', 'the kind follows from the path');
select is((select o_version from core.brain_document_save('PKG', 'Context/Work.md', '# Work', 0)), 1, 'a context page is created');
select is((select kind from core.brain_document_get('PKG', 'Context/Work.md')), 'context', 'Context/Work.md is context');
select is((select o_version from core.brain_document_save('PKG', 'Context/Preferences.md', '# Prefs', 0)), 1, 'Preferences created');
select is((select o_version from core.brain_document_save('PKG', 'Projects/Ask-Pub-K/BRIEF.md', '# Brief', 0)), 1, 'a project brief is created');
select is((select kind from core.brain_document_get('PKG', 'Projects/Ask-Pub-K/BRIEF.md')), 'project_brief', 'project brief kind');
select is((select array_agg(path order by path) from core.brain_documents_list('PKG', 'Context/')), array['Context/About-Me.md', 'Context/Preferences.md', 'Context/Work.md'],
          'list by prefix');
select is(core.brain_home_lane(), 'PKG', 'the home lane is the lane holding About-Me');

-- pruning: 25 more saves keep the last 20 versions
do $$
declare v int := 1;
begin
  for i in 1..25 loop
    perform core.brain_document_save('PKG', 'Notes/Log.md', 'entry ' || i, i - 1);
    v := v + 1;
  end loop;
end $$;
select is((select count(*)::int from core.brain_document_versions('PKG', 'Notes/Log.md')), 20, 'only the last 20 versions are kept');
select is((select min(version) from core.brain_document_versions('PKG', 'Notes/Log.md')), 6, '... versions 6 to 25');
select is((select max(version) from core.brain_document_versions('PKG', 'Notes/Log.md')), 25, '... newest is 25');
select is((select body_md from core.brain_document_versions('PKG', 'Notes/Log.md') where version = 25), 'entry 25', 'a version holds that version''s text');

-- refusals
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/../Etc.md', 'x', 0)$$, '22023', 'brain: invalid path', 'path traversal is refused');
select throws_ok($$select * from core.brain_document_save('PKG', 'Other/Work.md', 'x', 0)$$, '22023', 'brain: invalid path', 'a folder outside Context/Projects/Notes is refused');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Work.txt', 'x', 0)$$, '22023', 'brain: invalid path', 'a non-.md path is refused');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Big.md', repeat('a', 32769), 0)$$, '22023', null, 'over 32 KB is refused');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Null.md', null, 0)$$, '22023', null, 'a null body is refused');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Null.md', 'x', null)$$, '22023', null, 'a null if_version is refused');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Key.md', 'token: sk_live_abcdefghijklmnop1234', 0)$$, '22023', 'brain: content looks like a credential',
                 'a Stripe-style key inside a sentence is refused');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Key.md', E'notes\nsk-ant-api03-abcdefghijklmnop', 0)$$, '22023', 'brain: content looks like a credential',
                 'an Anthropic-style key on its own line is refused');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Key.md', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123', 0)$$, '22023', 'brain: content looks like a credential',
                 'a Bearer credential is refused');
-- security review H-1: name=value and name:value forms (made-up values)
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Key.md', 'STRIPE_SECRET_KEY=sk_live_51Habcdefghijklmnop', 0)$$, '22023', 'brain: content looks like a credential',
                 'an env-style NAME=key line is refused');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Key.md', 'token:ghp_abcdefghijklmnopqrstuvwxyz0123456789', 0)$$, '22023', 'brain: content looks like a credential',
                 'name:value with no space is refused');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Key.md', 'key:AKIAABCDEFGHIJKLMNOP', 0)$$, '22023', 'brain: content looks like a credential',
                 'an AWS key id after a colon is refused');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Key.md', 'https://api.example.com/v1?api_key=abcdefghijk123', 0)$$, '22023', 'brain: content looks like a credential',
                 'a URL api_key parameter is refused');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Key.md', 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 0)$$, '22023', 'brain: content looks like a credential',
                 'a spaced name = value secret is refused');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Key.md', 'password: Hunter2-Correct-Horse-Battery', 0)$$, '22023', 'brain: content looks like a credential',
                 'a password in prose form is refused');
select lives_ok($$select * from core.brain_document_save('PKG', 'Notes/Fine2.md', E'Reset the password: monthly, via the admin console.\nToken: see the vault entry for Stripe\nMeeting at 10:30, room=boardroom2', 0)$$,
                'prose mentioning password/token without a credential value is accepted');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Key.md', '(see https://example.test/cb?access_token=abc123)', 0)$$, '22023', 'brain: content looks like a credential',
                 'a URL carrying an access token is refused');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Key.md', E'-----BEGIN PRIVATE KEY-----\nabc', 0)$$, '22023', 'brain: content looks like a credential',
                 'a private key block is refused');
select lives_ok($$select * from core.brain_document_save('PKG', 'Context/Fine.md', 'See https://example.test/path?x=1 or mail a@example.test. Basic understanding of the work; skip secrets.', 0)$$,
                'ordinary text with a URL, an address and the word "basic" is accepted');
select throws_ok($$insert into brain.documents (lane_id, owner_user_id, kind, path, body_md, updated_by) values ('PKG', auth.uid(), 'note', 'Notes/X.md', 'x', auth.uid())$$,
                 '42501', null, 'authenticated cannot insert directly');
select throws_ok($$update brain.documents set body_md = 'tampered'$$, '42501', null, 'authenticated cannot update directly');
select throws_ok($$delete from brain.document_versions$$, '42501', null, 'authenticated cannot delete versions');
reset role;

-- the CHECK constraint refuses a secret even from a direct insert as the table owner
select throws_ok(format($$insert into brain.documents (lane_id, owner_user_id, kind, path, body_md, updated_by) values ('PKG', %L, 'note', 'Notes/Direct.md', 'sk_live_abcdefghijklmnop1234', %L)$$,
                        pg_temp.uid('owner@example.test'), pg_temp.uid('owner@example.test')), '23514', null, 'the CHECK constraint refuses a secret on a direct insert');
select throws_ok(format($$insert into brain.documents (lane_id, owner_user_id, kind, path, body_md, updated_by) values ('PKG', %L, 'about_me', 'Notes/Wrong.md', 'x', %L)$$,
                        pg_temp.uid('owner@example.test'), pg_temp.uid('owner@example.test')), '23514', null, 'a kind that does not follow from the path is refused');
select throws_ok($$update brain.document_versions set body_md = 'rewritten'$$, '42501', 'brain.document_versions is append-only', 'versions are append-only');
select is((select count(*)::int from brain.document_versions v where v.kind = 'about_me' and v.owner_user_id = pg_temp.uid('owner@example.test')), 2,
          'versions carry the document''s kind and owner (set by trigger)');

-- ---------------------------------------------------------------- other user (second PKG owner)
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from brain.documents where kind in ('about_me', 'preferences')), 0, 'other user: cannot read another user''s About-Me or Preferences');
select is((select count(*)::int from brain.document_versions where kind in ('about_me', 'preferences')), 0, 'other user: nor their versions');
select is((select count(*)::int from core.brain_document_get('PKG', 'Context/About-Me.md')), 0, 'other user: get on About-Me gives no row');
select is((select body_md from core.brain_document_get('PKG', 'Context/Work.md')), '# Work', 'other user: a lane context page is readable by lane owners');
select is((select is_mine from core.brain_document_get('PKG', 'Context/Work.md')), false, 'other user: the lane page is marked as not their own');
select is((select array_agg(path || ':' || is_mine order by path) from core.brain_documents_list('PKG', 'Context/')), array['Context/Fine.md:false', 'Context/Work.md:false'],
          'other user: the list shows the lane page (not mine) and none of the first user''s About-Me or Preferences');
select is(core.brain_home_lane(), null, 'other user: no home lane yet');
select is((select o_version from core.brain_document_save('PKG', 'Context/About-Me.md', '# Someone else', 0)), 1, 'other user: saves their OWN About-Me (version 1, no clash)');
select is((select body_md from core.brain_document_get('PKG', 'Context/About-Me.md')), '# Someone else', 'other user: reads their own copy');
select is((select count(*)::int from core.brain_document_versions('PKG', 'Context/Work.md')), 0, 'other user: sees no versions of a page they do not own');
reset role;
select is((select body_md from brain.documents where owner_user_id = pg_temp.uid('owner@example.test') and path = 'Context/About-Me.md'),
          E'# About me\nName: Synthetic Owner (edited)', 'the first user''s About-Me is untouched');

-- ---------------------------------------------------------------- cross-lane (APK owner, PKG owner into APK)
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from brain.documents), 0, 'other lane owner: sees no PKG document');
select is((select count(*)::int from brain.employees) + (select count(*)::int from brain.skills), 0, 'other lane owner: sees no PKG employee or skill');
select is((select count(*)::int from core.brain_documents_list('PKG')), 0, 'other lane owner: list of PKG is empty');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Work.md', 'intrusion', 1)$$, '42501', 'brain: the owner role in this lane is required',
                 'other lane owner: cannot save into PKG');
select is((select o_version from core.brain_document_save('APK', 'Context/Work.md', '# APK work', 0)), 1, 'other lane owner: can save in their own lane');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from brain.documents where lane_id = 'APK'), 0, 'PKG owner: sees no APK document');
select throws_ok($$select * from core.brain_document_save('APK', 'Context/Work.md', 'intrusion', 1)$$, '42501', 'brain: the owner role in this lane is required',
                 'PKG owner: cannot save into APK');
reset role;
select is((select body_md from brain.documents where lane_id = 'APK'), '# APK work', 'the APK page is untouched');

-- ---------------------------------------------------------------- AAL1, admin_technical, finance_operator, anon, service_role
select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from brain.documents), 0, 'AAL1: reads nothing');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Work.md', 'aal1 write', 1)$$, '42501', 'brain: a signed-in session at aal2 is required', 'AAL1: cannot save');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from brain.documents) + (select count(*)::int from brain.employees) + (select count(*)::int from brain.skills)
          + (select count(*)::int from brain.imports) + (select count(*)::int from brain.import_candidates) + (select count(*)::int from brain.document_versions),
          0, 'admin_technical: reads nothing in brain');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Work.md', 'admin write', 1)$$, '42501', 'brain: the owner role in this lane is required', 'admin_technical: cannot save');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from brain.documents), 0, 'finance_operator: reads nothing');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Work.md', 'fo write', 1)$$, '42501', 'brain: the owner role in this lane is required', 'finance_operator: cannot save');
reset role;
set local role anon;
select throws_ok($$select count(*) from brain.documents$$, '42501', null, 'anon: no access to the tables');
select throws_ok($$select * from core.brain_document_save('PKG', 'Context/Work.md', 'anon', 1)$$, '42501', null, 'anon: cannot call the wrapper');
reset role;
set local role service_role;
select throws_ok($$select * from brain.document_save('PKG', 'Context/Work.md', 'service', 1)$$, '42501', null, 'service_role: cannot call the writer');
reset role;

-- ---------------------------------------------------------------- employees
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select o_version from core.brain_employee_save('PKG', 'personal_assistant', 'Jarvis', 'Be brief.', '{"timezone":"America/New_York"}', 'draft', 0)), 1, 'employee: created as draft');
select is((select o_version from core.brain_employee_save('PKG', 'personal_assistant', 'Jarvis', 'Be brief.', '{"timezone":"America/New_York"}', 'active', 1)), 2, 'employee: updated');
select throws_ok($$select * from core.brain_employee_save('PKG', 'personal_assistant', 'Jarvis', 'x', '{}', 'active', 1)$$, '40001', 'brain: version_conflict', 'employee: stale version refused');
select throws_ok($$select * from core.brain_employee_save('PKG', 'personal_assistant', 'Jarvis', 'x', '{"api_key":"abc"}', 'draft', 2)$$, '22023', 'brain: content looks like a credential', 'employee: credential-named config key refused');
select throws_ok($$select * from core.brain_employee_save('PKG', 'personal_assistant', 'Jarvis', 'x', '["a"]', 'draft', 2)$$, '22023', null, 'employee: config must be an object');
select throws_ok($$select * from core.brain_employee_save('PKG', 'personal_assistant', 'Jarvis', 'x', '{}', 'running', 2)$$, '22023', 'brain: invalid status', 'employee: unknown status refused');
select throws_ok($$select * from core.brain_employee_save('PKG', 'personal_assistant', 'Jarvis', 'use sk_live_abcdefghijklmnop1234', '{}', 'draft', 2)$$, '22023', 'brain: content looks like a credential', 'employee: secret in instructions refused');
select is((select count(*)::int from core.brain_employees_list('PKG')), 1, 'employee: listed for the lane');
reset role;
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select o_version from core.brain_employee_save('PKG', 'personal_assistant', 'Other PA', 'Mine.', '{}', 'draft', 0)), 1, 'employee: a second owner creates their own profile for the role');
select throws_ok($$select * from core.brain_employee_save('PKG', 'personal_assistant', 'Other PA', 'Mine.', '{}', 'draft', 0)$$, '40001', 'brain: version_conflict', 'employee: and cannot create it twice');
reset role;
select is((select name from brain.employees where owner_user_id = pg_temp.uid('owner@example.test')), 'Jarvis', 'the first owner''s profile is untouched');
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.brain_employees_list('PKG')), 0, 'employee: other lane sees none');
reset role;

-- ---------------------------------------------------------------- skills
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select o_version from core.brain_skill_save('PKG', 'brain-maintenance', 'Brain maintenance', 'Method.', 0)), 1, 'skill: created');
select throws_ok($$select * from core.brain_skill_save('PKG', 'brain-maintenance', 'Brain maintenance', 'Method v2.', 0)$$, '40001', 'brain: version_conflict', 'skill: if_version 0 on an existing skill refused');
select throws_ok($$select * from core.brain_skill_save('PKG', 'Bad Key', 'T', 'x', 0)$$, '22023', 'brain: invalid skill key', 'skill: bad key refused');
select is((select count(*)::int from core.brain_skills_list('PKG')), 1, 'skill: listed');
reset role;

-- ---------------------------------------------------------------- imports and candidates
insert into brain.imports (id, lane_id, user_id, source, status) values
  ('00000000-0000-4000-8000-000000025001', 'PKG', pg_temp.uid('owner@example.test'), 'claude_paste', 'review'),
  ('00000000-0000-4000-8000-000000025002', 'PKG', pg_temp.uid('viewer@example.test'), 'chatgpt_paste', 'review');
insert into brain.import_candidates (id, import_id, lane_id, user_id, fact, evidence, target_path, target_lane, flags) values
  ('00000000-0000-4000-8000-0000000250a1', '00000000-0000-4000-8000-000000025001', 'PKG', pg_temp.uid('owner@example.test'), 'Prefers short replies', 'quote', 'Context/Preferences.md', 'PKG', '{}'),
  ('00000000-0000-4000-8000-0000000250a2', '00000000-0000-4000-8000-000000025001', 'PKG', pg_temp.uid('owner@example.test'), 'Chairs the board', null, 'Context/About-Me.md', 'PKG', '{possible_nl_content}'),
  ('00000000-0000-4000-8000-0000000250b1', '00000000-0000-4000-8000-000000025002', 'PKG', pg_temp.uid('viewer@example.test'), 'Other user fact', 'quote', 'Context/About-Me.md', 'PKG', '{}');
select throws_ok(format($$insert into brain.import_candidates (import_id, lane_id, user_id, fact, evidence, target_path, target_lane, flags) values ('00000000-0000-4000-8000-000000025001', 'PKG', %L, 'f', 'quote', 'Context/Work.md', 'PKG', '{possible_nl_content}')$$,
                        pg_temp.uid('owner@example.test')), '23514', null, 'a possible-NL candidate with an evidence quote is refused');
select throws_ok(format($$insert into brain.import_candidates (import_id, lane_id, user_id, fact, evidence, target_path, target_lane) values ('00000000-0000-4000-8000-000000025001', 'PKG', %L, 'f', repeat('e', 301), 'Context/Work.md', 'PKG')$$,
                        pg_temp.uid('owner@example.test')), '23514', null, 'evidence over 300 characters is refused');

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from brain.imports), 1, 'imports: a user sees only their own');
select is((select count(*)::int from brain.import_candidates), 2, 'candidates: a user sees only their own');
select throws_ok($$select * from core.brain_import_decide('PKG', '00000000-0000-4000-8000-000000025002', '[]', false)$$, '42501', 'brain: import not found', 'import_decide: another user''s import is refused');
select throws_ok($$select * from core.brain_import_decide('PKG', '00000000-0000-4000-8000-000000025001', '[{"id":"00000000-0000-4000-8000-0000000250b1","decision":"keep"}]', false)$$,
                 '42501', 'brain: unknown candidate', 'import_decide: another user''s candidate is refused');
select throws_ok($$select * from core.brain_import_decide('PKG', '00000000-0000-4000-8000-000000025001', '[{"id":"00000000-0000-4000-8000-0000000250a1","decision":"maybe"}]', false)$$,
                 '22023', 'brain: invalid decision', 'import_decide: an unknown decision is refused');
select throws_ok($$select * from core.brain_import_decide('PKG', '00000000-0000-4000-8000-000000025001', '[{"id":"------------------------------------","decision":"keep"}]', false)$$,
                 '22023', 'brain: invalid decision', 'import_decide: an id that is not a uuid is refused');
select is((select array_agg(o_fact order by o_fact) from core.brain_import_decide('PKG', '00000000-0000-4000-8000-000000025001',
          '[{"id":"00000000-0000-4000-8000-0000000250a1","decision":"keep"},{"id":"00000000-0000-4000-8000-0000000250a2","decision":"skip"}]', false)),
          array['Prefers short replies'], 'import_decide: returns the kept facts');
select is((select count(*)::int from brain.import_candidates), 2, 'import_decide: candidates stay until finished');
select is((select array_agg(o_fact) from core.brain_import_decide('PKG', '00000000-0000-4000-8000-000000025001', '[]', true)),
          array['Prefers short replies'], 'import_decide finish: still returns the kept facts');
select is((select count(*)::int from brain.import_candidates), 0, 'import_decide finish: candidates are deleted');
select is((select status from brain.imports), 'done', 'import_decide finish: the import is done');
select throws_ok($$select * from core.brain_import_decide('PKG', '00000000-0000-4000-8000-000000025001', '[]', false)$$, '55000', 'brain: import is not open for decisions', 'import_decide: a finished import is closed');
reset role;
select is((select count(*)::int from brain.import_candidates where user_id = pg_temp.uid('viewer@example.test')), 1, 'the other user''s candidate is untouched');

-- expiry: a candidate older than 24 h is unreadable, its import cannot be decided
update brain.imports set created_at = now() - interval '25 hours' where id = '00000000-0000-4000-8000-000000025002';
update brain.import_candidates set created_at = now() - interval '25 hours' where id = '00000000-0000-4000-8000-0000000250b1';
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from brain.import_candidates), 0, 'expiry: a candidate older than 24 h is hidden by RLS');
select throws_ok($$select * from core.brain_import_decide('PKG', '00000000-0000-4000-8000-000000025002', '[]', false)$$, '55000', 'brain: import expired', 'expiry: an old import cannot be decided');
reset role;

-- ---------------------------------------------------------------- purge
delete from brain.imports;
insert into brain.imports (id, lane_id, user_id, source, status, created_at) values
  ('00000000-0000-4000-8000-000000025011', 'PKG', pg_temp.uid('owner@example.test'), 'claude_paste', 'review', now() - interval '22 hours'),
  ('00000000-0000-4000-8000-000000025012', 'PKG', pg_temp.uid('owner@example.test'), 'claude_paste', 'review', now() - interval '25 hours'),
  ('00000000-0000-4000-8000-000000025013', 'APK', pg_temp.uid('outsider@example.test'), 'claude_paste', 'review', now() - interval '25 hours');
insert into brain.import_candidates (import_id, lane_id, user_id, fact, target_path, target_lane, created_at) values
  ('00000000-0000-4000-8000-000000025011', 'PKG', pg_temp.uid('owner@example.test'), 'fresh 22h', 'Context/Work.md', 'PKG', now() - interval '22 hours'),
  ('00000000-0000-4000-8000-000000025012', 'PKG', pg_temp.uid('owner@example.test'), 'old 24h', 'Context/Work.md', 'PKG', now() - interval '24 hours'),
  ('00000000-0000-4000-8000-000000025012', 'PKG', pg_temp.uid('owner@example.test'), 'old 25h', 'Context/Work.md', 'PKG', now() - interval '25 hours'),
  ('00000000-0000-4000-8000-000000025013', 'APK', pg_temp.uid('outsider@example.test'), 'other lane old', 'Context/Work.md', 'APK', now() - interval '25 hours');
set local role service_role;
select is(core.brain_import_purge('PKG'), 2, 'purge: deletes the PKG candidates older than 23 h');
reset role;
select is((select array_agg(fact) from brain.import_candidates where lane_id = 'PKG'), array['fresh 22h'], 'purge: the 22 h candidate is kept');
select is((select count(*)::int from brain.import_candidates where lane_id = 'APK'), 1, 'purge: another lane is untouched');
select is((select status from brain.imports where id = '00000000-0000-4000-8000-000000025012'), 'failed', 'purge: an import open after 24 h is closed as failed');
select is((select status from brain.imports where id = '00000000-0000-4000-8000-000000025011'), 'review', 'purge: a 22 h import stays open');
select is((select status from brain.imports where id = '00000000-0000-4000-8000-000000025013'), 'review', 'purge: another lane''s import is untouched');
set local role service_role;
select throws_ok($$select core.brain_import_purge('NL')$$, '42501', 'lane is not enabled', 'purge: a disabled lane is refused');
select throws_ok($$select core.brain_import_purge(null)$$, '22004', null, 'purge: a lane is required');
reset role;
set local role authenticated;
select throws_ok($$select core.brain_import_purge('PKG')$$, '42501', null, 'purge: authenticated cannot call it');
reset role;

select * from finish();
rollback;
