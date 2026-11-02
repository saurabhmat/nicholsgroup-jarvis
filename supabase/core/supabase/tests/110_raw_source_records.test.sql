-- Raw source records (T-039): private table, service_role-only upsert bound to the connection's lane, server-set hash
-- and provider, the content-body guard (database side), and cross-lane / API-role denial.
begin;
select plan(36);
\ir helpers/lane_rls.psql

select has_table('raw', 'source_records', 'raw.source_records exists');
select ok((select relrowsecurity from pg_class where oid = 'raw.source_records'::regclass), 'RLS is on');
select is((select count(*)::int from pg_policy where polrelid = 'raw.source_records'::regclass), 0, 'no policy: private table');
select ok(not has_table_privilege('authenticated', 'raw.source_records', 'select, insert, update, delete')
          and not has_table_privilege('anon', 'raw.source_records', 'select, insert, update, delete')
          and not has_table_privilege('service_role', 'raw.source_records', 'select, insert, update, delete'),
          'no role has table grants (only the definer function writes)');
select ok(not has_schema_privilege('authenticated', 'raw', 'usage') and not has_schema_privilege('anon', 'raw', 'usage'),
          'API roles have no usage on schema raw');
select ok(has_function_privilege('service_role', 'core.source_records_upsert(text, uuid, jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'core.source_records_upsert(text, uuid, jsonb)', 'execute')
          and not has_function_privilege('anon', 'core.source_records_upsert(text, uuid, jsonb)', 'execute'),
          'only service_role executes the upsert');

-- ---------------------------------------------------------------- body-field detection (pure function)
select ok(raw.payload_has_body_field('{"id": "m1", "body": {"content": "hi"}}'), 'a body key is found');
select ok(raw.payload_has_body_field('{"id": "m1", "bodyPreview": "hi"}'), 'bodyPreview is found');
select ok(raw.payload_has_body_field('{"id": "m1", "Body-Preview": "hi"}'), 'punctuation and case are ignored');
select ok(raw.payload_has_body_field('{"items": [{"parts": [{"snippet": "x"}]}]}'), 'found inside arrays and nesting');
select ok(raw.payload_has_body_field('{"a": {"b": {"c": {"d": {"e": {"f": {"g": {"h": {"i": {"j": {"k": {"l": {"m": {"n": {"o": {"p": {"q": 1}}}}}}}}}}}}}}}}}'),
          'nesting deeper than 16 levels fails closed');
select ok(not raw.payload_has_body_field('{"id": "m1", "subject": "Hello", "from": "a@example.test", "labels": ["INBOX"]}'),
          'metadata only has no body field');
select ok(not raw.payload_has_body_field('{"note": "the body is here"}'), 'values are not scanned, only keys');
select ok(raw.is_content_provider('google') and raw.is_content_provider('microsoft') and raw.is_content_provider('notion')
          and not raw.is_content_provider('quickbooks') and not raw.is_content_provider('stripe'),
          'content providers are google, microsoft, notion');

-- ---------------------------------------------------------------- fixtures (service_role is the real writer)
set local role service_role;
insert into core.connections (id, lane_id, provider, external_account_id, status) values
  ('00000000-0000-4000-8000-000000000391', 'PKG', 'quickbooks', 'realm-synthetic-39', 'active'),
  ('00000000-0000-4000-8000-000000000392', 'PKG', 'google', 'mailbox-synthetic-39', 'active'),
  ('00000000-0000-4000-8000-000000000393', 'APK', 'quickbooks', 'realm-synthetic-39b', 'active');

select is(
  core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391', $j$[
    {"object_type": "Invoice", "external_id": "inv-1", "payload": {"Id": "inv-1", "TotalAmt": "100.00"}, "source_updated_at": "2026-11-01T10:00:00Z", "deleted": false, "synced_at": "2026-11-02T10:00:00Z"},
    {"object_type": "Invoice", "external_id": "inv-2", "payload": {"Id": "inv-2"}, "synced_at": "2026-11-02T10:00:00Z"}
  ]$j$),
  2, 'a batch is written and counted');
reset role;

select is((select provider from raw.source_records where external_id = 'inv-1'), 'quickbooks', 'the provider comes from the connection row');
select is((select payload_hash from raw.source_records where external_id = 'inv-1'),
          encode(sha256(convert_to('{"Id": "inv-1", "TotalAmt": "100.00"}', 'UTF8')), 'hex'), 'the hash is the SHA-256 of the payload');
