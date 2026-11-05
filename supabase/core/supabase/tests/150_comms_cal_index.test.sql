-- Comms and calendar index tables (T-061): no body-like columns (rule 6), summary needs an approval marker, people
-- lists carry addresses and names only, same-lane connection FK, idempotent upsert keys, the standard lane policies
-- ('comms' / 'calendar' views), role matrix, cross-lane denial, service_role-only writes and the retention purges.
begin;
select plan(164);
\ir helpers/lane_rls.psql

-- ---------------------------------------------------------------- structure
select has_table('comms', 'message_index', 'comms.message_index exists');
select has_table('cal', 'event_index', 'cal.event_index exists');
select pg_temp.has_standard_lane_policy('comms.message_index'::regclass, 'comms');
select pg_temp.has_standard_lane_policy('cal.event_index'::regclass, 'calendar');
select ok(not has_schema_privilege('anon', s, 'usage') and has_schema_privilege('authenticated', s, 'usage') and has_schema_privilege('service_role', s, 'usage'),
          'schema ' || s || ': no anon usage; authenticated and service_role have usage') from unnest(array['comms', 'cal']) s;
select ok(has_table_privilege('service_role', t::regclass, 'select, insert, update, delete') and not has_table_privilege('service_role', t::regclass, 'truncate'),
          'service_role reads, writes and deletes ' || t || ' but cannot truncate')
from unnest(array['comms.message_index', 'cal.event_index']) t;

-- ---------------------------------------------------------------- no body-like column (rule 6)
create temp table idx_cols on commit drop as
  select format('%s.%s', c.relname, a.attname) as col, a.attname::text as attname, a.atttypid, format_type(a.atttypid, a.atttypmod) as typ
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
  where ((n.nspname = 'comms' and c.relname = 'message_index') or (n.nspname = 'cal' and c.relname = 'event_index'))
    and a.attnum > 0 and not a.attisdropped;
select is(
  (select array_agg(col order by col) from idx_cols
   where regexp_replace(lower(attname), '[^a-z0-9]', '', 'g') ~
     '(body|snippet|content|description|preview|excerpt|text|html|raw|payload|message$|notes?$|attachment(data|content)|mime|eml|plain)'
     and attname not in ('message_id')),
  null, 'no body, snippet, content, description, preview, html, raw or payload column in either index');
select is(
  (select array_agg(col order by col) from idx_cols
   where raw.payload_has_body_field(jsonb_build_object(attname, 1)) and attname <> 'summary'),
  null, 'the raw schema''s body-field detector flags no column (summary is the one reviewed exception)');
select is(
  (select array_agg(col order by col) from idx_cols where attname ~* '(token|secret|password|credential)'),
  null, 'no credential-like column');
select hasnt_column('comms', 'message_index', c, 'message_index has no ' || c)
from unnest(array['body', 'body_text', 'body_html', 'snippet', 'content', 'preview', 'text', 'html', 'raw', 'payload', 'description']) c;
select hasnt_column('cal', 'event_index', c, 'event_index has no ' || c)
from unnest(array['body', 'body_text', 'body_html', 'description', 'snippet', 'content', 'notes', 'preview', 'raw', 'payload']) c;
select is((select count(*)::int from idx_cols where col like 'message_index.%' and attname = 'summary'), 1, 'message_index has the optional summary');
select is((select count(*)::int from idx_cols where typ = 'timestamp without time zone'), 0, 'no timezone-less timestamps');
select is((select array_agg(col order by col) from idx_cols where attname ~ '_at$' and typ <> 'timestamp with time zone'), null, 'every *_at column is timestamptz');

select has_column('comms', 'message_index', c, 'message_index has ' || c)
from unnest(array['lane_id', 'connection_id', 'provider', 'message_id', 'thread_id', 'source_url', 'from_address', 'from_name', 'to_recipients', 'cc_recipients',
                  'subject', 'received_at', 'is_read', 'is_starred', 'is_important', 'has_attachments', 'folder', 'labels', 'priority_score', 'needs_reply',
                  'category', 'commitment_candidate', 'classifier_model', 'classifier_version', 'classified_at', 'summary', 'summary_approved_at', 'summary_approved_by']) c;
