-- T-068, T-264: core.push_subscriptions (provider change-notification subscriptions). Written only through the lane-checked definer functions, the clientState lives in
-- the Vault and never in the table, readable only by owner / admin_technical at aal2 in their own lanes through the 'health' view and only the columns that view needs.
-- Covered: shape and privileges, record (checks, Vault secret, supersede, one live row per stream), list / lookup / renewed / mark / remove_connection bound to
-- (lane, connection), purge (fixed 30 days, enabled lane), reads (CROSS-LANE denial, AAL1, anon, hidden columns, no writes), and that core.webhook_events accepts provider 'microsoft'.
begin;
select plan(87);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';

insert into core.connections (id, lane_id, provider, external_account_id, status, owner_user_id) values
  ('00000000-0000-4000-8000-000000032601', 'PKG', 'microsoft', 'ms-one@example.test', 'active', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032602', 'PKG', 'microsoft', 'ms-two@example.test', 'degraded', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032603', 'APK', 'microsoft', 'ms-apk@example.test', 'active', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032604', 'PKG', 'microsoft', 'ms-gone@example.test', 'disconnected', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000032605', 'PKG', 'google', 'g-one@example.test', 'active', pg_temp.uid('owner@example.test'));

-- ---------------------------------------------------------------- shape and privileges
select has_table('core', 'push_subscriptions', 'core.push_subscriptions exists');
select ok((select relrowsecurity from pg_class where oid = 'core.push_subscriptions'::regclass), 'RLS is on');
select has_column('core', 'push_subscriptions', 'lane_id', 'has lane_id');
select is((select count(*)::int from pg_attribute where attrelid = 'core.push_subscriptions'::regclass and attnum > 0
           and attname ~ '(client_state|clientstate|secret|token|payload|body|content)' and attname <> 'vault_secret_id'), 0,
          'no column can hold the clientState, a token or content (the Vault secret is referenced by id only)');
select pg_temp.has_standard_lane_policy('core.push_subscriptions', 'health');
select ok(not has_table_privilege('service_role', 'core.push_subscriptions', 'select, insert, update, delete')
          and not has_table_privilege('anon', 'core.push_subscriptions', 'select, insert, update, delete')
          and not has_table_privilege('authenticated', 'core.push_subscriptions', 'insert, update, delete'),
          'no role writes the table directly; service_role has no table grants (definer functions only)');
select ok(not has_column_privilege('authenticated', 'core.push_subscriptions', 'vault_secret_id', 'select')
          and not has_column_privilege('authenticated', 'core.push_subscriptions', 'subscription_id', 'select')
          and not has_column_privilege('authenticated', 'core.push_subscriptions', 'resource_path', 'select')
          and has_column_privilege('authenticated', 'core.push_subscriptions', 'expires_at', 'select'),
          'the Vault secret id, the provider subscription id and the resource path are not readable through the API; the expiry is');
select ok(has_function_privilege('service_role', 'core.push_subscription_record(text, uuid, text, text, text, text, timestamptz, text)', 'execute')
          and has_function_privilege('service_role', 'core.push_subscription_lookup(text, text, text)', 'execute')
          and has_function_privilege('service_role', 'core.push_subscription_list(text, uuid)', 'execute')
          and has_function_privilege('service_role', 'core.push_subscription_renewed(text, uuid, text, timestamptz)', 'execute')
          and has_function_privilege('service_role', 'core.push_subscription_mark(text, uuid, text, text)', 'execute')
          and has_function_privilege('service_role', 'core.push_subscriptions_remove_connection(text, uuid)', 'execute')
          and has_function_privilege('service_role', 'core.push_subscriptions_purge(text)', 'execute'),
          'service_role executes the seven functions');
select ok(not exists (
            select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'core' and p.proname ~ '^push_subscription'
              and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))),
          'authenticated, anon and public execute none of them');
select ok(not exists (
            select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'core' and p.proname ~ '^push_subscription' and (not p.prosecdef or p.proconfig is distinct from array['search_path=""'])),
          'every function is security definer with an empty search_path');

