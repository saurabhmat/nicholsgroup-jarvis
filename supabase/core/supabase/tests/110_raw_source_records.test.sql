-- Raw source records (T-039): private table, service_role-only upsert bound to the connection's lane, server-set hash
-- and provider, the content-body guard (database side), and cross-lane / API-role denial.
begin;
select plan(289);
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
select ok(not raw.payload_has_body_field('{"subject2": "the body is here"}'), 'values are not scanned, only keys');
select ok(raw.is_content_provider('google') and raw.is_content_provider('microsoft') and raw.is_content_provider('notion')
          and raw.is_content_provider('monday') and raw.is_content_provider('gohighlevel') and raw.is_content_provider('timesolv')
          and not raw.is_content_provider('quickbooks') and not raw.is_content_provider('stripe'),
          'content providers are google, microsoft, notion, monday, gohighlevel, timesolv');

select ok(raw.payload_has_body_field(jsonb_build_object(k, 'x')), 'body-like key found: ' || k)
from unnest(array['description', 'notes', 'contentBytes', 'formattedText', 'argumentText', 'indexableText', 'values',
                  'messageBody', 'bodyText', 'bodyContent', 'fullText', 'emailBody', 'comment', 'attachmentData',
                  'dataUrl', 'narrative', 'raw', 'contentTypeBody', 'note', 'memo', 'transcript', 'preview', 'excerpt', 'caption',
                  'internalNote', 'MeetingTranscript', E'b\u00f3dy', E'\uff42\uff4f\uff44\uff59']) as k;
select ok(not raw.payload_has_body_field('{"contentType": "text/plain", "contentLength": 4, "textColor": "red", "messageId": "m", "internetMessageId": "<x>", "context_id": "c", "hasAttachments": true}'),
          'documented safe metadata keys stay storable');
select ok(not raw.payload_has_body_field('{"htmlLink": "u", "webContentLink": "u", "messagesTotal": 1, "messagesUnread": 0, "lastMessageType": "t", "lastMessageDate": "2026-11-01T00:00:00Z"}'),
          'link and mailbox counter keys stay storable');
select ok(raw.payload_has_forbidden_field(jsonb_build_object(k, 'x')) and raw.payload_has_forbidden_field(jsonb_build_object('a', jsonb_build_array(jsonb_build_object(k, 'x'))), 'quickbooks'),
          'forbidden key found at any depth: ' || k)
from unnest(array['BankAcctNum', 'compensation', 'hourlyRate', 'wage', 'ssn_last4', 'employeeSsn', 'PrimaryTaxIdentifier', 'ein',
                  'api_key', 'id_token', 'webhook_secret', 'ssn', 'taxId', 'tax_identifier', 'AcctNum', 'account-number',
                  'bankAccountNumber', 'routingNumber', 'IBAN', 'billRate', 'costRate', 'payRate', 'bill_rate', 'salary', 'pin',
                  'password', 'passwd', 'secret', 'clientSecret', 'accessToken', 'refresh_token', 'socialSecurityNumber',
                  'payroll', 'accountNo', 'privateKey', 'apiKey', 'credentials', 'swift', 'bic', 'tin', 'sin', 'rate_bill',
                  'hourly.rate',
                  -- round 3: punctuation, plurals, acronym plurals, case and zero-width evasions, new contained terms
                  'S.S.N.', 's_sn', 'S-S-N', 'ssns', 'pins', 'ibans', 'rates_bill', 'tokens', 'SSNs', 'PINs', 'IBANs', 'acctno',
                  'AcctNo', 'FEIN', 'fein', 'ITIN', 'itin', 'authorization', 'Authorization', 'cookie', 'Cookies', 'passcode',
                  'pwd', 'billingrate', 'billing_rate', 'sSN', 'ssN', E's\u200bsn', E'ss\u200dn', E'ssn\ufeff', 'clientsecrets',
                  'account_no', 'AccountNo', 'accountno', 'secretKey', 'secrets', 'refreshTokens', 'billRates', 'secretkey']) as k;
