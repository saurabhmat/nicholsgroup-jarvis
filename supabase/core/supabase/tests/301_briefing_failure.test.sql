-- T-234 part 0: core.briefing_last_failure. Covered: grants (authenticated and service_role, not anon), the newest failed
-- attempt returns its stored code, a newer good attempt hides an older failure, an attempt without a code returns a null
-- reason, and denial: another lane, AAL1, same-lane member who is not the owner, outsider.
begin;
select plan(11);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
select ok(has_function_privilege('authenticated', 'core.briefing_last_failure(text)', 'execute'), 'authenticated may call it');
select ok(not has_function_privilege('anon', 'core.briefing_last_failure(text)', 'execute'), 'anon may not');

set local role service_role;
select isnt(core.briefing_save('PKG', pg_temp.uid('owner@example.test'), 'schedule', 'failed', now() - interval '1 day', now() - interval '3 hours',
  '{"notes": ["model_failed", "fail:model_setting_invalid"]}', '[]', '[]', 'mock'), null, 'a failed attempt with a code');
reset role;
update brief.briefings set prepared_at = now() - interval '3 hours' where lane_id = 'PKG';

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select reason from core.briefing_last_failure('PKG')), 'model_setting_invalid', 'the newest attempt failed: its code is returned');
select is((select count(*)::int from core.briefing_last_failure('APK')), 0, 'another lane: nothing');
reset role;

set local role service_role;
select isnt(core.briefing_save('PKG', pg_temp.uid('owner@example.test'), 'schedule', 'ready', now() - interval '1 day', now() - interval '1 hour', '{"lines": ["ok"]}', '[]', '[]', 'mock'), null, 'a newer good attempt');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.briefing_last_failure('PKG')), 0, 'a newer good attempt: no failure to report');
reset role;

set local role service_role;
select isnt(core.briefing_save('PKG', pg_temp.uid('owner@example.test'), 'schedule', 'failed', now() - interval '1 day', now() - interval '1 minute', '{"notes": ["model_failed"]}', '[]', '[]', 'mock'), null, 'a newer failure without a code');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int || ':' || coalesce(max(reason), 'null') from core.briefing_last_failure('PKG')), '1:null', 'reported with a null reason');
reset role;

select pg_temp.claims('owner@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.briefing_last_failure('PKG')), 0, 'AAL1: nothing');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.briefing_last_failure('PKG')), 0, 'same-lane non-owner and outsider: nothing');
reset role;

select * from finish();
rollback;
