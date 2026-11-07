-- Brain sensitive-number screen (T-210 follow-up, migration 20261107100000): SSNs, card-layout Luhn numbers and
-- labelled bank/routing/IBAN numbers are refused on every brain text column with an error naming the kind; phone numbers
-- and dates still save. The "shared cases" block is generated from tests/fixtures/brain_sensitive_cases.json and a Vitest
-- parity test (packages/modules/brain/src/domain/sensitive.test.ts) fails if a case is missing here. Synthetic values only.
begin;
select plan(70);
\ir helpers/lane_rls.psql

delete from brain.imports;
delete from brain.documents;
delete from brain.employees;
delete from brain.skills;

-- ---------------------------------------------------------------- shared cases (generated; keep in step with the fixture)
select is(brain.sensitive_number_kind(E'SSN 123-45-6789'), 'ssn', 'case "SSN 123-45-6789"');
select is(brain.sensitive_number_kind(E'ssn:123-45-6789.'), 'ssn', 'case "ssn:123-45-6789."');
select is(brain.sensitive_number_kind(E'SSN-123-45-6789'), 'ssn', 'case "SSN-123-45-6789"');
select is(brain.sensitive_number_kind(E'SSN 123-45-6789-'), 'ssn', 'case "SSN 123-45-6789-"');
select is(brain.sensitive_number_kind(E'SSN 123\u201345\u20136789'), 'ssn', 'case "SSN 123\u201345\u20136789"');
select is(brain.sensitive_number_kind(E'SSN \uff11\uff12\uff13-\uff14\uff15-\uff16\uff17\uff18\uff19'), 'ssn', 'case "SSN \uff11\uff12\uff13-\uff14\uff15-\uff16\uff17\uff18\uff19"');
select is(brain.sensitive_number_kind(E'card 4111 1111 1111 1111'), 'card', 'case "card 4111 1111 1111 1111"');
select is(brain.sensitive_number_kind(E'4111-1111-1111-1111'), 'card', 'case "4111-1111-1111-1111"');
select is(brain.sensitive_number_kind(E'4111111111111111'), 'card', 'case "4111111111111111"');
select is(brain.sensitive_number_kind(E'4111.1111.1111.1111'), 'card', 'case "4111.1111.1111.1111"');
select is(brain.sensitive_number_kind(E'4111  1111  1111  1111'), 'card', 'case "4111  1111  1111  1111"');
select is(brain.sensitive_number_kind(E'4111 1111 1111 1111 123'), 'card', 'case "4111 1111 1111 1111 123"');
select is(brain.sensitive_number_kind(E'4111 1111 1111 1111 12/28'), 'card', 'case "4111 1111 1111 1111 12/28"');
select is(brain.sensitive_number_kind(E'Card 4111 1111 1111 1111 12 28'), 'card', 'case "Card 4111 1111 1111 1111 12 28"');
select is(brain.sensitive_number_kind(E'Amex 3782 822463 10005'), 'card', 'case "Amex 3782 822463 10005"');
select is(brain.sensitive_number_kind(E'Notes/4111111111111111.md'), 'card', 'case "Notes/4111111111111111.md"');
select is(brain.sensitive_number_kind(E'Account number: 12345678'), 'bank', 'case "Account number: 12345678"');
select is(brain.sensitive_number_kind(E'acct #00012345678'), 'bank', 'case "acct #00012345678"');
select is(brain.sensitive_number_kind(E'**Account number:** 12345678'), 'bank', 'case "**Account number:** 12345678"');
select is(brain.sensitive_number_kind(E'| Account | 12345678 |'), 'bank', 'case "| Account | 12345678 |"');
select is(brain.sensitive_number_kind(E'Account Number - 12345678'), 'bank', 'case "Account Number - 12345678"');
select is(brain.sensitive_number_kind(E'Acct. 12345678'), 'bank', 'case "Acct. 12345678"');
select is(brain.sensitive_number_kind(E'Account number:\n12345678'), 'bank', 'case "Account number:\n12345678"');
select is(brain.sensitive_number_kind(E'Account: 1234 5678 9012'), 'bank', 'case "Account: 1234 5678 9012"');
select is(brain.sensitive_number_kind(E'Bank acct: 12-345-678'), 'bank', 'case "Bank acct: 12-345-678"');
select is(brain.sensitive_number_kind(E'routing 021000021'), 'bank', 'case "routing 021000021"');
select is(brain.sensitive_number_kind(E'Routing number is 021000021'), 'bank', 'case "Routing number is 021000021"');
select is(brain.sensitive_number_kind(E'ABA: 021000021'), 'bank', 'case "ABA: 021000021"');
select is(brain.sensitive_number_kind(E'IBAN: GB82 WEST 1234 5698 7654 32'), 'bank', 'case "IBAN: GB82 WEST 1234 5698 7654 32"');
select is(brain.sensitive_number_kind(E'IBAN\nGB82WEST12345698765432'), 'bank', 'case "IBAN\nGB82WEST12345698765432"');
select is(brain.sensitive_number_kind(E'IBAN GB82-WEST-1234-5698-7654-32'), 'bank', 'case "IBAN GB82-WEST-1234-5698-7654-32"');
select is(brain.sensitive_number_kind(E'4111 1111 1111 1112'), null, 'case "4111 1111 1111 1112"');
select is(brain.sensitive_number_kind(E'Call 555-123-4567 or +1 (555) 987-6543'), null, 'case "Call 555-123-4567 or +1 (555) 987-6543"');
select is(brain.sensitive_number_kind(E'555-123-4567 555-987-6543'), null, 'case "555-123-4567 555-987-6543"');
select is(brain.sensitive_number_kind(E'212-555-0100 1234'), null, 'case "212-555-0100 1234"');
select is(brain.sensitive_number_kind(E'Due 2026-11-07, 11/07/2026, 10:30'), null, 'case "Due 2026-11-07, 11/07/2026, 10:30"');
select is(brain.sensitive_number_kind(E'2026-02-22 2026-03-01'), null, 'case "2026-02-22 2026-03-01"');
select is(brain.sensitive_number_kind(E'2026-04-26 2026-05-03'), null, 'case "2026-04-26 2026-05-03"');
select is(brain.sensitive_number_kind(E'07.11.2026 08.11.2026'), null, 'case "07.11.2026 08.11.2026"');
select is(brain.sensitive_number_kind(E'account ending 1234'), null, 'case "account ending 1234"');
select is(brain.sensitive_number_kind(E'Account review on 2026-11-07'), null, 'case "Account review on 2026-11-07"');
select is(brain.sensitive_number_kind(E'Account 2026-11-07'), null, 'case "Account 2026-11-07"');
select is(brain.sensitive_number_kind(E'Account 400100 Revenue'), null, 'case "Account 400100 Revenue"');
select is(brain.sensitive_number_kind(E'order 12345678'), null, 'case "order 12345678"');
select is(brain.sensitive_number_kind(E'1234-5678-90'), null, 'case "1234-5678-90"');
select is(brain.sensitive_number_kind(E'version 1.2.3-45-6789x'), null, 'case "version 1.2.3-45-6789x"');
select is(brain.sensitive_number_kind(E'Prefers replies under 100 words. Meetings 9-5 ET.'), null, 'case "Prefers replies under 100 words. Meetings 9-5 ET."');
select is(brain.sensitive_number_kind(E''), null, 'case ""');