select ok(raw.payload_has_forbidden_field('{"bank": {"routing": "x", "account": "y"}}'), 'a nested routing key is found');
select ok(not raw.payload_has_forbidden_field('{"bank": {"account": "y"}}'), 'account alone is not forbidden');
select ok(not raw.payload_has_forbidden_field(jsonb_build_object(k, 'x'), 'quickbooks'), 'allowed key: ' || k)
from unnest(array['SyncToken', 'nextPageToken', 'pageToken', 'deltaToken', 'classname', 'pinned', 'Id', 'TotalAmt', 'rate', 'Rate',
                  'pinning', 'single', 'winner', 'operate', 'tokenizer', 'generate', 'ratio', 'CurrencyRef', 'MetaData',
                  'nextSyncToken', 'startPageToken', 'secretary', 'accountNotes', 'Secretary', 'rates', 'Rates', 'spinner',
                  '!deep', '__proto__']) as k;
select ok(raw.payload_has_forbidden_field('{"rates": 1}', 'timesolv') and not raw.payload_has_forbidden_field('{"rates": 1}', 'stripe')
          and raw.payload_has_forbidden_field('{"hourlyRates": 1}', 'stripe'), 'rates is like rate');
select ok(not raw.payload_has_forbidden_field('{"!deep": 1}') and not raw.payload_has_body_field('{"!deep": 1}'),
          'a key literally named !deep is an ordinary key (no sentinel)');
select ok(raw.payload_has_forbidden_field('{"Rate": 1}', 'timesolv') and not raw.payload_has_forbidden_field('{"Rate": 1}', 'stripe')
          and not raw.payload_has_forbidden_field('{"Rate": 1}'), 'bare rate is forbidden for timesolv only');
select ok(raw.payload_has_forbidden_field('{"a": {"b": {"c": {"d": {"e": {"f": {"g": {"h": {"i": {"j": {"k": {"l": {"m": {"n": {"o": {"p": {"q": 1}}}}}}}}}}}}}}}}}'),
          'forbidden guard fails closed on deep nesting');

-- key_words fixtures (the same list is tested in packages/connectors/src/raw/guard.test.ts)
select is(raw.key_words(E'employeeSsn'), array['employee', 'ssn'], 'words: employeeSsn');
select is(raw.key_words(E'SSNLast4'), array['ssn', 'last', '4'], 'words: SSNLast4');
select is(raw.key_words(E'ssn_last4'), array['ssn', 'last', '4'], 'words: ssn_last4');
select is(raw.key_words(E'Body-Preview'), array['body', 'preview'], 'words: Body-Preview');
select is(raw.key_words(E'hourlyRate'), array['hourly', 'rate'], 'words: hourlyRate');
select is(raw.key_words(E'classname'), array['classname'], 'words: classname');
select is(raw.key_words(E'id_token'), array['id', 'token'], 'words: id_token');
select is(raw.key_words(E'PrimaryTaxIdentifier'), array['primary', 'tax', 'identifier'], 'words: PrimaryTaxIdentifier');
select is(raw.key_words(E'bódy.text'), array['body', 'text'], 'words: accents dropped, dot splits');
select is(raw.key_words(E'SSNs'), array['ssns'], 'words: SSNs');
select is(raw.key_words(E'PINs'), array['pins'], 'words: PINs');
select is(raw.key_words(E'IBANs'), array['ibans'], 'words: IBANs');
select is(raw.key_words(E'PINsList'), array['pins', 'list'], 'words: PINsList');
select is(raw.key_words(E'SSNStatus'), array['ssn', 'status'], 'words: SSNStatus');
select is(raw.key_words(E'XMLHttpRequest'), array['xml', 'http', 'request'], 'words: XMLHttpRequest');
select is(raw.key_words(E's\u200bsn'), array['ssn'], 'words: zero-width characters are dropped');
select is(raw.key_words(''), '{}'::text[], 'words: empty key');

-- key length: over 256 characters fails closed before anything is normalised; an 80k-character key is cheap
select throws_ok(format('select raw.payload_has_forbidden_field(jsonb_build_object(%L, 1))', repeat('k', 257)),
                 '22023', 'raw.source_records: payload has a key that is too long', 'a 257-character key is refused (forbidden scan)');
select throws_ok(format('select raw.payload_has_body_field(jsonb_build_object(%L, 1))', repeat('k', 257)),
                 '22023', null, 'a 257-character key is refused (body scan)');
select lives_ok(format('select raw.payload_has_forbidden_field(jsonb_build_object(%L, 1))', repeat('k', 256)), 'a 256-character key is accepted');
select throws_ok(format('select raw.payload_has_forbidden_field(jsonb_build_object(%L, 1))', repeat(E'\U0001F600', 257)),
                 '22023', null, 'the limit counts characters, not bytes (257 emoji refused)');