select has_column('cal', 'event_index', c, 'event_index has ' || c)
from unnest(array['lane_id', 'connection_id', 'provider', 'calendar_id', 'event_id', 'source_url', 'title', 'location', 'organizer_email', 'start_at', 'end_at',
                  'all_day', 'start_date', 'end_date', 'timezone', 'attendees', 'status', 'recurring_event_id', 'original_start_at', 'online_meeting_url']) c;

-- ---------------------------------------------------------------- fixtures
update core.lanes set enabled = true where code = 'APK';
insert into core.connections (id, lane_id, provider, external_account_id, status) values
  ('00000000-0000-4000-8000-000000000611', 'PKG', 'google', 'exec-synthetic@example.test', 'active'),
  ('00000000-0000-4000-8000-000000000612', 'APK', 'google', 'apk-synthetic@example.test', 'active'),
  ('00000000-0000-4000-8000-000000000613', 'PKG', 'quickbooks', 'realm-synthetic-61', 'active'),
  ('00000000-0000-4000-8000-000000000614', 'PKG', 'microsoft', 'exec-synthetic-ms@example.test', 'active');
set local role service_role;
insert into comms.message_index (lane_id, connection_id, provider, message_id, thread_id, from_address, from_name, to_recipients, subject, received_at, priority_score, classified_at, classifier_model)
values ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'm-1', 't-1', 'a@example.test', 'A Sender',
        '[{"address": "exec-synthetic@example.test", "name": "Exec"}]', 'Synthetic subject', now() - interval '1 day', 80, now(), 'synthetic-model');
insert into comms.message_index (lane_id, connection_id, provider, message_id, from_address, subject, received_at)
values ('APK', '00000000-0000-4000-8000-000000000612', 'google', 'm-1', 'b@example.test', 'Other lane', now() - interval '1 day');
insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, title, start_at, end_at, attendees)
values ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'primary', 'e-1', 'Synthetic meeting', now() + interval '1 day', now() + interval '1 day 1 hour',
        '[{"email": "a@example.test", "name": "A", "response": "accepted"}]');
insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, title, start_at, end_at)
values ('APK', '00000000-0000-4000-8000-000000000612', 'google', 'primary', 'e-1', 'Other lane meeting', now() + interval '1 day', now() + interval '2 days');
reset role;

-- ---------------------------------------------------------------- keys and same-lane connection
set local role service_role;
select throws_ok($$insert into comms.message_index (lane_id, connection_id, provider, message_id, received_at) values ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'm-1', now())$$,
                 '23505', null, 'a provider message id is unique per (lane, connection)');
select lives_ok($$insert into comms.message_index (lane_id, connection_id, provider, message_id, received_at) values ('PKG', '00000000-0000-4000-8000-000000000614', 'microsoft', 'm-1', now())$$,
                'the same message id on another connection is a different row');
select lives_ok($$insert into comms.message_index (lane_id, connection_id, provider, message_id, received_at, subject)
                   values ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'm-1', now(), 'upserted')
                   on conflict (lane_id, connection_id, message_id) do update set subject = excluded.subject$$, 'idempotent upsert on the unique key works');
select is((select subject from comms.message_index where lane_id = 'PKG' and message_id = 'm-1' and connection_id = '00000000-0000-4000-8000-000000000611'), 'upserted', 'the upsert updated the row');
select throws_ok($$insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, start_at, end_at) values ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'primary', 'e-1', now(), now())$$,
                 '23505', null, 'an event id is unique per (lane, connection, calendar)');
select lives_ok($$insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, start_at, end_at) values ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'work', 'e-1', now(), now())$$,
                'the same event id in another calendar is a different row');
select throws_ok($$insert into comms.message_index (lane_id, connection_id, provider, message_id, received_at) values ('PKG', '00000000-0000-4000-8000-000000000612', 'google', 'x', now())$$,
                 '23503', null, 'cross-lane: a message cannot use another lane''s connection');
select throws_ok($$insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, start_at, end_at) values ('APK', '00000000-0000-4000-8000-000000000611', 'google', 'p', 'x', now(), now())$$,
                 '23503', null, 'cross-lane: an event cannot use another lane''s connection');
select throws_ok($$insert into comms.message_index (lane_id, connection_id, provider, message_id, received_at) values ('PKG', '00000000-0000-4000-8000-000000000613', 'quickbooks', 'x', now())$$,
                 '23514', null, 'a QuickBooks connection cannot hold messages (provider check)');