-- ---------------------------------------------------------------- privileges and time
select ok((select bool_and(not has_function_privilege(r, f, 'execute'))
           from unnest(array['anon', 'authenticated', 'service_role']) r,
                unnest(array['brain.sensitive_number_kind(text)', 'brain.luhn_ok(text)', 'brain.card_layout(integer[])']) f),
          'the screen functions are not callable by API roles');
select ok((select bool_and(t.tgenabled = 'O') from pg_trigger t where t.tgname like '%\_sensitive' escape '\' and t.tgrelid::regclass::text like 'brain.%')
          and (select count(*) from pg_trigger t where t.tgname like '%\_sensitive' escape '\' and t.tgrelid::regclass::text like 'brain.%') = 5,
          'the screen is on all five brain text tables');
create temp table t_timing (ms numeric);
do $$
declare v_start timestamptz := clock_timestamp();
begin
  perform brain.sensitive_number_kind('account' || repeat(' ', 32000) || 'x');
  perform brain.sensitive_number_kind(repeat('1 ', 16000) || 'x');
  perform brain.sensitive_number_kind(repeat('1234-', 6400) || 'x');
  perform brain.sensitive_number_kind(repeat('account number:** ', 1700));
  insert into t_timing values (extract(epoch from clock_timestamp() - v_start) * 1000);
end $$;
select cmp_ok((select ms from t_timing), '<', 2000::numeric, 'four 32 KB adversarial inputs screen in under 2 s together');

-- ---------------------------------------------------------------- through the writers, as the owner (message names the kind)
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select * from core.brain_document_save('PKG', 'Notes/S.md', 'SSN 123-45-6789', 0)$$, '22023', 'brain: sensitive_ssn (content contains a sensitive number and was not saved)', 'page: an SSN is refused');
select throws_ok($$select * from core.brain_document_save('PKG', 'Notes/S.md', 'Card 4111 1111 1111 1111 12/28', 0)$$, '22023', 'brain: sensitive_card (content contains a sensitive number and was not saved)', 'page: a card number with expiry is refused');
select throws_ok($$select * from core.brain_document_save('PKG', 'Notes/S.md', '**Routing number:** 021000021', 0)$$, '22023', 'brain: sensitive_bank (content contains a sensitive number and was not saved)', 'page: a markdown-labelled routing number is refused');
select throws_ok($$select * from core.brain_document_save('PKG', 'Notes/4111111111111111.md', 'x', 0)$$, '22023', 'brain: sensitive_card (content contains a sensitive number and was not saved)', 'page: a card number in the path is refused');
select lives_ok($$select * from core.brain_document_save('PKG', 'Notes/Ok.md', E'Call 555-123-4567.\nBoard meeting 2026-11-07 at 10:30; renew by 11/30/2026.\nPost fees to Account 400100 Revenue.', 0)$$,
                'page: phone numbers, dates and a ledger account save');
select is((select count(*)::int from core.brain_document_versions('PKG', 'Notes/Ok.md')), 1, '... and the version row is written');
select lives_ok($$select * from core.brain_document_save('PKG', 'Notes/Ok.md', 'Fine text', 1)$$, 'page: an ordinary update saves');
select throws_ok($$select * from core.brain_document_save('PKG', 'Notes/Ok.md', 'acct #00012345678', 2)$$, '22023', 'brain: sensitive_bank (content contains a sensitive number and was not saved)', 'page: an update adding an account number is refused');
select throws_ok($$select * from core.brain_employee_save('PKG', 'personal_assistant', 'Jarvis', 'My SSN is 123-45-6789', '{}', 'draft', 0)$$, '22023', 'brain: sensitive_ssn (content contains a sensitive number and was not saved)', 'employee: an SSN in instructions is refused');
select throws_ok($$select * from core.brain_employee_save('PKG', 'personal_assistant', 'Card 4111111111111111', 'x', '{}', 'draft', 0)$$, '22023', 'brain: sensitive_card (content contains a sensitive number and was not saved)', 'employee: a card number in the name is refused');
select throws_ok($$select * from core.brain_employee_save('PKG', 'personal_assistant', 'Jarvis', 'x', '{"note": "routing 021000021"}', 'draft', 0)$$, '22023', 'brain: sensitive_bank (content contains a sensitive number and was not saved)', 'employee: a routing number in config is refused');
select throws_ok($$select * from core.brain_skill_save('PKG', 'pay-run', 'Pay run', 'Use account number 12345678', 0)$$, '22023', 'brain: sensitive_bank (content contains a sensitive number and was not saved)', 'skill: a labelled account number is refused');
select throws_ok($$select * from core.brain_skill_save('PKG', 'pay-run', 'IBAN GB82WEST12345698765432', 'x', 0)$$, '22023', 'brain: sensitive_bank (content contains a sensitive number and was not saved)', 'skill: an IBAN in the title is refused');
reset role;

-- ---------------------------------------------------------------- direct inserts (table owner) are covered by the trigger
select throws_ok(format($$insert into brain.documents (lane_id, owner_user_id, kind, path, body_md, updated_by) values ('PKG', %L, 'note', 'Notes/D.md', 'SSN 123-45-6789', %L)$$,
                        pg_temp.uid('owner@example.test'), pg_temp.uid('owner@example.test')), '22023', 'brain: sensitive_ssn (content contains a sensitive number and was not saved)', 'direct insert of a page with an SSN is refused');
insert into brain.imports (id, lane_id, user_id, source, status) values
  ('00000000-0000-4000-8000-000000025101', 'PKG', pg_temp.uid('owner@example.test'), 'claude_paste', 'review');
select throws_ok(format($$insert into brain.import_candidates (import_id, lane_id, user_id, fact, evidence, target_path, target_lane, flags) values ('00000000-0000-4000-8000-000000025101', 'PKG', %L, 'Has a card', 'card 4111 1111 1111 1111', 'Context/Work.md', 'PKG', '{}')$$,
                        pg_temp.uid('owner@example.test')), '22023', 'brain: sensitive_card (content contains a sensitive number and was not saved)', 'import candidate: a card number in the evidence is refused');
select throws_ok(format($$insert into brain.import_candidates (import_id, lane_id, user_id, fact, evidence, target_path, target_lane, flags) values ('00000000-0000-4000-8000-000000025101', 'PKG', %L, 'SSN 123-45-6789', null, 'Context/Work.md', 'PKG', '{}')$$,
                        pg_temp.uid('owner@example.test')), '22023', 'brain: sensitive_ssn (content contains a sensitive number and was not saved)', 'import candidate: an SSN in the fact is refused');
select throws_ok(format($$insert into brain.import_candidates (import_id, lane_id, user_id, fact, evidence, target_path, target_lane, flags) values ('00000000-0000-4000-8000-000000025101', 'PKG', %L, 'x', null, 'Notes/4111111111111111.md', 'PKG', '{}')$$,
                        pg_temp.uid('owner@example.test')), '22023', 'brain: sensitive_card (content contains a sensitive number and was not saved)', 'import candidate: a card number in the target path is refused');
select lives_ok(format($$insert into brain.import_candidates (import_id, lane_id, user_id, fact, evidence, target_path, target_lane, flags) values ('00000000-0000-4000-8000-000000025101', 'PKG', %L, 'Office line 555-123-4567', 'since 2026-11-07', 'Context/Work.md', 'PKG', '{}')$$,
                        pg_temp.uid('owner@example.test')), 'import candidate: a phone number and a date save');

-- ---------------------------------------------------------------- an unknown column fails loudly (review L-1)
create temp table t_screen (body_md text);
create trigger t_screen_bad before insert on t_screen for each row execute function brain.refuse_sensitive_numbers('no_such_column');
select throws_like($$insert into t_screen values ('x')$$, '%unknown column no_such_column%', 'a misnamed trigger column fails instead of screening nothing');

select * from finish();
rollback;