select lives_ok(format('select raw.payload_has_forbidden_field(jsonb_build_object(%L, 1))', repeat(E'\U0001F600', 256)), '256 emoji are accepted');
create temp table t_long_start as select clock_timestamp() as t;
select throws_ok(format('select raw.payload_has_forbidden_field(jsonb_build_object(%L, 1))', repeat('A', 80000)),
                 '22023', null, 'an 80k uppercase key is refused');
select throws_ok(format('select raw.payload_has_forbidden_field(jsonb_build_object(%L, 1))', repeat('aB', 40000)),
                 '22023', null, 'an 80k camel key is refused');
select ok(clock_timestamp() - (select t from t_long_start) < interval '500 milliseconds', 'long keys are refused quickly (no quadratic regex)');

-- key cap and cost: 20000 distinct keys is the limit; a wide payload is cheap
select throws_ok($$select raw.payload_has_forbidden_field((select jsonb_object_agg('k' || g, 1) from generate_series(1, 20001) g))$$,
                 '22023', 'raw.source_records: payload has too many distinct keys', 'more than 20000 distinct keys fails closed (forbidden scan)');
select throws_ok($$select raw.payload_has_body_field((select jsonb_object_agg('k' || g, 1) from generate_series(1, 20001) g))$$,
                 '22023', null, 'more than 20000 distinct keys fails closed (body scan)');
select lives_ok($$select raw.payload_has_forbidden_field((select jsonb_object_agg('k' || g, 1) from generate_series(1, 20000) g))$$,
                'exactly 20000 distinct keys is accepted');
create temp table t_scan_start as select clock_timestamp() as t;
select ok(not raw.payload_has_forbidden_field((select jsonb_object_agg('field' || g || 'Name', g) from generate_series(1, 5000) g), 'google')
          and not raw.payload_has_body_field((select jsonb_object_agg('field' || g || 'Name', g) from generate_series(1, 5000) g)),
          'a 5000-key payload is clean');
select ok(clock_timestamp() - (select t from t_scan_start) < interval '3 seconds', 'a 5000-key payload is scanned in well under 3 seconds');

-- ---------------------------------------------------------------- fixtures (service_role is the real writer)
set local role service_role;
insert into core.connections (id, lane_id, provider, external_account_id, status) values
  ('00000000-0000-4000-8000-000000000391', 'PKG', 'quickbooks', 'realm-synthetic-39', 'active'),
  ('00000000-0000-4000-8000-000000000392', 'PKG', 'google', 'mailbox-synthetic-39', 'active'),
  ('00000000-0000-4000-8000-000000000393', 'APK', 'quickbooks', 'realm-synthetic-39b', 'active'),
  ('00000000-0000-4000-8000-000000000394', 'PKG', 'quickbooks', 'realm-synthetic-39c', 'reconnect_required'),
  ('00000000-0000-4000-8000-000000000395', 'PKG', 'stripe', 'acct-synthetic-39d', 'degraded'),
  ('00000000-0000-4000-8000-000000000396', 'PKG', 'timesolv', 'firm-synthetic-39', 'active');

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
  '[{"object_type": "Invoice", "external_id": "inv-1", "payload": {"Id": "inv-1", "TotalAmt": "250.00"}, "source_updated_at": "2026-11-02T10:00:00Z", "deleted": true, "synced_at": "2026-11-03T10:00:00Z"}]'),
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
  '22023', null, 'a payload over 1 MB is refused by our own check (no constraint DETAIL)');
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