-- ---------------------------------------------------------------- record
set local role service_role;
select isnt(core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000032601', 'microsoft', 'mail', 'sub-mail-1', 'me/mailfolders(''inbox'')/messages',
              now() + interval '6 days', 'CLIENT-STATE-CANARY-0123456789-abcdefghijklmnopqrstuvwxyz'), null, 'records a mail subscription');
select isnt(core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000032601', 'microsoft', 'calendar', 'sub-cal-1', 'me/events',
              now() + interval '6 days', 'CLIENT-STATE-CANARY-calendar-0123456789-abcdefghijkl'), null, 'records a calendar subscription of the same connection');
select isnt(core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000032602', 'microsoft', 'mail', 'sub-mail-2', 'me/mailfolders(''inbox'')/messages',
              now() + interval '2 days', 'CLIENT-STATE-CANARY-two-0123456789-abcdefghijklmnopqrstu'), null, 'a degraded connection can have a subscription');
select isnt(core.push_subscription_record('APK', '00000000-0000-4000-8000-000000032603', 'microsoft', 'mail', 'sub-mail-apk', 'me/mailfolders(''inbox'')/messages',
              now() + interval '6 days', 'CLIENT-STATE-CANARY-apk-0123456789-abcdefghijklmnopqrstu'), null, 'the other lane records its own');
select throws_ok($$select core.push_subscription_record('APK', '00000000-0000-4000-8000-000000032601', 'microsoft', 'mail', 'sub-x', 'me/events', now() + interval '1 day', repeat('s', 40))$$,
                 '42501', null, 'a connection of another lane is refused');
select throws_ok($$select core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000032604', 'microsoft', 'mail', 'sub-x', 'me/events', now() + interval '1 day', repeat('s', 40))$$,
                 '42501', null, 'a disconnected connection is refused');
select throws_ok($$select core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000032605', 'microsoft', 'mail', 'sub-x', 'me/events', now() + interval '1 day', repeat('s', 40))$$,
                 '42501', null, 'a connection of another provider is refused');
select throws_ok($$select core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000032601', 'microsoft', 'mail', 'sub-x', 'me/events', now() - interval '1 minute', repeat('s', 40))$$,
                 '22023', null, 'an expiry in the past is refused');
select throws_ok($$select core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000032601', 'microsoft', 'mail', 'sub-x', 'me/events', now() + interval '9 days', repeat('s', 40))$$,
                 '22023', null, 'an expiry beyond 8 days is refused');
select throws_ok($$select core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000032601', 'microsoft', 'mail', 'sub-x', 'me/events', now() + interval '1 day', repeat('s', 31))$$,
                 '22023', null, 'a client state under 32 characters is refused');
select throws_ok($$select core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000032601', 'microsoft', 'mail', 'sub-x', 'me/events', now() + interval '1 day', repeat('s', 129))$$,
                 '22023', null, 'a client state over 128 characters is refused');
select throws_ok($$select core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000032601', 'microsoft', 'mail', 'sub-x', 'me/events', now() + interval '1 day', null)$$,
                 '22004', null, 'a missing argument is refused');
select throws_ok($$select core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000032601', 'microsoft', 'inbox', 'sub-x', 'me/events', now() + interval '1 day', repeat('s', 40))$$,
                 '23514', null, 'an unknown resource is refused');
select throws_ok($$select core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000032601', 'microsoft', 'mail', 'sub-x', 'me/messages/someone@example.test', now() + interval '1 day', repeat('s', 40))$$,
                 '23514', null, 'a resource path that holds an address is refused');
reset role;

select is((select count(*)::int from core.push_subscriptions where lane_id = 'PKG'), 3, 'three PKG rows were recorded');
select is((select count(*)::int from core.push_subscriptions p where row_to_json(p)::text like '%CLIENT-STATE-CANARY%'), 0,
          'the clientState appears in no column of the table');
select is((select count(*)::int from vault.decrypted_secrets where name like 'push_subscription:%' and decrypted_secret like 'CLIENT-STATE-CANARY%'), 4,
          'each clientState is a Vault secret');
select is((select count(*)::int from core.push_subscriptions where vault_secret_id is not null), 4, 'each live row names its Vault secret');