select throws_ok($$insert into comms.message_index (lane_id, connection_id, provider, message_id, received_at) values ('PKG', '00000000-0000-4000-8000-000000000614', 'google', 'x', now())$$,
                 '23503', null, 'provider must match the connection''s provider');
select throws_ok($$insert into comms.message_index (lane_id, connection_id, provider, message_id, received_at) values ('ZZZ', '00000000-0000-4000-8000-000000000611', 'google', 'x', now())$$,
                 '23503', null, 'an unknown lane is refused');

-- ---------------------------------------------------------------- summary needs approval; classification shape
select throws_ok($$update comms.message_index set summary = 'A summary' where message_id = 'm-1' and lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000000611'$$,
                 '23514', null, 'a summary without an approval marker is refused');
select throws_ok($$update comms.message_index set summary_approved_at = now(), summary_approved_by = (select id from core.users limit 1) where message_id = 'm-1' and lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000000611'$$,
                 '23514', null, 'an approval marker without a summary is refused');
select lives_ok($$update comms.message_index set summary = 'A summary', summary_approved_at = now(), summary_approved_by = pg_temp.uid('owner@example.test') where message_id = 'm-1' and lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000000611'$$,
                'a summary with its approval marker is accepted');
select throws_ok($$update comms.message_index set summary_approved_by = '00000000-0000-4000-8000-0000000000ff' where message_id = 'm-1' and lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000000611'$$,
                 '23514', null, 'the approver must be a real user (a member of the lane)');
select throws_ok($$update comms.message_index set classified_at = null where message_id = 'm-1' and lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000000611'$$,
                 '23514', null, 'a priority score without classification metadata is refused');
select throws_ok($$update comms.message_index set priority_score = 101 where message_id = 'm-1' and lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000000611'$$,
                 '23514', null, 'priority_score is 0..100');

-- ---------------------------------------------------------------- people lists: addresses and names only
select throws_ok($$update comms.message_index set to_recipients = '[{"address": "a@example.test", "body": "x"}]' where message_id = 'm-1' and lane_id = 'PKG'$$,
                 '23514', null, 'recipients cannot carry extra keys');
select throws_ok($$update comms.message_index set to_recipients = '{"address": "a@example.test"}' where message_id = 'm-1' and lane_id = 'PKG'$$,
                 '23514', null, 'recipients must be an array');
select throws_ok($$update comms.message_index set cc_recipients = '[{"name": "no address"}]' where message_id = 'm-1' and lane_id = 'PKG'$$,
                 '23514', null, 'a recipient needs an address');
select throws_ok($$update comms.message_index set to_recipients = '["a@example.test"]' where message_id = 'm-1' and lane_id = 'PKG'$$,
                 '23514', null, 'recipients must be objects');
select throws_ok($$update cal.event_index set attendees = '[{"email": "a@example.test", "notes": "x"}]' where event_id = 'e-1' and calendar_id = 'primary' and lane_id = 'PKG'$$,
                 '23514', null, 'attendees cannot carry extra keys');
select throws_ok($$update cal.event_index set attendees = '[{"email": "a@example.test", "response": "maybe"}]' where event_id = 'e-1' and calendar_id = 'primary' and lane_id = 'PKG'$$,
                 '23514', null, 'attendee response must be a known value');
select throws_ok($$update comms.message_index set source_url = 'javascript:alert(1)' where message_id = 'm-1' and lane_id = 'PKG'$$,
                 '23514', null, 'source links are https only');
select throws_ok($$update cal.event_index set online_meeting_url = 'http://meet.example.test/x' where event_id = 'e-1' and calendar_id = 'primary' and lane_id = 'PKG'$$,
                 '23514', null, 'meeting links are https only');
select throws_ok($$update cal.event_index set end_at = start_at - interval '1 minute' where event_id = 'e-1' and calendar_id = 'primary' and lane_id = 'PKG'$$,
                 '23514', null, 'an event cannot end before it starts');
select throws_ok($$update cal.event_index set status = 'deleted' where event_id = 'e-1' and calendar_id = 'primary' and lane_id = 'PKG'$$,
                 '23514', null, 'event status is a known value');

-- ---------------------------------------------------------------- identity is frozen
select throws_ok($$update comms.message_index set lane_id = 'APK' where message_id = 'm-1' and lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000000611'$$,
                 '42501', null, 'a message cannot change lane');