-- ---------------------------------------------------------------- validation (own errors, no payload in the message)
set local role service_role;
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391', '["not an object"]')$$, '22023', null, 'a non-object element is refused');
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Invoice", "external_id": "x", "payload": [1], "synced_at": "2026-11-03T10:00:00Z"}]')$$, '22023', null, 'a non-object payload is refused');
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "1bad type", "external_id": "x", "payload": {}, "synced_at": "2026-11-03T10:00:00Z"}]')$$, '22023', null, 'a bad object_type is refused');
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Invoice", "external_id": "", "payload": {}, "synced_at": "2026-11-03T10:00:00Z"}]')$$, '22023', null, 'an empty external_id is refused');
select throws_ok(format($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Invoice", "external_id": "%s", "payload": {}, "synced_at": "2026-11-03T10:00:00Z"}]')$$, repeat('e', 257)),
  '22023', null, 'an over-long external_id is refused');
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Invoice", "external_id": "x", "payload": {}}]')$$, '22023', null, 'a missing synced_at is refused');
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Invoice", "external_id": "x", "payload": {}, "synced_at": "SECRET-not-a-time"}]')$$, '22023', null, 'a bad timestamp is refused');
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Invoice", "external_id": "x", "payload": {}, "deleted": "yes", "synced_at": "2026-11-03T10:00:00Z"}]')$$, '22023', null, 'a non-boolean deleted is refused');
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Invoice", "external_id": "x", "payload": {"secretvalue": "SYNTH-LEAK-1"}, "synced_at": "SECRET-not-a-time"}]')$$,
  '22023', 'record 1: a timestamp is invalid', 'the error text carries no payload or input value');
select throws_ok(format($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391', %L::jsonb)$$,
  (select jsonb_agg(jsonb_build_object('object_type', 'T', 'external_id', 'e' || g, 'payload', '{}'::jsonb, 'synced_at', '2026-11-03T10:00:00Z'))::text
   from generate_series(1, 1001) g)),
  '54000', null, 'more than 1000 records in one call is refused');
reset role;

-- timestamps: ISO-8601 with an offset, finite
select throws_ok(format($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Invoice", "external_id": "x", "payload": {}, "synced_at": %s}]')$$, to_json(v)::text),
  '22023', 'record 1: a timestamp is invalid', 'synced_at refused: ' || v)
from unnest(array['infinity', '-infinity', 'now', 'epoch', 'today', 'tomorrow', 'yesterday', 'allballs', '2026-11-03', '2026-11-03 10:00:00',
                  '2026-11-03T10:00:00', 'November 3 2026 10:00 UTC', '2026-13-03T10:00:00Z']) as v;
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Invoice", "external_id": "x", "payload": {}, "source_updated_at": "infinity", "synced_at": "2026-11-03T10:00:00Z"}]')$$,
  '22023', 'record 1: a timestamp is invalid', 'source_updated_at infinity is refused');
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Invoice", "external_id": "x", "payload": {}, "source_updated_at": "epoch", "synced_at": "2026-11-03T10:00:00Z"}]')$$,
  '22023', null, 'source_updated_at epoch is refused');
select lives_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Invoice", "external_id": "ts1", "payload": {}, "source_updated_at": "2026-11-03T10:00:00.123+05:30", "synced_at": "2026-11-03T10:00:00Z"}]')$$,
  'ISO-8601 with fractional seconds and an offset is accepted');

-- a null source_updated_at does not overwrite a row that has one (it is skipped); it can replace a row without one
select is(core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Invoice", "external_id": "inv-1", "payload": {"Id": "inv-1", "TotalAmt": "999.00"}, "synced_at": "2026-11-04T10:00:00Z"}]'),
  0, 'a record with no source_updated_at does not overwrite one that has it');
reset role;
select is((select payload ->> 'TotalAmt' from raw.source_records where external_id = 'inv-1'), '250.00', 'the stored payload is unchanged');
set local role service_role;
select is(core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Invoice", "external_id": "inv-2", "payload": {"Id": "inv-2", "TotalAmt": "5.00"}, "synced_at": "2026-11-04T10:00:00Z"}]'),
  1, 'a record with no source_updated_at replaces a row that has none');
select lives_ok(format($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391', %L::jsonb)$$,
  (select jsonb_build_array(jsonb_build_object('object_type', 'Wide', 'external_id', 'w1', 'synced_at', '2026-11-03T10:00:00Z',
     'payload', (select jsonb_object_agg('field' || g || 'Name', g) from generate_series(1, 5000) g)))::text)),
  'a 5000-key payload is stored (single scan, fast)');
select throws_ok(format($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391', %L::jsonb)$$,
  (select jsonb_build_array(jsonb_build_object('object_type', 'Wide', 'external_id', 'w2', 'synced_at', '2026-11-03T10:00:00Z',
     'payload', (select jsonb_object_agg('f' || g, g) from generate_series(1, 20001) g)))::text)),
  '22023', 'raw.source_records: payload has too many distinct keys', 'more than 20000 distinct keys is refused at write time');