-- one live subscription per connection and stream: a new record supersedes the old row and deletes its secret
set local role service_role;
select isnt(core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000032601', 'microsoft', 'mail', 'sub-mail-1b', 'me/mailfolders(''inbox'')/messages',
              now() + interval '6 days', 'CLIENT-STATE-CANARY-0123456789-replacement-abcdefghijklmn'), null, 'a second record for the same stream is accepted');
reset role;
select is((select status from core.push_subscriptions where subscription_id = 'sub-mail-1'), 'removed', 'the superseded row is removed');
select is((select count(*)::int from core.push_subscriptions where connection_id = '00000000-0000-4000-8000-000000032601' and resource = 'mail' and status <> 'removed'), 1,
          'exactly one live mail subscription remains for the connection');
select is((select count(*)::int from vault.decrypted_secrets where name like 'push_subscription:%' and decrypted_secret = 'CLIENT-STATE-CANARY-0123456789-abcdefghijklmnopqrstuvwxyz'), 0,
          'the superseded row''s Vault secret was deleted');

-- ---------------------------------------------------------------- list (bound to lane and connection)
set local role service_role;
select is((select count(*)::int from core.push_subscription_list('PKG', '00000000-0000-4000-8000-000000032601')), 2, 'list returns the two live rows of the connection');
select is((select count(*)::int from core.push_subscription_list('PKG', '00000000-0000-4000-8000-000000032602')), 1, 'list returns the other connection''s own row only');
select is((select count(*)::int from core.push_subscription_list('APK', '00000000-0000-4000-8000-000000032601')), 0, 'cross-lane: the same connection id asked in another lane lists nothing');
select throws_ok($$select * from core.push_subscription_list(null, '00000000-0000-4000-8000-000000032601')$$, '22004', null, 'list needs a lane');

-- ---------------------------------------------------------------- lookup (receiver)
select is((select client_state from core.push_subscription_lookup('PKG', 'microsoft', 'sub-mail-1b')), 'CLIENT-STATE-CANARY-0123456789-replacement-abcdefghijklmn', 'lookup returns the clientState of a live row in its lane');
select is((select resource from core.push_subscription_lookup('PKG', 'microsoft', 'sub-cal-1')), 'calendar', 'lookup returns the stream');
select is((select connection_id from core.push_subscription_lookup('PKG', 'microsoft', 'sub-cal-1')), '00000000-0000-4000-8000-000000032601'::uuid, 'lookup returns the connection');
select is((select count(*)::int from core.push_subscription_lookup('APK', 'microsoft', 'sub-mail-1b')), 0, 'cross-lane: a subscription of PKG asked in APK is unknown');
select is((select count(*)::int from core.push_subscription_lookup('PKG', 'microsoft', 'sub-mail-1')), 0, 'a removed row is unknown');
select is((select count(*)::int from core.push_subscription_lookup('PKG', 'google', 'sub-mail-1b')), 0, 'another provider is unknown');
select is((select count(*)::int from core.push_subscription_lookup('PKG', 'microsoft', 'nope')), 0, 'an unknown id is unknown');
select is((select count(*)::int from core.push_subscription_lookup('PKG', 'microsoft', repeat('x', 257))), 0, 'an over-long id is unknown');
reset role;