select throws_ok($$update comms.message_index set message_id = 'm-9' where message_id = 'm-1' and lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000000611'$$,
                 '42501', null, 'a message cannot change provider id');
select throws_ok($$update cal.event_index set connection_id = '00000000-0000-4000-8000-000000000614' where event_id = 'e-1' and calendar_id = 'primary' and lane_id = 'PKG'$$,
                 '42501', null, 'an event cannot change connection');
reset role;
select has_trigger('comms', 'message_index', 'message_index_set_updated_at', 'message_index maintains updated_at');
select has_trigger('cal', 'event_index', 'event_index_set_updated_at', 'event_index maintains updated_at');
select ok(not has_function_privilege('authenticated', 'core.forbid_identity_change()', 'execute')
          and not has_function_privilege('anon', 'core.forbid_identity_change()', 'execute')
          and not has_function_privilege('authenticated', 'comms.message_summary_guard()', 'execute')
          and not has_function_privilege('authenticated', 'comms.labels_ok(text[])', 'execute')
          and not has_function_privilege('authenticated', 'comms.recipients_ok(jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'cal.attendees_ok(jsonb)', 'execute')
          and not has_function_privilege('anon', 'comms.recipients_ok(jsonb)', 'execute'),
          'helper and trigger functions are not callable by API roles');

-- ---------------------------------------------------------------- roles, AAL and cross-lane denial
create function pg_temp.visible() returns jsonb language sql as $$
  select jsonb_build_object('messages', (select count(*) from comms.message_index), 'events', (select count(*) from cal.event_index));
$$;
create function pg_temp.visible_lanes() returns text[] language sql as $$
  select array(select distinct lane_id from (select lane_id from comms.message_index union all select lane_id from cal.event_index) x order by 1);
$$;
grant execute on function pg_temp.visible(), pg_temp.visible_lanes() to authenticated, anon;

-- the viewer persona is given the named 'calendar' view for the test ('comms' is not a viewer-grantable view: owner only)
update core.memberships set views = array['calendar']::text[] where user_id = pg_temp.uid('viewer@example.test') and lane_id = 'PKG';

select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible_lanes(), array['APK', 'PKG'], 'owner reads both enabled lanes');
reset role;
update core.lanes set enabled = false where code = 'APK';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible_lanes(), array['PKG'], 'a disabled lane is not readable even by the owner');
select is((pg_temp.visible() ->> 'messages')::int, 2, 'owner reads the PKG messages (two connections) and nothing of APK');
reset role;
update core.lanes set enabled = true where code = 'APK';

select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible(), '{"messages": 0, "events": 2}'::jsonb, 'a viewer with the calendar view reads PKG events only (APK denied) and no messages');
reset role;
select pg_temp.claims('viewer@example.test', 'aal1');
set local role authenticated;
select is(pg_temp.visible(), '{"messages": 0, "events": 0}'::jsonb, 'AAL1 reads nothing');
reset role;
update core.memberships set views = array[]::text[] where user_id = pg_temp.uid('viewer@example.test') and lane_id = 'PKG';
select pg_temp.claims('viewer@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible(), '{"messages": 0, "events": 0}'::jsonb, 'a viewer without the named views reads nothing');
reset role;

select pg_temp.claims(p, 'aal2') from unnest(array['finance-operator@example.test']) p;
set local role authenticated;
select is(pg_temp.visible(), '{"messages": 0, "events": 0}'::jsonb, 'finance_operator has neither comms nor calendar view');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible(), '{"messages": 0, "events": 0}'::jsonb, 'admin_technical reads no mail or calendar metadata');
reset role;
select pg_temp.claims('outsider@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible(), '{"messages": 0, "events": 0}'::jsonb, 'an outsider reads nothing');
reset role;
set local role anon;
select throws_ok($$select count(*) from comms.message_index$$, '42501', null, 'anon cannot read message_index');
select throws_ok($$select count(*) from cal.event_index$$, '42501', null, 'anon cannot read event_index');
reset role;

-- authenticated has no write path
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select throws_ok($$insert into comms.message_index (lane_id, connection_id, provider, message_id, received_at) values ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'z', now())$$,
                 '42501', null, 'authenticated cannot insert messages');