reset role;

-- ---------------------------------------------------------------- forbidden-data guard (every provider)
set local role service_role;
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Customer", "external_id": "c1", "payload": {"Id": "c1", "Nested": [{"AcctNum": "SYNTH-123"}]}, "synced_at": "2026-11-03T10:00:00Z"}]')$$,
  '22023', 'raw.source_records: payload contains a field that must not be stored', 'a finance payload with a bank identifier key is refused, nothing echoed');
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000396',
  '[{"object_type": "TimeEntry", "external_id": "t1", "payload": {"id": "t1", "billRate": "250.00"}, "synced_at": "2026-11-03T10:00:00Z"}]')$$,
  '22023', null, 'a rate key is refused for timesolv');
reset role;
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Customer", "external_id": "c2", "payload": {"Id": "c2", "bank": {"routing": "SYNTH", "account": "SYNTH"}}, "synced_at": "2026-11-03T10:00:00Z"}]')$$,
  '22023', null, 'a nested routing key is refused at write time');
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000396',
  '[{"object_type": "TimeEntry", "external_id": "t4", "payload": {"id": "t4", "Rate": "250.00"}, "synced_at": "2026-11-03T10:00:00Z"}]')$$,
  '22023', null, 'a bare Rate key is refused for timesolv at write time');
select lives_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Customer", "external_id": "c3", "payload": {"Id": "c3", "SyncToken": "0", "Rate": 1}, "synced_at": "2026-11-03T10:00:00Z"}]')$$,
  'SyncToken and a bare Rate (non-timesolv) are stored');
select is((select count(*)::int from raw.source_records where external_id in ('c1', 't1', 'c2', 't4')), 0, 'nothing was stored');

-- ---------------------------------------------------------------- content providers added in this revision
set local role service_role;
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000396',
  '[{"object_type": "TimeEntry", "external_id": "t2", "payload": {"id": "t2", "narrative": "synthetic"}, "synced_at": "2026-11-03T10:00:00Z"}]')$$,
  '42501', null, 'a timesolv narrative is refused while store_content_bodies is false');
select lives_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000396',
  '[{"object_type": "TimeEntry", "external_id": "t3", "payload": {"id": "t3", "hours": "1.50"}, "synced_at": "2026-11-03T10:00:00Z"}]')$$,
  'timesolv metadata is stored');
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000392',
  '[{"object_type": "message", "external_id": "m9", "payload": {"id": "m9", "bodyContent": "x"}, "synced_at": "2026-11-03T10:00:00Z"}]')$$,
  '42501', null, 'a substring-style body key is refused (bodyContent)');
reset role;

-- ---------------------------------------------------------------- connection status and lane enabled
set local role service_role;
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000394',
  '[{"object_type": "Invoice", "external_id": "x", "payload": {}, "synced_at": "2026-11-03T10:00:00Z"}]')$$,
  '42501', 'connection not found in this lane', 'a reconnect_required connection is refused with the same error');
select lives_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000395',
  '[{"object_type": "Charge", "external_id": "ch1", "payload": {"id": "ch1"}, "synced_at": "2026-11-03T10:00:00Z"}]')$$,
  'a degraded connection is accepted');
reset role;
update core.lanes set enabled = false where code = 'PKG';
set local role service_role;
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Invoice", "external_id": "x", "payload": {}, "synced_at": "2026-11-03T10:00:00Z"}]')$$,
  '42501', 'connection not found in this lane', 'a disabled lane is refused with the same error');
reset role;
update core.lanes set enabled = true where code = 'PKG';

-- ---------------------------------------------------------------- ordering guard, unchanged hash, direct UPDATE
set local role service_role;
select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Order", "external_id": "o1", "payload": {"v": "new"}, "source_updated_at": "2026-11-05T00:00:00Z", "synced_at": "2026-11-05T01:00:00Z"}]');
select is(core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Order", "external_id": "o1", "payload": {"v": "old"}, "source_updated_at": "2026-11-01T00:00:00Z", "synced_at": "2026-11-05T02:00:00Z"}]'),
  0, 'a stale (older source_updated_at) overwrite is skipped and not counted');