-- ---------------------------------------------------------------- renewed and mark (bound to lane and connection)
set local role service_role;
select is(core.push_subscription_renewed('PKG', '00000000-0000-4000-8000-000000032601', 'sub-mail-1b', now() + interval '5 days'), true, 'renewed moves a live row''s expiry');
select is(core.push_subscription_renewed('PKG', '00000000-0000-4000-8000-000000032602', 'sub-mail-1b', now() + interval '5 days'), false, 'renewed acts only on the same connection (another connection of the lane changes nothing)');
select is(core.push_subscription_renewed('APK', '00000000-0000-4000-8000-000000032601', 'sub-mail-1b', now() + interval '5 days'), false, 'cross-lane: renewed with another lane changes nothing');
select is(core.push_subscription_renewed('PKG', '00000000-0000-4000-8000-000000032601', 'sub-mail-1', now() + interval '5 days'), false, 'a removed row is not renewed');
select throws_ok($$select core.push_subscription_renewed('PKG', '00000000-0000-4000-8000-000000032601', 'sub-mail-1b', now() + interval '30 days')$$, '22023', null, 'renewed refuses an expiry beyond 8 days');
select is(core.push_subscription_mark('PKG', '00000000-0000-4000-8000-000000032601', 'sub-cal-1', 'reauthorization_required'), true, 'a live row is marked reauthorization_required');
reset role;
select is((select status from core.push_subscriptions where subscription_id = 'sub-cal-1'), 'reauthorization_required', 'the status moved');
set local role service_role;
select is(core.push_subscription_renewed('PKG', '00000000-0000-4000-8000-000000032601', 'sub-cal-1', now() + interval '5 days'), true, 'a renewal clears reauthorization_required');
reset role;
select is((select status from core.push_subscriptions where subscription_id = 'sub-cal-1'), 'active', 'the row is active again');
set local role service_role;
select is(core.push_subscription_mark('PKG', '00000000-0000-4000-8000-000000032602', 'sub-cal-1', 'removed'), false, 'mark acts only on the same connection');
select is(core.push_subscription_mark('APK', '00000000-0000-4000-8000-000000032601', 'sub-cal-1', 'removed'), false, 'cross-lane: mark with another lane changes nothing');
select throws_ok($$select core.push_subscription_mark('PKG', '00000000-0000-4000-8000-000000032601', 'sub-cal-1', 'active')$$, '22023', null, 'mark only accepts reauthorization_required or removed');
select is(core.push_subscription_mark('PKG', '00000000-0000-4000-8000-000000032601', 'sub-cal-1', 'removed'), true, 'a live row is marked removed');
reset role;
select is((select count(*)::int from vault.decrypted_secrets where decrypted_secret = 'CLIENT-STATE-CANARY-calendar-0123456789-abcdefghijkl'), 0, 'removing deletes the Vault secret');
select ok((select vault_secret_id is null and removed_at is not null from core.push_subscriptions where subscription_id = 'sub-cal-1'), 'the removed row holds no secret id and has a removal time');

-- ---------------------------------------------------------------- remove every live subscription of a connection
set local role service_role;
select is(core.push_subscriptions_remove_connection('APK', '00000000-0000-4000-8000-000000032602'), 0, 'cross-lane: a PKG connection id with the APK lane removes nothing');
select is(core.push_subscriptions_remove_connection('PKG', '00000000-0000-4000-8000-000000032601'), 1, 'remove_connection removes the connection''s one live row');
select is(core.push_subscriptions_remove_connection('PKG', '00000000-0000-4000-8000-000000032601'), 0, 'and is idempotent');
reset role;
select is((select count(*)::int from core.push_subscriptions where connection_id = '00000000-0000-4000-8000-000000032602' and status <> 'removed'), 1, 'another connection''s subscription is untouched');
select is((select count(*)::int from core.push_subscriptions where lane_id = 'APK' and status <> 'removed'), 1, 'another lane''s subscription is untouched');
-- a connection that is disconnected afterwards: its rows can still be removed (the disconnect path)
update core.connections set status = 'disconnected' where id = '00000000-0000-4000-8000-000000032602';
set local role service_role;
select is(core.push_subscriptions_remove_connection('PKG', '00000000-0000-4000-8000-000000032602'), 1, 'a disconnected connection''s subscription can be removed');
select is((select count(*)::int from core.push_subscription_lookup('PKG', 'microsoft', 'sub-mail-2')), 0, 'and is unknown to the receiver');
reset role;
update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000032602';

-- ---------------------------------------------------------------- webhook_events accepts provider microsoft (T-036 check, covered here)
set local role service_role;
select is(core.webhook_event_claim('PKG', '00000000-0000-4000-8000-000000032601', 'microsoft', 'ms:test-event-1', 'mail.changed', repeat('a', 64)), 'process', 'a Microsoft event is claimed in core.webhook_events');
select is(core.webhook_event_claim('PKG', '00000000-0000-4000-8000-000000032601', 'microsoft', 'ms:test-event-1', 'mail.changed', repeat('a', 64)), 'duplicate', 'a repeat of it is a duplicate');
select is(core.webhook_event_claim('PKG', '00000000-0000-4000-8000-000000032601', 'microsoft', 'ms:test-event-1', 'mail.changed', repeat('b', 64)), 'conflict', 'the same key with another body hash is a conflict');
reset role;