select throws_ok($$update comms.message_index set subject = 'x'$$, '42501', null, 'authenticated cannot update messages');
select throws_ok($$delete from cal.event_index$$, '42501', null, 'authenticated cannot delete events');
select throws_ok($$insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, start_at, end_at) values ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'p', 'z', now(), now())$$,
                 '42501', null, 'authenticated cannot insert events');
select throws_ok($$select comms.message_index_purge('PKG')$$, '42501', null, 'authenticated cannot run the message purge');
select throws_ok($$select cal.event_index_purge('PKG')$$, '42501', null, 'authenticated cannot run the event purge');
reset role;

-- ---------------------------------------------------------------- retention purge
-- Age rows past the 90 / 30 day marks (replica mode skips the identity and updated_at triggers).
set local session_replication_role = replica;
insert into comms.message_index (lane_id, connection_id, provider, message_id, received_at) values
  ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'old-60', now() - interval '60 days'),
  ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'old-100', now() - interval '100 days'),
  ('APK', '00000000-0000-4000-8000-000000000612', 'google', 'old-60', now() - interval '60 days');
insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, start_at, end_at) values
  ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'primary', 'old-170', now() - interval '170 days', now() - interval '170 days'),
  ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'primary', 'old-200', now() - interval '200 days', now() - interval '200 days'),
  ('APK', '00000000-0000-4000-8000-000000000612', 'google', 'primary', 'old-200', now() - interval '200 days', now() - interval '200 days');
set local session_replication_role = origin;
update core.lane_policies set retention_days = 90 where lane_id = 'PKG';
update core.lane_policies set retention_days = 30 where lane_id = 'APK';

set local role service_role;
select is(comms.message_index_purge('PKG'), 1, 'PKG purge (policy 90 days) deletes only the 100-day-old message');
select is((select count(*)::int from comms.message_index where lane_id = 'PKG' and message_id = 'old-60'), 1, 'the 60-day-old PKG message is kept');
select is((select count(*)::int from comms.message_index where lane_id = 'APK'), 2, 'the PKG purge did not touch APK');
select is(comms.message_index_purge('APK'), 1, 'APK purge (policy 30 days) deletes the 60-day-old message');
select is(comms.message_index_purge('PKG', interval '10 days'), 1, 'an explicit shorter interval is honoured');
select throws_ok($$select comms.message_index_purge('PKG', interval '1 hour')$$, '22023', null, 'the message purge refuses under one day');
select throws_ok($$select comms.message_index_purge('ZZZ')$$, '22023', null, 'the message purge refuses a lane with no policy');
select throws_ok($$select comms.message_index_purge(null)$$, '22004', null, 'the message purge needs a lane');
select is(cal.event_index_purge('PKG'), 1, 'event purge (180 days) deletes only the 200-day-old event');
select is((select count(*)::int from cal.event_index where lane_id = 'PKG' and event_id = 'old-170'), 1, 'the 170-day-old event is kept');
select is((select count(*)::int from cal.event_index where lane_id = 'APK'), 2, 'the PKG event purge did not touch APK');
select throws_ok($$select cal.event_index_purge('PKG', interval '5 days')$$, '22023', null, 'the event purge refuses under 30 days');
reset role;
select ok(not has_function_privilege('anon', 'comms.message_index_purge(text, interval)', 'execute')
          and not has_function_privilege('anon', 'cal.event_index_purge(text, interval)', 'execute')
          and has_function_privilege('service_role', 'comms.message_index_purge(text, interval)', 'execute')
          and has_function_privilege('service_role', 'cal.event_index_purge(text, interval)', 'execute'),
          'purge functions are executable by service_role only');

-- ---------------------------------------------------------------- review fixes
-- events: cancelled stubs may lack times; all-day events carry dates (end exclusive)
select hasnt_column('cal', 'event_index', 'deleted', 'event_index has no deleted flag (status cancelled is the gone state)');
set local role service_role;
select lives_ok($$insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, status) values ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'primary', 'stub-1', 'cancelled')$$,
                'a cancelled stub without times is accepted');
select throws_ok($$insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id) values ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'primary', 'stub-2')$$,
                 '23514', null, 'a confirmed event without times is rejected');
select throws_ok($$insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, start_at, end_at, all_day) values ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'primary', 'ad-1', now(), now() + interval '1 day', true)$$,
                 '23514', null, 'an all-day event without dates is rejected');