reset role;
select is((select payload ->> 'v' from raw.source_records where external_id = 'o1'), 'new', 'the newer payload is kept');
select is((select synced_at from raw.source_records where external_id = 'o1'), '2026-11-05T01:00:00Z'::timestamptz, 'synced_at was not touched by the skipped write');
set local role service_role;
select is(core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Order", "external_id": "o1", "payload": {"v": "newer"}, "source_updated_at": "2026-11-06T00:00:00Z", "synced_at": "2026-11-06T01:00:00Z"}]'),
  1, 'a newer version overwrites');
reset role;
create temp table h0 as select payload_hash from raw.source_records where external_id = 'o1';
set local role service_role;
select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Order", "external_id": "o1", "payload": {"v": "newer"}, "source_updated_at": "2026-11-06T00:00:00Z", "synced_at": "2026-11-06T02:00:00Z"}]');
reset role;
select is((select payload_hash from raw.source_records where external_id = 'o1'), (select payload_hash from h0), 'an identical re-upsert keeps the same hash');
select is((select count(*)::int from raw.source_records where external_id = 'o1'), 1, 'and still one row');

update raw.source_records set payload = '{"v": "direct"}' where external_id = 'o1';
select is((select payload_hash from raw.source_records where external_id = 'o1'),
          encode(sha256(convert_to('{"v": "direct"}', 'UTF8')), 'hex'), 'a direct UPDATE goes through the trigger (hash recomputed)');
update raw.source_records set deleted = true where external_id = 'o1';
select ok((select deleted from raw.source_records where external_id = 'o1'), 'an update that leaves the payload unchanged skips the guard scan and works');
select throws_ok($$update raw.source_records set payload = '{"salary": 1}' where external_id = 'o1'$$, '22023', null,
                 'a direct UPDATE with a forbidden key is refused by the trigger');
select throws_ok($$update raw.source_records set provider = 'google', payload = '{"body": "x"}' where external_id = 'o1'$$, '42501', null,
                 'a direct UPDATE to a content provider with a body is refused by the trigger');

-- ---------------------------------------------------------------- deletions and in-batch ordering (round 3)
set local role service_role;
select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Del", "external_id": "d1", "payload": {"v": 1}, "source_updated_at": "2026-11-05T00:00:00Z", "synced_at": "2026-11-05T01:00:00Z"}]');
select is(core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Del", "external_id": "d1", "payload": {"v": 1}, "deleted": true, "synced_at": "2026-11-05T02:00:00Z"}]'),
  1, 'an undated deletion is applied over a dated row');
reset role;
select ok((select deleted from raw.source_records where external_id = 'd1'), 'the deletion marker is stored');
select is((select source_updated_at from raw.source_records where external_id = 'd1'), '2026-11-05T00:00:00Z'::timestamptz,
          'an undated deletion keeps the stored provider time');
set local role service_role;
select is(core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Del", "external_id": "d1", "payload": {"v": 0}, "source_updated_at": "2026-11-01T00:00:00Z", "synced_at": "2026-11-05T03:00:00Z"}]'),
  0, 'a late older update does not undo the deletion');
select is(core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Del", "external_id": "d1", "payload": {"v": 0}, "deleted": true, "source_updated_at": "2026-11-01T00:00:00Z", "synced_at": "2026-11-05T03:00:00Z"}]'),
  0, 'a dated deletion older than the stored version is skipped');
select is(core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Del", "external_id": "d2", "payload": {"v": 1}, "deleted": true, "synced_at": "2026-11-05T02:00:00Z"}]'),
  1, 'an undated deletion of an unseen object is stored');
select is(core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Del", "external_id": "d2", "payload": {"v": 2}, "deleted": true, "synced_at": "2026-11-05T03:00:00Z"}]'),
  1, 'an undated deletion over an undated row is applied');
-- in one batch the newest provider version wins, whatever the element order
select is(core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Ord", "external_id": "b1", "payload": {"v": "newer"}, "source_updated_at": "2026-11-05T00:00:00Z", "synced_at": "2026-11-05T01:00:00Z"},
    {"object_type": "Ord", "external_id": "b1", "payload": {"v": "older"}, "source_updated_at": "2026-11-01T00:00:00Z", "synced_at": "2026-11-05T01:00:01Z"}]'),
  1, 'two versions of one object in a batch write one row');
reset role;
select is((select payload ->> 'v' from raw.source_records where external_id = 'b1' and object_type = 'Ord'), 'newer',
          'the newer version wins even when listed first');
