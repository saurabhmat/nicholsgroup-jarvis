-- Webhook receiver (T-036): core.webhook_events is written only through the lane-checked definer functions, deduped on
-- (lane_id, provider, event_id), never holds a payload, and is readable only by owner / admin_technical at aal2 in their
-- own lanes (column grants hide payload_hash). Covered: privileges, the standard lane policy, resolve (D-23 predicate,
-- case, status, lane enabled, per-lane), claim (new, duplicate, failed retry, stuck retry, conflict, wrong lane or
-- provider, cross-lane no collision), mark, purge (floor of 7 days, per lane), and cross-lane and anon denial.
begin;
select plan(53);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';

set local role service_role;
insert into core.connections (id, lane_id, provider, external_account_id, status) values
  ('00000000-0000-4000-8000-000000000141', 'PKG', 'quickbooks', 'Realm-WH-1', 'active'),
  ('00000000-0000-4000-8000-000000000142', 'APK', 'quickbooks', 'realm-wh-2', 'active'),
  ('00000000-0000-4000-8000-000000000143', 'PKG', 'stripe', 'acct_wh_old', 'disconnected'),
  ('00000000-0000-4000-8000-000000000144', 'PKG', 'monday', 'ws-pending', 'pending'),
  ('00000000-0000-4000-8000-000000000145', 'PKG', 'monday', 'ws-degraded', 'degraded');
reset role;

-- ---------------------------------------------------------------- shape and privileges
select has_table('core', 'webhook_events', 'core.webhook_events exists');
select ok((select relrowsecurity from pg_class where oid = 'core.webhook_events'::regclass), 'RLS is on');
select has_column('core', 'webhook_events', 'lane_id', 'has lane_id');
select is((select count(*)::int from pg_attribute where attrelid = 'core.webhook_events'::regclass and attnum > 0
           and attname ~ '(payload|body|content|data|raw)$' and attname <> 'payload_hash'), 0, 'no column can hold a payload or body');
select pg_temp.has_standard_lane_policy('core.webhook_events', 'health');
select ok(not has_table_privilege('service_role', 'core.webhook_events', 'select, insert, update, delete')
          and not has_table_privilege('anon', 'core.webhook_events', 'select, insert, update, delete')
          and not has_table_privilege('authenticated', 'core.webhook_events', 'insert, update, delete'),
          'no role writes the table directly; service_role has no table grants (definer functions only)');
select ok(not has_column_privilege('authenticated', 'core.webhook_events', 'payload_hash', 'select'), 'payload_hash is not readable through the API');
select ok(has_function_privilege('service_role', 'core.webhook_event_claim(text, uuid, text, text, text, text)', 'execute')
          and has_function_privilege('service_role', 'core.webhook_event_mark(text, text, text, text)', 'execute')
          and has_function_privilege('service_role', 'core.webhook_resolve_connection(text, text, text)', 'execute')
          and has_function_privilege('service_role', 'core.webhook_events_purge(text, interval)', 'execute'),
          'service_role executes the four functions');
select ok(not has_function_privilege('authenticated', 'core.webhook_event_claim(text, uuid, text, text, text, text)', 'execute')
          and not has_function_privilege('anon', 'core.webhook_event_claim(text, uuid, text, text, text, text)', 'execute')
          and not has_function_privilege('authenticated', 'core.webhook_event_mark(text, text, text, text)', 'execute')
          and not has_function_privilege('authenticated', 'core.webhook_resolve_connection(text, text, text)', 'execute')
          and not has_function_privilege('anon', 'core.webhook_resolve_connection(text, text, text)', 'execute')
          and not has_function_privilege('authenticated', 'core.webhook_events_purge(text, interval)', 'execute')
          and not has_function_privilege('anon', 'core.webhook_events_purge(text, interval)', 'execute'),
          'authenticated and anon execute none of them');