-- ---------------------------------------------------------------- reads: owner and admin_technical, own lanes, aal2
set local role service_role;
select isnt(core.push_subscription_record('PKG', '00000000-0000-4000-8000-000000032601', 'microsoft', 'mail', 'sub-mail-3', 'me/mailfolders(''inbox'')/messages',
              now() + interval '6 days', 'CLIENT-STATE-CANARY-three-0123456789-abcdefghijklmnopqrst'), null, 'a fresh PKG row for the read tests');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal2');
set local role authenticated;
select set_eq($$select distinct lane_id from core.push_subscriptions$$, array['PKG'], 'admin_technical reads PKG rows and no APK ones (cross-lane denial)');
select ok((select count(*) from core.push_subscriptions where expires_at is not null) >= 1, 'the expiry is readable (Settings health shows it)');
select throws_ok($$select subscription_id from core.push_subscriptions$$, '42501', null, 'the provider subscription id is hidden');
select throws_ok($$select vault_secret_id from core.push_subscriptions$$, '42501', null, 'the Vault secret id is hidden');
select throws_ok($$select resource_path from core.push_subscriptions$$, '42501', null, 'the resource path is hidden');
select throws_ok($$insert into core.push_subscriptions (lane_id, connection_id, provider, resource, subscription_id, resource_path, expires_at, vault_secret_id) values ('PKG', '00000000-0000-4000-8000-000000032601', 'microsoft', 'mail', 'x', 'me/events', now() + interval '1 day', gen_random_uuid())$$,
                 '42501', null, 'authenticated cannot insert');
select throws_ok($$delete from core.push_subscriptions where lane_id = 'PKG'$$, '42501', null, 'authenticated cannot delete');
reset role;
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select set_eq($$select distinct lane_id from core.push_subscriptions$$, array['APK', 'PKG'], 'the owner reads rows of both enabled lanes');
reset role;
select pg_temp.claims('finance-operator@example.test', 'aal2');
set local role authenticated;
select is((select count(*)::int from core.push_subscriptions), 0, 'finance_operator has no health view and reads nothing');
reset role;
select pg_temp.claims('admin-technical@example.test', 'aal1');
set local role authenticated;
select is((select count(*)::int from core.push_subscriptions), 0, 'AAL1 reads nothing');
reset role;
set local role anon;
select throws_ok($$select id from core.push_subscriptions$$, '42501', null, 'anon is denied');
reset role;

-- ---------------------------------------------------------------- purge (fixed 30 days, one lane)
set local session_replication_role = replica;
update core.push_subscriptions set removed_at = now() - interval '40 days' where subscription_id in ('sub-mail-1', 'sub-cal-1');
update core.push_subscriptions set removed_at = now() - interval '10 days' where subscription_id = 'sub-mail-2';
set local session_replication_role = origin;
set local role service_role;
select is(core.push_subscriptions_purge('PKG'), 2, 'purge deletes PKG removed rows older than 30 days');
select is(core.push_subscriptions_purge('PKG'), 0, 'and is idempotent');
reset role;
select is((select count(*)::int from core.push_subscriptions where subscription_id = 'sub-mail-2'), 1, 'a row removed 10 days ago stays');
select is((select count(*)::int from core.push_subscriptions where lane_id = 'APK'), 1, 'purge is lane-bound: the APK row stays');
select is((select count(*)::int from core.push_subscriptions where status <> 'removed' and subscription_id in ('sub-mail-3')), 1, 'live rows are never purged');
update core.lanes set enabled = false where code = 'APK';
set local role service_role;
select throws_ok($$select core.push_subscriptions_purge('APK')$$, '42501', null, 'a disabled lane is refused');
reset role;

select * from finish();
rollback;