set local role service_role;
select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Ord", "external_id": "b2", "payload": {"v": "undated"}, "synced_at": "2026-11-05T01:00:00Z"},
    {"object_type": "Ord", "external_id": "b2", "payload": {"v": "dated"}, "source_updated_at": "2026-11-01T00:00:00Z", "synced_at": "2026-11-05T01:00:01Z"},
    {"object_type": "Ord", "external_id": "b2", "payload": {"v": "tie-later"}, "source_updated_at": "2026-11-01T00:00:00Z", "synced_at": "2026-11-05T01:00:02Z"}]');
reset role;
select is((select payload ->> 'v' from raw.source_records where external_id = 'b2' and object_type = 'Ord'), 'tie-later',
          'undated versions rank last; equal times fall back to the later element');

-- replay of an update after an undated deletion must not undo it; a strictly newer update may restore
set local role service_role;
select is(core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Inv", "external_id": "r1", "payload": {"v": 1}, "source_updated_at": "2026-11-01T10:00:00Z", "synced_at": "2026-11-05T01:00:00Z"}]'),
  1, 'a dated update is stored');
select is(core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Inv", "external_id": "r1", "payload": {"v": 1}, "deleted": true, "synced_at": "2026-11-05T02:00:00Z"}]'),
  1, 'an undated deletion applies');
select is(core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Inv", "external_id": "r1", "payload": {"v": 1}, "source_updated_at": "2026-11-01T10:00:00Z", "synced_at": "2026-11-05T03:00:00Z"}]'),
  0, 'a replay of the same update after the deletion is skipped');
reset role;
select is((select deleted from raw.source_records where external_id = 'r1' and object_type = 'Inv'), true,
          'the object stays deleted after the replay');
set local role service_role;
select is(core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Inv", "external_id": "r1", "payload": {"v": 2}, "source_updated_at": "2026-11-02T10:00:00Z", "synced_at": "2026-11-05T04:00:00Z"}]'),
  1, 'a strictly newer dated update after a deletion is applied (restored object)');
reset role;
select is((select deleted from raw.source_records where external_id = 'r1' and object_type = 'Inv'), false,
          'a strictly newer update un-deletes (intended)');
set local role service_role;
select is(core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Inv", "external_id": "r2", "payload": {"v": 1}, "source_updated_at": "2026-11-01T10:00:00Z", "synced_at": "2026-11-05T01:00:00Z"},
    {"object_type": "Inv", "external_id": "r2", "payload": {"v": 1}, "deleted": true, "synced_at": "2026-11-05T01:00:01Z"}]'),
  1, 'a batch of a dated update and an undated deletion writes one row');
reset role;
select is((select deleted from raw.source_records where external_id = 'r2' and object_type = 'Inv'), true,
          'in one batch an undated deletion beats a dated update (matches cross-batch)');

-- a key literally named !deep is stored (it is not the deep-nesting marker)
set local role service_role;
select lives_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Odd", "external_id": "k1", "payload": {"!deep": 1}, "synced_at": "2026-11-05T01:00:00Z"}]')$$,
  'a payload with a key named !deep is stored');
select throws_ok(format($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391', %L::jsonb)$$,
  jsonb_build_array(jsonb_build_object('object_type', 'Odd', 'external_id', 'k2', 'synced_at', '2026-11-05T01:00:00Z',
    'payload', jsonb_build_object(repeat('k', 257), 1)))::text),
  '22023', 'raw.source_records: payload has a key that is too long', 'a key over 256 characters is refused at write time');
select lives_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Odd", "external_id": "k3", "payload": {}, "source_updated_at": "2026-11-05T01:00:00.123456789Z", "synced_at": "2026-11-05T01:00:00Z"}]')$$,
  'nine fractional digits are accepted');
select throws_ok($$select core.source_records_upsert('PKG', '00000000-0000-4000-8000-000000000391',
  '[{"object_type": "Odd", "external_id": "k4", "payload": {}, "source_updated_at": "2026-11-05T01:00:00.1234567890Z", "synced_at": "2026-11-05T01:00:00Z"}]')$$,
  '22023', 'record 1: a timestamp is invalid', 'ten fractional digits are refused (the TypeScript store agrees)');
reset role;
select is((select count(*)::int from raw.source_records where external_id in ('k1')), 1, 'the !deep payload is in the table');

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