-- ---------------------------------------------------------------- resolve (D-23 predicate, asked one lane at a time)
set local role service_role;
select is(core.webhook_resolve_connection('PKG', 'quickbooks', 'Realm-WH-1'), '00000000-0000-4000-8000-000000000141'::uuid, 'resolves the account in its lane');
select is(core.webhook_resolve_connection('PKG', 'quickbooks', 'REALM-wh-1'), '00000000-0000-4000-8000-000000000141'::uuid, 'the account id matches case-insensitively');
select is(core.webhook_resolve_connection('APK', 'quickbooks', 'Realm-WH-1'), null, 'the same account asked in another lane resolves to nothing');
select is(core.webhook_resolve_connection('APK', 'quickbooks', 'realm-wh-2'), '00000000-0000-4000-8000-000000000142'::uuid, 'the other lane resolves its own account');
select is(core.webhook_resolve_connection('PKG', 'stripe', 'acct_wh_old'), null, 'a disconnected connection does not resolve');
select is(core.webhook_resolve_connection('PKG', 'monday', 'ws-pending'), null, 'a pending connection does not resolve');
select is(core.webhook_resolve_connection('PKG', 'monday', 'ws-degraded'), '00000000-0000-4000-8000-000000000145'::uuid, 'a degraded connection still resolves (it holds the account)');
select is(core.webhook_resolve_connection('PKG', 'stripe', 'Realm-WH-1'), null, 'another provider does not resolve it');
select is(core.webhook_resolve_connection('PKG', 'quickbooks', 'nobody'), null, 'an unknown account resolves to nothing');
select is(core.webhook_resolve_connection('PKG', 'quickbooks', ''), null, 'an empty account resolves to nothing');
select is(core.webhook_resolve_connection('PKG', 'quickbooks', repeat('x', 257)), null, 'an over-long account resolves to nothing');
reset role;
update core.lanes set enabled = false where code = 'APK';
set local role service_role;
select is(core.webhook_resolve_connection('APK', 'quickbooks', 'realm-wh-2'), null, 'a disabled lane resolves nothing');
reset role;
update core.lanes set enabled = true where code = 'APK';

-- ---------------------------------------------------------------- claim
set local role service_role;
select is(core.webhook_event_claim('PKG', '00000000-0000-4000-8000-000000000141', 'quickbooks', 'evt-1', 'entity.update', repeat('a', 64)),
          'process', 'a new event is claimed');
select is(core.webhook_event_claim('PKG', '00000000-0000-4000-8000-000000000141', 'quickbooks', 'evt-1', 'entity.update', repeat('a', 64)),
          'duplicate', 'a repeat while the hand-off is fresh is a duplicate (no second enqueue)');
select is(core.webhook_event_claim('PKG', '00000000-0000-4000-8000-000000000141', 'quickbooks', 'evt-1', 'entity.update', repeat('b', 64)),
          'conflict', 'the same id with a different body hash is a conflict');
select is(core.webhook_event_mark('PKG', 'quickbooks', 'evt-1', 'enqueued'), true, 'marked enqueued');
select is(core.webhook_event_mark('PKG', 'quickbooks', 'evt-1', 'failed'), false, 'an enqueued event cannot move back');
select is(core.webhook_event_claim('PKG', '00000000-0000-4000-8000-000000000141', 'quickbooks', 'evt-1', 'entity.update', repeat('a', 64)),
          'duplicate', 'a repeat after the hand-off is a duplicate');

select is(core.webhook_event_claim('PKG', '00000000-0000-4000-8000-000000000141', 'quickbooks', 'evt-2', 'entity.update', repeat('c', 64)), 'process', 'second event claimed');
select is(core.webhook_event_mark('PKG', 'quickbooks', 'evt-2', 'failed'), true, 'a failed hand-off is recorded');
select is(core.webhook_event_claim('PKG', '00000000-0000-4000-8000-000000000141', 'quickbooks', 'evt-2', 'entity.update', repeat('d', 64)),
          'process', 'a retry of a failed hand-off is claimed again, even if the delivery body changed (the event is not lost)');
reset role;
select is((select attempts from core.webhook_events where event_id = 'evt-2'), 2, 'the retry counted as attempt 2');

-- (updated_at is maintained by a trigger; replica mode skips it so the test can age the row)
set local session_replication_role = replica;
update core.webhook_events set updated_at = now() - interval '3 minutes' where event_id = 'evt-2';
set local session_replication_role = origin;
set local role service_role;
select is(core.webhook_event_claim('PKG', '00000000-0000-4000-8000-000000000141', 'quickbooks', 'evt-2', 'entity.update', repeat('d', 64)),
          'process', 'a row stuck in received for over two minutes is claimed again (crashed receiver)');