select is((select deleted from raw.source_records where external_id = 'inv-2'), false, 'deleted defaults to false');

-- upsert: same key updates in place, the hash follows the payload
set local role service_role;
select is(core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Invoice", "external_id": "inv-1", "payload": {"Id": "inv-1", "TotalAmt": "250.00"}, "deleted": true, "synced_at": "2026-11-03T10:00:00Z"}]'),
  1, 'an existing object is updated');
reset role;
select is((select count(*)::int from raw.source_records where external_id = 'inv-1'), 1, 'still one row for the object');
select is((select payload_hash from raw.source_records where external_id = 'inv-1'),
          encode(sha256(convert_to('{"Id": "inv-1", "TotalAmt": "250.00"}', 'UTF8')), 'hex'), 'the hash was recomputed on update');
select ok((select deleted from raw.source_records where external_id = 'inv-1'), 'the deletion marker is stored');

set local role service_role;
select lives_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Bill", "external_id": "b1", "payload": {"v": 1}, "synced_at": "2026-11-03T10:00:00Z"},
    {"object_type": "Bill", "external_id": "b1", "payload": {"v": 2}, "synced_at": "2026-11-03T10:00:01Z"}]')$$,
  'a duplicate object inside one batch does not fail');
reset role;
select is((select payload ->> 'v' from raw.source_records where external_id = 'b1'), '2', 'the last duplicate in a batch wins');

-- ---------------------------------------------------------------- lane binding
set local role service_role;
select throws_ok($$select core.source_records_upsert('APK', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Invoice", "external_id": "x", "payload": {}, "synced_at": "2026-11-03T10:00:00Z"}]')$$,
  '42501', null, 'cross-lane: another lane''s connection id is refused');
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-0000000003ff',
  '[{"object_type": "Invoice", "external_id": "x", "payload": {}, "synced_at": "2026-11-03T10:00:00Z"}]')$$,
  '42501', null, 'an unknown connection gives the same error');
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391', '{"not": "an array"}')$$,
  '22004', null, 'records must be an array');
reset role;
select throws_ok($$insert into raw.source_records (lane_id, connection_id, provider, object_type, external_id, payload, payload_hash, synced_at)
  values ('PKG', '00000000-0000-4000-8000-000000000393', 'quickbooks', 'Invoice', 'y', '{}', '', now())$$,
  '23503', null, 'cross-lane: the table itself refuses a record under another lane''s connection');

set local role service_role;
select throws_ok(format($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Invoice", "external_id": "big", "payload": {"v": "%s"}, "synced_at": "2026-11-03T10:00:00Z"}]')$$, repeat('x', 1100000)),
  '23514', null, 'a payload over 1 MB is refused');
reset role;

-- ---------------------------------------------------------------- content guard (database side)
set local role service_role;
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000392',
  '[{"object_type": "message", "external_id": "m1", "payload": {"id": "m1", "body": {"content": "synthetic"}}, "synced_at": "2026-11-03T10:00:00Z"}]')$$,
  '42501', null, 'a mail payload with a body is refused while store_content_bodies is false');
select lives_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000392',
  '[{"object_type": "message", "external_id": "m2", "payload": {"id": "m2", "subject": "Hi"}, "synced_at": "2026-11-03T10:00:00Z"}]')$$,
  'a metadata-only mail payload is stored');
reset role;
update core.lane_policies set store_content_bodies = true where lane_id = 'PKG';
set local role service_role;
select lives_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000392',
  '[{"object_type": "message", "external_id": "m1", "payload": {"id": "m1", "body": {"content": "synthetic"}}, "synced_at": "2026-11-03T10:00:00Z"}]')$$,
  'the same payload is stored once the lane policy allows bodies');
reset role;
update core.lane_policies set store_content_bodies = false where lane_id = 'PKG';
set local role service_role;
select lives_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Invoice", "external_id": "inv-3", "payload": {"Id": "inv-3", "text": "memo"}, "synced_at": "2026-11-03T10:00:00Z"}]')$$,
  'the guard does not apply to finance providers');
reset role;

-- ---------------------------------------------------------------- API roles
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$select * from raw.source_records$$, '42501', null, 'a signed-in owner cannot read raw records');
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391', '[]')$$, '42501', null,
                 'a signed-in owner cannot call the upsert');
reset role;
set local role anon;
select throws_ok($$select * from raw.source_records$$, '42501', null, 'anon cannot read raw records');
reset role;

select * from finish();
rollback;