select throws_ok($$insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, start_at, end_at, all_day, start_date, end_date) values ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'primary', 'ad-2', now(), now() + interval '1 day', true, '2026-11-05', '2026-11-05')$$,
                 '23514', null, 'an all-day event needs an exclusive end date after the start date');
select lives_ok($$insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, start_at, end_at, all_day, start_date, end_date, timezone) values ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'primary', 'ad-3', '2026-11-05 05:00+00', '2026-11-06 05:00+00', true, '2026-11-05', '2026-11-06', 'America/New_York')$$,
                'a valid all-day event is accepted');

-- summary guard: new approval for changed text, lane policy, approver membership
select throws_ok($$update comms.message_index set summary = 'Changed text' where message_id = 'm-1' and lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000000611'$$,
                 '23514', null, 'a changed summary with the old approval time is rejected');
select lives_ok($$update comms.message_index set summary = 'Changed text', summary_approved_at = clock_timestamp(), summary_approved_by = pg_temp.uid('owner@example.test') where message_id = 'm-1' and lane_id = 'PKG' and connection_id = '00000000-0000-4000-8000-000000000611'$$,
                'a changed summary with a new approval time is accepted');
select throws_ok($$update comms.message_index set summary = 'X', summary_approved_at = now(), summary_approved_by = pg_temp.uid('viewer@example.test') where message_id = 'm-1' and lane_id = 'APK' and connection_id = '00000000-0000-4000-8000-000000000612'$$,
                 '23514', null, 'cross-lane: an approver who is not a member of the lane is rejected');
reset role;
update core.lane_policies set llm_allowed_categories = array['finance']::text[] where lane_id = 'APK';
set local role service_role;
select throws_ok($$update comms.message_index set summary = 'X', summary_approved_at = now(), summary_approved_by = pg_temp.uid('owner@example.test') where message_id = 'm-1' and lane_id = 'APK' and connection_id = '00000000-0000-4000-8000-000000000612'$$,
                 '23514', null, 'a lane whose policy does not allow email is refused a summary');
select throws_ok($$insert into comms.message_index (lane_id, connection_id, provider, message_id, received_at, labels) values ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'lbl-1', now(), array[repeat('x', 257)])$$,
                 '23514', null, 'an oversized label is rejected');
select throws_ok($$insert into comms.message_index (lane_id, connection_id, provider, message_id, received_at, labels) values ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'lbl-2', now(), array['ok', null])$$,
                 '23514', null, 'a null label is rejected');
select lives_ok($$insert into comms.message_index (lane_id, connection_id, provider, message_id, received_at, labels) values ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'lbl-3', now(), array['INBOX', 'IMPORTANT'])$$,
                'normal labels are accepted');
reset role;

-- purge upper bounds
set local session_replication_role = replica;
insert into comms.message_index (lane_id, connection_id, provider, message_id, received_at) values
  ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'old-95', now() - interval '95 days');
insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, status, updated_at) values
  ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'primary', 'stub-old', 'cancelled', now() - interval '200 days');
insert into cal.event_index (lane_id, connection_id, provider, calendar_id, event_id, start_at, end_at) values
  ('PKG', '00000000-0000-4000-8000-000000000611', 'google', 'primary', 'old-190', now() - interval '190 days', now() - interval '190 days');
set local session_replication_role = origin;
set local role service_role;
select is(comms.message_index_purge('PKG', interval '400 days'), 1, 'a longer interval than the lane policy is capped at retention_days (90): the 95-day-old message goes');
select is(cal.event_index_purge('PKG', interval '400 days'), 2, 'a longer interval than 180 days is capped at 180: the 190-day-old event and the old cancelled stub (aged by updated_at) go');
select is((select count(*)::int from cal.event_index where lane_id = 'PKG' and event_id = 'old-170'), 1, 'the 170-day-old event is still kept');
reset role;

-- cross-lane denial for messages: an owner with a PKG-only membership
delete from core.memberships where user_id = pg_temp.uid('owner@example.test') and lane_id <> 'PKG';
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is(pg_temp.visible_lanes(), array['PKG'], 'a PKG-only owner sees only PKG rows although APK is enabled');
select is((select count(*)::int from comms.message_index where lane_id = 'APK'), 0, 'a PKG-only owner sees 0 APK messages');
reset role;

select * from finish();
rollback;