-- the same event id in another lane is a different row
select is(core.webhook_event_claim('APK', '00000000-0000-4000-8000-000000000142', 'quickbooks', 'evt-1', 'entity.update', repeat('a', 64)),
          'process', 'cross-lane: the same provider event id in another lane does not collide');

-- connection must belong to the lane and provider, and be usable
select throws_ok($$select core.webhook_event_claim('APK', '00000000-0000-4000-8000-000000000141', 'quickbooks', 'evt-x', 't', repeat('a', 64))$$,
                 '42501', null, 'a connection of another lane is refused');
select throws_ok($$select core.webhook_event_claim('PKG', '00000000-0000-4000-8000-000000000141', 'stripe', 'evt-x', 't', repeat('a', 64))$$,
                 '42501', null, 'a connection of another provider is refused');
select throws_ok($$select core.webhook_event_claim('PKG', '00000000-0000-4000-8000-000000000143', 'stripe', 'evt-x', 't', repeat('a', 64))$$,
                 '42501', null, 'a disconnected connection is refused');
select throws_ok($$select core.webhook_event_claim('PKG', '00000000-0000-4000-8000-000000000141', 'quickbooks', 'evt-x', 't', 'not-a-hash')$$,
                 '23514', null, 'a malformed hash is refused');
select throws_ok($$select core.webhook_event_claim('PKG', '00000000-0000-4000-8000-000000000141', 'quickbooks', '', 't', repeat('a', 64))$$,
                 '23514', null, 'an empty event id is refused');
select throws_ok($$select core.webhook_event_claim('PKG', null, 'quickbooks', 'e', 't', repeat('a', 64))$$,
                 '22004', null, 'a missing argument is refused');
select throws_ok($$select core.webhook_event_mark('PKG', 'quickbooks', 'evt-2', 'received')$$, '22023', null, 'mark only accepts enqueued or failed');
select is(core.webhook_event_mark('APK', 'quickbooks', 'evt-2', 'enqueued'), false, 'mark is lane-bound: another lane cannot move the row');
reset role;
select is((select status from core.webhook_events where lane_id = 'PKG' and event_id = 'evt-2'), 'received', 'the PKG row was untouched by the APK mark');

-- ---------------------------------------------------------------- reads: owner and admin_technical, own lanes, aal2
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select set_eq($$select distinct lane_id from core.webhook_events$$, array['PKG'], 'admin_technical reads PKG receipts and no APK ones (cross-lane denial)');
select throws_ok($$select payload_hash from core.webhook_events$$, '42501', null, 'payload_hash is hidden');
select throws_ok($$insert into core.webhook_events (lane_id, connection_id, provider, event_id, event_type, payload_hash) values ('PKG', '00000000-0000-4000-8000-000000000141', 'quickbooks', 'x', 't', repeat('a', 64))$$,
                 '42501', null, 'authenticated cannot insert');
select throws_ok($$delete from core.webhook_events$$, '42501', null, 'authenticated cannot delete');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select set_eq($$select distinct lane_id from core.webhook_events$$, array['APK', 'PKG'], 'the owner reads receipts of both enabled lanes');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.webhook_events), 0, 'finance_operator has no health view and reads nothing');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.webhook_events), 0, 'AAL1 reads nothing');
reset role;
set local role anon;
select throws_ok($$select id from core.webhook_events$$, '42501', null, 'anon is denied');
reset role;

-- ---------------------------------------------------------------- purge
update core.webhook_events set received_at = now() - interval '40 days' where lane_id = 'PKG' and event_id = 'evt-1';
update core.webhook_events set received_at = now() - interval '40 days' where lane_id = 'APK' and event_id = 'evt-1';
set local role service_role;
select throws_ok($$select core.webhook_events_purge('PKG', interval '1 day')$$, '22023', null, 'purge refuses keeping under 7 days');
select is(core.webhook_events_purge('PKG'), 1, 'purge deletes the PKG receipt older than 30 days');
reset role;
select is((select count(*)::int from core.webhook_events where lane_id = 'APK' and event_id = 'evt-1'), 1, 'purge is lane-bound: the APK receipt stays');

select * from finish();
rollback;
